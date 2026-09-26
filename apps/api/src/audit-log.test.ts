import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.js';
import { resetRateLimitForTests } from './lib/rate-limit.js';
import { parseAuditPage } from './audit-log.test-support.js';

// allow: SIZE_OK — one Testcontainers lifecycle keeps the audit API contract deterministic.
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
      scheduler_heartbeat, app_config, recovery_codes, webauthn_credentials, users CASCADE`);
}

async function createUser(
  email: string,
  role = 'user',
): Promise<{ readonly id: string; readonly cookie: string }> {
  const password = 'password-12-chars';
  const { hashPassword } = await import('@heartbeat-vault/crypto');
  const passwordHash = await hashPassword(password);
  const created = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id`,
    [email, passwordHash, role],
  );
  const id = created.rows[0]?.id;
  if (!id) throw new Error('Expected user ID');
  const loggedIn = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password },
  });
  expect(loggedIn.statusCode).toBe(200);
  const header = loggedIn.headers['set-cookie'];
  const value = Array.isArray(header) ? header.join('; ') : header;
  const match = value?.match(/__Host-session=([^;]+)/);
  if (!match?.[1]) throw new Error('Expected session cookie');
  return { id, cookie: `__Host-session=${match[1]}` };
}

async function createSwitch(ownerId: string): Promise<string> {
  const created = await pool.query<{ id: string }>(
    `INSERT INTO switches (owner_id, title, mode, status, heartbeat_interval, grace_window, dry_run, release_policy)
     VALUES ($1,$2,'direct_delivery','paused',INTERVAL '24 hours',INTERVAL '1 hour',false,'fail_safe')
     RETURNING id`,
    [ownerId, `switch-${ownerId}`],
  );
  const id = created.rows[0]?.id;
  if (!id) throw new Error('Expected switch ID');
  return id;
}

