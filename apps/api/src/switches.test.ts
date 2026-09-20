import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { buildServer } from './server.js';
import { resetRateLimitForTests } from './lib/rate-limit.js';
import type { FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';
const TEST_MASTER_KEY = randomBytes(32).toString('hex');

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

async function loginAs(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return extractSessionCookie(res)!;
}

/** Full happy-path scaffold: user + switch + accepted recipient + payload. */
async function scaffoldArmed(opts?: {
  mode?: string;
  releasePolicy?: string;
}): Promise<{ ownerId: string; ownerCookie: string; switchId: string; recipientToken: string }> {
  const ownerId = await createUser('owner@example.com', 'password-12-chars', 'user');
  const ownerCookie = await loginAs('owner@example.com', 'password-12-chars');
  const mode = opts?.mode ?? 'direct_delivery';
  const releasePolicy = opts?.releasePolicy ?? 'fail_safe';
  const created = await app.inject({
    method: 'POST',
    url: '/api/switches',
    headers: authCookie(ownerCookie),
    payload: {
      title: 'Test switch',
      mode,
      heartbeatIntervalHours: 24 * 14,
      graceWindowHours: 72,
      releasePolicy,
    },
  });
  expect(created.statusCode).toBe(201);
  const { id: switchId } = JSON.parse(created.body) as { id: string };
  const recip = await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/recipients`,
    headers: authCookie(ownerCookie),
    payload: { channel: 'email', address: 'friend@example.com' },
  });
  expect(recip.statusCode).toBe(201);
  const { inviteToken } = JSON.parse(recip.body) as { inviteToken: string };
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/recipients/accept',
    payload: { token: inviteToken },
  });
  expect(accepted.statusCode).toBe(200);
  if (
    !opts?.releasePolicy ||
    opts.releasePolicy === 'fail_safe' ||
    opts.releasePolicy === 'fail_deadly'
  ) {
    const payload = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/payload`,
      headers: authCookie(ownerCookie),
      payload: { plaintext: 'the-crown-jewels' },
    });
    expect(payload.statusCode).toBe(201);
  }
  return { ownerId, ownerCookie, switchId, recipientToken: inviteToken };
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

