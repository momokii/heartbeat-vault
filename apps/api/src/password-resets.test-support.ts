import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { resetRateLimitForTests } from './lib/rate-limit.js';
import { buildServer } from './server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';
const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const resetStateSettings = {
  active: { expiresOffsetMs: RESET_TTL_MS, isConsumed: false },
  expired: { expiresOffsetMs: -1000, isConsumed: false },
  consumed: { expiresOffsetMs: RESET_TTL_MS, isConsumed: true },
} as const;

type ResetState = keyof typeof resetStateSettings;

export function firstRow<T>(rows: readonly T[]): T {
  const row = rows.at(0);
  if (row === undefined) {
    throw new Error('Expected a database row');
  }
  return row;
}

function extractSessionCookie(raw: string | string[] | undefined): string {
  const header = Array.isArray(raw) ? raw.join('; ') : raw;
  const token = header?.match(/__Host-session=([^;]+)/)?.[1];
  if (token === undefined) {
    throw new Error('Expected session cookie');
  }
  return token;
}

async function applyMigrations(databasePool: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', '..', '..', 'packages', 'db', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(drizzle(databasePool), { migrationsFolder });
}

export async function createPasswordResetTestHarness() {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('heartbeat_vault_password_resets_api_test')
    .withUsername('test')
    .withPassword('test')
    .start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await applyMigrations(pool);
  const app = await buildServer(pool);
  await app.ready();

  async function reset(): Promise<void> {
    await pool.query(`
      TRUNCATE audit_log, delivery_jobs, vault_waits, trigger_jobs, heartbeats,
        sealed_payloads, recipients, switches, sessions, password_resets, invites,
        dead_letter_jobs, scheduler_heartbeat, app_config, users CASCADE`);
    resetRateLimitForTests();
  }

  async function close(): Promise<void> {
    await app.close();
    await pool.end();
    await container.stop();
  }

  async function createUser(email: string, password: string, role = 'user'): Promise<string> {
    const { hashPassword } = await import('@heartbeat-vault/crypto');
    const passwordHash = await hashPassword(password);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id`,
      [email, passwordHash, role],
    );
    return firstRow(result.rows).id;
  }

  async function loginAs(email: string, password: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password },
    });
    if (response.statusCode !== 200) {
      throw new Error('Expected test user login to succeed');
    }
    return extractSessionCookie(response.headers['set-cookie']);
  }

  async function createPasswordReset(
    userId: string,
    token: string,
    state: ResetState = 'active',
  ): Promise<string> {
    const settings = resetStateSettings[state];
    const result = await pool.query<{ id: string }>(
      `INSERT INTO password_resets (user_id, token_hash, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        userId,
        createHash('sha256').update(token, 'utf8').digest('hex'),
        new Date(Date.now() + settings.expiresOffsetMs),
        settings.isConsumed ? new Date() : null,
      ],
    );
    return firstRow(result.rows).id;
  }

  async function passwordHashFor(userId: string): Promise<string> {
    const result = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    );
    return firstRow(result.rows).password_hash;
  }

  async function issueReset(userId: string, cookie?: string) {
    if (cookie === undefined) {
      return app.inject({ method: 'POST', url: `/api/users/${userId}/password-reset` });
    }
    return app.inject({
      method: 'POST',
      url: `/api/users/${userId}/password-reset`,
      headers: { cookie: `__Host-session=${cookie}` },
    });
  }

  async function consumeReset(token: string, newPassword: string, remoteAddress?: string) {
    if (remoteAddress === undefined) {
      return app.inject({
        method: 'POST',
        url: '/api/account/password/reset',
        payload: { token, newPassword },
      });
    }
    return app.inject({
      method: 'POST',
      url: '/api/account/password/reset',
      remoteAddress,
      payload: { token, newPassword },
    });
  }

  return {
    app,
    pool,
    reset,
    close,
    createUser,
    loginAs,
    createPasswordReset,
    passwordHashFor,
    issueReset,
    consumeReset,
  };
}
