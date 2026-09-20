import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { generate as generateTotp } from 'otplib';
import { buildServer } from './server.js';
import { resetRateLimitForTests } from './lib/rate-limit.js';
import { requireStepUp } from './routes/two-factor.js';
import type { FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';
// 32 bytes hex — MASTER_KEY for the envelope KEK (test-only value)
const TEST_MASTER_KEY = randomBytes(32).toString('hex');
const TOTP_PERIOD_SEC = 30;

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
      scheduler_heartbeat, app_config, recovery_codes, webauthn_credentials, users CASCADE`);
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

function authCookie(cookie: string): { cookie: string } {
  return { cookie: `__Host-session=${cookie}` };
}

/**
 * Generate a TOTP code guaranteed to be at a time step AFTER the user's
 * totp_last_counter (anti-replay would reject a reused step). Waits across a
 * period boundary when needed — bounded by one period (30s).
 */
async function freshTotpCode(email: string, secret: string): Promise<string> {
  const u = await pool.query<{ totp_last_counter: string }>(
    `SELECT totp_last_counter FROM users WHERE email=$1`,
    [email],
  );
  const last = Number(u.rows[0]!.totp_last_counter);
  for (;;) {
    const nowSec = Date.now() / 1000;
    if (Math.floor(nowSec / TOTP_PERIOD_SEC) > last) {
      return generateTotp({ secret });
    }
    const waitMs = ((last + 1) * TOTP_PERIOD_SEC - nowSec) * 1000 + 250;
    await new Promise(r => setTimeout(r, Math.min(waitMs, 31000)));
  }
}

/**
 * Real-path setup: create user → login (200) → enroll → verify with a fresh
 * code. Returns the STILL-FULL session cookie (created before TOTP was
 * enabled) plus the base32 secret for later code generation.
 */
async function enrollAndVerify(
  email: string,
  password: string,
): Promise<{ userId: string; secret: string; cookie: string }> {
  const userId = await createUser(email, password);
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password },
  });
  expect(login.statusCode).toBe(200);
  const cookie = extractSessionCookie(login)!;
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/2fa/totp/enroll',
    headers: authCookie(cookie),
  });
  expect(enroll.statusCode).toBe(200);
  const { secret } = JSON.parse(enroll.body) as { secret: string };
  const code = await freshTotpCode(email, secret);
  const verify = await app.inject({
    method: 'POST',
    url: '/api/2fa/totp/verify',
    headers: authCookie(cookie),
    payload: { code },
  });
  expect(verify.statusCode).toBe(200);
  // Setup consumed 2fa-bucket + login-budget slots; clear so the actual test
  // starts from a clean limiter state.
  resetRateLimitForTests();
  return { userId, secret, cookie };
}

/** Login for a TOTP-enabled user → 202 step-up pending session cookie. */
async function toPendingSession(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(202);
  return extractSessionCookie(res)!;
}

describe('two-factor T3.3', () => {
  beforeAll(async () => {
    process.env['MASTER_KEY'] = TEST_MASTER_KEY;
    process.env['WEBAUTHN_RP_ID'] = 'localhost';
    process.env['WEBAUTHN_ORIGIN'] = 'https://localhost';
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

  describe('TOTP enroll + verify', () => {
    it('enroll returns {otpauthUrl, secret} and stores only ciphertext, unverified', async () => {
      await createUser('enroll@example.com', 'supersecure123');
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email: 'enroll@example.com', password: 'supersecure123' },
      });
      const cookie = extractSessionCookie(login)!;
      const res = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/enroll',
        headers: authCookie(cookie),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { otpauthUrl: string; secret: string };
      expect(body.secret).toMatch(/^[A-Z2-7]+=*$/);
      expect(body.otpauthUrl.startsWith('otpauth://totp/')).toBe(true);
      expect(body.otpauthUrl).toContain(encodeURIComponent('enroll@example.com'));
      // secret never at rest in plaintext
      const row = await pool.query<{ totp_secret_encrypted: Buffer | null }>(
        `SELECT totp_secret_encrypted FROM users WHERE email=$1`,
        ['enroll@example.com'],
      );
      const stored = row.rows[0]!.totp_secret_encrypted;
      expect(stored).not.toBeNull();
      expect(stored!.toString('latin1')).not.toContain(body.secret);
      expect(stored!.length).toBeGreaterThan(100);
      const u = await pool.query<{ totp_verified_at: string | null }>(
        `SELECT totp_verified_at FROM users WHERE email=$1`,
        ['enroll@example.com'],
      );
      expect(u.rows[0]!.totp_verified_at).toBeNull();
    });

    it('enroll requires auth', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/2fa/totp/enroll' });
      expect(res.statusCode).toBe(401);
    });

    it('verify with current code enables TOTP; wrong code 401; unenrolled 400', async () => {
      await createUser('verify@example.com', 'supersecure123');
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email: 'verify@example.com', password: 'supersecure123' },
      });
      const cookie = extractSessionCookie(login)!;
      const noSecret = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/verify',
        headers: authCookie(cookie),
        payload: { code: '123456' },
      });
      expect(noSecret.statusCode).toBe(400);

      const enroll = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/enroll',
        headers: authCookie(cookie),
      });
      const { secret } = JSON.parse(enroll.body) as { secret: string };

      const wrong = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/verify',
        headers: authCookie(cookie),
        payload: { code: '000000' },
      });
      expect(wrong.statusCode).toBe(401);
      expect((JSON.parse(wrong.body) as { error: string }).error).toBe('invalid_code');

      const ok = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/verify',
        headers: authCookie(cookie),
        payload: { code: await freshTotpCode('verify@example.com', secret) },
      });
      expect(ok.statusCode).toBe(200);
      const u = await pool.query<{ totp_verified_at: string | null; totp_last_counter: string }>(
        `SELECT totp_verified_at, totp_last_counter FROM users WHERE email=$1`,
        ['verify@example.com'],
      );
      expect(u.rows[0]!.totp_verified_at).not.toBeNull();
      expect(Number(u.rows[0]!.totp_last_counter)).toBeGreaterThan(0);
      const audit = await pool.query(
        `SELECT action FROM audit_log WHERE action='2fa_totp_enabled'`,
      );
      expect(audit.rowCount).toBe(1);
    });
  });

  describe('login step-up + challenge', () => {
    it('enroll→verify→login 202→/me 403 totp_pending→challenge 200→/me 200', async () => {
      const { secret } = await enrollAndVerify('flow@example.com', 'supersecure123');
      const cookie = await toPendingSession('flow@example.com', 'supersecure123');
      // pending session rejected for non-2fa routes
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: authCookie(cookie) });
      expect(me.statusCode).toBe(403);
      expect((JSON.parse(me.body) as { error: string }).error).toBe('totp_pending');

      const challenge = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/challenge',
        headers: authCookie(cookie),
        payload: { code: await freshTotpCode('flow@example.com', secret) },
      });
      expect(challenge.statusCode).toBe(200);

      const me2 = await app.inject({ method: 'GET', url: '/api/me', headers: authCookie(cookie) });
      expect(me2.statusCode).toBe(200);
      expect((JSON.parse(me2.body) as { email: string }).email).toBe('flow@example.com');
    });

    it('challenge with wrong code 401 and session stays pending', async () => {
      await enrollAndVerify('wrong@example.com', 'supersecure123');
      const cookie = await toPendingSession('wrong@example.com', 'supersecure123');
      const bad = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/challenge',
        headers: authCookie(cookie),
        payload: { code: '000000' },
      });
      expect(bad.statusCode).toBe(401);
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: authCookie(cookie) });
      expect(me.statusCode).toBe(403);
    });

    it('replay of the same code is rejected on the next pending session', async () => {
      const { secret } = await enrollAndVerify('replay@example.com', 'supersecure123');
      const code = await freshTotpCode('replay@example.com', secret);
      const c1 = await toPendingSession('replay@example.com', 'supersecure123');
      const first = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/challenge',
        headers: authCookie(c1),
        payload: { code },
      });
      expect(first.statusCode).toBe(200);
      resetRateLimitForTests();
      const c2 = await toPendingSession('replay@example.com', 'supersecure123');
      const second = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/challenge',
        headers: authCookie(c2),
        payload: { code },
      });
      expect(second.statusCode).toBe(401);
    });

    it('challenge rejects when TOTP not enabled', async () => {
      await createUser('plain@example.com', 'supersecure123');
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email: 'plain@example.com', password: 'supersecure123' },
      });
      expect(login.statusCode).toBe(200);
      const cookie = extractSessionCookie(login)!;
      const res = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/challenge',
        headers: authCookie(cookie),
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { error: string }).error).toBe('totp_not_enabled');
    });

    it('11th challenge attempt within window is rate limited 429', async () => {
      const { secret } = await enrollAndVerify('ratelimit@example.com', 'supersecure123');
      const cookie = await toPendingSession('ratelimit@example.com', 'supersecure123');
      for (let i = 0; i < 10; i++) {
        const r = await app.inject({
          method: 'POST',
          url: '/api/2fa/totp/challenge',
          headers: authCookie(cookie),
          payload: { code: '000000' },
        });
        expect(r.statusCode).toBe(401);
      }
      const eleventh = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/challenge',
        headers: authCookie(cookie),
        payload: { code: await generateTotp({ secret }) },
      });
      expect(eleventh.statusCode).toBe(429);
      expect(eleventh.headers['retry-after']).toBeDefined();
    });
  });

  describe('totp disable', () => {
    it('wrong password 401; correct password disables, wipes config + recovery codes', async () => {
      const email = 'disable@example.com';
      const pw = 'supersecure123';
      const { secret, cookie } = await enrollAndVerify(email, pw);

      const bad = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/disable',
        headers: authCookie(cookie),
        payload: { password: 'not-the-password' },
      });
      expect(bad.statusCode).toBe(401);
      expect((JSON.parse(bad.body) as { error: string }).error).toBe('invalid_password');

      const ok = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/disable',
        headers: authCookie(cookie),
        payload: { password: pw },
      });
      expect(ok.statusCode).toBe(200);

      const u = await pool.query<{
        totp_verified_at: string | null;
        totp_secret_encrypted: Buffer | null;
      }>(`SELECT totp_verified_at, totp_secret_encrypted FROM users WHERE email=$1`, [email]);
      expect(u.rows[0]!.totp_verified_at).toBeNull();
      expect(u.rows[0]!.totp_secret_encrypted).toBeNull();

      // login no longer 202
      resetRateLimitForTests();
      const res = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email, password: pw },
      });
      expect(res.statusCode).toBe(200);
      expect(secret).toBeDefined();
    });

    it('challenge after disable returns 400 totp_not_enabled', async () => {
      const email = 'disable2@example.com';
      const pw = 'supersecure123';
      const { cookie } = await enrollAndVerify(email, pw);
      const disable = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/disable',
        headers: authCookie(cookie),
        payload: { password: pw },
      });
      expect(disable.statusCode).toBe(200);
      resetRateLimitForTests();
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email, password: pw },
      });
      expect(login.statusCode).toBe(200);
      const c2 = extractSessionCookie(login)!;
      const res = await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/challenge',
        headers: authCookie(c2),
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { error: string }).error).toBe('totp_not_enabled');
    });
  });

  describe('recovery codes', () => {
    it('regenerate returns 10 plaintext codes once; single-use; regenerate invalidates old', async () => {
      const email = 'recover@example.com';
      const pw = 'supersecure123';
      const { secret, cookie } = await enrollAndVerify(email, pw);

      const regen = await app.inject({
        method: 'POST',
        url: '/api/2fa/recovery-codes/regenerate',
        headers: authCookie(cookie),
        payload: { code: await freshTotpCode(email, secret) },
      });
      expect(regen.statusCode).toBe(200);
      const { codes } = JSON.parse(regen.body) as { codes: string[] };
      expect(codes).toHaveLength(10);
      for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);

      // codes stored hashed, never plaintext
      const stored = await pool.query<{ code_hash: string }>(
        `SELECT rc.code_hash FROM recovery_codes rc JOIN users u ON u.id=rc.user_id WHERE u.email=$1`,
        [email],
      );
      expect(stored.rowCount).toBe(10);
      for (const r of stored.rows) {
        expect(r.code_hash.startsWith('$argon2id$')).toBe(true);
        for (const c of codes) expect(r.code_hash).not.toBe(c);
      }

      resetRateLimitForTests();
      // consume first code → full session
      const rec1 = await app.inject({
        method: 'POST',
        url: '/api/login/recover',
        payload: { email, code: codes[0]! },
      });
      expect(rec1.statusCode).toBe(200);
      const cookie1 = extractSessionCookie(rec1)!;
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: authCookie(cookie1) });
      expect(me.statusCode).toBe(200);

      // second use of same code → 401
      resetRateLimitForTests();
      const rec2 = await app.inject({
        method: 'POST',
        url: '/api/login/recover',
        payload: { email, code: codes[0]! },
      });
      expect(rec2.statusCode).toBe(401);

      // another code from same batch still works
      resetRateLimitForTests();
      const rec3 = await app.inject({
        method: 'POST',
        url: '/api/login/recover',
        payload: { email, code: codes[1]! },
      });
      expect(rec3.statusCode).toBe(200);

      // regenerate (with the recovery-login full session) invalidates old batch
      resetRateLimitForTests();
      const regen2 = await app.inject({
        method: 'POST',
        url: '/api/2fa/recovery-codes/regenerate',
        headers: authCookie(cookie1),
        payload: { code: await freshTotpCode(email, secret) },
      });
      expect(regen2.statusCode).toBe(200);
      const { codes: codes2 } = JSON.parse(regen2.body) as { codes: string[] };
      expect(codes2).toHaveLength(10);

      resetRateLimitForTests();
      const oldCode = await app.inject({
        method: 'POST',
        url: '/api/login/recover',
        payload: { email, code: codes[2]! },
      });
      expect(oldCode.statusCode).toBe(401);
      resetRateLimitForTests();
      const newCode = await app.inject({
        method: 'POST',
        url: '/api/login/recover',
        payload: { email, code: codes2[0]! },
      });
      expect(newCode.statusCode).toBe(200);
    });

    it('recover with unknown email and wrong code both generic 401 same shape', async () => {
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/login/recover',
        payload: { email: 'ghost@example.com', code: 'AAAA-BBBB' },
      });
      expect(wrong.statusCode).toBe(401);
      const b1 = JSON.parse(wrong.body) as { error: string };
      expect(b1.error).toBe('invalid_code');
      const other = await app.inject({
        method: 'POST',
        url: '/api/login/recover',
        payload: { email: 'recover-shape@example.com', code: 'ZZZZ-ZZZZ' },
      });
      expect(other.statusCode).toBe(401);
      const b2 = JSON.parse(other.body) as { error: string };
      expect(Object.keys(b1).sort()).toEqual(Object.keys(b2).sort());
    });

    it('regenerate without TOTP enabled returns 400 totp_required', async () => {
      await createUser('norecovery@example.com', 'supersecure123');
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email: 'norecovery@example.com', password: 'supersecure123' },
      });
      const cookie = extractSessionCookie(login)!;
      const res = await app.inject({
        method: 'POST',
        url: '/api/2fa/recovery-codes/regenerate',
        headers: authCookie(cookie),
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { error: string }).error).toBe('totp_required');
    });
  });

  describe('WebAuthn', () => {
    it('register-options returns valid challenge for full session; pending session rejected', async () => {
      const email = 'wa@example.com';
      const pw = 'supersecure123';
      const { cookie } = await enrollAndVerify(email, pw);
      const opts = await app.inject({
        method: 'POST',
        url: '/api/2fa/webauthn/register-options',
        headers: authCookie(cookie),
      });
      expect(opts.statusCode).toBe(200);
      const body = JSON.parse(opts.body) as {
        challenge: string;
        rp: { id: string };
        user: { name: string };
      };
      expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(body.rp.id).toBe('localhost');
      expect(body.user.name).toBe(email);

      const sess = await pool.query<{ webauthn_challenge: string | null }>(
        `SELECT s.webauthn_challenge FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE u.email=$1 ORDER BY s.created_at DESC LIMIT 1`,
        [email],
      );
      expect(sess.rows[0]!.webauthn_challenge).toContain(body.challenge);

      resetRateLimitForTests();
      const pending = await toPendingSession(email, pw);
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/2fa/webauthn/register-options',
        headers: authCookie(pending),
      });
      expect(rejected.statusCode).toBe(403);
      expect((JSON.parse(rejected.body) as { error: string }).error).toBe('totp_pending');
    });

    it('register-verify rejects garbage attestation with 400', async () => {
      const email = 'wagarbage@example.com';
      const pw = 'supersecure123';
      const { cookie } = await enrollAndVerify(email, pw);
      const opts = await app.inject({
        method: 'POST',
        url: '/api/2fa/webauthn/register-options',
        headers: authCookie(cookie),
      });
      const { challenge } = JSON.parse(opts.body) as { challenge: string };
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge, origin: 'https://localhost' }),
      ).toString('base64url');
      const garbage = await app.inject({
        method: 'POST',
        url: '/api/2fa/webauthn/register-verify',
        headers: authCookie(cookie),
        payload: {
          type: 'public-key',
          id: Buffer.from(randomBytes(32)).toString('base64url'),
          rawId: Buffer.from(randomBytes(32)).toString('base64url'),
          response: {
            clientDataJSON,
            attestationObject: Buffer.from(randomBytes(64)).toString('base64url'),
          },
          clientExtensionResults: {},
        },
      });
      expect(garbage.statusCode).toBe(400);
      expect((JSON.parse(garbage.body) as { error: string }).error).toBe('verification_failed');
    });

    it('login-options requires a credential; login-verify rejects garbage', async () => {
      const email = 'walogin@example.com';
      const pw = 'supersecure123';
      await enrollAndVerify(email, pw);
      resetRateLimitForTests();
      const pending = await toPendingSession(email, pw);

      const noCreds = await app.inject({
        method: 'POST',
        url: '/api/2fa/webauthn/login-options',
        headers: authCookie(pending),
      });
      expect(noCreds.statusCode).toBe(400);
      expect((JSON.parse(noCreds.body) as { error: string }).error).toBe('no_credentials');

      const garbage = await app.inject({
        method: 'POST',
        url: '/api/2fa/webauthn/login-verify',
        headers: authCookie(pending),
        payload: {
          type: 'public-key',
          id: Buffer.from(randomBytes(16)).toString('base64url'),
          rawId: Buffer.from(randomBytes(16)).toString('base64url'),
          response: {
            clientDataJSON: Buffer.from(
              JSON.stringify({
                type: 'webauthn.get',
                challenge: 'AAAA',
                origin: 'https://localhost',
              }),
            ).toString('base64url'),
            authenticatorData: Buffer.from(randomBytes(37)).toString('base64url'),
            signature: Buffer.from(randomBytes(64)).toString('base64url'),
          },
          clientExtensionResults: {},
        },
      });
      // No challenge was ever issued to this session (login-options bailed on
      // no_credentials) — fail-closed as challenge_expired, never a verify attempt.
      expect(garbage.statusCode).toBe(400);
      expect((JSON.parse(garbage.body) as { error: string }).error).toBe('challenge_expired');
    });
  });

  describe('requireStepUp export', () => {
    it('exports a preHandler factory', () => {
      expect(typeof requireStepUp).toBe('function');
      const handler = requireStepUp(pool);
      expect(typeof handler).toBe('function');
    });
  });

  describe('audit trail', () => {
    it('2fa lifecycle actions are audited', async () => {
      const email = 'audit2fa@example.com';
      const pw = 'supersecure123';
      const { cookie } = await enrollAndVerify(email, pw);
      await app.inject({
        method: 'POST',
        url: '/api/2fa/totp/disable',
        headers: authCookie(cookie),
        payload: { password: pw },
      });
      const actions = await pool.query<{ action: string }>(
        `SELECT DISTINCT action FROM audit_log ORDER BY action`,
      );
      const found = actions.rows.map(r => r.action);
      expect(found).toContain('2fa_totp_enabled');
      expect(found).toContain('2fa_totp_disabled');
      expect(found).toContain('2fa_totp_enroll_started');
    });
  });
});
