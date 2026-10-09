import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { buildServer } from './server.js';
import { resetRateLimitForTests } from './lib/rate-limit.js';
import type { FastifyInstance } from 'fastify';
import { createChannelRegistry, type DeliveryContext } from './channels/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';
const TEST_MASTER_KEY = randomBytes(32).toString('hex');
const serializedSwitchSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
const deliveredTests: DeliveryContext[] = [];
const testRegistry = createChannelRegistry(
  Object.fromEntries(
    ['email', 'webhook', 'telegram'].map(channel => [
      channel,
      {
        async send(context: DeliveryContext) {
          deliveredTests.push(context);
          return { status: 'sent' as const, receipt: `test:${channel}` };
        },
      },
    ]),
  ),
);

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
  app = await buildServer({ pool, channelRegistry: testRegistry });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await truncateAll(pool);
  resetRateLimitForTests();
  deliveredTests.length = 0;
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

  it('returns duplicate_title without an audit row when an owner creates a duplicate title', async () => {
    await createUser('duplicate-create@example.com', 'password-12-chars');
    const ownerCookie = await loginAs('duplicate-create@example.com', 'password-12-chars');
    const payload = {
      title: 'Recovery plan',
      mode: 'direct_delivery',
      heartbeatIntervalHours: 24,
      graceWindowHours: 2,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/switches',
          headers: authCookie(ownerCookie),
          payload,
        })
      ).statusCode,
    ).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/switches',
      headers: authCookie(ownerCookie),
      payload,
    });

    expect(duplicate.statusCode).toBe(409);
    expect(JSON.parse(duplicate.body)).toEqual({ error: 'duplicate_title' });
    expect(
      await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_log WHERE action='switch_created'`,
      ),
    ).toMatchObject({ rows: [{ count: '1' }] });
  });

  it('allows different owners to create switches with the same title', async () => {
    await createUser('duplicate-first@example.com', 'password-12-chars');
    await createUser('duplicate-second@example.com', 'password-12-chars');
    const firstCookie = await loginAs('duplicate-first@example.com', 'password-12-chars');
    const secondCookie = await loginAs('duplicate-second@example.com', 'password-12-chars');
    const payload = {
      title: 'Recovery plan',
      mode: 'direct_delivery',
      heartbeatIntervalHours: 24,
      graceWindowHours: 2,
    };

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/switches',
          headers: authCookie(firstCookie),
          payload,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/switches',
          headers: authCookie(secondCookie),
          payload,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('duplicates configuration as a paused template without operational state', async () => {
    const { ownerCookie, switchId: sourceId } = await scaffoldArmed({ mode: 'asymmetric_key' });
    const trigger = await app.inject({
      method: 'POST',
      url: `/api/switches/${sourceId}/trigger`,
      headers: authCookie(ownerCookie),
      payload: { type: 'quorum', threshold: 3 },
    });
    expect(trigger.statusCode).toBe(200);
    await pool.query(
      `UPDATE switches
       SET status='active', heartbeat_token_hash='source-token-hash',
           dry_run=true, release_policy='fail_deadly',
           heartbeat_started_at=clock_timestamp(), next_deadline=clock_timestamp() + interval '1 day'
       WHERE id=$1`,
      [sourceId],
    );
    await pool.query(
      `INSERT INTO heartbeat_links (switch_id, token_hash, expires_at)
       VALUES ($1, 'source-link-hash', clock_timestamp() + interval '1 day')`,
      [sourceId],
    );
    await pool.query(`INSERT INTO heartbeats (switch_id, method) VALUES ($1, 'api')`, [sourceId]);
    await pool.query(
      `INSERT INTO trigger_jobs (switch_id, deadline_at, idempotency_key)
       VALUES ($1, clock_timestamp(), 'source-trigger-job')`,
      [sourceId],
    );

    const duplicated = await app.inject({
      method: 'POST',
      url: `/api/switches/${sourceId}/duplicate`,
      headers: authCookie(ownerCookie),
      payload: { title: 'Copied template' },
    });

    expect(duplicated.statusCode).toBe(201);
    const body = JSON.parse(duplicated.body) as { id: string; status: string; dryRun: boolean };
    expect(body.status).toBe('paused');
    expect(body.dryRun).toBe(true);
    const source = await pool.query<{
      owner_id: string;
      mode: string;
      heartbeat_interval: string;
      grace_window: string;
      dry_run: boolean;
      release_policy: string;
      trigger_type: string;
      quorum_threshold: number | null;
    }>(
      `SELECT owner_id, mode, heartbeat_interval::text, grace_window::text, dry_run, release_policy,
              trigger_type, quorum_threshold
       FROM switches WHERE id=$1`,
      [sourceId],
    );
    const target = await pool.query<{
      owner_id: string;
      title: string;
      mode: string;
      status: string;
      heartbeat_interval: string;
      grace_window: string;
      dry_run: boolean;
      release_policy: string;
      trigger_type: string;
      quorum_threshold: number | null;
      heartbeat_token_hash: string | null;
      heartbeat_started_at: Date | null;
      next_deadline: Date | null;
      fire_at: Date | null;
    }>(
      `SELECT owner_id, title, mode, status, heartbeat_interval::text, grace_window::text, dry_run,
              release_policy, trigger_type, quorum_threshold, heartbeat_token_hash,
              heartbeat_started_at, next_deadline, fire_at
       FROM switches WHERE id=$1`,
      [body.id],
    );
    expect(target.rows[0]).toMatchObject({
      owner_id: source.rows[0]!.owner_id,
      title: 'Copied template',
      mode: source.rows[0]!.mode,
      status: 'paused',
      heartbeat_interval: source.rows[0]!.heartbeat_interval,
      grace_window: source.rows[0]!.grace_window,
      dry_run: source.rows[0]!.dry_run,
      release_policy: source.rows[0]!.release_policy,
      trigger_type: source.rows[0]!.trigger_type,
      quorum_threshold: source.rows[0]!.quorum_threshold,
      heartbeat_token_hash: null,
      heartbeat_started_at: null,
      next_deadline: null,
      fire_at: null,
    });

    for (const table of [
      'sealed_payloads',
      'recipients',
      'heartbeat_links',
      'heartbeats',
      'trigger_jobs',
    ]) {
      const count = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE switch_id=$1`,
        [body.id],
      );
      expect(count.rows[0]!.count).toBe('0');
    }
    const audit = await pool.query<{ actor_id: string; details: Record<string, unknown> }>(
      `SELECT actor_id, details FROM audit_log WHERE action='switch_created' AND target=$1`,
      [body.id],
    );
    expect(audit.rows[0]).toMatchObject({
      actor_id: source.rows[0]!.owner_id,
      details: expect.objectContaining({ duplicatedFrom: sourceId }),
    });
  });

  it('applies create title validation and owner uniqueness to duplication', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    for (const title of ['', 'x'.repeat(201)]) {
      const invalid = await app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/duplicate`,
        headers: authCookie(ownerCookie),
        payload: { title },
      });
      expect(invalid.statusCode).toBe(400);
    }
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/duplicate`,
      headers: authCookie(ownerCookie),
      payload: { title: 'Test switch' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(JSON.parse(duplicate.body)).toEqual({ error: 'duplicate_title' });
  });

  it('hides missing and foreign duplicate sources, while admins duplicate as themselves', async () => {
    const { ownerId, switchId } = await scaffoldArmed();
    await createUser('mallory-duplicate@example.com', 'password-12-chars');
    const malloryCookie = await loginAs('mallory-duplicate@example.com', 'password-12-chars');
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/duplicate`,
      headers: authCookie(malloryCookie),
      payload: { title: 'Foreign copy' },
    });
    expect(foreign.statusCode).toBe(404);
    expect(JSON.parse(foreign.body)).toEqual({ error: 'not_found' });

    const missing = await app.inject({
      method: 'POST',
      url: `/api/switches/00000000-0000-0000-0000-000000000000/duplicate`,
      headers: authCookie(malloryCookie),
      payload: { title: 'Missing copy' },
    });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: 'not_found' });

    await createUser('admin-duplicate@example.com', 'password-12-chars', 'admin');
    const adminCookie = await loginAs('admin-duplicate@example.com', 'password-12-chars');
    const admin = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/duplicate`,
      headers: authCookie(adminCookie),
      payload: { title: 'Admin copy' },
    });
    expect(admin.statusCode).toBe(201);
    const adminCopy = JSON.parse(admin.body) as { id: string };
    const owner = await pool.query<{ id: string }>(
      `SELECT owner_id AS id FROM switches WHERE id=$1`,
      [adminCopy.id],
    );
    const adminUser = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [
      'admin-duplicate@example.com',
    ]);
    expect(owner.rows[0]!.id).toBe(adminUser.rows[0]!.id);
    void ownerId;
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

  it('serializes created and updated timestamps on list and detail reads', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    const createdAt = '2026-01-02T03:04:05.000Z';
    const updatedAt = '2026-02-03T04:05:06.000Z';
    await pool.query(`UPDATE switches SET created_at=$1, updated_at=$2 WHERE id=$3`, [
      createdAt,
      updatedAt,
      switchId,
    ]);

    const list = await app.inject({
      method: 'GET',
      url: '/api/switches',
      headers: authCookie(ownerCookie),
    });
    expect(list.statusCode).toBe(200);
    const listItems = z.array(serializedSwitchSchema).parse(JSON.parse(list.body));
    expect(listItems).toContainEqual(
      expect.objectContaining({ id: switchId, createdAt, updatedAt }),
    );

    const detail = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}`,
      headers: authCookie(ownerCookie),
    });
    expect(detail.statusCode).toBe(200);
    expect(serializedSwitchSchema.parse(JSON.parse(detail.body))).toMatchObject({
      id: switchId,
      createdAt,
      updatedAt,
    });
  });

  it('includes owner email only on an administrator all-switch list', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await createUser('admin@example.com', 'password-12-chars', 'admin');
    const adminCookie = await loginAs('admin@example.com', 'password-12-chars');

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/switches?all=1',
      headers: authCookie(adminCookie),
    });
    expect(adminList.statusCode).toBe(200);
    const adminItems = z
      .array(serializedSwitchSchema.extend({ ownerEmail: z.string().email() }))
      .parse(JSON.parse(adminList.body));
    expect(adminItems).toContainEqual(
      expect.objectContaining({ id: switchId, ownerEmail: 'owner@example.com' }),
    );

    const ownerAllList = await app.inject({
      method: 'GET',
      url: '/api/switches?all=1',
      headers: authCookie(ownerCookie),
    });
    expect(ownerAllList.statusCode).toBe(200);
    const ownerItems = z
      .array(z.record(z.string(), z.unknown()))
      .parse(JSON.parse(ownerAllList.body));
    expect(ownerItems).toHaveLength(1);
    expect(ownerItems[0]).not.toHaveProperty('ownerEmail');

    const adminDetail = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}`,
      headers: authCookie(adminCookie),
    });
    expect(adminDetail.statusCode).toBe(200);
    const detail = z.record(z.string(), z.unknown()).parse(JSON.parse(adminDetail.body));
    expect(detail).not.toHaveProperty('ownerEmail');
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

  it('returns duplicate_title without an audit row when an owner renames to an existing title', async () => {
    await createUser('duplicate-rename@example.com', 'password-12-chars');
    const ownerCookie = await loginAs('duplicate-rename@example.com', 'password-12-chars');
    const create = async (title: string): Promise<string> => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/switches',
        headers: authCookie(ownerCookie),
        payload: {
          title,
          mode: 'direct_delivery',
          heartbeatIntervalHours: 24,
          graceWindowHours: 2,
        },
      });
      expect(response.statusCode).toBe(201);
      return (JSON.parse(response.body) as { id: string }).id;
    };
    await create('Original title');
    const switchId = await create('Other title');

    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/switches/${switchId}`,
      headers: authCookie(ownerCookie),
      payload: { title: 'Original title' },
    });

    expect(rename.statusCode).toBe(409);
    expect(JSON.parse(rename.body)).toEqual({ error: 'duplicate_title' });
    expect(
      await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_log WHERE action='switch_updated'`,
      ),
    ).toMatchObject({ rows: [{ count: '0' }] });
    expect(
      await pool.query<{ title: string }>(`SELECT title FROM switches WHERE id=$1`, [switchId]),
    ).toMatchObject({ rows: [{ title: 'Other title' }] });
  });

  it('PATCH with no effective changes marks the audit row explicitly', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    const detail = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/switches/${switchId}`,
          headers: authCookie(ownerCookie),
        })
      ).body,
    ) as { title: string; heartbeatIntervalHours: number; graceWindowHours: number };
    const noop = await app.inject({
      method: 'PATCH',
      url: `/api/switches/${switchId}`,
      headers: authCookie(ownerCookie),
      payload: {
        title: detail.title,
        heartbeatIntervalHours: detail.heartbeatIntervalHours,
        graceWindowHours: detail.graceWindowHours,
      },
    });
    expect(noop.statusCode).toBe(200);
    const audit = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action='switch_updated' AND target=$1 ORDER BY id DESC LIMIT 1`,
      [switchId],
    );
    expect(audit.rows[0]!.details).toEqual({ changes: {}, noEffectiveChanges: true });
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

