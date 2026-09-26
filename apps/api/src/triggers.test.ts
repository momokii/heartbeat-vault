import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { generate as generateTotp } from 'otplib';
import { buildServer } from './server.js';
import { resetRateLimitForTests } from './lib/rate-limit.js';
import { materializeDueTriggers, claimJob, processJob } from './lib/trigger-engine.js';
import type { FastifyInstance } from 'fastify';

const auditFailures = vi.hoisted(() => ({ triggerCancel: false }));

vi.mock('./lib/audit.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./lib/audit.js')>();
  return {
    ...actual,
    writeAudit: async (
      client: Parameters<typeof actual.writeAudit>[0],
      entry: Parameters<typeof actual.writeAudit>[1],
    ) => {
      if (entry.action === 'trigger_cancelled' && auditFailures.triggerCancel) {
        throw new Error('injected trigger_cancelled audit failure');
      }
      return actual.writeAudit(client, entry);
    },
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_MASTER_KEY = randomBytes(32).toString('hex');

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

async function createUserAndLogin(email: string): Promise<{ userId: string; cookie: string }> {
  const { hashPassword } = await import('@heartbeat-vault/crypto');
  const phc = await hashPassword('password-12-chars');
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id`,
    [email, phc],
  );
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password: 'password-12-chars' },
  });
  expect(login.statusCode).toBe(200);
  return { userId: u.rows[0]!.id as string, cookie: extractSessionCookie(login)! };
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

/** Active armed switch, deadline far in the future (heartbeat ladder never fires). */
async function createActiveSwitch(ownerId?: string): Promise<string> {
  let id = ownerId;
  if (!id) {
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`u${Math.random()}@t.test`],
    );
    id = u.rows[0]!.id as string;
  }
  const s = await pool.query<{ id: string }>(
    `INSERT INTO switches (owner_id, title, mode, status, heartbeat_interval, grace_window,
        heartbeat_started_at, next_deadline)
     VALUES ($1,'t','direct_delivery','active', make_interval(secs => 1209600), make_interval(secs => 7200),
        clock_timestamp(), clock_timestamp() + make_interval(secs => 1209600))
     RETURNING id`,
    [id],
  );
  return s.rows[0]!.id as string;
}

async function addAcceptedRecipient(switchId: string, channel = 'email'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO recipients (switch_id, channel, address, status) VALUES ($1,$2,'a@b.c','accepted') RETURNING id`,
    [switchId, channel],
  );
  return r.rows[0]!.id as string;
}

