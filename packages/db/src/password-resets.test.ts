import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type QueryResult } from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';

let container: StartedPostgreSqlContainer;
let pool: Pool;

function firstId(result: QueryResult<{ id: string }>): string {
  const row = result.rows.at(0);
  if (row === undefined) {
    throw new Error('expected inserted row');
  }
  return row.id;
}

async function applyMigrations(databasePool: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(drizzle(databasePool), { migrationsFolder });
}

describe('password reset migrations', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('heartbeat_vault_password_resets_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await applyMigrations(pool);
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE password_resets, users CASCADE');
  });

  it('creates the password_resets table', async () => {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'password_resets'
    `);

    expect(result.rows).toHaveLength(1);
  });

  it('enforces unique token hashes', async () => {
    const userId = firstId(
      await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ('reset@example.com', 'phc') RETURNING id`,
      ),
    );

    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, 'hashed-token', clock_timestamp() + interval '1 hour')`,
      [userId],
    );

    await expect(
      pool.query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, 'hashed-token', clock_timestamp() + interval '1 hour')`,
        [userId],
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('removes password resets when their user is deleted', async () => {
    const userId = firstId(
      await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ('cascade@example.com', 'phc') RETURNING id`,
      ),
    );

    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, 'cascade-token', clock_timestamp() + interval '1 hour')`,
      [userId],
    );
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    const result = await pool.query('SELECT count(*)::int AS count FROM password_resets');
    expect(result.rows.at(0)?.count).toBe(0);
  });

  it('grants app role CRUD access to password resets', async () => {
    const userId = firstId(
      await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ('app-role@example.com', 'phc') RETURNING id`,
      ),
    );

    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tester') THEN
        CREATE USER app_tester WITH PASSWORD 'app_tester_pw' IN ROLE app;
      END IF;
    END $$;`);

    const appPool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: 'heartbeat_vault_password_resets_test',
      user: 'app_tester',
      password: 'app_tester_pw',
    });

    try {
      const resetId = firstId(
        await appPool.query<{ id: string }>(
          `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, 'app-role-token', clock_timestamp() + interval '1 hour') RETURNING id`,
          [userId],
        ),
      );

      const selected = await appPool.query<{ id: string }>(
        'SELECT id FROM password_resets WHERE id = $1',
        [resetId],
      );
      expect(selected.rows).toEqual([{ id: resetId }]);

      const updated = await appPool.query<{ consumed_at: Date }>(
        'UPDATE password_resets SET consumed_at = clock_timestamp() WHERE id = $1 RETURNING consumed_at',
        [resetId],
      );
      expect(updated.rows.at(0)?.consumed_at).toBeInstanceOf(Date);

      const deleted = await appPool.query<{ id: string }>(
        'DELETE FROM password_resets WHERE id = $1 RETURNING id',
        [resetId],
      );
      expect(deleted.rows).toEqual([{ id: resetId }]);
    } finally {
      await appPool.end();
    }
  });
});
