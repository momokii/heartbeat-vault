// Trigger engine (T4.4): durable Postgres-backed job queue for the release path.
//
// Mechanics (per docs/DESIGN.md §5 + ADR-002):
// - materializeDueTriggers: one idempotent trigger_job per active switch whose
//   deadline has passed (UNIQUE(switch_id, deadline_at) + ON CONFLICT DO
//   NOTHING). run_at = deadline + 50% of interval + 24h fire lag, matching the
//   escalation ladder in lib/escalation.ts.
// - claimJob: FOR UPDATE SKIP LOCKED — concurrent workers never double-claim.
// - Leases: 30s, renewed by the worker; reapExpiredLeases returns stale
//   running jobs to pending (at-least-once, never lost).
// - failJob: exponential backoff with full jitter; at max_attempts the job
//   goes dead and lands in dead_letter_jobs (never a silent drop).
// - processJob: dry-run switches complete without delivery; live switches
//   enqueue one idempotent delivery_job per ACCEPTED recipient and transition
//   the switch to released.
import type { Pool, PoolClient } from 'pg';

/** Anything with .query — lets helpers run on a pool or inside a transaction. */
type Queryable = Pool | PoolClient;

export const LEASE_SECONDS = 30;
export const MAX_ATTEMPTS_DEFAULT = 5;
export const FIRE_LAG_SECONDS = 24 * 3600;
export const BACKOFF_BASE_SECONDS = 2;

export type TriggerJobRow = {
  readonly id: number;
  readonly switchId: string;
  readonly state: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly ownerId: string | null;
  readonly leaseExpires: Date | null;
  readonly idempotencyKey: string;
};

export async function materializeDueTriggers(pool: Pool, now: Date): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO trigger_jobs (switch_id, deadline_at, run_at, state, idempotency_key, payload)
     SELECT s.id,
            CASE WHEN s.trigger_type = 'heartbeat' THEN s.next_deadline ELSE s.fire_at END,
            CASE WHEN s.trigger_type = 'heartbeat'
                 THEN s.next_deadline
                      + (extract(epoch FROM s.heartbeat_interval) * 0.5 + $2::bigint) * interval '1 second'
                 ELSE s.fire_at END,
            'pending',
            'switch:' || s.id::text || ':' || extract(epoch FROM CASE
              WHEN s.trigger_type = 'heartbeat' THEN s.next_deadline ELSE s.fire_at END)::bigint,
            CASE WHEN s.trigger_type = 'heartbeat'
                 THEN '{"kind":"fire"}'::jsonb
                 ELSE '{"kind":"fire","variant":true}'::jsonb END
     FROM switches s
     WHERE s.status = 'active'
       AND (
         (s.trigger_type = 'heartbeat' AND s.next_deadline <= $1)
         OR (s.trigger_type IN ('fixed_date','panic') AND s.fire_at IS NOT NULL AND s.fire_at <= $1)
       )
       AND NOT EXISTS (SELECT 1 FROM vault_waits w WHERE w.switch_id = s.id)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [now, FIRE_LAG_SECONDS],
  );
  return res.rowCount ?? 0;
}

export async function claimJob(
  pool: Pool,
  workerId: string,
  now: Date,
): Promise<TriggerJobRow | null> {
  const res = await pool.query<TriggerJobRow>(
    `WITH picked AS (
       SELECT id FROM trigger_jobs
       WHERE state = 'pending' AND run_at <= $2
       ORDER BY run_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE trigger_jobs j
     SET state = 'running', owner_id = $1,
         lease_expires = $2 + make_interval(secs => $3::int),
         attempts = j.attempts + 1
     FROM picked
     WHERE j.id = picked.id
     RETURNING j.id, j.switch_id AS "switchId", j.state, j.attempts,
       j.max_attempts AS "maxAttempts", j.owner_id AS "ownerId",
       j.lease_expires AS "leaseExpires", j.idempotency_key AS "idempotencyKey"`,
    [workerId, now, LEASE_SECONDS],
  );
  return res.rows[0] ?? null;
}

