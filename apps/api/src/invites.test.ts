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

async function loginAs(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  const c = extractSessionCookie(res);
  expect(c).not.toBeNull();
  return c as string;
}

describe('T3.4 roles + invites + RBAC + IDOR', () => {
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

  it('non-admin invite 403', async () => {
    const adminPw = 'adminpass123';
    const userPw = 'userpass1234';
    await createUser('admin@example.com', adminPw, 'admin');
    await createUser('user@example.com', userPw, 'user');
    resetRateLimitForTests();
    const userCookie = await loginAs('user@example.com', userPw);
    const res = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: `__Host-session=${userCookie}` },
      payload: { email: 'new@example.com', role: 'user' },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('forbidden');
  });

  it('invite → consume → login works', async () => {
    const adminPw = 'adminpass123';
    await createUser('admin@example.com', adminPw, 'admin');
    resetRateLimitForTests();
    const adminCookie = await loginAs('admin@example.com', adminPw);

    const invRes = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: `__Host-session=${adminCookie}` },
      payload: { email: 'invitee@example.com', role: 'user' },
    });
    expect(invRes.statusCode).toBe(201);
    const invBody = JSON.parse(invRes.body) as { id: string; token: string };
    expect(invBody.id).toBeDefined();
    expect(invBody.token).toBeDefined();
    expect(invBody.token.length).toBeGreaterThanOrEqual(43);
    expect(invBody.token).not.toContain('+');
    expect(invBody.token).not.toContain('/');

    // hash-only storage
    const tokenHash = createHash('sha256').update(invBody.token, 'utf8').digest('hex');
    const dbInvite = await pool.query<{ token_hash: string; role: string; email: string }>(
      `SELECT token_hash, role, email FROM invites WHERE id=$1`,
      [invBody.id],
    );
    expect(dbInvite.rowCount).toBe(1);
    expect(dbInvite.rows[0]!.token_hash).toBe(tokenHash);
    expect(dbInvite.rows[0]!.token_hash).toHaveLength(64);
    expect(dbInvite.rows[0]!.token_hash).not.toBe(invBody.token);
    expect(dbInvite.rows[0]!.role).toBe('user');

    // audit row for invite_created
    const auditCreated = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action='invite_created' AND target=$1`,
      [invBody.id],
    );
    expect(auditCreated.rowCount).toBe(1);
    expect(auditCreated.rows[0]!.details).toEqual({ role: 'user', expiresInHours: 24 });
    expect(JSON.stringify(auditCreated.rows[0]!.details)).not.toContain(invBody.token);

    // consume
    resetRateLimitForTests();
    const consumeRes = await app.inject({
      method: 'POST',
      url: '/api/invites/consume',
      payload: { token: invBody.token, email: 'invitee@example.com', password: 'newuserpass123' },
    });
    expect(consumeRes.statusCode).toBe(201);
    const consumeBody = JSON.parse(consumeRes.body) as { id: string; email: string; role: string };
    expect(consumeBody.email).toBe('invitee@example.com');
    expect(consumeBody.role).toBe('user');

    const consumed = await pool.query<{ consumed_at: string | null }>(
      `SELECT consumed_at FROM invites WHERE id=$1`,
      [invBody.id],
    );
    expect(consumed.rows[0]!.consumed_at).not.toBeNull();

    const auditConsumed = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action='invite_consumed' AND target=$1`,
      [invBody.id],
    );
    expect(auditConsumed.rowCount).toBe(1);
    expect(auditConsumed.rows[0]!.details).toEqual({ role: 'user' });

    // login with new user works
    resetRateLimitForTests();
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'invitee@example.com', password: 'newuserpass123' },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginBody = JSON.parse(loginRes.body) as { role: string };
    expect(loginBody.role).toBe('user');
    const cookie = extractSessionCookie(loginRes);
    expect(cookie).not.toBeNull();
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${cookie}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = JSON.parse(me.body) as { email: string };
    expect(meBody.email).toBe('invitee@example.com');
  });

  it('double-consume 400 (single-use atomicity)', async () => {
    const adminPw = 'adminpass123';
    await createUser('admin@example.com', adminPw, 'admin');
    resetRateLimitForTests();
    const adminCookie = await loginAs('admin@example.com', adminPw);
    const invRes = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: `__Host-session=${adminCookie}` },
      payload: { email: 'once@example.com', role: 'user' },
    });
    const { token } = JSON.parse(invRes.body) as { token: string };
    resetRateLimitForTests();
    const first = await app.inject({
      method: 'POST',
      url: '/api/invites/consume',
      payload: { token, email: 'once@example.com', password: 'oncepass1234' },
    });
    expect(first.statusCode).toBe(201);
    // second attempt same token — should be 400 even with different email/password
    resetRateLimitForTests();
    const second = await app.inject({
      method: 'POST',
      url: '/api/invites/consume',
      payload: { token, email: 'once@example.com', password: 'oncepass1234' },
    });
    expect(second.statusCode).toBe(400);
    const b = JSON.parse(second.body) as { error: string };
    expect(b.error).toBe('invalid_request');
  });

  it('expired invite 400', async () => {
    const adminPw = 'adminpass123';
    await createUser('admin@example.com', adminPw, 'admin');
    resetRateLimitForTests();
    const adminCookie = await loginAs('admin@example.com', adminPw);
    const invRes = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: `__Host-session=${adminCookie}` },
      payload: { email: 'expire@example.com', role: 'user' },
    });
    const invBody = JSON.parse(invRes.body) as { id: string; token: string };
    // force expiry
    await pool.query(`UPDATE invites SET expires_at = now() - interval '1 hour' WHERE id=$1`, [
      invBody.id,
    ]);
    resetRateLimitForTests();
    const consumeRes = await app.inject({
      method: 'POST',
      url: '/api/invites/consume',
      payload: { token: invBody.token, email: 'expire@example.com', password: 'expirepass123' },
    });
    expect(consumeRes.statusCode).toBe(400);
    const b = JSON.parse(consumeRes.body) as { error: string };
    expect(b.error).toBe('invalid_request');
    const cnt = await pool.query(
      `SELECT count(*)::int as c FROM users WHERE email='expire@example.com'`,
    );
    expect(cnt.rows[0]!.c).toBe(0);
  });

  it('cross-user /users/:id 404 (IDOR guard) and self/admin allowed', async () => {
    const pw = 'testpass1234';
    const aliceId = await createUser('alice@example.com', pw, 'user');
    const bobId = await createUser('bob@example.com', pw, 'user');
    await createUser('admin@example.com', pw, 'admin');
    resetRateLimitForTests();
    const aliceCookie = await loginAs('alice@example.com', pw);
    resetRateLimitForTests();
    const adminCookie = await loginAs('admin@example.com', pw);

    // alice tries to fetch bob → 404 (not 403) same shape as not_found
    const cross = await app.inject({
      method: 'GET',
      url: `/api/users/${bobId}`,
      headers: { cookie: `__Host-session=${aliceCookie}` },
    });
    expect(cross.statusCode).toBe(404);
    const crossBody = JSON.parse(cross.body) as { error: string };
    expect(crossBody.error).toBe('not_found');

    // alice fetch self → 200
    const selfRes = await app.inject({
      method: 'GET',
      url: `/api/users/${aliceId}`,
      headers: { cookie: `__Host-session=${aliceCookie}` },
    });
    expect(selfRes.statusCode).toBe(200);
    const selfBody = JSON.parse(selfRes.body) as { id: string; email: string };
    expect(selfBody.id).toBe(aliceId);
    expect(selfBody.email).toBe('alice@example.com');
    expect((selfBody as Record<string, unknown>).password_hash).toBeUndefined();
    expect((selfBody as Record<string, unknown>).passwordHash).toBeUndefined();

    // admin can fetch bob → 200
    const adminFetch = await app.inject({
      method: 'GET',
      url: `/api/users/${bobId}`,
      headers: { cookie: `__Host-session=${adminCookie}` },
    });
    expect(adminFetch.statusCode).toBe(200);
    const adminBody = JSON.parse(adminFetch.body) as { id: string };
    expect(adminBody.id).toBe(bobId);

    // non-existent id as alice → 404 same shape
    const fakeId = '00000000-0000-4000-a000-000000000000';
    const fake = await app.inject({
      method: 'GET',
      url: `/api/users/${fakeId}`,
      headers: { cookie: `__Host-session=${adminCookie}` },
    });
    // admin on fake should also be 404
    expect(fake.statusCode).toBe(404);
    const fakeBody = JSON.parse(fake.body) as { error: string };
    expect(fakeBody.error).toBe('not_found');
    // ensure cross and fake have same error shape
    expect(Object.keys(crossBody).sort()).toEqual(Object.keys(fakeBody).sort());
  });

  it('GET /api/users admin only, list sans hashes', async () => {
    const pw = 'testpass1234';
    await createUser('admin@example.com', pw, 'admin');
    await createUser('user@example.com', pw, 'user');
    resetRateLimitForTests();
    const userCookie = await loginAs('user@example.com', pw);
    const forbid = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: `__Host-session=${userCookie}` },
    });
    expect(forbid.statusCode).toBe(403);
    resetRateLimitForTests();
    const adminCookie = await loginAs('admin@example.com', pw);
    const ok = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: `__Host-session=${adminCookie}` },
    });
    expect(ok.statusCode).toBe(200);
    const list = JSON.parse(ok.body) as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(2);
    for (const u of list) {
      expect(u.password_hash).toBeUndefined();
      expect(u.passwordHash).toBeUndefined();
      expect(u.id).toBeDefined();
      expect(u.email).toBeDefined();
      expect(u.role).toBeDefined();
    }
  });

  it('POST /api/users/:id/revoke-sessions self-or-admin', async () => {
    const pw = 'testpass1234';
    const aliceId = await createUser('alice2@example.com', pw, 'user');
    const bobId = await createUser('bob2@example.com', pw, 'user');
    await createUser('admin2@example.com', pw, 'admin');
    resetRateLimitForTests();
    const aliceCookie1 = await loginAs('alice2@example.com', pw);
    resetRateLimitForTests();
    const aliceCookie2 = await loginAs('alice2@example.com', pw);
    // ensure both valid
    const me1 = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${aliceCookie1}` },
    });
    expect(me1.statusCode).toBe(200);
    const me2 = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${aliceCookie2}` },
    });
    expect(me2.statusCode).toBe(200);

    // bob tries to revoke alice → 404
    resetRateLimitForTests();
    const bobCookie = await loginAs('bob2@example.com', pw);
    const crossRevoke = await app.inject({
      method: 'POST',
      url: `/api/users/${aliceId}/revoke-sessions`,
      headers: { cookie: `__Host-session=${bobCookie}` },
    });
    expect(crossRevoke.statusCode).toBe(404);

    // alice revokes own → 200 and both sessions revoked
    const selfRevoke = await app.inject({
      method: 'POST',
      url: `/api/users/${aliceId}/revoke-sessions`,
      headers: { cookie: `__Host-session=${aliceCookie1}` },
    });
    expect(selfRevoke.statusCode).toBe(200);
    const check1 = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${aliceCookie1}` },
    });
    expect(check1.statusCode).toBe(401);
    const check2 = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${aliceCookie2}` },
    });
    expect(check2.statusCode).toBe(401);

    // admin can revoke bob
    resetRateLimitForTests();
    const adminCookie = await loginAs('admin2@example.com', pw);
    // create fresh session for bob
    resetRateLimitForTests();
    const bobCookie2 = await loginAs('bob2@example.com', pw);
    const admRevokeBob = await app.inject({
      method: 'POST',
      url: `/api/users/${bobId}/revoke-sessions`,
      headers: { cookie: `__Host-session=${adminCookie}` },
    });
    expect(admRevokeBob.statusCode).toBe(200);
    const bobCheck = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-session=${bobCookie2}` },
    });
    expect(bobCheck.statusCode).toBe(401);
  });

  it('register 404 when closed + works when opened', async () => {
    // default closed → 404
    const closed = await app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { email: 'open1@example.com', password: 'openpass1234' },
    });
    expect(closed.statusCode).toBe(404);
    const cnt0 = await pool.query(
      `SELECT count(*)::int as c FROM users WHERE email='open1@example.com'`,
    );
    expect(cnt0.rows[0]!.c).toBe(0);

    // admin toggles open
    const adminPw = 'adminpass123';
    await createUser('admin3@example.com', adminPw, 'admin');
    resetRateLimitForTests();
    const adminCookie = await loginAs('admin3@example.com', adminPw);
    const toggleOn = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: `__Host-session=${adminCookie}` },
      payload: { openRegistration: true },
    });
    expect(toggleOn.statusCode).toBe(200);
    const bodyOn = JSON.parse(toggleOn.body) as { openRegistration: boolean };
    expect(bodyOn.openRegistration).toBe(true);

    // now register works
    const open = await app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { email: 'open1@example.com', password: 'openpass1234' },
    });
    expect(open.statusCode).toBe(201);
    const openBody = JSON.parse(open.body) as { email: string; role: string };
    expect(openBody.email).toBe('open1@example.com');
    expect(openBody.role).toBe('user');
    // password_hash not leaked
    expect((openBody as Record<string, unknown>).password_hash).toBeUndefined();

    // admin toggles closed again → 404
    const toggleOff = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: `__Host-session=${adminCookie}` },
      payload: { openRegistration: false },
    });
    expect(toggleOff.statusCode).toBe(200);
    const closed2 = await app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { email: 'open2@example.com', password: 'openpass1234' },
    });
    expect(closed2.statusCode).toBe(404);
  });

  it('settings toggle admin-only + audit row', async () => {
    const pw = 'testpass1234';
    await createUser('admin4@example.com', pw, 'admin');
    await createUser('user4@example.com', pw, 'user');
    resetRateLimitForTests();
    const userCookie = await loginAs('user4@example.com', pw);
    const forbid = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: `__Host-session=${userCookie}` },
      payload: { openRegistration: true },
    });
    expect(forbid.statusCode).toBe(403);

    // unauth 401
    const unauth = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { openRegistration: true },
    });
    expect(unauth.statusCode).toBe(401);

    resetRateLimitForTests();
    const adminCookie = await loginAs('admin4@example.com', pw);
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: `__Host-session=${adminCookie}` },
      payload: { openRegistration: true },
    });
    expect(ok.statusCode).toBe(200);

    const audit = await pool.query(
      `SELECT action, target FROM audit_log WHERE action='admin_settings_updated'`,
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    const row = audit.rows.find(r => (r as { target: string }).target === 'open_registration');
    expect(row).toBeDefined();

    // invalid body 400
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: `__Host-session=${adminCookie}` },
      payload: { openRegistration: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('consume rate-limit 429 with Retry-After', async () => {
    // Use dummy tokens to trigger rate limit on consume endpoint
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/invites/consume',
        payload: {
          token: `dummy-token-${i}`,
          email: `a${i}@example.com`,
          password: 'dummyPass123',
        },
      });
      expect([400, 429]).toContain(r.statusCode);
      if (r.statusCode === 429) break;
    }
    const sixth = await app.inject({
      method: 'POST',
      url: '/api/invites/consume',
      payload: { token: 'dummy-token-5', email: 'a5@example.com', password: 'dummyPass123' },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });

  it('admin invite with admin role creates admin user', async () => {
    const adminPw = 'adminpass123';
    await createUser('admin@example.com', adminPw, 'admin');
    resetRateLimitForTests();
    const adminCookie = await loginAs('admin@example.com', adminPw);
    const invRes = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: `__Host-session=${adminCookie}` },
      payload: { email: 'newadmin@example.com', role: 'admin' },
    });
    expect(invRes.statusCode).toBe(201);
    const { token } = JSON.parse(invRes.body) as { token: string };
    resetRateLimitForTests();
    const consume = await app.inject({
      method: 'POST',
      url: '/api/invites/consume',
      payload: { token, email: 'newadmin@example.com', password: 'adminNewPass123' },
    });
    expect(consume.statusCode).toBe(201);
    const body = JSON.parse(consume.body) as { role: string };
    expect(body.role).toBe('admin');
    const row = await pool.query(`SELECT role FROM users WHERE email='newadmin@example.com'`);
    expect(row.rows[0]!.role).toBe('admin');
  });
});
