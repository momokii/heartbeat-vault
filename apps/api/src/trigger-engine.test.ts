import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeDueTriggers,
  claimJob,
  completeJob,
  failJob,
  reapExpiredLeases,
  processJob,
  runSchedulerTick,
  type TriggerJobRow,
} from './lib/trigger-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

async function applyMigrations(p: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', '..', '..', 'packages', 'db', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(drizzle(p), { migrationsFolder });
}

async function truncateAll(p: Pool): Promise<void> {
  await p.query(`
    TRUNCATE audit_log, delivery_jobs, vault_waits, trigger_jobs, heartbeats, heartbeat_links,
      sealed_payloads, recipients, switches, sessions, invites, dead_letter_jobs,
      scheduler_heartbeat, app_config, recovery_codes, webauthn_credentials, users CASCADE`);
}

/** Active switch whose deadline is `deadlineOffsetSec` ago (negative = due). */
async function createActiveSwitch(opts?: {
  deadlineOffsetSec?: number;
  intervalSec?: number;
  dryRun?: boolean;
}): Promise<string> {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
    [`u${Math.random()}@t.test`],
  );
  const intervalSec = opts?.intervalSec ?? 14 * 86400;
  const offset = opts?.deadlineOffsetSec ?? -(intervalSec * 0.5 + 86400 + 60);
  const s = await pool.query<{ id: string }>(
    `INSERT INTO switches (owner_id, title, mode, status, heartbeat_interval, grace_window,
        dry_run, heartbeat_started_at, next_deadline)
     VALUES ($1,'t','direct_delivery','active', make_interval(secs => $2), make_interval(secs => 3600),
        $3, clock_timestamp() - make_interval(secs => $4::int), clock_timestamp() + make_interval(secs => $5::int))
     RETURNING id`,
    [u.rows[0]!.id, intervalSec, opts?.dryRun ?? false, -offset - intervalSec, offset],
  );
  return s.rows[0]!.id;
}