async function setTriggerViaApi(
  cookie: string,
  switchId: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/trigger`,
    headers: authCookie(cookie),
    payload,
  });
  return { status: res.statusCode, body: res.body };
}

async function vote(token: string): Promise<{ status: number; body: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/recipients/vote',
    payload: { token, vote: 'deceased' },
  });
  return { status: res.statusCode, body: res.body };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await applyMigrations(pool);
  process.env['MASTER_KEY'] = TEST_MASTER_KEY;
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

describe('fixed_date trigger', () => {
  it('configures future fire date; no materialization until due; fires at fire_at', async () => {
    const { userId, cookie } = await createUserAndLogin('fd@example.com');
    const sid = await createActiveSwitch(userId);
    await addAcceptedRecipient(sid);
    const cfg = await setTriggerViaApi(cookie, sid, {
      type: 'fixed_date',
      fireAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(cfg.status).toBe(200);
    const row = await pool.query<{ trigger_type: string; fire_at: Date }>(
      `SELECT trigger_type, fire_at FROM switches WHERE id=$1`,
      [sid],
    );
    expect(row.rows[0]!.trigger_type).toBe('fixed_date');
    expect(row.rows[0]!.fire_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await materializeDueTriggers(pool, new Date())).toBe(0);
    // make due
    await pool.query(
      `UPDATE switches SET fire_at = clock_timestamp() - interval '1 min' WHERE id=$1`,
      [sid],
    );
    expect(await materializeDueTriggers(pool, new Date())).toBe(1);
    const job = (await claimJob(pool, 'w1', new Date()))!;
    expect(job).not.toBeNull();
    await processJob(pool, job!, 'w1');
    const dj = await pool.query<{ available_at: Date }>(`SELECT available_at FROM delivery_jobs`);
    expect(dj.rows).toHaveLength(1);
    expect(dj.rows[0]!.available_at.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
    const sw = await pool.query<{ status: string }>(`SELECT status FROM switches WHERE id=$1`, [
      sid,
    ]);
    expect(sw.rows[0]!.status).toBe('released');
  });

  it('rejects a past fire date', async () => {
    const { userId, cookie } = await createUserAndLogin('fd2@example.com');
    const sid = await createActiveSwitch(userId);
    const cfg = await setTriggerViaApi(cookie, sid, {
      type: 'fixed_date',
      fireAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(cfg.status).toBe(400);
  });
});

describe('panic trigger', () => {
  it('requires confirm literal', async () => {
    const { userId, cookie } = await createUserAndLogin('p1@example.com');
    const sid = await createActiveSwitch(userId);
    const cfg = await setTriggerViaApi(cookie, sid, { type: 'panic' });
    expect(cfg.status).toBe(400);
  });

  it('confirm fires immediately on next materialization', async () => {
    const { userId, cookie } = await createUserAndLogin('p2@example.com');
    const sid = await createActiveSwitch(userId);
    await addAcceptedRecipient(sid, 'webhook');
    const cfg = await setTriggerViaApi(cookie, sid, { type: 'panic', confirm: true });
    expect(cfg.status).toBe(200);
    const mat = await materializeDueTriggers(pool, new Date());
    expect(mat).toBe(1);
    const job = (await claimJob(pool, 'w1', new Date()))!;
    expect(job).not.toBeNull();
    await processJob(pool, job!, 'w1');
    const dj = await pool.query<{ available_at: Date }>(`SELECT available_at FROM delivery_jobs`);
    expect(dj.rows).toHaveLength(1);
    expect(dj.rows[0]!.available_at.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
  });
});

describe('quorum trigger', () => {
  it('fires when threshold reached; extra votes do not duplicate', async () => {
    const { userId, cookie } = await createUserAndLogin('q@example.com');
    const sid = await createActiveSwitch(userId);
    const tokens: string[] = [];
    for (const ch of ['email', 'webhook', 'telegram']) {
      const tok = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(tok, 'utf8').digest('hex');
      await pool.query(
        `INSERT INTO recipients (switch_id, channel, address, status, invite_token_hash)
         VALUES ($1,$2,'voter@x.y','accepted',$3)`,
        [sid, ch, tokenHash],
      );
      tokens.push(tok);
    }
    const cfg = await setTriggerViaApi(cookie, sid, { type: 'quorum', threshold: 2 });
    expect(cfg.status).toBe(200);

    const v1 = await vote(tokens[0]!);
    expect(v1.status).toBe(200);
    const jobs1 = await pool.query(`SELECT * FROM trigger_jobs WHERE switch_id=$1`, [sid]);
    expect(jobs1.rows).toHaveLength(0);

    const v2 = await vote(tokens[1]!);
    expect(v2.status).toBe(200);
    const jobs2 = await pool.query(`SELECT * FROM trigger_jobs WHERE switch_id=$1`, [sid]);
    expect(jobs2.rows).toHaveLength(1);

    const v3 = await vote(tokens[2]!);
    expect(v3.status).toBe(200);
    const jobs3 = await pool.query(`SELECT * FROM trigger_jobs WHERE switch_id=$1`, [sid]);
    expect(jobs3.rows).toHaveLength(1);
  });

  it('rejects unknown vote token', async () => {
    const res = await vote('definitely-not-a-token');
    expect(res.status).toBe(400);
  });
});

describe('cancellation', () => {
  it('cancel aborts queued deliveries, pending jobs, and disarms', async () => {
    const { userId, cookie } = await createUserAndLogin('c@example.com');
    const sid = await createActiveSwitch(userId);
    await addAcceptedRecipient(sid);
    await setTriggerViaApi(cookie, sid, { type: 'panic', confirm: true });
    expect(await materializeDueTriggers(pool, new Date())).toBe(1);
    const job = (await claimJob(pool, 'w1', new Date()))!;
    expect(job).not.toBeNull();
    await processJob(pool, job!, 'w1');
    // fire happened: delivery queued for +48h, switch released
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/cancel`,
      headers: authCookie(cookie),
    });
    expect(cancel.statusCode).toBe(200);
    const dj = await pool.query<{ state: string }>(`SELECT state FROM delivery_jobs`);
    expect(dj.rows.every(r => r.state === 'cancelled')).toBe(true);
    const tj = await pool.query<{ state: string }>(`SELECT state FROM trigger_jobs`);
    expect(tj.rows.every(r => r.state === 'succeeded' || r.state === 'cancelled')).toBe(true);
    const sw = await pool.query<{ status: string }>(`SELECT status FROM switches WHERE id=$1`, [
      sid,
    ]);
    expect(sw.rows[0]!.status).toBe('paused');
  });

  it('non-owner cannot cancel (404 shape)', async () => {
    const sid = await createActiveSwitch();
    const { cookie } = await createUserAndLogin('other-c@example.com');
    const res = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/cancel`,
      headers: authCookie(cookie),
    });
    expect(res.statusCode).toBe(404);
  });

  it('TOTP-enabled owner must step up to cancel', async () => {
    const { userId, cookie } = await createUserAndLogin('totp-c@example.com');
    await pool.query(`UPDATE users SET totp_verified_at = clock_timestamp() WHERE id=$1`, [userId]);
    const sid = await createActiveSwitch(userId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/cancel`,
      headers: authCookie(cookie),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body) as { error: string }).toMatchObject({ error: 'totp_required' });
  });

  it('rolls the TOTP counter back when the cancel transaction fails', async () => {
    const { userId, cookie } = await createUserAndLogin('totp-rollback@example.com');
    const secret = await enableTotp(userId);
    const sid = await createActiveSwitch(userId);
    auditFailures.triggerCancel = true;
    let statusCode = 0;
    try {
      const code = await generateTotp({ secret });
      const res = await app.inject({
        method: 'POST',
        url: `/api/switches/${sid}/cancel`,
        headers: authCookie(cookie),
        payload: { totpCode: code },
      });
      statusCode = res.statusCode;
    } finally {
      auditFailures.triggerCancel = false;
    }
    expect(statusCode).toBe(500);
    const counter = await pool.query<{ totp_last_counter: string }>(
      `SELECT totp_last_counter FROM users WHERE id=$1`,
      [userId],
    );
    expect(counter.rows[0]!.totp_last_counter).toBe('0');
    const sw = await pool.query<{ status: string }>(`SELECT status FROM switches WHERE id=$1`, [
      sid,
    ]);
    expect(sw.rows[0]!.status).toBe('active');
    const auditRows = await pool.query(
      `SELECT 1 FROM audit_log WHERE action='trigger_cancelled' AND target=$1`,
      [sid],
    );
    expect(auditRows.rows).toHaveLength(0);
  });

  it('requires step-up when TOTP is enabled concurrently with the cancel', async () => {
    const { userId, cookie } = await createUserAndLogin('totp-toctou-c@example.com');
    const sid = await createActiveSwitch(userId);
    const race = await pool.connect();
    try {
      await race.query('BEGIN');
      await race.query(`UPDATE users SET totp_verified_at=clock_timestamp() WHERE id=$1`, [userId]);
      const pending = app.inject({
        method: 'POST',
        url: `/api/switches/${sid}/cancel`,
        headers: authCookie(cookie),
      });
      await new Promise(r => setTimeout(r, 250));
      await race.query('COMMIT');
      const res = await pending;
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body) as { error: string }).toMatchObject({ error: 'totp_required' });
    } finally {
      race.release();
    }
    const sw = await pool.query<{ status: string }>(`SELECT status FROM switches WHERE id=$1`, [
      sid,
    ]);
    expect(sw.rows[0]!.status).toBe('active');
    const auditRows = await pool.query(
      `SELECT 1 FROM audit_log WHERE action='trigger_cancelled' AND target=$1`,
      [sid],
    );
    expect(auditRows.rows).toHaveLength(0);
  });
});
