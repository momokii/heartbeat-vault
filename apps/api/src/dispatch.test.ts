import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChannelRegistry, type DeliveryChannel } from './channels/types.js';
import { deliverPendingDeliveries } from './channels/dispatch.js';

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

async function insertDelivery(opts?: {
  attempts?: number;
  maxAttempts?: number;
  channel?: string;
}): Promise<string> {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
    [`u${Math.random()}@t.test`],
  );
  const s = await pool.query<{ id: string }>(
    `INSERT INTO switches (owner_id, title, mode, status, heartbeat_interval, grace_window)
     VALUES ($1,'t','direct_delivery','active', make_interval(secs => 604800), make_interval(secs => 3600))
     RETURNING id`,
    [u.rows[0]!.id],
  );
  const t = await pool.query<{ id: string }>(
    `INSERT INTO trigger_jobs (switch_id, deadline_at, run_at, state, idempotency_key)
     VALUES ($1, clock_timestamp(), clock_timestamp(), 'succeeded', $2) RETURNING id`,
    [s.rows[0]!.id, `tj:${Math.random()}`],
  );
  const d = await pool.query<{ id: string }>(
    `INSERT INTO delivery_jobs (switch_id, trigger_job_id, channel, state, available_at,
        attempts, max_attempts, idempotency_key, payload)
     VALUES ($1,$2,$3,'pending', clock_timestamp() - interval '1 sec', $4, $5, $6, '{"kind":"release"}'::jsonb)
     RETURNING id`,
    [
      s.rows[0]!.id,
      t.rows[0]!.id,
      opts?.channel ?? 'email',
      opts?.attempts ?? 0,
      opts?.maxAttempts ?? 3,
      `dj:${Math.random()}`,
    ],
  );
  return d.rows[0]!.id;
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

function fakeChannel(
  behavior: 'sent' | 'retry' | 'dead',
  sent: Array<{ idempotencyKey: string; channel: string }>,
): DeliveryChannel {
  return {
    async send(ctx) {
      sent.push({ idempotencyKey: ctx.idempotencyKey, channel: ctx.channel });
      if (behavior === 'sent') return { status: 'sent', receipt: `rcpt-${ctx.idempotencyKey}` };
      if (behavior === 'retry') return { status: 'retry', error: 'smtp timeout' };
      return { status: 'dead', error: 'permanent rejection' };
    },
  };
}

describe('channel registry', () => {
  it('resolves registered channels and rejects unknown ones', async () => {
    const sent: Array<{ idempotencyKey: string; channel: string }> = [];
    const reg = createChannelRegistry({ email: fakeChannel('sent', sent) });
    expect(reg.get('email')).toBeDefined();
    expect(reg.get('telegram')).toBeUndefined();
  });
});

describe('deliverPendingDeliveries', () => {
  it('sends, stores receipt, marks succeeded', async () => {
    const id = await insertDelivery({ channel: 'email' });
    const sent: Array<{ idempotencyKey: string; channel: string }> = [];
    const reg = createChannelRegistry({ email: fakeChannel('sent', sent) });
    const summary = await deliverPendingDeliveries(pool, reg, 'w1', new Date());
    expect(summary.sent).toBe(1);
    const row = await pool.query<{ state: string; payload: Record<string, unknown> }>(
      `SELECT state, payload FROM delivery_jobs WHERE id=$1`,
      [id],
    );
    expect(row.rows[0]!.state).toBe('succeeded');
    expect(sent).toHaveLength(1);
    expect(row.rows[0]!.payload['receipt']).toBe(`rcpt-${sent[0]!.idempotencyKey}`);
    expect(sent[0]!.channel).toBe('email');
  });

  it('retryable failure requeues with backoff and increments attempts', async () => {
    const id = await insertDelivery({ channel: 'email' });
    const reg = createChannelRegistry({ email: fakeChannel('retry', []) });
    await deliverPendingDeliveries(pool, reg, 'w1', new Date());
    const row = await pool.query<{ state: string; attempts: number; available_at: Date }>(
      `SELECT state, attempts, available_at FROM delivery_jobs WHERE id=$1`,
      [id],
    );
    expect(row.rows[0]!.state).toBe('pending');
    expect(row.rows[0]!.attempts).toBe(1);
    expect(row.rows[0]!.available_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('moves to dead + DLQ at max attempts', async () => {
    const id = await insertDelivery({ channel: 'email', attempts: 2, maxAttempts: 3 });
    const reg = createChannelRegistry({ email: fakeChannel('retry', []) });
    await deliverPendingDeliveries(pool, reg, 'w1', new Date());
    const row = await pool.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM delivery_jobs WHERE id=$1`,
      [id],
    );
    expect(row.rows[0]!.state).toBe('dead');
    expect(row.rows[0]!.attempts).toBe(3);
    const dlq = await pool.query<{ source: string }>(`SELECT source FROM dead_letter_jobs`);
    expect(dlq.rows).toHaveLength(1);
    expect(dlq.rows[0]!.source).toBe('delivery');
  });

  it('permanent provider rejection goes straight to dead + DLQ', async () => {
    const id = await insertDelivery({ channel: 'email' });
    const reg = createChannelRegistry({ email: fakeChannel('dead', []) });
    await deliverPendingDeliveries(pool, reg, 'w1', new Date());
    const row = await pool.query<{ state: string }>(`SELECT state FROM delivery_jobs WHERE id=$1`, [
      id,
    ]);
    expect(row.rows[0]!.state).toBe('dead');
  });

  it('unknown channel dead-letters instead of crashing', async () => {
    await insertDelivery({ channel: 'carrier_pigeon' });
    const reg = createChannelRegistry({});
    const summary = await deliverPendingDeliveries(pool, reg, 'w1', new Date());
    expect(summary.dead).toBe(1);
  });

  it('two workers never process the same delivery (SKIP LOCKED)', async () => {
    await insertDelivery({ channel: 'email' });
    const sent: Array<{ idempotencyKey: string; channel: string }> = [];
    const reg = createChannelRegistry({ email: fakeChannel('sent', sent) });
    await Promise.all([
      deliverPendingDeliveries(pool, reg, 'w1', new Date()),
      deliverPendingDeliveries(pool, reg, 'w2', new Date()),
    ]);
    expect(sent).toHaveLength(1);
  });

  it('skips deliveries not yet available (backoff pending)', async () => {
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      ['future@t.test'],
    );
    const s = await pool.query<{ id: string }>(
      `INSERT INTO switches (owner_id, title, mode, status, heartbeat_interval, grace_window)
       VALUES ($1,'t','direct_delivery','active', make_interval(secs => 604800), make_interval(secs => 3600))
       RETURNING id`,
      [u.rows[0]!.id],
    );
    const t = await pool.query<{ id: string }>(
      `INSERT INTO trigger_jobs (switch_id, deadline_at, run_at, state, idempotency_key)
       VALUES ($1, clock_timestamp(), clock_timestamp(), 'succeeded', 'tj-f') RETURNING id`,
      [s.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO delivery_jobs (switch_id, trigger_job_id, channel, state, available_at, idempotency_key, payload)
       VALUES ($1,$2,'email','pending', clock_timestamp() + interval '1 hour', 'dj-future', '{}'::jsonb)`,
      [s.rows[0]!.id, t.rows[0]!.id],
    );
    const sent: Array<{ idempotencyKey: string; channel: string }> = [];
    const reg = createChannelRegistry({ email: fakeChannel('sent', sent) });
    await deliverPendingDeliveries(pool, reg, 'w1', new Date());
    expect(sent).toHaveLength(0);
  });
});
