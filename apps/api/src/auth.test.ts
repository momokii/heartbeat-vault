import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildServer } from './server.js';
import { resetRateLimitForTests } from './lib/rate-limit.js';
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

async function createUser(email: string, password: string, role = 'user'): Promise<string> {
  const { hashPassword } = await import('@heartbeat-vault/crypto');
  const phc = await hashPassword(password);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id`,
    [email, phc, role],
  );
  return res.rows[0]!.id as string;
}

function extractSessionCookie(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers['set-cookie'] as string | string[] | undefined;
  if (!raw) return null;
  const str = Array.isArray(raw) ? raw.join('; ') : raw;
  const m = str.match(/__Host-session=([^;]+)/);
  return m ? (m[1] as string) : null;
}

describe('auth core T3.2', () => {
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
    resetRateLimitForTests();
  });

  it('login happy creates session, sets __Host-session cookie, /me returns user', async () => {
    const email = 'alice@example.com';
    const pw = 'supersecure123';
    const userId = await createUser(email, pw);
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password: pw },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { id: string; email: string; role: string };
    expect(body.id).toBe(userId);
    expect(body.email).toBe(email);
    const cookie = extractSessionCookie(res);
    expect(cookie).not.toBeNull();
    const setCookieHeader = res.headers['set-cookie'] as string;
    const s = Array.isArray(setCookieHeader)
      ? setCookieHeader.join(';')
      : (setCookieHeader as string);
    expect(s).toContain('__Host-session=');
    expect(s).toContain('HttpOnly');
    expect(s).toContain('SameSite=Strict');
    expect(s).toContain('Path=/');
    const hash = createHash('sha256')
      .update(cookie as string, 'utf8')
      .digest('hex');
    const sess = await pool.query(
      `SELECT token_hash, expires_at, revoked_at FROM sessions WHERE token_hash=$1`,
      [hash],
    );
    expect(sess.rowCount).toBe(1);
    expect(sess.rows[0].revoked_at).toBeNull();
    const exp = new Date(sess.rows[0].expires_at as string);
    expect(exp.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${cookie}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = JSON.parse(me.body) as { id: string; email: string; role: string };
    expect(meBody.id).toBe(userId);
    expect(meBody.email).toBe(email);
  });

  it('bad password and unknown email both return generic 401 same shape', async () => {
    const email = 'bob@example.com';
    const pw = 'supersecure123';
    await createUser(email, pw);
    const badPw = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password: 'wrongpassword1' },
    });
    expect(badPw.statusCode).toBe(401);
    const b1 = JSON.parse(badPw.body) as { error: string };
    expect(b1.error).toBe('invalid_credentials');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'nouser@example.com', password: 'wrongpassword1' },
    });
    expect(unknown.statusCode).toBe(401);
    const b2 = JSON.parse(unknown.body) as { error: string };
    expect(b2.error).toBe('invalid_credentials');
    expect(Object.keys(b1).sort()).toEqual(Object.keys(b2).sort());
  });

  it('/me 401 without cookie and 200 with cookie', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/api/me' });
    expect(r1.statusCode).toBe(401);
    const email = 'carol@example.com';
    const pw = 'supersecure123';
    await createUser(email, pw);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password: pw },
    });
    const cookie = extractSessionCookie(login)!;
    const r2 = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${cookie}` },
    });
    expect(r2.statusCode).toBe(200);
  });

  it('logout revokes current session, /me then 401', async () => {
    const email = 'dave@example.com';
    const pw = 'supersecure123';
    await createUser(email, pw);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password: pw },
    });
    const cookie = extractSessionCookie(login)!;
    const out = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie: `__Host-session=${cookie}` },
    });
    expect(out.statusCode).toBe(200);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${cookie}` },
    });
    expect(me.statusCode).toBe(401);
    const hash = createHash('sha256').update(cookie, 'utf8').digest('hex');
    const sess = await pool.query(`SELECT revoked_at FROM sessions WHERE token_hash=$1`, [hash]);
    expect(sess.rows[0].revoked_at).not.toBeNull();
  });

  it('revoke-all kills all sessions for user', async () => {
    const email = 'eve@example.com';
    const pw = 'supersecure123';
    const userId = await createUser(email, pw);
    resetRateLimitForTests();
    const l1 = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password: pw },
    });
    const c1 = extractSessionCookie(l1)!;
    resetRateLimitForTests();
    const l2 = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password: pw },
    });
    const c2 = extractSessionCookie(l2)!;
    expect(c1).not.toBe(c2);
    const me1 = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${c1}` },
    });
    expect(me1.statusCode).toBe(200);
    const me2 = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${c2}` },
    });
    expect(me2.statusCode).toBe(200);
    const revoke = await app.inject({
      method: 'POST',
      url: '/api/sessions/revoke-all',
      headers: { cookie: `__Host-session=${c1}` },
    });
    expect(revoke.statusCode).toBe(200);
    const check1 = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${c1}` },
    });
    expect(check1.statusCode).toBe(401);
    const check2 = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${c2}` },
    });
    expect(check2.statusCode).toBe(401);
    const remaining = await pool.query(
      `SELECT count(*)::int as c FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
    expect(remaining.rows[0].c).toBe(0);
  });

  it('6th rapid login 429 with Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email: `nouser${i}@example.com`, password: 'wrongpassword1' },
      });
      expect(r.statusCode).toBe(401);
    }
    const sixth = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'nouser5@example.com', password: 'wrongpassword1' },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
    const body = JSON.parse(sixth.body) as { error: string };
    expect(body.error).toBe('rate_limited');
  });

  it('lockout after 5 bad passwords returns generic 401 and audit row, correct pw while locked still 401', async () => {
    const email = 'frank@example.com';
    const pw = 'supersecure123';
    const userId = await createUser(email, pw);
    for (let i = 0; i < 5; i++) {
      resetRateLimitForTests();
      const r = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email, password: 'badpassword123' },
      });
      expect(r.statusCode).toBe(401);
    }
    const locked = await pool.query(`SELECT locked_until FROM users WHERE id=$1`, [userId]);
    expect(locked.rows[0].locked_until).not.toBeNull();
    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE action='auth_lockout' AND target=$1`,
      [userId],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    resetRateLimitForTests();
    const whileLocked = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password: pw },
    });
    expect(whileLocked.statusCode).toBe(401);
    const b = JSON.parse(whileLocked.body) as { error: string };
    expect(b.error).toBe('invalid_credentials');
  });

  it('audit chain verifies (recompute hashes)', async () => {
    const email = 'grace@example.com';
    const pw = 'supersecure123';
    await createUser(email, pw);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email, password: pw },
    });
    const cookie = extractSessionCookie(login)!;
    await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie: `__Host-session=${cookie}` },
    });
    resetRateLimitForTests();
    await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: pw } });

    const rows = await pool.query<{
      id: number;
      ts: Date;
      actor_id: string | null;
      action: string;
      target: string | null;
      prev_hash: Buffer | null;
      hash: Buffer;
    }>(`SELECT id, ts, actor_id, action, target, prev_hash, hash FROM audit_log ORDER BY id ASC`);

    expect(rows.rowCount).toBeGreaterThanOrEqual(2);
    let prev = Buffer.alloc(32, 0);
    for (const row of rows.rows) {
      const expectedPrev = row.prev_hash ? (row.prev_hash as Buffer) : Buffer.alloc(32, 0);
      expect(Buffer.compare(expectedPrev, prev)).toBe(0);
      const ts = new Date(row.ts);
      const computed = createHash('sha256')
        .update(prev)
        .update('|')
        .update(ts.toISOString())
        .update('|')
        .update(row.actor_id ?? '')
        .update('|')
        .update(row.action)
        .update('|')
        .update(row.target ?? '')
        .digest();
      expect(Buffer.compare(computed, row.hash as Buffer)).toBe(0);
      prev = row.hash as Buffer;
    }
  });
});
