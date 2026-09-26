import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_GENESIS, computeAuditHash, writeAudit } from './audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXED_TS = new Date('2026-09-26T12:34:56.789Z');

let container: StartedPostgreSqlContainer;
let pool: Pool;

async function applyMigrations(client: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', '..', '..', '..', 'packages', 'db', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(drizzle(client), { migrationsFolder });
}

function expectedV2Hash(details: string): Buffer {
  return createHash('sha256')
    .update(AUDIT_GENESIS)
    .update('|')
    .update(FIXED_TS.toISOString())
    .update('|')
    .update('')
    .update('|')
    .update('audit.test')
    .update('|')
    .update('target')
    .update(Buffer.from(details, 'utf8'))
    .digest();
}

async function writeInTransaction(client: PoolClient, action: string): Promise<void> {
  await client.query('BEGIN');
  await writeAudit(client, { action });
  await client.query('COMMIT');
}

describe('audit chain v2', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await applyMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE audit_log');
  });

  it('uses JCS key ordering for nested objects and preserves array order', () => {
    const first = { b: [2, { a: false }], a: { z: 1, y: null } };
    const second = { a: { y: null, z: 1 }, b: [2, { a: false }] };

    const firstHash = computeAuditHash(
      AUDIT_GENESIS,
      FIXED_TS,
      null,
      'audit.test',
      'target',
      first,
    );
    const secondHash = computeAuditHash(
      AUDIT_GENESIS,
      FIXED_TS,
      null,
      'audit.test',
      'target',
      second,
    );

    expect(firstHash.equals(secondHash)).toBe(true);
    expect(firstHash.equals(expectedV2Hash('{"a":{"y":null,"z":1},"b":[2,{"a":false}]}'))).toBe(
      true,
    );
  });

  it('rejects undefined details because JCS cannot represent it', () => {
    expect(() =>
      computeAuditHash(AUDIT_GENESIS, FIXED_TS, null, 'audit.test', 'target', {
        omitted: undefined,
      }),
    ).toThrow();
  });

  it('preserves null rather than treating it as an omitted detail', () => {
    const nullHash = computeAuditHash(AUDIT_GENESIS, FIXED_TS, null, 'audit.test', 'target', {
      value: null,
    });
    const emptyHash = computeAuditHash(AUDIT_GENESIS, FIXED_TS, null, 'audit.test', 'target', {});

    expect(nullHash.equals(emptyHash)).toBe(false);
    expect(nullHash.equals(expectedV2Hash('{"value":null}'))).toBe(true);
  });

  it('normalizes omitted details to an empty object', () => {
    const omittedHash = computeAuditHash(AUDIT_GENESIS, FIXED_TS, null, 'audit.test', 'target');

    expect(omittedHash.equals(expectedV2Hash('{}'))).toBe(true);
  });

  it('invalidates a persisted entry when its details are tampered', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await writeAudit(client, {
        action: 'audit.test',
        target: 'target',
        details: { state: 'original' },
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const row = await pool.query<{
      readonly ts: Date;
      readonly actor_id: string | null;
      readonly action: string;
      readonly target: string | null;
      readonly prev_hash: Buffer | null;
      readonly hash: Buffer;
      readonly details: Record<string, unknown>;
    }>('SELECT ts, actor_id, action, target, prev_hash, hash, details FROM audit_log');
    const audit = row.rows[0]!;
    const original = computeAuditHash(
      audit.prev_hash ?? AUDIT_GENESIS,
      audit.ts,
      audit.actor_id,
      audit.action,
      audit.target,
      audit.details,
    );
    expect(original.equals(audit.hash)).toBe(true);

    await pool.query(`UPDATE audit_log SET details = '{"state":"tampered"}'::jsonb`);
    const tampered = await pool.query<typeof audit>(
      'SELECT ts, actor_id, action, target, prev_hash, hash, details FROM audit_log',
    );
    const changed = tampered.rows[0]!;
    const recomputed = computeAuditHash(
      changed.prev_hash ?? AUDIT_GENESIS,
      changed.ts,
      changed.actor_id,
      changed.action,
      changed.target,
      changed.details,
    );
    expect(recomputed.equals(changed.hash)).toBe(false);
  });

  it('serializes parallel writers into one linear chain', async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await Promise.all([
        writeInTransaction(first, 'parallel.first'),
        writeInTransaction(second, 'parallel.second'),
      ]);

      const rows = await pool.query<{ readonly prev_hash: Buffer | null; readonly hash: Buffer }>(
        'SELECT prev_hash, hash FROM audit_log ORDER BY id ASC',
      );
      expect(rows.rows).toHaveLength(2);
      expect((rows.rows[0]!.prev_hash ?? AUDIT_GENESIS).equals(AUDIT_GENESIS)).toBe(true);
      expect(rows.rows[1]!.prev_hash?.equals(rows.rows[0]!.hash)).toBe(true);
    } finally {
      first.release();
      second.release();
    }
  });
});