describe('pause-only switch delegates', () => {
  it('owner can grant, list, and revoke a registered delegate by email', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await createUser('delegate@example.com', 'password-12-chars');
    const granted = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(ownerCookie),
      payload: { email: 'delegate@example.com' },
    });
    expect(granted.statusCode).toBe(201);
    const delegationId = (JSON.parse(granted.body) as { id: string }).id;

    const listed = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(ownerCookie),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      expect.objectContaining({ id: delegationId, email: 'delegate@example.com' }),
    ]);

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(ownerCookie),
      payload: { email: 'nobody@example.com' },
    });
    expect(unknown.statusCode).toBe(404);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/switches/${switchId}/delegates/${delegationId}`,
      headers: authCookie(ownerCookie),
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      await pool.query(`SELECT 1 FROM switch_delegations WHERE id=$1`, [delegationId]),
    ).toMatchObject({ rows: [] });
  });

  it('refuses to grant when case-variant accounts make the email ambiguous', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await createUser('User@Example.com', 'password-12-chars');
    await createUser('user@example.com', 'password-12-chars');
    const response = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(ownerCookie),
      payload: { email: 'USER@example.com' },
    });
    expect(response.statusCode).toBe(404);
    expect(
      await pool.query(`SELECT 1 FROM switch_delegations WHERE switch_id=$1`, [switchId]),
    ).toMatchObject({ rows: [] });
  });

  it('delegate can disarm but cannot access owner-only operations', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await createUser('delegate@example.com', 'password-12-chars');
    const delegateId = (
      await pool.query<{ id: string }>(`SELECT id FROM users WHERE email='delegate@example.com'`)
    ).rows[0]!.id;
    const delegateCookie = await loginAs('delegate@example.com', 'password-12-chars');
    const grant = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(ownerCookie),
      payload: { email: 'delegate@example.com' },
    });
    expect(grant.statusCode).toBe(201);

    await pool.query(`UPDATE switches SET status='active' WHERE id=$1`, [switchId]);
    const disarm = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/disarm`,
      headers: authCookie(delegateCookie),
    });
    expect(disarm.statusCode).toBe(200);

    const denied = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/payload`,
        headers: authCookie(delegateCookie),
        payload: { plaintext: 'must stay private' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/recipients`,
        headers: authCookie(delegateCookie),
        payload: { channel: 'email', address: 'leak@example.com' },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/switches/${switchId}`,
        headers: authCookie(delegateCookie),
        payload: { title: 'changed' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/check-in`,
        headers: authCookie(delegateCookie),
      }),
      app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/trigger`,
        headers: authCookie(delegateCookie),
        payload: { type: 'panic', confirm: true },
      }),
    ]);
    expect(denied.map(response => response.statusCode)).toEqual([404, 404, 404, 404, 404]);

    const audit = await pool.query<{ actor_id: string; action: string; details: unknown }>(
      `SELECT actor_id, action, details FROM audit_log
       WHERE target=$1 AND action IN ('delegate_granted','switch_disarmed') ORDER BY id`,
      [switchId],
    );
    expect(audit.rows.map(row => row.action)).toEqual(['delegate_granted', 'switch_disarmed']);
    expect(audit.rows[1]?.actor_id).toBe(delegateId);
    expect(audit.rows[1]?.details).toMatchObject({ delegationId: expect.any(String) });
  });

  it('delegate can cancel a pending trigger and the audit identifies the delegation', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await pool.query(
      `UPDATE switches SET status='active', trigger_type='panic', fire_at=clock_timestamp(),
          heartbeat_started_at=clock_timestamp(), next_deadline=clock_timestamp() + interval '1 day'
       WHERE id=$1`,
      [switchId],
    );
    await createUser('delegate@example.com', 'password-12-chars');
    const delegateId = (
      await pool.query<{ id: string }>(`SELECT id FROM users WHERE email='delegate@example.com'`)
    ).rows[0]!.id;
    const delegateCookie = await loginAs('delegate@example.com', 'password-12-chars');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/switches/${switchId}/delegates`,
          headers: authCookie(ownerCookie),
          payload: { email: 'delegate@example.com' },
        })
      ).statusCode,
    ).toBe(201);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/cancel`,
      headers: authCookie(delegateCookie),
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    const audit = await pool.query<{ actor_id: string; details: unknown }>(
      `SELECT actor_id, details FROM audit_log WHERE action='trigger_cancelled' AND target=$1`,
      [switchId],
    );
    expect(audit.rows[0]?.actor_id).toBe(delegateId);
    expect(audit.rows[0]?.details).toMatchObject({ delegationId: expect.any(String) });
  });

  it('revocation stops access and unrelated users receive a 404', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await createUser('delegate@example.com', 'password-12-chars');
    await createUser('other@example.com', 'password-12-chars');
    const delegateCookie = await loginAs('delegate@example.com', 'password-12-chars');
    const otherCookie = await loginAs('other@example.com', 'password-12-chars');
    const granted = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(ownerCookie),
      payload: { email: 'delegate@example.com' },
    });
    expect(granted.statusCode).toBe(201);
    const delegationId = (JSON.parse(granted.body) as { id: string }).id;
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/switches/${switchId}/delegates/${delegationId}`,
          headers: authCookie(ownerCookie),
        })
      ).statusCode,
    ).toBe(200);

    for (const cookie of [delegateCookie, otherCookie]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/disarm`,
        headers: authCookie(cookie),
      });
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ error: 'not_found' });
    }
  });

  it('only the owner can grant or revoke, and duplicate grants return a conflict', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await createUser('delegate@example.com', 'password-12-chars');
    await createUser('other@example.com', 'password-12-chars');
    const otherCookie = await loginAs('other@example.com', 'password-12-chars');
    const delegateCookie = await loginAs('delegate@example.com', 'password-12-chars');

    const ownerGrant = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(ownerCookie),
      payload: { email: 'delegate@example.com' },
    });
    expect(ownerGrant.statusCode).toBe(201);
    const delegationId = (JSON.parse(ownerGrant.body) as { id: string }).id;

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(ownerCookie),
      payload: { email: 'delegate@example.com' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(JSON.parse(duplicate.body)).toEqual({ error: 'already_delegated' });

    const otherGrant = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(otherCookie),
      payload: { email: 'delegate@example.com' },
    });
    expect(otherGrant.statusCode).toBe(404);
    expect(JSON.parse(otherGrant.body)).toEqual({ error: 'not_found' });

    const delegateGrant = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/delegates`,
      headers: authCookie(delegateCookie),
      payload: { email: 'other@example.com' },
    });
    expect(delegateGrant.statusCode).toBe(404);
    expect(JSON.parse(delegateGrant.body)).toEqual({ error: 'not_found' });

    const otherRevoke = await app.inject({
      method: 'DELETE',
      url: `/api/switches/${switchId}/delegates/${delegationId}`,
      headers: authCookie(otherCookie),
    });
    expect(otherRevoke.statusCode).toBe(404);
    expect(JSON.parse(otherRevoke.body)).toEqual({ error: 'not_found' });
  });

  it('delegate cannot read or mutate any owner-only switch surface', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await createUser('delegate@example.com', 'password-12-chars');
    const delegateCookie = await loginAs('delegate@example.com', 'password-12-chars');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/switches/${switchId}/delegates`,
          headers: authCookie(ownerCookie),
          payload: { email: 'delegate@example.com' },
        })
      ).statusCode,
    ).toBe(201);

    const denied = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/switches/${switchId}`,
        headers: authCookie(delegateCookie),
      }),
      app.inject({
        method: 'GET',
        url: `/api/switches/${switchId}/audit`,
        headers: authCookie(delegateCookie),
      }),
      app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/duplicate`,
        headers: authCookie(delegateCookie),
        payload: { title: 'leak' },
      }),
      app.inject({ method: 'GET', url: '/api/switches', headers: authCookie(delegateCookie) }),
      app.inject({
        method: 'GET',
        url: `/api/switches/${switchId}/recipients`,
        headers: authCookie(delegateCookie),
      }),
      app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/payload`,
        headers: authCookie(delegateCookie),
        payload: { plaintext: 'must stay private' },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/switches/${switchId}`,
        headers: authCookie(delegateCookie),
        payload: { title: 'changed' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/check-in`,
        headers: authCookie(delegateCookie),
      }),
    ]);
    expect(denied.slice(0, 3).map(response => response.statusCode)).toEqual([404, 404, 404]);
    expect(denied.slice(3).map(response => response.statusCode)).toEqual([200, 404, 404, 404, 404]);
  });

  it('delegate cannot cancel a released switch or alter its jobs', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    await createUser('delegate@example.com', 'password-12-chars');
    const delegateCookie = await loginAs('delegate@example.com', 'password-12-chars');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/switches/${switchId}/delegates`,
          headers: authCookie(ownerCookie),
          payload: { email: 'delegate@example.com' },
        })
      ).statusCode,
    ).toBe(201);
    await pool.query(`UPDATE switches SET status='released' WHERE id=$1`, [switchId]);
    await pool.query(
      `INSERT INTO trigger_jobs (switch_id, deadline_at, state, idempotency_key)
       VALUES ($1, clock_timestamp(), 'succeeded', 'released-delegate-job')`,
      [switchId],
    );
    await pool.query(
      `INSERT INTO delivery_jobs (switch_id, channel, available_at, state, idempotency_key)
       VALUES ($1, 'email', clock_timestamp(), 'pending', 'released-delegate-delivery')`,
      [switchId],
    );

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/cancel`,
      headers: authCookie(delegateCookie),
      payload: {},
    });
    expect(cancel.statusCode).toBe(409);
    expect(JSON.parse(cancel.body)).toEqual({ error: 'cancel_blocked', reason: 'released' });
    const state = await pool.query<{ status: string }>(`SELECT status FROM switches WHERE id=$1`, [
      switchId,
    ]);
    const jobs = await pool.query<{ state: string }>(
      `SELECT state FROM delivery_jobs WHERE switch_id=$1`,
      [switchId],
    );
    expect(state.rows[0]!.status).toBe('released');
    expect(jobs.rows[0]!.state).toBe('pending');
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

