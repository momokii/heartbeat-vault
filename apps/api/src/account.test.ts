import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

async function applyMigrations(databasePool: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', '..', '..', 'packages', 'db', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(drizzle(databasePool), { migrationsFolder });
}

async function truncateAll(databasePool: Pool): Promise<void> {
  await databasePool.query(`
    TRUNCATE audit_log, delivery_jobs, vault_waits, trigger_jobs, heartbeats,
      sealed_payloads, recipients, switches, sessions, invites, dead_letter_jobs,
      scheduler_heartbeat, app_config, users CASCADE`);
}

async function createUser(email: string, password: string): Promise<string> {
  const { hashPassword } = await import('@heartbeat-vault/crypto');
  const passwordHash = await hashPassword(password);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'user') RETURNING id`,
    [email, passwordHash],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('Expected inserted user id');
  return id;
}

function extractSessionCookie(raw: string | string[] | undefined): string {
  const header = Array.isArray(raw) ? raw.join('; ') : raw;
  const match = header?.match(/__Host-session=([^;]+)/);
  if (match?.[1] === undefined) throw new Error('Expected session cookie');
  return match[1];
}

async function login(email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return extractSessionCookie(response.headers['set-cookie']);
}

describe('account password T3.5', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('heartbeat_vault_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await applyMigrations(pool);
    app = await buildServer(pool);
    await app.ready();
  }, 180000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('requires an authenticated session to change a password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/account/password',
      payload: { currentPassword: 'current-password', newPassword: 'new-password-123' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a short replacement password at the request boundary', async () => {
    const email = 'boundary@example.com';
    const currentPassword = 'current-password-123';
    await createUser(email, currentPassword);
    const cookie = await login(email, currentPassword);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: `__Host-session=${cookie}` },
      payload: { currentPassword, newPassword: 'too-short' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an incorrect current password without changing the stored password', async () => {
    const email = 'verify@example.com';
    const currentPassword = 'current-password-123';
    const newPassword = 'replacement-password-123';
    const userId = await createUser(email, currentPassword);
    const cookie = await login(email, currentPassword);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: `__Host-session=${cookie}` },
      payload: { currentPassword: 'incorrect-password-123', newPassword },
    });

    expect(response.statusCode).toBe(401);
    const result = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId],
    );
    const passwordHash = result.rows[0]?.password_hash;
    if (passwordHash === undefined) throw new Error('Expected stored password hash');
    const { verifyPassword } = await import('@heartbeat-vault/crypto');
    await expect(verifyPassword(passwordHash, currentPassword)).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, newPassword)).resolves.toBe(false);
  });

  it('updates the password after verifying the current password and writes an audit event', async () => {
    const email = 'change@example.com';
    const currentPassword = 'current-password-123';
    const newPassword = 'replacement-password-123';
    const userId = await createUser(email, currentPassword);
    const cookie = await login(email, currentPassword);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: `__Host-session=${cookie}` },
      payload: { currentPassword, newPassword },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    const result = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId],
    );
    const passwordHash = result.rows[0]?.password_hash;
    if (passwordHash === undefined) throw new Error('Expected stored password hash');
    const { verifyPassword } = await import('@heartbeat-vault/crypto');
    await expect(verifyPassword(passwordHash, currentPassword)).resolves.toBe(false);
    await expect(verifyPassword(passwordHash, newPassword)).resolves.toBe(true);
    const audit = await pool.query<{ action: string; target: string }>(
      `SELECT action, target FROM audit_log WHERE actor_id = $1 ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    expect(audit.rows[0]).toEqual({ action: 'account_password_changed', target: userId });
  });
});
