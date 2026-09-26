import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildServer } from './server.js';
import { generateSetupToken, hashSetupToken } from './lib/setup-token.js';
import type { FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

async function applyMigrations(p: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', '..', '..', 'packages', 'db', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const drizzleDb = drizzle(p);
  await migrate(drizzleDb, { migrationsFolder });
}

async function truncateAll(p: Pool): Promise<void> {
  await p.query(`
    TRUNCATE audit_log, delivery_jobs, vault_waits, trigger_jobs, heartbeats,
      sealed_payloads, recipients, switches, sessions, invites, dead_letter_jobs,
      scheduler_heartbeat, app_config, users CASCADE`);
}

async function seedSetupToken(
  p: Pool,
  token: string,
  opts: { expiresAt?: Date; completed?: boolean } = {},
): Promise<void> {
  const hash = hashSetupToken(token);
  const completed = opts.completed ? 'true' : 'false';
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);
  await p.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('setup_completed',$1, clock_timestamp()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=clock_timestamp()`,
    [completed],
  );
  await p.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('setup_token_hash',$1, clock_timestamp()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=clock_timestamp()`,
    [hash],
  );
  await p.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('setup_token_expires_at',$1, clock_timestamp()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=clock_timestamp()`,
    [expiresAt.toISOString()],
  );
}

describe('setup bootstrap (T3.1)', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('heartbeat_vault_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    const cs = container.getConnectionUri();
    pool = new Pool({ connectionString: cs });
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

  it('health endpoint returns 200 with security headers and JSON body limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe('ok');
    // helmet headers
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('happy path creates admin and second call is 410 Gone', async () => {
    const token = generateSetupToken();
    await seedSetupToken(pool, token);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: 'admin@example.com', password: 'supersecure123', name: 'Admin' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string; email: string; role: string };
    expect(body.email).toBe('admin@example.com');
    expect(body.role).toBe('admin');

    const userRes = await pool.query(
      `SELECT email, role FROM users WHERE email='admin@example.com'`,
    );
    expect(userRes.rowCount).toBe(1);
    expect(userRes.rows[0].role).toBe('admin');

    const auditRes = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action='setup_completed'`,
    );
    expect(auditRes.rowCount).toBe(1);
    expect(auditRes.rows[0]!.details).toEqual({ role: 'admin' });
    expect(JSON.stringify(auditRes.rows[0]!.details)).not.toContain('supersecure123');

    const configRes = await pool.query(
      `SELECT key, value FROM app_config WHERE key='setup_completed'`,
    );
    expect(configRes.rows[0].value).toBe('true');

    const hashRes = await pool.query(`SELECT value FROM app_config WHERE key='setup_token_hash'`);
    expect(hashRes.rows[0].value).toBe('');

    // second call -> 410
    const token2 = generateSetupToken();
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        token: token2,
        email: 'second@example.com',
        password: 'supersecure123',
        name: 'Second',
      },
    });
    expect(res2.statusCode).toBe(410);
    const body2 = JSON.parse(res2.body) as { error: string };
    expect(body2.error).toBe('gone');
  });

  it('wrong token returns 400 generic without enumeration', async () => {
    const token = generateSetupToken();
    await seedSetupToken(pool, token);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'wrong-token-value', email: 'x@example.com', password: 'supersecure123' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('invalid_request');
    const userRes = await pool.query(`SELECT count(*)::int as c FROM users`);
    expect(userRes.rows[0].c).toBe(0);
  });

  it('expired token returns 410 or 400 and does not create user', async () => {
    const token = generateSetupToken();
    await seedSetupToken(pool, token, { expiresAt: new Date(Date.now() - 1000) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: 'expired@example.com', password: 'supersecure123' },
    });
    expect([400, 410]).toContain(res.statusCode);
    const userRes = await pool.query(`SELECT count(*)::int as c FROM users`);
    expect(userRes.rows[0].c).toBe(0);
  });

  it('weak password returns 400 generic', async () => {
    const token = generateSetupToken();
    await seedSetupToken(pool, token);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: 'weak@example.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('invalid email returns 400 generic', async () => {
    const token = generateSetupToken();
    await seedSetupToken(pool, token);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: 'not-an-email', password: 'supersecure123' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DB holds hash only, not plaintext token', async () => {
    const token = generateSetupToken();
    await seedSetupToken(pool, token);
    const cfg = await pool.query(`SELECT value FROM app_config WHERE key='setup_token_hash'`);
    const storedHash: string = cfg.rows[0].value as string;
    expect(storedHash).not.toBe(token);
    expect(storedHash).not.toContain(token.slice(0, 8));
    const expectedHash = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(storedHash).toBe(expectedHash);
    expect(storedHash).toHaveLength(64);
  });

  it('setup endpoint is permanently 410 after completion (unreachable shape)', async () => {
    const token = generateSetupToken();
    await seedSetupToken(pool, token);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: 'once@example.com', password: 'supersecure123' },
    });
    expect(ok.statusCode).toBe(201);
    for (const payload of [
      { token, email: 'again@example.com', password: 'supersecure123' },
      { token: generateSetupToken(), email: 'again2@example.com', password: 'supersecure123' },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/api/setup', payload });
      expect(r.statusCode).toBe(410);
      const b = JSON.parse(r.body) as { error: string };
      expect(b.error).toBe('gone');
    }
    // ensure no second admin created
    const cnt = await pool.query(`SELECT count(*)::int as c FROM users`);
    expect(cnt.rows[0].c).toBe(1);
  });

  it('generateSetupToken produces 32B base64url and hash is SHA-256 hex', () => {
    const t = generateSetupToken();
    // base64url 32B => 43 chars (no padding)
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(t).not.toContain('+');
    expect(t).not.toContain('/');
    const h = hashSetupToken(t);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
