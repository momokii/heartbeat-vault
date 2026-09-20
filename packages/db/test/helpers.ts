import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as schema from '../src/schema.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TestDb {
  readonly container: StartedPostgreSqlContainer;
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;
  readonly connectionString: string;
}

const POSTGRES_IMAGE = 'postgres:17-alpine';

export async function createTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('heartbeat_vault_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionString = container.getConnectionUri();
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  await applyMigrations(pool);

  return { container, pool, db, connectionString };
}

async function applyMigrations(pool: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', 'drizzle');
  try {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { drizzle: drizzlePg } = await import('drizzle-orm/node-postgres');
    const db = drizzlePg(pool);
    await migrate(db, { migrationsFolder });
  } catch {
    const files = readdirSync(migrationsFolder)
      .filter(f => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const full = join(migrationsFolder, file);
      const content = readFileSync(full, 'utf-8');
      if (content.trim().length === 0) continue;
      await pool.query(content);
    }
  }
}

export async function truncateAll(pool: Pool): Promise<void> {
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
}

export function getDb(pool: Pool): NodePgDatabase<typeof schema> {
  return drizzle(pool, { schema });
}

export async function destroyTestDb(testDb: TestDb): Promise<void> {
  await testDb.pool.end();
  await testDb.container.stop();
}