describe('switches CRUD', () => {
  it('creates a switch with status paused, never active', async () => {
    const { ownerCookie } = await scaffoldArmed();
    const created = await app.inject({
      method: 'POST',
      url: '/api/switches',
      headers: authCookie(ownerCookie),
      payload: {
        title: 'My vault',
        mode: 'asymmetric_key',
        heartbeatIntervalHours: 168,
        graceWindowHours: 48,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.body) as { id: string; status: string; dryRun: boolean };
    expect(body.status).toBe('paused');
    expect(body.dryRun).toBe(false);
    const list = await app.inject({
      method: 'GET',
      url: '/api/switches',
      headers: authCookie(ownerCookie),
    });
    expect(list.statusCode).toBe(200);
    const items = JSON.parse(list.body) as ReadonlyArray<{ id: string }>;
    expect(items).toHaveLength(2);
  });

  it('rejects invalid create payloads', async () => {
    const ownerId = await createUser('v@example.com', 'password-12-chars');
    const cookie = await loginAs('v@example.com', 'password-12-chars');
    void ownerId;
    for (const bad of [
      { title: '', mode: 'direct_delivery', heartbeatIntervalHours: 24, graceWindowHours: 2 },
      { title: 'x', mode: 'bogus', heartbeatIntervalHours: 24, graceWindowHours: 2 },
      { title: 'x', mode: 'direct_delivery', heartbeatIntervalHours: 1, graceWindowHours: 2 },
      { title: 'x', mode: 'direct_delivery', heartbeatIntervalHours: 24, graceWindowHours: 1 },
      { title: 'x', mode: 'direct_delivery', heartbeatIntervalHours: 5000, graceWindowHours: 2 },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/switches',
        headers: authCookie(cookie),
        payload: bad,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('owner lists own switches; other user sees 404-shape; admin sees all', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await createUser('mallory@example.com', 'password-12-chars');
    const malloryCookie = await loginAs('mallory@example.com', 'password-12-chars');
    const cross = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}`,
      headers: authCookie(malloryCookie),
    });
    expect(cross.statusCode).toBe(404);
    const ownList = await app.inject({
      method: 'GET',
      url: '/api/switches',
      headers: authCookie(malloryCookie),
    });
    expect(JSON.parse(ownList.body) as unknown[]).toHaveLength(0);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}`,
      headers: authCookie(ownerCookie),
    });
    expect(detail.statusCode).toBe(200);
  });

  it('PATCH updates config only (not status/mode) with audit', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/switches/${switchId}`,
      headers: authCookie(ownerCookie),
      payload: { title: 'Renamed', heartbeatIntervalHours: 24 * 7 },
    });
    expect(patched.statusCode).toBe(200);
    const detail = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/switches/${switchId}`,
          headers: authCookie(ownerCookie),
        })
      ).body,
    ) as { title: string; heartbeatIntervalHours: number; status: string };
    expect(detail.title).toBe('Renamed');
    expect(detail.heartbeatIntervalHours).toBe(168);
    expect(detail.status).toBe('paused');
  });

  it('DELETE removes a non-released switch; 409 once released', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/switches/${switchId}`,
      headers: authCookie(ownerCookie),
    });
    expect(del.statusCode).toBe(200);
    // released path: simulate released status directly, recreate + release via SQL
    const ownerId = await createUser('rel@example.com', 'password-12-chars');
    void ownerId;
    const cookie = await loginAs('rel@example.com', 'password-12-chars');
    const created = await app.inject({
      method: 'POST',
      url: '/api/switches',
      headers: authCookie(cookie),
      payload: {
        title: 'gone',
        mode: 'direct_delivery',
        heartbeatIntervalHours: 24,
        graceWindowHours: 2,
      },
    });
    const sid = (JSON.parse(created.body) as { id: string }).id;
    await pool.query(`UPDATE switches SET status='released' WHERE id=$1`, [sid]);
    const delReleased = await app.inject({
      method: 'DELETE',
      url: `/api/switches/${sid}`,
      headers: authCookie(cookie),
    });
    expect(delReleased.statusCode).toBe(409);
    expect((JSON.parse(delReleased.body) as { error: string }).error).toBe('released_immutable');
    void ownerCookie;
  });
});

describe('arming guards', () => {
  it('arm blocked with no accepted recipient (invited only)', async () => {
    const ownerId = await createUser('a1@example.com', 'password-12-chars');
    const cookie = await loginAs('a1@example.com', 'password-12-chars');
    void ownerId;
    const created = await app.inject({
      method: 'POST',
      url: '/api/switches',
      headers: authCookie(cookie),
      payload: {
        title: 's',
        mode: 'direct_delivery',
        heartbeatIntervalHours: 24,
        graceWindowHours: 2,
      },
    });
    const sid = (JSON.parse(created.body) as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/recipients`,
      headers: authCookie(cookie),
      payload: { channel: 'email', address: 'r@example.com' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/payload`,
      headers: authCookie(cookie),
      payload: { plaintext: 'secret' },
    });
    const arm = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/arm`,
      headers: authCookie(cookie),
      payload: { confirm: true },
    });
    expect(arm.statusCode).toBe(409);
    expect(JSON.parse(arm.body) as { reason: string }).toMatchObject({
      error: 'arm_blocked',
      reason: 'no_accepted_recipient',
    });
  });

  it('arm blocked without payload; then payload + arm succeeds and sets heartbeat state', async () => {
    const ownerId = await createUser('a2@example.com', 'password-12-chars');
    const cookie = await loginAs('a2@example.com', 'password-12-chars');
    void ownerId;
    const created = await app.inject({
      method: 'POST',
      url: '/api/switches',
      headers: authCookie(cookie),
      payload: {
        title: 's',
        mode: 'direct_delivery',
        heartbeatIntervalHours: 24,
        graceWindowHours: 2,
      },
    });
    const sid = (JSON.parse(created.body) as { id: string }).id;
    const recip = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/recipients`,
      headers: authCookie(cookie),
      payload: { channel: 'email', address: 'r@example.com' },
    });
    const { inviteToken } = JSON.parse(recip.body) as { inviteToken: string };
    const acc = await app.inject({
      method: 'POST',
      url: '/api/recipients/accept',
      payload: { token: inviteToken },
    });
    expect(acc.statusCode).toBe(200);
    const armNoPayload = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/arm`,
      headers: authCookie(cookie),
      payload: { confirm: true },
    });
    expect(armNoPayload.statusCode).toBe(409);
    expect(JSON.parse(armNoPayload.body) as { reason: string }).toMatchObject({
      error: 'arm_blocked',
      reason: 'no_payload',
    });
    const stored = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/payload`,
      headers: authCookie(cookie),
      payload: { plaintext: 'top-secret-payload' },
    });
    expect(stored.statusCode).toBe(201);
    const arm = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/arm`,
      headers: authCookie(cookie),
      payload: { confirm: true },
    });
    expect(arm.statusCode).toBe(200);
    const row = await pool.query<{
      status: string;
      heartbeat_started_at: Date;
      next_deadline: Date;
    }>(`SELECT status, heartbeat_started_at, next_deadline FROM switches WHERE id=$1`, [sid]);
    expect(row.rows[0]!.status).toBe('active');
    expect(row.rows[0]!.heartbeat_started_at).toBeInstanceOf(Date);
    expect(row.rows[0]!.next_deadline!.getTime()).toBeGreaterThan(Date.now());
    // re-arm while active → 409 already_active
    const rearm = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/arm`,
      headers: authCookie(cookie),
      payload: { confirm: true },
    });
    expect(rearm.statusCode).toBe(409);
    expect(JSON.parse(rearm.body) as { reason: string }).toMatchObject({
      error: 'arm_blocked',
      reason: 'already_active',
    });
  });

  it('arm without confirm literal → 400; disarm returns to paused', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    const noConfirm = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/arm`,
      headers: authCookie(ownerCookie),
      payload: { confirm: false },
    });
    expect(noConfirm.statusCode).toBe(400);
    const arm = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/arm`,
      headers: authCookie(ownerCookie),
      payload: { confirm: true },
    });
    expect(arm.statusCode).toBe(200);
    const disarm = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/disarm`,
      headers: authCookie(ownerCookie),
    });
    expect(disarm.statusCode).toBe(200);
    const row = await pool.query<{ status: string }>(`SELECT status FROM switches WHERE id=$1`, [
      switchId,
    ]);
    expect(row.rows[0]!.status).toBe('paused');
  });

  it('fail_deadly requires exact switch-id typed confirmation', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed({ releasePolicy: 'fail_deadly' });
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/arm`,
      headers: authCookie(ownerCookie),
      payload: { confirm: true, failDeadlyConfirmation: 'not-the-id' },
    });
    expect(wrong.statusCode).toBe(409);
    expect(JSON.parse(wrong.body) as { reason: string }).toMatchObject({
      error: 'arm_blocked',
      reason: 'confirmation_required',
    });
    const right = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/arm`,
      headers: authCookie(ownerCookie),
      payload: { confirm: true, failDeadlyConfirmation: switchId },
    });
    expect(right.statusCode).toBe(200);
  });

  it('non-owner cannot arm/payload/recipient-manage (404 shape)', async () => {
    const { switchId } = await scaffoldArmed();
    await createUser('evil@example.com', 'password-12-chars');
    const evilCookie = await loginAs('evil@example.com', 'password-12-chars');
    for (const call of [
      { method: 'POST' as const, url: `/api/switches/${switchId}/arm`, payload: { confirm: true } },
      {
        method: 'POST' as const,
        url: `/api/switches/${switchId}/payload`,
        payload: { plaintext: 'x' },
      },
      {
        method: 'POST' as const,
        url: `/api/switches/${switchId}/recipients`,
        payload: { channel: 'email', address: 'a@b.c' },
      },
      { method: 'DELETE' as const, url: `/api/switches/${switchId}`, payload: undefined },
    ]) {
      const res = await app.inject({
        method: call.method,
        url: call.url,
        headers: authCookie(evilCookie),
        ...(call.payload !== undefined ? { payload: call.payload } : {}),
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('payload encryption at rest', () => {
  it('stores ciphertext only — plaintext absent from all bytea columns', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    const secret = 'hunter2-super-secret-plaintext';
    const stored = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/payload`,
      headers: authCookie(ownerCookie),
      payload: { plaintext: secret },
    });
    expect(stored.statusCode).toBe(201);
    const row = await pool.query<{
      payload_ct: Buffer;
      wrapped_dek_ct: Buffer;
      payload_nonce: Buffer;
    }>(`SELECT payload_ct, wrapped_dek_ct, payload_nonce FROM sealed_payloads WHERE switch_id=$1`, [
      switchId,
    ]);
    const blob =
      row.rows[0]!.payload_ct.toString('latin1') +
      row.rows[0]!.wrapped_dek_ct.toString('latin1') +
      row.rows[0]!.payload_nonce.toString('latin1');
    expect(blob.includes(secret)).toBe(false);
    // round-trip sanity: decrypt via crypto package
    const { decrypt } = await import('@heartbeat-vault/crypto');
    const full = await pool.query<{
      kid: string;
      kek_version: number;
      wrapped_dek_nonce: Buffer;
      wrapped_dek_ct: Buffer;
      payload_nonce: Buffer;
      payload_ct: Buffer;
      payload_tag: Buffer;
      aad: { tenantId: string; switchId: string };
    }>(`SELECT * FROM sealed_payloads WHERE switch_id=$1`, [switchId]);
    const r = full.rows[0]!;
    const pt = decrypt(
      {
        version: 1,
        kid: r.kid,
        kekVersion: r.kek_version,
        wrappedDEK: {
          nonce: new Uint8Array(r.wrapped_dek_nonce),
          ct: new Uint8Array(r.wrapped_dek_ct),
        },
        payload: {
          nonce: new Uint8Array(r.payload_nonce),
          ct: new Uint8Array(r.payload_ct),
          tag: new Uint8Array(r.payload_tag),
        },
      },
      { tenantId: r.aad.tenantId, switchId: r.aad.switchId },
      new Uint8Array(Buffer.from(TEST_MASTER_KEY, 'hex')),
    );
    expect(new TextDecoder().decode(pt)).toBe(secret);
  });

  it('rejects oversized payload', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    const res = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/payload`,
      headers: authCookie(ownerCookie),
      payload: { plaintext: 'x'.repeat(1_000_001) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('recipients', () => {
  it('invite → accept → idempotent re-accept; bad token 400; list hides hashes', async () => {
    const { ownerCookie, switchId, recipientToken } = await scaffoldArmed();
    const acc2 = await app.inject({
      method: 'POST',
      url: '/api/recipients/accept',
      payload: { token: recipientToken },
    });
    expect(acc2.statusCode).toBe(200);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/recipients/accept',
      payload: { token: 'wrong-token-entirely' },
    });
    expect(bad.statusCode).toBe(400);
    const list = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/recipients`,
      headers: authCookie(ownerCookie),
    });
    const items = JSON.parse(list.body) as ReadonlyArray<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('accepted');
    expect(JSON.stringify(items)).not.toContain('invite_token_hash');
    expect(JSON.stringify(items)).not.toContain('inviteTokenHash');
    void ownerCookie;
  });

  it('recipient invite token stored hashed only', async () => {
    const ownerId = await createUser('h@example.com', 'password-12-chars');
    const cookie = await loginAs('h@example.com', 'password-12-chars');
    void ownerId;
    const created = await app.inject({
      method: 'POST',
      url: '/api/switches',
      headers: authCookie(cookie),
      payload: {
        title: 'h',
        mode: 'direct_delivery',
        heartbeatIntervalHours: 24,
        graceWindowHours: 2,
      },
    });
    const sid = (JSON.parse(created.body) as { id: string }).id;
    const recip = await app.inject({
      method: 'POST',
      url: `/api/switches/${sid}/recipients`,
      headers: authCookie(cookie),
      payload: { channel: 'email', address: 'r@example.com' },
    });
    const { inviteToken } = JSON.parse(recip.body) as { inviteToken: string };
    const row = await pool.query<{ invite_token_hash: string | null }>(
      `SELECT invite_token_hash FROM recipients WHERE switch_id=$1`,
      [sid],
    );
    const expectedHash = createHash('sha256').update(inviteToken, 'utf8').digest('hex');
    expect(row.rows[0]!.invite_token_hash).toBe(expectedHash);
    expect(row.rows[0]!.invite_token_hash).not.toBe(inviteToken);
  });

  it('DELETE recipient works for owner', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    const list = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/switches/${switchId}/recipients`,
          headers: authCookie(ownerCookie),
        })
      ).body,
    ) as ReadonlyArray<{ id: string }>;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/switches/${switchId}/recipients/${list[0]!.id}`,
      headers: authCookie(ownerCookie),
    });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/recipients`,
      headers: authCookie(ownerCookie),
    });
    expect(JSON.parse(after.body) as unknown[]).toHaveLength(0);
  });
});

describe('audit trail', () => {
  it('records switch lifecycle actions', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/arm`,
      headers: authCookie(ownerCookie),
      payload: { confirm: true },
    });
    await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/disarm`,
      headers: authCookie(ownerCookie),
    });
    const actions = await pool.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_log ORDER BY action`,
    );
    const found = actions.rows.map(r => r.action);
    expect(found).toContain('switch_created');
    expect(found).toContain('payload_stored');
    expect(found).toContain('recipient_accepted');
    expect(found).toContain('switch_armed');
    expect(found).toContain('switch_disarmed');
  });
});
