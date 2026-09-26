// Downtime compensation + clock contract (T4.5).
//
// Fail-safe rule (ADR-003): if the scheduler itself was down, a switch whose
// deadline fell inside the outage gap must NOT fire on recovery. Two cases:
//   - still inside its own grace window → install a vault_wait with
//     wake_at = deadline + grace_window; the owner gets the whole grace to
//     check in and cancel (a check-in deletes the wait). Materialization skips
//     switches holding a wait row.
//   - grace already expired during the gap → fire exactly once, immediately
//     (the miss is genuine; at-most-once via the same idempotency key shape
//     materializeDueTriggers uses, so double-compensation is impossible).
// Clock contract (ADR-004): every persisted deadline is written by Postgres
// clock_timestamp(); the app host clock is only trusted as far as the skew
// budget — past it the worker holds dispatch (CLOCK_UNCERTAIN) instead of
// guessing.
import type { Pool } from 'pg';
import { writeAudit } from './audit.js';
import { materializeDueTriggers } from './trigger-engine.js';

export { materializeDueTriggers };

export const TICK_INTERVAL_SEC_DEFAULT = 60;

export type OutageRecovery = {
  readonly outage: boolean;
  readonly affected: number;
};

const AFFECTED_SQL = `
  FROM switches s
  WHERE s.status = 'active'
    AND s.next_deadline <= $1
    AND s.next_deadline > $2
    AND NOT EXISTS (
      SELECT 1 FROM trigger_jobs j
      WHERE j.switch_id = s.id AND j.deadline_at = s.next_deadline
    )`;

export async function recoverFromOutage(
  pool: Pool,
  now: Date,
  tickIntervalSec: number = TICK_INTERVAL_SEC_DEFAULT,
): Promise<OutageRecovery> {
  const last = await pool.query<{ last_tick_at: Date }>(
    `SELECT last_tick_at FROM scheduler_heartbeat WHERE id = 1`,
  );
  const baseline = last.rows[0]?.last_tick_at;
  if (!baseline) return { outage: false, affected: 0 };
  const gapMs = now.getTime() - baseline.getTime();
  if (gapMs <= tickIntervalSec * 2 * 1000) return { outage: false, affected: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const affected = await client.query<{ id: string }>(`SELECT s.id ${AFFECTED_SQL}`, [
      now,
      baseline,
    ]);
    const ids = affected.rows.map(r => r.id);
    if (ids.length > 0) {
      await client.query(
        `INSERT INTO vault_waits (switch_id, wake_at, reason)
         SELECT s.id, s.next_deadline + s.grace_window, 'post-recovery-grace'
         FROM switches s
         WHERE s.id = ANY($2::uuid[]) AND s.next_deadline + s.grace_window > $1
         ON CONFLICT (switch_id) DO UPDATE SET wake_at = EXCLUDED.wake_at`,
        [now, ids],
      );
      await client.query(
        `INSERT INTO trigger_jobs (switch_id, deadline_at, run_at, state, idempotency_key, payload)
         SELECT s.id, s.next_deadline, $1, 'pending',
                'switch:' || s.id::text || ':' || extract(epoch FROM s.next_deadline)::bigint,
                '{"kind":"fire","backfilled":true}'::jsonb
         FROM switches s
         WHERE s.id = ANY($2::uuid[]) AND s.next_deadline + s.grace_window <= $1
         ON CONFLICT DO NOTHING`,
        [now, ids],
      );
      for (const id of ids) {
        await writeAudit(client, { action: 'downtime_recovery', target: id, details: {} });
      }
    }
    await client.query('COMMIT');
    return { outage: true, affected: ids.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function promoteDueWaits(pool: Pool, now: Date): Promise<string[]> {
  const res = await pool.query<{ switch_id: string }>(
    `DELETE FROM vault_waits WHERE wake_at <= $1 RETURNING switch_id`,
    [now],
  );
  return res.rows.map(r => r.switch_id);
}

export async function checkClockSkew(
  pool: Pool,
  budgetMs: number,
): Promise<{ skewMs: number; uncertain: boolean }> {
  const res = await pool.query<{ db_now: Date }>(`SELECT clock_timestamp() AS db_now`);
  const dbNowMs = res.rows[0]!.db_now.getTime();
  const skewMs = Date.now() - dbNowMs;
  return { skewMs, uncertain: Math.abs(skewMs) > budgetMs };
}

export async function runSchedulerTick(
  pool: Pool,
  workerId: string,
  now: Date,
  tickIntervalSec: number = TICK_INTERVAL_SEC_DEFAULT,
): Promise<number> {
  const recovery = await recoverFromOutage(pool, now, tickIntervalSec);
  void recovery;
  await promoteDueWaits(pool, now);
  const materialized = await materializeDueTriggers(pool, now);
  await pool.query(
    `INSERT INTO scheduler_heartbeat (id, last_tick_at, tick_owner) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET last_tick_at = EXCLUDED.last_tick_at, tick_owner = EXCLUDED.tick_owner`,
    [now, workerId],
  );
  return materialized;
}