describe('test release', () => {
  it('sends a marked message through every configured channel without release state or jobs', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    for (const [channel, address] of [
      ['webhook', 'https://recipient.example.test/hook'],
      ['telegram', 'chat-123'],
    ]) {
      const created = await app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/recipients`,
        headers: authCookie(ownerCookie),
        payload: { channel, address },
      });
      const { inviteToken } = JSON.parse(created.body) as { inviteToken: string };
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/recipients/accept',
        payload: { token: inviteToken },
      });
      expect(accepted.statusCode).toBe(200);
    }

    const response = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/test-release`,
      headers: authCookie(ownerCookie),
    });

    expect(response.statusCode).toBe(200);
    expect(deliveredTests).toHaveLength(3);
    expect(deliveredTests.every(context => context.idempotencyKey.startsWith('test:'))).toBe(true);
    expect(deliveredTests.every(context => context.payload.testRelease === true)).toBe(true);
    expect(deliveredTests.every(context => context.payload.message?.startsWith('[TEST]'))).toBe(
      true,
    );
    const status = await pool.query<{ status: string }>('SELECT status FROM switches WHERE id=$1', [
      switchId,
    ]);
    expect(status.rows[0]!.status).toBe('paused');
    expect((await pool.query('SELECT id FROM trigger_jobs')).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM delivery_jobs')).rowCount).toBe(0);
    const audit = await pool.query<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM audit_log WHERE target=$1`,
      [switchId],
    );
    const testAudit = audit.rows.find(row => row.action === 'test_release_sent');
    expect(testAudit?.details).toMatchObject({ channelCount: 3 });
    expect(JSON.stringify(testAudit?.details)).not.toContain('recipient.example.test');
  });

  it('returns the same 404 shape for unknown and non-owner switches', async () => {
    const { switchId } = await scaffoldArmed();
    const otherCookie = await loginAs('other@example.com', 'password-12-chars').catch(() => null);
    if (otherCookie === null) {
      await createUser('other@example.com', 'password-12-chars');
    }
    const cookie = otherCookie ?? (await loginAs('other@example.com', 'password-12-chars'));
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/test-release`,
      headers: authCookie(cookie),
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/switches/00000000-0000-4000-8000-000000000000/test-release',
      headers: authCookie(cookie),
    });
    expect(forbidden.statusCode).toBe(404);
    expect(forbidden.body).toBe(missing.body);
  });

  it('allows three test releases per switch and rejects the fourth', async () => {
    const { ownerCookie, switchId } = await scaffoldArmed();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/switches/${switchId}/test-release`,
        headers: authCookie(ownerCookie),
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: 'POST',
      url: `/api/switches/${switchId}/test-release`,
      headers: authCookie(ownerCookie),
    });
    expect(limited.statusCode).toBe(429);
    expect(JSON.parse(limited.body)).toEqual({ error: 'rate_limited' });
  });
});