async function addAcceptedRecipient(switchId: string, channel = 'email'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO recipients (switch_id, channel, address, status) VALUES ($1,$2,'a@b.c','accepted') RETURNING id`,
    [switchId, channel],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await applyMigrations(pool);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await truncateAll(pool);
});

describe('materializeDueTriggers', () => {
  it('creates one pending job per due switch with deterministic idempotency key', async () => {
    const sid = await createActiveSwitch();
    const n1 = await materializeDueTriggers(pool, new Date());
    expect(n1).toBe(1);
    const n2 = await materializeDueTriggers(pool, new Date());
    expect(n2).toBe(0);
    const jobs = await pool.query<TriggerJobRow>(`SELECT * FROM trigger_jobs WHERE switch_id=$1`, [
      sid,
    ]);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.state).toBe('pending');
    // run_at = deadline + 50% interval + 24h fire lag
    const row = await pool.query<{ run_at: Date; deadline_at: Date; interval: string }>(
      `SELECT j.run_at, j.deadline_at, s.heartbeat_interval::text as interval
       FROM trigger_jobs j JOIN switches s ON s.id=j.switch_id WHERE s.id=$1`,
      [sid],
    );
    const expected = row.rows[0]!.deadline_at.getTime() + (14 * 86400 * 0.5 + 86400) * 1000;
    expect(Math.abs(row.rows[0]!.run_at.getTime() - expected)).toBeLessThan(1000);
  });

  it('skips non-active and not-yet-due switches', async () => {
    await createActiveSwitch({ deadlineOffsetSec: 3600 });
    const paused = await createActiveSwitch({ deadlineOffsetSec: -999999 });
    await pool.query(`UPDATE switches SET status='paused' WHERE id=$1`, [paused]);
    const n = await materializeDueTriggers(pool, new Date());
    expect(n).toBe(0);
  });
});

describe('claim + complete', () => {
  it('two workers never claim the same job; succeeded jobs are not re-claimable', async () => {
    await createActiveSwitch();
    await createActiveSwitch();
    await createActiveSwitch();
    await materializeDueTriggers(pool, new Date());
    const claimed: string[] = [];
    for (let i = 0; i < 6; i++) {
      const worker = `w${i % 2}`;
      const job = await claimJob(pool, worker, new Date());
      if (job) {
        expect(claimed).not.toContain(job.id.toString());
        claimed.push(job.id.toString());
        await completeJob(pool, job.id, worker);
      }
    }
    expect(claimed).toHaveLength(3);
    const states = await pool.query<{ state: string }>(`SELECT state FROM trigger_jobs`);
    expect(states.rows.every(r => r.state === 'succeeded')).toBe(true);
  });

  it('does not claim jobs whose run_at is in the future', async () => {
    // Deadline only 60s in the past → run_at lands ~8.5 days in the future.
    await createActiveSwitch({ deadlineOffsetSec: -60 });
    await materializeDueTriggers(pool, new Date());
    const job = await claimJob(pool, 'w1', new Date());
    expect(job).toBeNull();
    const later = new Date(Date.now() + (14 * 86400 * 0.5 + 86400 + 3600) * 1000);
    const job2 = await claimJob(pool, 'w1', later);
    expect(job2).not.toBeNull();
  });
});

describe('lease + sweeper', () => {
  it('reaps expired leases back to pending; live leases untouched', async () => {
    await createActiveSwitch();
    await materializeDueTriggers(pool, new Date());
    const later = new Date(Date.now() + (14 * 86400 * 0.5 + 86400 + 3600) * 1000);
    const job = (await claimJob(pool, 'w1', later))!;
    expect(job).not.toBeNull();
    // force lease expiry
    await pool.query(
      `UPDATE trigger_jobs SET lease_expires = now() - interval '1 sec' WHERE id=$1`,
      [job!.id],
    );
    const reaped = await reapExpiredLeases(pool, new Date());
    expect(reaped).toBe(1);
    const reclaimed = await claimJob(pool, 'w2', later);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.ownerId).toBe('w2');
    // live lease: not reaped
    await completeJob(pool, reclaimed!.id, 'w2');
    const reaped2 = await reapExpiredLeases(pool, new Date());
    expect(reaped2).toBe(0);
  });
});

describe('retries + dead-letter', () => {
  it('failJob with attempts < max requeues with backoff; at max goes dead + DLQ', async () => {
    await createActiveSwitch();
    await materializeDueTriggers(pool, new Date());
    const later = new Date(Date.now() + (14 * 86400 * 0.5 + 86400 + 3600) * 1000);
    const job = (await claimJob(pool, 'w1', later))!;
    await failJob(pool, job!.id, 'w1', 'smtp timeout');
    const afterFail = await pool.query<{ state: string; attempts: number; run_at: Date }>(
      `SELECT state, attempts, run_at FROM trigger_jobs WHERE id=$1`,
      [job!.id],
    );
    expect(afterFail.rows[0]!.state).toBe('pending');
    expect(afterFail.rows[0]!.attempts).toBe(1);
    expect(afterFail.rows[0]!.run_at.getTime()).toBeGreaterThan(Date.now());
    // drive to max attempts
    for (let i = 0; i < 4; i++) {
      const j = (await claimJob(pool, 'w1', new Date(Date.now() + 3_600_000)))!;
      await failJob(pool, j!.id, 'w1', 'smtp timeout again');
    }
    const dead = await pool.query<{ state: string }>(`SELECT state FROM trigger_jobs WHERE id=$1`, [
      job!.id,
    ]);
    expect(dead.rows[0]!.state).toBe('dead');
    const dlq = await pool.query<{ source: string; final_error: string }>(
      `SELECT source, final_error FROM dead_letter_jobs`,
    );
    expect(dlq.rows).toHaveLength(1);
    expect(dlq.rows[0]!.source).toBe('trigger');
  });
});

describe('processJob', () => {
  it('dry_run switch completes without delivery jobs and advances deadline', async () => {
    const sid = await createActiveSwitch({ dryRun: true });
    await addAcceptedRecipient(sid);
    await materializeDueTriggers(pool, new Date());
    const later = new Date(Date.now() + (14 * 86400 * 0.5 + 86400 + 3600) * 1000);
    const job = (await claimJob(pool, 'w1', later))!;
    await processJob(pool, job!, 'w1');
    const sw = await pool.query<{ status: string; next_deadline: Date }>(
      `SELECT status, next_deadline FROM switches WHERE id=$1`,
      [sid],
    );
    expect(sw.rows[0]!.status).toBe('active');
    expect(sw.rows[0]!.next_deadline.getTime()).toBeGreaterThan(Date.now());
    const dj = await pool.query(`SELECT * FROM delivery_jobs`);
    expect(dj.rows).toHaveLength(0);
  });

  it('fire creates one delivery job per accepted recipient and releases the switch', async () => {
    const sid = await createActiveSwitch();
    await addAcceptedRecipient(sid, 'email');
    await addAcceptedRecipient(sid, 'webhook');
    await addAcceptedRecipient(sid, 'telegram');
    // one invited (not accepted) — must be excluded
    await pool.query(
      `INSERT INTO recipients (switch_id, channel, address, status) VALUES ($1,'email','x@y.z','invited')`,
      [sid],
    );
    await materializeDueTriggers(pool, new Date());
    const later = new Date(Date.now() + (14 * 86400 * 0.5 + 86400 + 3600) * 1000);
    const job = (await claimJob(pool, 'w1', later))!;
    await processJob(pool, job!, 'w1');
    const dj = await pool.query<{ channel: string; idempotency_key: string }>(
      `SELECT channel, idempotency_key FROM delivery_jobs ORDER BY channel`,
    );
    expect(dj.rows).toHaveLength(3);
    expect(dj.rows.every(r => r.idempotency_key.includes(job!.id.toString()))).toBe(true);
    const sw = await pool.query<{ status: string }>(`SELECT status FROM switches WHERE id=$1`, [
      sid,
    ]);
    expect(sw.rows[0]!.status).toBe('released');
  });
});

describe('runSchedulerTick', () => {
  it('updates scheduler heartbeat singleton', async () => {
    await runSchedulerTick(pool, 'worker-a', new Date());
    const hb = await pool.query<{ last_tick_at: Date; tick_owner: string }>(
      `SELECT last_tick_at, tick_owner FROM scheduler_heartbeat WHERE id=1`,
    );
    expect(hb.rows[0]!.tick_owner).toBe('worker-a');
    expect(hb.rows[0]!.last_tick_at).toBeInstanceOf(Date);
  });
});