async function insertAudit(input: {
  readonly actorId?: string | null;
  readonly action: string;
  readonly target?: string | null;
  readonly details?: Record<string, unknown> | null;
  readonly timestamp?: string;
}): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO audit_log (ts, actor_id, action, target, ip, request_id, details, prev_hash, hash)
     VALUES (COALESCE($1::timestamptz, clock_timestamp()),$2,$3,$4,'192.0.2.1','request-secret',$5,decode('00', 'hex'),decode('01', 'hex')) RETURNING id`,
    [
      input.timestamp ?? null,
      input.actorId ?? null,
      input.action,
      input.target ?? null,
      input.details === undefined ? {} : input.details,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('Expected audit ID');
  return id;
}

describe('audit read APIs', () => {
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
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    resetRateLimitForTests();
    await truncateAll(pool);
  });

  it('returns a switch audit page to its owner or an admin, ordered newest first and redacted', async () => {
    // Given
    const owner = await createUser('owner@example.com');
    const admin = await createUser('admin@example.com', 'admin');
    const switchId = await createSwitch(owner.id);
    const firstId = await insertAudit({
      actorId: owner.id,
      action: 'switch_created',
      target: switchId,
    });
    const secondId = await insertAudit({
      actorId: owner.id,
      action: 'switch_armed',
      target: switchId,
    });

    // When
    const ownerResponse = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/audit`,
      headers: { cookie: owner.cookie },
    });
    const adminResponse = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/audit`,
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(ownerResponse.statusCode).toBe(200);
    expect(adminResponse.statusCode).toBe(200);
    const page = parseAuditPage(ownerResponse);
    expect(page.items.map(item => item.id)).toEqual([secondId, firstId]);
    expect(page.items[0]).toEqual({
      id: secondId,
      timestamp: expect.any(String),
      actorId: owner.id,
      actorEmail: 'owner@example.com',
      action: 'switch_armed',
      target: switchId,
      category: 'switch',
      details: {},
    });
    expect(ownerResponse.body).not.toContain('192.0.2.1');
    expect(ownerResponse.body).not.toContain('request-secret');
    expect(ownerResponse.body).not.toContain('prevHash');
    expect(ownerResponse.body).not.toContain('hash');
  });

  it('hides inaccessible or malformed switches and rejects invalid pagination before querying', async () => {
    // Given
    const owner = await createUser('owner@example.com');
    const other = await createUser('other@example.com');
    const switchId = await createSwitch(owner.id);

    // When
    const crossOwner = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/audit`,
      headers: { cookie: other.cookie },
    });
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/switches/not-a-uuid/audit',
      headers: { cookie: owner.cookie },
    });
    const badQuery = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/audit?limit=101`,
      headers: { cookie: owner.cookie },
    });

    // Then
    expect(crossOwner).toMatchObject({ statusCode: 404, json: expect.any(Function) });
    expect(crossOwner.json()).toEqual({ error: 'not_found' });
    expect(malformed).toMatchObject({ statusCode: 404, json: expect.any(Function) });
    expect(malformed.json()).toEqual({ error: 'not_found' });
    expect(badQuery).toMatchObject({ statusCode: 400, json: expect.any(Function) });
    expect(badQuery.json()).toEqual({ error: 'invalid_request' });
  });

  it('paginates scoped switch history without mutating the audit log', async () => {
    // Given
    const owner = await createUser('owner@example.com');
    const switchId = await createSwitch(owner.id);
    const firstId = await insertAudit({ actorId: owner.id, action: 'first', target: switchId });
    const secondId = await insertAudit({ actorId: owner.id, action: 'second', target: switchId });
    const thirdId = await insertAudit({ actorId: owner.id, action: 'third', target: switchId });
    await insertAudit({ actorId: owner.id, action: 'unrelated', target: 'another-target' });
    const countBefore = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM audit_log',
    );

    // When
    const firstPageResponse = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/audit?limit=2`,
      headers: { cookie: owner.cookie },
    });
    const firstPage = parseAuditPage(firstPageResponse);
    const secondPageResponse = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/audit?limit=2&beforeId=${firstPage.nextBeforeId}`,
      headers: { cookie: owner.cookie },
    });

    // Then
    expect(firstPage.items.map(item => item.id)).toEqual([thirdId, secondId]);
    expect(firstPage.nextBeforeId).toBe(secondId);
    expect(parseAuditPage(secondPageResponse).items.map(item => item.id)).toEqual([firstId]);
    const exactPageResponse = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/audit?limit=3`,
      headers: { cookie: owner.cookie },
    });
    expect(parseAuditPage(exactPageResponse).nextBeforeId).toBeNull();
    const countAfter = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM audit_log',
    );
    expect(countAfter.rows[0]?.count).toBe(countBefore.rows[0]?.count);
  });

  it('enforces the global audit admin matrix and supports category, query, and cursor filters', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');
    const user = await createUser('member@example.com');
    const switchId = await createSwitch(user.id);
    const matchingId = await insertAudit({
      actorId: user.id,
      action: 'switch_armed',
      target: switchId,
    });
    await insertAudit({ actorId: null, action: 'auth_login', target: 'other-target' });

    // When
    const anonymous = await app.inject({ method: 'GET', url: '/api/audit-log' });
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/audit-log',
      headers: { cookie: user.cookie },
    });
    const filtered = await app.inject({
      method: 'GET',
      url: '/api/audit-log?category=switch&q=MEMBER&limit=1',
      headers: { cookie: admin.cookie },
    });
    const fallback = await app.inject({
      method: 'GET',
      url: '/api/audit-log?q=other-target',
      headers: { cookie: admin.cookie },
    });
    const rejectedActionFilter = await app.inject({
      method: 'GET',
      url: '/api/audit-log?action=switch_armed',
      headers: { cookie: admin.cookie },
    });
    const badQuery = await app.inject({
      method: 'GET',
      url: '/api/audit-log?q=',
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(anonymous.json()).toEqual({ error: 'unauthorized' });
    expect(forbidden.json()).toEqual({ error: 'forbidden' });
    expect(filtered.statusCode).toBe(200);
    expect(parseAuditPage(filtered).items.map(item => item.id)).toEqual([matchingId]);
    expect(filtered.body).not.toContain('192.0.2.1');
    expect(filtered.body).not.toContain('request-secret');
    expect(parseAuditPage(fallback).items[0]).toMatchObject({
      actorId: null,
      actorEmail: null,
      action: 'auth_login',
    });
    expect(rejectedActionFilter).toMatchObject({ statusCode: 400, json: expect.any(Function) });
    expect(rejectedActionFilter.json()).toEqual({ error: 'invalid_request' });
    expect(badQuery).toMatchObject({ statusCode: 400, json: expect.any(Function) });
    expect(badQuery.json()).toEqual({ error: 'invalid_request' });
  });

  it('derives categories at read time and filters the global audit page by category', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');
    const categoryActions = [
      ['auth_login', 'auth'],
      ['switch_armed', 'switch'],
      ['account_password_changed', 'account'],
      ['admin_settings_updated', 'admin'],
      ['invite_created', 'invite'],
      ['2fa_totp_enabled', '2fa'],
      ['trigger_panicked', 'trigger'],
      ['quorum_vote_recorded', 'trigger'],
      ['heartbeat_checked_in', 'heartbeat'],
      ['delivery_succeeded', 'delivery'],
      ['unclassified_event', 'system'],
    ] as const;
    for (const [action] of categoryActions) await insertAudit({ action });

    // When
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit-log?category=trigger',
      headers: { cookie: admin.cookie },
    });
    const derivedCategories = new Map<string, string>();
    for (const category of [...new Set(categoryActions.map(([, value]) => value))]) {
      const categoryResponse = await app.inject({
        method: 'GET',
        url: `/api/audit-log?category=${category}&limit=100`,
        headers: { cookie: admin.cookie },
      });
      for (const item of parseAuditPage(categoryResponse).items) {
        derivedCategories.set(item.action, item.category);
      }
    }

    // Then
    expect(response.statusCode).toBe(200);
    expect(parseAuditPage(response).items.map(item => [item.action, item.category])).toEqual([
      ['quorum_vote_recorded', 'trigger'],
      ['trigger_panicked', 'trigger'],
    ]);
    expect(
      categoryActions.map(([action, category]) => derivedCategories.get(action) === category),
    ).toEqual(categoryActions.map(() => true));
  });

  it('applies inclusive UTC date filters and rejects invalid or reversed audit ranges', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');
    const from = '2026-09-01T00:00:00.000Z';
    const to = '2026-09-01T01:00:00.000Z';
    const firstId = await insertAudit({ action: 'auth_first', timestamp: from });
    const lastId = await insertAudit({ action: 'auth_last', timestamp: to });
    await insertAudit({ action: 'auth_after', timestamp: '2026-09-01T01:00:00.001Z' });

    // When
    const ranged = await app.inject({
      method: 'GET',
      url: `/api/audit-log?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie: admin.cookie },
    });
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/audit-log?from=not-a-date',
      headers: { cookie: admin.cookie },
    });
    const reversed = await app.inject({
      method: 'GET',
      url: `/api/audit-log?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`,
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(parseAuditPage(ranged).items.map(item => item.id)).toEqual([lastId, firstId]);
    expect(invalid.json()).toEqual({ error: 'invalid_request' });
    expect(reversed.json()).toEqual({ error: 'invalid_request' });
  });

  it('composes category and date filters with scoped switch history', async () => {
    // Given
    const owner = await createUser('owner@example.com');
    const switchId = await createSwitch(owner.id);
    const from = '2026-09-01T00:00:00.000Z';
    const to = '2026-09-01T01:00:00.000Z';
    const matchingId = await insertAudit({
      actorId: owner.id,
      action: 'switch_armed',
      target: switchId,
      timestamp: from,
    });
    await insertAudit({
      actorId: owner.id,
      action: 'switch_paused',
      target: switchId,
      timestamp: '2026-09-01T01:00:00.001Z',
    });
    await insertAudit({
      actorId: owner.id,
      action: 'auth_login',
      target: switchId,
      timestamp: from,
    });

    // When
    const response = await app.inject({
      method: 'GET',
      url: `/api/switches/${switchId}/audit?category=switch&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie: owner.cookie },
    });

    // Then
    expect(parseAuditPage(response).items.map(item => item.id)).toEqual([matchingId]);
  });

  it('returns details as an object and normalizes legacy null details', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');
    await pool.query('ALTER TABLE audit_log ALTER COLUMN details DROP NOT NULL');
    const legacyId = await insertAudit({ action: 'legacy_event', details: null });
    const detailedId = await insertAudit({
      action: 'admin_settings_updated',
      details: { setting: 'openRegistration', enabled: true },
    });

    // When
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit-log?category=admin',
      headers: { cookie: admin.cookie },
    });
    const legacyResponse = await app.inject({
      method: 'GET',
      url: '/api/audit-log?category=system',
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(parseAuditPage(response).items[0]).toMatchObject({
      id: detailedId,
      category: 'admin',
      details: { setting: 'openRegistration', enabled: true },
    });
    expect(parseAuditPage(legacyResponse).items[0]).toMatchObject({ id: legacyId, details: {} });
  });
});
