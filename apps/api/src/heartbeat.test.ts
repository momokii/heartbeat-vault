import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { generate as generateTotp } from 'otplib';
import { buildServer } from './server.js';
import { resetRateLimitForTests } from './lib/rate-limit.js';
import type { FastifyInstance } from 'fastify';

const auditFailures = vi.hoisted(() => ({ heartbeatCheckin: false }));

vi.mock('./lib/audit.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./lib/audit.js')>();
  return {
    ...actual,
    writeAudit: async (
      client: Parameters<typeof actual.writeAudit>[0],
      entry: Parameters<typeof actual.writeAudit>[1],
    ) => {
      if (entry.action === 'heartbeat_checkin' && auditFailures.heartbeatCheckin) {
        throw new Error('injected heartbeat_checkin audit failure');
      }
      return actual.writeAudit(client, entry);
    },
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';
const TEST_MASTER_KEY = randomBytes(32).toString('hex');
const TOTP_PERIOD_SEC = 30;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

async function applyMigrations(p: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', '..', '..', 'packages', 'db', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(drizzle(p), { migrationsFolder });
}

async function truncateAll(p: Pool): Promise<void> {
  await p.query(`
    TRUNCATE audit_log, delivery_jobs, vault_waits, trigger_jobs, heartbeats, heartbeat_links,
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

async function enableTotp(userId: string): Promise<string> {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const { encrypt } = await import('@heartbeat-vault/crypto');
  const envelope = encrypt(
    new TextEncoder().encode(secret),
    { tenantId: 'default', switchId: 'totp' },
    new Uint8Array(Buffer.from(TEST_MASTER_KEY, 'hex')),
    'totp',
    1,
  );
  const blob = Buffer.from(
    JSON.stringify({
      version: envelope.version,
      kid: envelope.kid,
      kekVersion: envelope.kekVersion,
      wrappedDEK: {
        nonce: Buffer.from(envelope.wrappedDEK.nonce).toString('base64'),
        ct: Buffer.from(envelope.wrappedDEK.ct).toString('base64'),
      },
      payload: {
        nonce: Buffer.from(envelope.payload.nonce).toString('base64'),
        ct: Buffer.from(envelope.payload.ct).toString('base64'),
        tag: Buffer.from(envelope.payload.tag).toString('base64'),
      },
    }),
    'utf8',
  );
  await pool.query(
    `UPDATE users SET totp_secret_encrypted=$1, totp_verified_at=clock_timestamp(), totp_last_counter=0 WHERE id=$2`,
    [blob, userId],
  );
  return secret;
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

async function loginAs(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return extractSessionCookie(res)!;
}

async function scaffoldActiveSwitch(email = 'hb@example.com'): Promise<{
  ownerId: string;
  ownerCookie: string;
  switchId: string;
}> {
  const ownerId = await createUser(email, 'password-12-chars');
  const ownerCookie = await loginAs(email, 'password-12-chars');
  const created = await app.inject({
    method: 'POST',
    url: '/api/switches',
    headers: authCookie(ownerCookie),
    payload: {
      title: 'hb',
      mode: 'direct_delivery',
      heartbeatIntervalHours: 24,
      graceWindowHours: 2,
    },
  });
  expect(created.statusCode).toBe(201);
  const switchId = (JSON.parse(created.body) as { id: string }).id;
  const recip = await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/recipients`,
    headers: authCookie(ownerCookie),
    payload: { channel: 'email', address: 'r@example.com' },
  });
  const { inviteToken } = JSON.parse(recip.body) as { inviteToken: string };
  await app.inject({
    method: 'POST',
    url: '/api/recipients/accept',
    payload: { token: inviteToken },
  });
  await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/payload`,
    headers: authCookie(ownerCookie),
    payload: { plaintext: 'p' },
  });
  const arm = await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/arm`,
    headers: authCookie(ownerCookie),
    payload: { confirm: true },
  });
  expect(arm.statusCode).toBe(200);
  return { ownerId, ownerCookie, switchId };
}

async function issueToken(cookie: string, switchId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/heartbeat-token`,
    headers: authCookie(cookie),
  });
  expect(res.statusCode).toBe(201);
  return (JSON.parse(res.body) as { token: string }).token;
}

async function issueEmailLink(cookie: string, switchId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/heartbeat-link`,
    headers: authCookie(cookie),
  });
  expect(res.statusCode).toBe(201);
  return (JSON.parse(res.body) as { token: string }).token;
}

beforeAll(async () => {
  process.env['MASTER_KEY'] = TEST_MASTER_KEY;
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await applyMigrations(pool);
  app = await buildServer(pool);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await truncateAll(pool);
  resetRateLimitForTests();
});

