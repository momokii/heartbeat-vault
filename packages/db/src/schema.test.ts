import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';

let container: StartedPostgreSqlContainer;
let pool: Pool;

async function applyMigrations(p: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const drizzleDb = drizzle(p);
  await migrate(drizzleDb, { migrationsFolder });
}

describe('db schema migrations', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('heartbeat_vault_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    const connectionString = container.getConnectionUri();
    pool = new Pool({ connectionString });
    await applyMigrations(pool);
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    // truncate children first
    await pool.query(`
      TRUNCATE
        audit_log,
        delivery_jobs,
        vault_waits,
        trigger_jobs,
        heartbeats,
        sealed_payloads,
        recipients,
        switches,
        sessions,
        invites,
        dead_letter_jobs,
        scheduler_heartbeat,
        app_config,
        users
      CASCADE
    `);
  });

  it('migration round-trip: all expected tables exist', async () => {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const tables = result.rows.map((r: { table_name: string }) => r.table_name);
    const expected = [
      'app_config',
      'audit_log',
      'dead_letter_jobs',
      'delivery_jobs',
      'heartbeats',
      'invites',
      'recipients',
      'scheduler_heartbeat',
      'sealed_payloads',
      'sessions',
      'switches',
      'trigger_jobs',
      'users',
      'vault_waits',
    ];
    for (const t of expected) {
      expect(tables).toContain(t);
    }
  });

  it('enforces UNIQUE(switch_id, deadline_at) on trigger_jobs', async () => {
    const userId = (await pool
      .query(
        `INSERT INTO users (email, password_hash, role) VALUES ('u@example.com','phc', 'user') RETURNING id`,
      )
      .then(r => r.rows[0].id as string)) as string;

    const switchId = (await pool
      .query(
        `INSERT INTO switches (owner_id, mode, status, heartbeat_interval, grace_window) VALUES ($1,'direct_delivery','active','14 days','3 days') RETURNING id`,
        [userId],
      )
      .then(r => r.rows[0].id as string)) as string;

    const deadline = new Date('2026-10-01T00:00:00Z');

    await pool.query(
      `INSERT INTO trigger_jobs (switch_id, deadline_at, idempotency_key) VALUES ($1,$2,'key-1')`,
      [switchId, deadline],
    );

    await expect(
      pool.query(
        `INSERT INTO trigger_jobs (switch_id, deadline_at, idempotency_key) VALUES ($1,$2,'key-2')`,
        [switchId, deadline],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);

    // Different deadline should succeed
    await pool.query(
      `INSERT INTO trigger_jobs (switch_id, deadline_at, idempotency_key) VALUES ($1,$2,'key-3')`,
      [switchId, new Date('2026-10-02T00:00:00Z')],
    );
    const count = await pool.query(`SELECT count(*)::int as c FROM trigger_jobs`);
    expect(count.rows[0].c).toBe(2);
  });

  it('rejects UPDATE/DELETE on audit_log for app role', async () => {
    await pool.query(`INSERT INTO audit_log (action, hash) VALUES ('test.action', '\\xdeadbeef')`);
    const id = (await pool
      .query(`SELECT id FROM audit_log LIMIT 1`)
      .then(r => r.rows[0].id as number)) as number;

    // Create a non-superuser that inherits app privileges to test REVOKE
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_tester') THEN
        CREATE USER app_tester WITH PASSWORD 'app_tester_pw' IN ROLE app;
      END IF;
    END $$;`);

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const appPool = new Pool({
      host,
      port,
      database: 'heartbeat_vault_test',
      user: 'app_tester',
      password: 'app_tester_pw',
    });

    try {
      await expect(
        appPool.query(`UPDATE audit_log SET action='hacked' WHERE id=$1`, [id]),
      ).rejects.toThrow(/permission denied/i);
      await expect(appPool.query(`DELETE FROM audit_log WHERE id=$1`, [id])).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        appPool.query(`SELECT details FROM audit_log WHERE id=$1`, [id]),
      ).resolves.toBeDefined();
      await expect(
        appPool.query(`INSERT INTO audit_log (action, hash) VALUES ('allowed', '\\xbeef')`),
      ).resolves.toBeDefined();
    } finally {
      await appPool.end();
    }

    const after = await pool.query(`SELECT count(*)::int as c FROM audit_log`);
    expect(after.rows[0].c).toBe(2);
  });

  it('stores audit details as non-null JSONB with an empty-object default', async () => {
    const column = await pool.query<{
      readonly data_type: string;
      readonly udt_name: string;
      readonly is_nullable: string;
      readonly column_default: string | null;
    }>(`
      SELECT data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'audit_log' AND column_name = 'details'
    `);
    expect(column.rows[0]?.data_type).toBe('jsonb');
    expect(column.rows[0]?.udt_name).toBe('jsonb');
    expect(column.rows[0]?.is_nullable).toBe('NO');
    expect(column.rows[0]?.column_default).toContain("'{}'::jsonb");

    await pool.query(`INSERT INTO audit_log (action, hash) VALUES ('default-details', '\\x01')`);
    const row = await pool.query<{ readonly details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'default-details'`,
    );
    expect(row.rows[0]?.details).toEqual({});
  });

  it('keeps default-detail audit rows in a v2-continuous chain', async () => {
    const firstTs = new Date('2026-09-26T12:00:00.000Z');
    const secondTs = new Date('2026-09-26T12:00:01.000Z');
    const genesis = Buffer.alloc(32, 0);
    const firstHash = createHash('sha256')
      .update(genesis)
      .update('|')
      .update(firstTs.toISOString())
      .update('|')
      .update('')
      .update('|')
      .update('first')
      .update('|')
      .update('')
      .update(Buffer.from('{}', 'utf8'))
      .digest();
    const secondHash = createHash('sha256')
      .update(firstHash)
      .update('|')
      .update(secondTs.toISOString())
      .update('|')
      .update('')
      .update('|')
      .update('second')
      .update('|')
      .update('')
      .update(Buffer.from('{}', 'utf8'))
      .digest();

    await pool.query(
      `INSERT INTO audit_log (ts, action, prev_hash, hash) VALUES ($1, 'first', $2, $3), ($4, 'second', $3, $5)`,
      [firstTs, genesis, firstHash, secondTs, secondHash],
    );
    const rows = await pool.query<{
      readonly prev_hash: Buffer | null;
      readonly hash: Buffer;
      readonly details: Record<string, unknown>;
    }>(`SELECT prev_hash, hash, details FROM audit_log ORDER BY id ASC`);

    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.details).toEqual({});
    expect(rows.rows[1]?.details).toEqual({});
    expect(rows.rows[0]?.hash.equals(firstHash)).toBe(true);
    expect(rows.rows[1]?.prev_hash?.equals(rows.rows[0]!.hash)).toBe(true);
    expect(rows.rows[1]?.hash.equals(secondHash)).toBe(true);
  });

  it('backfills legacy audit rows to empty details and recomputes a v2 chain', async () => {
    const migrationSql = await readFile(
      join(__dirname, '..', 'drizzle', '0008_audit_details.sql'),
      'utf8',
    );
    await pool.query('CREATE SCHEMA audit_details_backfill_test');
    await pool.query('SET search_path TO audit_details_backfill_test, public');
    try {
      await pool.query(`
        CREATE TABLE audit_log (
          id serial PRIMARY KEY,
          ts timestamp with time zone NOT NULL,
          actor_id uuid,
          action text NOT NULL,
          target text,
          prev_hash bytea,
          hash bytea NOT NULL
        )
      `);
      const firstTs = new Date('2026-09-26T12:00:00.123Z');
      const secondTs = new Date('2026-09-26T12:00:01.456Z');
      await pool.query(
        `INSERT INTO audit_log (ts, action, target, hash) VALUES
          ($1, 'legacy.first', 'one', '\\x01'), ($2, 'legacy.second', 'two', '\\x02')`,
        [firstTs, secondTs],
      );

      await pool.query(migrationSql);

      const rows = await pool.query<{
        readonly ts: Date;
        readonly action: string;
        readonly target: string | null;
        readonly prev_hash: Buffer;
        readonly hash: Buffer;
        readonly details: Record<string, unknown>;
      }>('SELECT ts, action, target, prev_hash, hash, details FROM audit_log ORDER BY id ASC');
      const genesis = Buffer.alloc(32, 0);
      const firstHash = createHash('sha256')
        .update(genesis)
        .update('|')
        .update(firstTs.toISOString())
        .update('|')
        .update('')
        .update('|')
        .update('legacy.first')
        .update('|')
        .update('one')
        .update(Buffer.from('{}', 'utf8'))
        .digest();
      const secondHash = createHash('sha256')
        .update(firstHash)
        .update('|')
        .update(secondTs.toISOString())
        .update('|')
        .update('')
        .update('|')
        .update('legacy.second')
        .update('|')
        .update('two')
        .update(Buffer.from('{}', 'utf8'))
        .digest();

      expect(rows.rows.map(row => row.details)).toEqual([{}, {}]);
      expect(rows.rows[0]?.prev_hash.equals(genesis)).toBe(true);
      expect(rows.rows[0]?.hash.equals(firstHash)).toBe(true);
      expect(rows.rows[1]?.prev_hash.equals(firstHash)).toBe(true);
      expect(rows.rows[1]?.hash.equals(secondHash)).toBe(true);
    } finally {
      await pool.query('RESET search_path');
      await pool.query('DROP SCHEMA audit_details_backfill_test CASCADE');
    }
  });

  it('stores timestamptz in UTC via clock_timestamp()', async () => {
    // Check column types are timestamptz
    const cols = await pool.query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_name='users' AND column_name='created_at'
    `);
    expect(cols.rows[0].data_type).toBe('timestamp with time zone');

    const before = Date.now();
    const inserted = await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ('tz@example.com','phc','user') RETURNING created_at`,
    );
    const after = Date.now();
    const createdAt: Date = inserted.rows[0].created_at as Date;
    expect(createdAt).toBeInstanceOf(Date);
    const ts = createdAt.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 2000);
    expect(ts).toBeLessThanOrEqual(after + 2000);
    // ISO string must be UTC (ends with Z when serialized)
    expect(createdAt.toISOString()).toMatch(/Z$/);

    // DB clock_timestamp() should be close to JS now in UTC
    const dbNow = await pool.query(`SELECT clock_timestamp() as now`);
    const dbTime: Date = dbNow.rows[0].now as Date;
    expect(Math.abs(dbTime.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('scheduler_heartbeat singleton check enforces id=1', async () => {
    await pool.query(`INSERT INTO scheduler_heartbeat (id, tick_owner) VALUES (1,'owner-a')`);
    await expect(
      pool.query(`INSERT INTO scheduler_heartbeat (id, tick_owner) VALUES (2,'owner-b')`),
    ).rejects.toThrow(/check|violates/i);
  });

  it('sealed_payloads enforces UNIQUE switch_id', async () => {
    const userId = (await pool
      .query(
        `INSERT INTO users (email, password_hash) VALUES ('sp@example.com','phc') RETURNING id`,
      )
      .then(r => r.rows[0].id)) as string;
    const switchId = (await pool
      .query(
        `INSERT INTO switches (owner_id, mode, heartbeat_interval, grace_window) VALUES ($1,'asymmetric_key','14 days','3 days') RETURNING id`,
        [userId],
      )
      .then(r => r.rows[0].id)) as string;

    await pool.query(
      `INSERT INTO sealed_payloads (switch_id, kid, kek_version, wrapped_dek_nonce, wrapped_dek_ct, payload_nonce, payload_ct, payload_tag, aad) VALUES ($1,'kid1',1,'\\x01','\\x02','\\x03','\\x04','\\x05','{}')`,
      [switchId],
    );
    await expect(
      pool.query(
        `INSERT INTO sealed_payloads (switch_id, kid, kek_version, wrapped_dek_nonce, wrapped_dek_ct, payload_nonce, payload_ct, payload_tag, aad) VALUES ($1,'kid2',1,'\\x01','\\x02','\\x03','\\x04','\\x05','{}')`,
        [switchId],
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('delivery_jobs and trigger_jobs idempotency_key unique', async () => {
    const userId = (await pool
      .query(
        `INSERT INTO users (email, password_hash) VALUES ('idem@example.com','phc') RETURNING id`,
      )
      .then(r => r.rows[0].id)) as string;
    const switchId = (await pool
      .query(
        `INSERT INTO switches (owner_id, mode, heartbeat_interval, grace_window) VALUES ($1,'direct_delivery','14 days','3 days') RETURNING id`,
        [userId],
      )
      .then(r => r.rows[0].id)) as string;

    await pool.query(
      `INSERT INTO trigger_jobs (switch_id, deadline_at, idempotency_key) VALUES ($1,'2026-11-01T00:00:00Z','idem-key-1')`,
      [switchId],
    );
    await expect(
      pool.query(
        `INSERT INTO trigger_jobs (switch_id, deadline_at, idempotency_key) VALUES ($1,'2026-11-02T00:00:00Z','idem-key-1')`,
        [switchId],
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('enforces switch titles as unique for each owner while allowing another owner to reuse them', async () => {
    const firstOwner = await pool
      .query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ('title-one@example.com','phc') RETURNING id`,
      )
      .then(result => result.rows[0]!.id);
    const secondOwner = await pool
      .query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ('title-two@example.com','phc') RETURNING id`,
      )
      .then(result => result.rows[0]!.id);

    await pool.query(
      `INSERT INTO switches (owner_id, title, mode, heartbeat_interval, grace_window)
       VALUES ($1, 'Recovery plan', 'direct_delivery', '24 hours', '2 hours')`,
      [firstOwner],
    );
    await expect(
      pool.query(
        `INSERT INTO switches (owner_id, title, mode, heartbeat_interval, grace_window)
         VALUES ($1, 'Recovery plan', 'direct_delivery', '24 hours', '2 hours')`,
        [firstOwner],
      ),
    ).rejects.toThrow(/duplicate|unique/i);
    await expect(
      pool.query(
        `INSERT INTO switches (owner_id, title, mode, heartbeat_interval, grace_window)
         VALUES ($1, 'Recovery plan', 'direct_delivery', '24 hours', '2 hours')`,
        [secondOwner],
      ),
    ).resolves.toBeDefined();
  });

  it('backfills duplicate switch titles deterministically without losing rows', async () => {
    const migrationSql = await readFile(
      join(__dirname, '..', 'drizzle', '0007_switch_title_uniqueness.sql'),
      'utf8',
    );
    await pool.query(`CREATE SCHEMA switch_title_backfill_test`);
    await pool.query(`SET search_path TO switch_title_backfill_test, public`);
    try {
      await pool.query(`
        CREATE TABLE switches (
          id uuid PRIMARY KEY,
          owner_id uuid NOT NULL,
          title text NOT NULL,
          created_at timestamp with time zone NOT NULL
        )
      `);
      const ownerId = '00000000-0000-0000-0000-000000000001';
      await pool.query(
        `INSERT INTO switches (id, owner_id, title, created_at) VALUES
          ('00000000-0000-0000-0000-000000000011', $1, 'Legacy plan', '2026-01-01T00:00:00Z'),
          ('00000000-0000-0000-0000-000000000012', $1, 'Legacy plan', '2026-01-02T00:00:00Z'),
          ('00000000-0000-0000-0000-000000000013', $1, 'Legacy plan', '2026-01-03T00:00:00Z')`,
        [ownerId],
      );

      await pool.query(migrationSql);

      const rows = await pool.query<{ title: string }>(
        `SELECT title FROM switches WHERE owner_id=$1 ORDER BY created_at`,
        [ownerId],
      );
      expect(rows.rows.map(row => row.title)).toEqual([
        'Legacy plan (duplicate 1)',
        'Legacy plan (duplicate 2)',
        'Legacy plan',
      ]);
      expect(rows.rows).toHaveLength(3);
    } finally {
      await pool.query(`RESET search_path`);
      await pool.query(`DROP SCHEMA switch_title_backfill_test CASCADE`);
    }
  });
});