export async function completeJob(q: Queryable, jobId: number, workerId: string): Promise<boolean> {
  const res = await q.query(
    `UPDATE trigger_jobs SET state='succeeded', lease_expires=NULL
     WHERE id=$1 AND owner_id=$2 AND state='running'`,
    [jobId, workerId],
  );
  return (res.rowCount ?? 0) === 1;
}

function jitteredBackoffSeconds(attempts: number): number {
  const base = BACKOFF_BASE_SECONDS * 2 ** attempts;
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

export async function failJob(
  pool: Pool,
  jobId: number,
  workerId: string,
  error: string,
): Promise<'requeued' | 'dead'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{
      attempts: number;
      max_attempts: number;
      payload: unknown;
    }>(
      `SELECT attempts, max_attempts, payload FROM trigger_jobs WHERE id=$1 AND owner_id=$2 AND state='running' FOR UPDATE`,
      [jobId, workerId],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return 'requeued';
    }
    if (row.attempts >= row.max_attempts) {
      await client.query(`UPDATE trigger_jobs SET state='dead', lease_expires=NULL WHERE id=$1`, [
        jobId,
      ]);
      await client.query(
        `INSERT INTO dead_letter_jobs (source, source_id, payload, final_error)
         VALUES ('trigger', $1, $2, $3)`,
        [jobId.toString(), JSON.stringify(row.payload ?? {}), error],
      );
      await client.query('COMMIT');
      return 'dead';
    }
    const backoffSec = jitteredBackoffSeconds(row.attempts);
    await client.query(
      `UPDATE trigger_jobs SET state='pending', owner_id=NULL, lease_expires=NULL,
         run_at = clock_timestamp() + make_interval(secs => $2::int)
       WHERE id=$1`,
      [jobId, backoffSec],
    );
    await client.query('COMMIT');
    return 'requeued';
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function reapExpiredLeases(pool: Pool, now: Date): Promise<number> {
  const res = await pool.query(
    `UPDATE trigger_jobs SET state='pending', owner_id=NULL, lease_expires=NULL
     WHERE state='running' AND lease_expires < $1`,
    [now],
  );
  return res.rowCount ?? 0;
}

export async function processJob(pool: Pool, job: TriggerJobRow, workerId: string): Promise<void> {
  const sw = await pool.query<{
    id: string;
    dry_run: boolean;
    heartbeat_interval: string;
    next_deadline: Date;
  }>(`SELECT id, dry_run, heartbeat_interval, next_deadline FROM switches WHERE id=$1`, [
    job.switchId,
  ]);
  const row = sw.rows[0];
  if (!row) {
    await failJob(pool, job.id, workerId, 'switch disappeared');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM switches WHERE id=$1 FOR UPDATE`, [row.id]);
    if (row.dry_run) {
      await client.query(
        `UPDATE switches SET next_deadline = clock_timestamp() + heartbeat_interval,
            heartbeat_started_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id=$1`,
        [row.id],
      );
      await completeJob(client, job.id, workerId);
      await client.query('COMMIT');
      return;
    }
    const recipients = await client.query<{ id: string; channel: string }>(
      `SELECT id, channel FROM recipients WHERE switch_id=$1 AND status='accepted'`,
      [row.id],
    );
    for (const r of recipients.rows) {
      await client.query(
        `INSERT INTO delivery_jobs (switch_id, trigger_job_id, channel, state, available_at,
            idempotency_key, payload)
         VALUES ($1,$2,$3,'pending', clock_timestamp() + interval '48 hours', $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          row.id,
          job.id,
          r.channel,
          `job:${job.id}:recipient:${r.id}`,
          JSON.stringify({
            kind: 'release',
            switchId: row.id,
            recipientId: r.id,
            channel: r.channel,
          }),
        ],
      );
    }
    await client.query(
      `UPDATE switches SET status='released', updated_at=clock_timestamp() WHERE id=$1`,
      [row.id],
    );
    await completeJob(client, job.id, workerId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
