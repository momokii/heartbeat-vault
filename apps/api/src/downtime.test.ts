import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeDueTriggers,
  runSchedulerTick,
  recoverFromOutage,
  promoteDueWaits,
  checkClockSkew,
} from './lib/downtime.js';
import { AUDIT_GENESIS, computeAuditHash } from './lib/audit.js';
import { recordHeartbeat } from './routes/heartbeat.js';

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

/** Active switch with deadline `deadlineAgeSec` in the past and grace `graceSec`. */
async function createActiveSwitch(deadlineAgeSec: number, graceSec = 7200): Promise<string> {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
    [`u${Math.random()}@t.test`],
  );
  const s = await pool.query<{ id: string }>(
    `INSERT INTO switches (owner_id, title, mode, status, heartbeat_interval, grace_window,
        heartbeat_started_at, next_deadline)
     VALUES ($1,'t','direct_delivery','active', make_interval(secs => 1209600), make_interval(secs => $2),
        clock_timestamp() - make_interval(secs => $3::int), clock_timestamp() - make_interval(secs => $4::int))
     RETURNING id`,
    [u.rows[0]!.id, graceSec, deadlineAgeSec + 1209600, deadlineAgeSec],
  );
  return s.rows[0]!.id;
}

async function seedHeartbeatTick(ageMs: number): Promise<void> {
  await pool.query(
    `INSERT INTO scheduler_heartbeat (id, last_tick_at, tick_owner) VALUES (1, clock_timestamp() - make_interval(secs => $1), 'w0')
     ON CONFLICT (id) DO UPDATE SET last_tick_at = clock_timestamp() - make_interval(secs => $1)`,
    [ageMs / 1000],
  );
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

describe('recoverFromOutage', () => {
  it('no-op when the scheduler tick is fresh', async () => {
    await createActiveSwitch(3600);
    await seedHeartbeatTick(30_000);
    const out = await recoverFromOutage(pool, new Date(), 60);
    expect(out.outage).toBe(false);
    expect(out.affected).toBe(0);
    const waits = await pool.query(`SELECT * FROM vault_waits`);
    expect(waits.rows).toHaveLength(0);
  });

  it('switch still inside grace during outage → vault_wait installed, job NOT materialized', async () => {
    // deadline 1h ago, grace 2h → still in grace; outage 3h
    const sid = await createActiveSwitch(3600, 7200);
    await seedHeartbeatTick(3 * 3600_000);
    const out = await recoverFromOutage(pool, new Date(), 60);
    expect(out.outage).toBe(true);
    expect(out.affected).toBe(1);
    const wait = await pool.query<{ wake_at: Date; reason: string }>(
      `SELECT wake_at, reason FROM vault_waits WHERE switch_id=$1`,
      [sid],
    );
    expect(wait.rows).toHaveLength(1);
    expect(wait.rows[0]!.reason).toBe('post-recovery-grace');
    const mat = await materializeDueTriggers(pool, new Date());
    expect(mat).toBe(0);
    const jobs = await pool.query(`SELECT * FROM trigger_jobs WHERE switch_id=$1`, [sid]);
    expect(jobs.rows).toHaveLength(0);
  });

  it('grace expired during outage → exactly one immediate job (at-most-once)', async () => {
    // deadline 3h ago, grace 2h → expired
    const sid = await createActiveSwitch(3 * 3600, 7200);
    await seedHeartbeatTick(5 * 3600_000);
    const out = await recoverFromOutage(pool, new Date(), 60);
    expect(out.outage).toBe(true);
    expect(out.affected).toBe(1);
    // idempotent: run recovery again — no duplicates
    await recoverFromOutage(pool, new Date(), 60);
    const jobs = await pool.query<{ run_at: Date }>(
      `SELECT run_at FROM trigger_jobs WHERE switch_id=$1`,
      [sid],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.run_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('writes downtime_recovery through the normal v2 audit chain with empty details', async () => {
    const sid = await createActiveSwitch(3 * 3600, 7200);
    await seedHeartbeatTick(5 * 3600_000);

    await recoverFromOutage(pool, new Date(), 60);

    const audit = await pool.query<{
      readonly ts: Date;
      readonly actor_id: string | null;
      readonly action: string;
      readonly target: string | null;
      readonly details: Record<string, unknown>;
      readonly prev_hash: Buffer | null;
      readonly hash: Buffer;
    }>(
      `SELECT ts, actor_id, action, target, details, prev_hash, hash
       FROM audit_log WHERE action = 'downtime_recovery' AND target = $1`,
      [sid],
    );
    const row = audit.rows[0]!;
    expect(row.details).toEqual({});
    expect(
      computeAuditHash(
        row.prev_hash ?? AUDIT_GENESIS,
        row.ts,
        row.actor_id,
        row.action,
        row.target,
        row.details,
      ).equals(row.hash),
    ).toBe(true);
  });

  it('mixed: two switches, one in grace one expired', async () => {
    await createActiveSwitch(3600, 7200);
    await createActiveSwitch(3 * 3600, 7200);
    await seedHeartbeatTick(4 * 3600_000);
    const out = await recoverFromOutage(pool, new Date(), 60);
    expect(out.affected).toBe(2);
    const waits = await pool.query(`SELECT * FROM vault_waits`);
    expect(waits.rows).toHaveLength(1);
    const jobs = await pool.query(`SELECT * FROM trigger_jobs`);
    expect(jobs.rows).toHaveLength(1);
  });
});

describe('promoteDueWaits', () => {
  it('promotes only due waits; materialize then creates the job', async () => {
    const sid = await createActiveSwitch(3600, 7200);
    await seedHeartbeatTick(3 * 3600_000);
    await recoverFromOutage(pool, new Date(), 60);
    // wait not due yet (wake_at = deadline + 2h > now)
    expect(await promoteDueWaits(pool, new Date())).toHaveLength(0);
    // force due
    await pool.query(`UPDATE vault_waits SET wake_at = clock_timestamp() - interval '1 sec'`);
    const promoted = await promoteDueWaits(pool, new Date());
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toBe(sid);
    const mat = await materializeDueTriggers(pool, new Date());
    expect(mat).toBe(1);
    // materialize is now unblocked: no double
    expect(await materializeDueTriggers(pool, new Date())).toBe(0);
  });
});

describe('runSchedulerTick integration', () => {
  it('tick after outage: recovers, promotes, materializes, updates heartbeat', async () => {
    const inGrace = await createActiveSwitch(3600, 7200);
    await seedHeartbeatTick(3 * 3600_000);
    await runSchedulerTick(pool, 'w1', new Date());
    // in-grace switch waits; heartbeat refreshed
    const waits = await pool.query(`SELECT * FROM vault_waits WHERE switch_id=$1`, [inGrace]);
    expect(waits.rows).toHaveLength(1);
    const hb = await pool.query<{ tick_owner: string }>(
      `SELECT tick_owner FROM scheduler_heartbeat WHERE id=1`,
    );
    expect(hb.rows[0]!.tick_owner).toBe('w1');
    // next tick: fresh, no-op recovery
    const out = await recoverFromOutage(pool, new Date(), 60);
    expect(out.outage).toBe(false);
  });
});

describe('check-in cancels post-recovery wait', () => {
  it('recordHeartbeat deletes the vault_wait row', async () => {
    const sid = await createActiveSwitch(3600, 7200);
    await pool.query(
      `INSERT INTO vault_waits (switch_id, wake_at, reason) VALUES ($1, clock_timestamp() + interval '1h', 'post-recovery-grace')`,
      [sid],
    );
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await recordHeartbeat(c, sid, 'manual', { actorId: null, ip: null, requestId: null });
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    const waits = await pool.query(`SELECT * FROM vault_waits WHERE switch_id=$1`, [sid]);
    expect(waits.rows).toHaveLength(0);
  });
});

describe('checkClockSkew', () => {
  it('reports sane skew and honors the budget', async () => {
    const ok = await checkClockSkew(pool, 60_000);
    expect(Math.abs(ok.skewMs)).toBeLessThan(60_000);
    expect(ok.uncertain).toBe(false);
    // Negative budget: any real clock pair differs by > -1ms, so this must
    // always hold — deterministic regardless of rounding.
    const strict = await checkClockSkew(pool, -1);
    expect(strict.uncertain).toBe(true);
  });
});