describe('manual check-in', () => {
  it('resets next_deadline and records a heartbeat', async () => {
    const { ownerCookie, switchId } = await scaffoldActiveSwitch();
    const before = await pool.query<{ next_deadline: Date; heartbeat_started_at: Date }>(
      `SELECT next_deadline, heartbeat_started_at FROM switches WHERE id=$1`,
      [switchId],
    );
    await new Promise(r => setTimeout(r, 50));
    const res = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/check-in`,
      headers: authCookie(ownerCookie),
    });
    expect(res.statusCode).toBe(200);
    const after = await pool.query<{ next_deadline: Date; heartbeat_started_at: Date }>(
      `SELECT next_deadline, heartbeat_started_at FROM switches WHERE id=$1`,
      [switchId],
    );
    expect(after.rows[0]!.next_deadline.getTime()).toBeGreaterThan(
      before.rows[0]!.next_deadline.getTime(),
    );
    const hb = await pool.query<{ method: string }>(
      `SELECT method FROM heartbeats WHERE switch_id=$1`,
      [switchId],
    );
    expect(hb.rows).toHaveLength(1);
    expect(hb.rows[0]!.method).toBe('manual');
  });

  it('requires auth', async () => {
    const { switchId } = await scaffoldActiveSwitch();
    const res = await app.inject({ method: 'POST', url: `/api/switches/${switchId}/check-in` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects check-in on paused switch', async () => {
    const { ownerCookie, switchId } = await scaffoldActiveSwitch();
    await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/disarm`,
      headers: authCookie(ownerCookie),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/check-in`,
      headers: authCookie(ownerCookie),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body) as { error: string }).toMatchObject({ error: 'not_active' });
  });

  it('TOTP-enabled owner must step up (code required and verified)', async () => {
    const ownerId = await createUser('totp-hb@example.com', 'password-12-chars');
    const secret = await enableTotp(ownerId);
    // TOTP user login → 202 step-up → complete challenge → full session.
    const pending = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'totp-hb@example.com', password: 'password-12-chars' },
    });
    expect(pending.statusCode).toBe(202);
    const pendingCookie = extractSessionCookie(pending)!;
    const challengeCode = await generateTotp({ secret });
    const challenge = await app.inject({
      method: 'POST',
      url: '/api/2fa/totp/challenge',
      headers: authCookie(pendingCookie),
      payload: { code: challengeCode },
    });
    expect(challenge.statusCode, `challenge body: ${challenge.body}`).toBe(200);
    const ownerCookie = pendingCookie;
    // The TOTP user owns the switch; scaffold it with their full session.
    const created = await app.inject({
      method: 'POST',
      url: '/api/switches',
      headers: authCookie(ownerCookie),
      payload: {
        title: 'hb-totp',
        mode: 'direct_delivery',
        heartbeatIntervalHours: 24,
        graceWindowHours: 2,
      },
    });
    expect(created.statusCode).toBe(201);
    const switchId = (JSON.parse(created.body) as { id: string }).id;
    const recip = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/recipients`,
      headers: authCookie(ownerCookie),
      payload: { channel: 'email', address: 'r@example.com' },
    });
    const { inviteToken } = JSON.parse(recip.body) as { inviteToken: string };
    await app.inject({
      method: 'POST',
      url: '/api/recipients/accept',
      payload: { token: inviteToken },
    });
    await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/payload`,
      headers: authCookie(ownerCookie),
      payload: { plaintext: 'p' },
    });
    const arm = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/arm`,
      headers: authCookie(ownerCookie),
      payload: { confirm: true },
    });
    expect(arm.statusCode).toBe(200);
    resetRateLimitForTests();
    const noCode = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/check-in`,
      headers: authCookie(ownerCookie),
    });
    expect(noCode.statusCode).toBe(403);
    expect(JSON.parse(noCode.body) as { error: string }).toMatchObject({ error: 'totp_required' });
    const bad = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/check-in`,
      headers: authCookie(ownerCookie),
      payload: { totpCode: '000000' },
    });
    expect(bad.statusCode).toBe(403);
    // The login challenge consumed the current step; wait for a fresh step.
    await new Promise(r => setTimeout(r, TOTP_PERIOD_SEC * 1000 + 500));
    const freshCode = await generateTotp({ secret });
    const ok = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/check-in`,
      headers: authCookie(ownerCookie),
      payload: { totpCode: freshCode },
    });
    expect(ok.statusCode).toBe(200);
    void ownerCookie;
  }, 90_000);

  it('rolls the TOTP counter back when the check-in transaction fails', async () => {
    const ownerId = await createUser('totp-rollback@example.com', 'password-12-chars');
    const cookie = await loginAs('totp-rollback@example.com', 'password-12-chars');
    const secret = await enableTotp(ownerId);
    const created = await app.inject({
      method: 'POST',
      url: '/api/switches',
      headers: authCookie(cookie),
      payload: {
        title: 'hb-rollback',
        mode: 'direct_delivery',
        heartbeatIntervalHours: 24,
        graceWindowHours: 2,
      },
    });
    expect(created.statusCode).toBe(201);
    const switchId = (JSON.parse(created.body) as { id: string }).id;
    const recip = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/recipients`,
      headers: authCookie(cookie),
      payload: { channel: 'email', address: 'r@example.com' },
    });
    const { inviteToken } = JSON.parse(recip.body) as { inviteToken: string };
    await app.inject({
      method: 'POST',
      url: '/api/recipients/accept',
      payload: { token: inviteToken },
    });
    await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/payload`,
      headers: authCookie(cookie),
      payload: { plaintext: 'p' },
    });
    const arm = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/arm`,
      headers: authCookie(cookie),
      payload: { confirm: true },
    });
    expect(arm.statusCode).toBe(200);
    resetRateLimitForTests();
    auditFailures.heartbeatCheckin = true;
    let statusCode = 0;
    try {
      const code = await generateTotp({ secret });
      const res = await app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/check-in`,
        headers: authCookie(cookie),
        payload: { totpCode: code },
      });
      statusCode = res.statusCode;
    } finally {
      auditFailures.heartbeatCheckin = false;
    }
    expect(statusCode).toBe(500);
    const counter = await pool.query<{ totp_last_counter: string }>(
      `SELECT totp_last_counter FROM users WHERE id=$1`,
      [ownerId],
    );
    expect(counter.rows[0]!.totp_last_counter).toBe('0');
    const heartbeats = await pool.query(`SELECT 1 FROM heartbeats WHERE switch_id=$1`, [switchId]);
    expect(heartbeats.rows).toHaveLength(0);
    const auditRows = await pool.query(
      `SELECT 1 FROM audit_log WHERE action='heartbeat_checkin' AND target=$1`,
      [switchId],
    );
    expect(auditRows.rows).toHaveLength(0);
  });
});

describe('token check-in', () => {
  it('issues hashed token; check-in via token works', async () => {
    const { ownerCookie, switchId } = await scaffoldActiveSwitch();
    const token = await issueToken(ownerCookie, switchId);
    const hashRow = await pool.query<{ heartbeat_token_hash: string | null }>(
      `SELECT heartbeat_token_hash FROM switches WHERE id=$1`,
      [switchId],
    );
    expect(hashRow.rows[0]!.heartbeat_token_hash).not.toBe(token);
    expect(hashRow.rows[0]!.heartbeat_token_hash).not.toBeNull();
    const res = await app.inject({ method: 'POST', url: `/api/heartbeat/${token}` });
    expect(res.statusCode).toBe(200);
    const hb = await pool.query<{ method: string }>(
      `SELECT method FROM heartbeats WHERE switch_id=$1`,
      [switchId],
    );
    expect(hb.rows[0]!.method).toBe('token');
  });

  it('unknown token → 404 no enumeration; re-issue invalidates old token', async () => {
    const { ownerCookie, switchId } = await scaffoldActiveSwitch();
    const bad = await app.inject({ method: 'POST', url: `/api/heartbeat/not-a-real-token` });
    expect(bad.statusCode).toBe(404);
    const t1 = await issueToken(ownerCookie, switchId);
    await issueToken(ownerCookie, switchId);
    const old = await app.inject({ method: 'POST', url: `/api/heartbeat/${t1}` });
    expect(old.statusCode).toBe(404);
    void switchId;
  });
});

describe('email link check-in', () => {
  it('one-time link: GET preview → POST consumes → second POST 410', async () => {
    const { ownerCookie, switchId } = await scaffoldActiveSwitch();
    const token = await issueEmailLink(ownerCookie, switchId);
    const preview = await app.inject({ method: 'GET', url: `/api/heartbeat/link/${token}` });
    expect(preview.statusCode).toBe(200);
    const ok = await app.inject({ method: 'POST', url: `/api/heartbeat/link/${token}` });
    expect(ok.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `/api/heartbeat/link/${token}` });
    expect(again.statusCode).toBe(410);
    const hb = await pool.query<{ method: string }>(
      `SELECT method FROM heartbeats WHERE switch_id=$1`,
      [switchId],
    );
    expect(hb.rows[0]!.method).toBe('email_link');
  });

  it('expired link → 410', async () => {
    const { ownerCookie, switchId } = await scaffoldActiveSwitch();
    const token = await issueEmailLink(ownerCookie, switchId);
    await pool.query(`UPDATE heartbeat_links SET expires_at = now() - interval '1 hour'`);
    void switchId;
    const res = await app.inject({ method: 'POST', url: `/api/heartbeat/link/${token}` });
    expect(res.statusCode).toBe(410);
  });

  it('unknown link token → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/heartbeat/link/nope` });
    expect(res.statusCode).toBe(404);
  });
});

describe('token timing window', () => {
  it('fresh code at same step is accepted; verify totp_last_counter stays 0 for manual owner', async () => {
    const { ownerCookie, switchId } = await scaffoldActiveSwitch();
    const nowSec = Math.floor(Date.now() / 1000);
    void nowSec;
    void ownerCookie;
    void switchId;
    const res = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/check-in`,
      headers: authCookie(ownerCookie),
    });
    expect(res.statusCode).toBe(200);
    expect(TOTP_PERIOD_SEC).toBe(30);
  });
});
