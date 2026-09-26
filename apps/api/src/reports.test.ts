import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.js';
import { resetRateLimitForTests } from './lib/rate-limit.js';

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
    TRUNCATE export_jobs, audit_log, delivery_jobs, vault_waits, trigger_jobs, heartbeats,
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

async function createSwitch(ownerId: string, title = 'export-target'): Promise<string> {
  const created = await pool.query<{ id: string }>(
    `INSERT INTO switches (owner_id, title, mode, status, heartbeat_interval, grace_window, dry_run, release_policy)
     VALUES ($1,$2,'direct_delivery','paused',INTERVAL '24 hours',INTERVAL '1 hour',false,'fail_safe')
     RETURNING id`,
    [ownerId, title],
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
}): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO audit_log (ts, actor_id, action, target, ip, request_id, details, prev_hash, hash)
     VALUES (clock_timestamp(),$1,$2,$3,'192.0.2.1','request-secret',$4,decode('00', 'hex'),decode('01', 'hex')) RETURNING id`,
    [input.actorId ?? null, input.action, input.target ?? null, input.details ?? {}],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('Expected audit ID');
  return id;
}

type LedgerRow = {
  readonly id: string;
  readonly requested_by: string;
  readonly scope_type: string;
  readonly switch_id: string | null;
  readonly format: string;
  readonly filters: Record<string, unknown>;
  readonly row_count: number | null;
  readonly status: string;
  readonly error_code: string | null;
};

async function ledgerRows(): Promise<readonly LedgerRow[]> {
  const result = await pool.query<LedgerRow>(
    `SELECT id, requested_by, scope_type, switch_id, format, filters, row_count,
            status, error_code
     FROM export_jobs ORDER BY created_at DESC, id DESC`,
  );
  return result.rows;
}

function exportBody(
  overrides: Partial<{
    format: string;
    scope: string;
    switchId: string;
    category: string;
    from: string;
    to: string;
  }> = {},
): Record<string, unknown> {
  return { format: 'json', scope: 'global', ...overrides };
}

describe('report exports', () => {
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

  it('streams a filtered global export to administrators and records a successful ledger entry', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');
    const user = await createUser('member@example.com');
    const matchingId = await insertAudit({
      actorId: user.id,
      action: 'switch_armed',
      details: { source: 'test' },
    });
    await insertAudit({ actorId: user.id, action: 'auth_login' });

    // When
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody(),
    });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody(),
      headers: { cookie: user.cookie },
    });
    const exported = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({ category: 'switch' }),
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(anonymous.json()).toEqual({ error: 'unauthorized' });
    expect(forbidden.json()).toEqual({ error: 'forbidden' });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/json');
    expect(exported.headers['content-disposition']).toBe('attachment; filename="audit-log.json"');
    expect(exported.headers['cache-control']).toBe('no-store');
    expect(exported.headers['x-content-type-options']).toBe('nosniff');
    expect(exported.json()).toEqual({
      items: [
        expect.objectContaining({
          id: matchingId,
          category: 'switch',
          details: { source: 'test' },
        }),
      ],
    });
    expect(exported.body).not.toContain('192.0.2.1');
    expect(exported.body).not.toContain('request-secret');

    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      requested_by: admin.id,
      scope_type: 'global',
      switch_id: null,
      format: 'json',
      filters: { category: 'switch' },
      row_count: 1,
      status: 'success',
      error_code: null,
    });
  });

  it('streams CSV without spreadsheet formula interpretation and records the format', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');
    const actor = await createUser('+formula@example.com');
    const auditId = await insertAudit({
      actorId: actor.id,
      action: '=danger,"quoted"',
      target: '\tformula',
      details: null,
    });

    // When
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({ format: 'csv' }),
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe('attachment; filename="audit-log.csv"');
    expect(response.body).toContain(
      '"id","timestamp","category","actorId","actorEmail","action","target","details"\r\n',
    );
    expect(response.body).toContain(`"${auditId}"`);
    expect(response.body).toContain('"\'=danger,""quoted"""');
    expect(response.body).toContain('"\'\tformula"');
    expect(response.body).toContain('"{}"');

    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      format: 'csv',
      status: 'success',
      row_count: 3,
    });
  });

  it('exports a switch-scoped report and records the switch reference', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');
    const owner = await createUser('owner@example.com');
    const switchId = await createSwitch(owner.id, 'legacy-plan');
    const scopedId = await insertAudit({ action: 'switch_armed', target: switchId });
    await insertAudit({ action: 'auth_login' });

    // When
    const exported = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({ scope: 'switch', switchId }),
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toBe(
      'attachment; filename="switch-audit.json"',
    );
    const body = exported.json() as { items: readonly { id: number }[] };
    expect(body.items.map(item => item.id)).toEqual([scopedId]);

    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      scope_type: 'switch',
      switch_id: switchId,
      status: 'success',
      row_count: 1,
    });
  });

  it('rejects malformed export requests before recording anything', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');

    // When
    const missingSwitch = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({ scope: 'switch' }),
      headers: { cookie: admin.cookie },
    });
    const unknownSwitch = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({
        scope: 'switch',
        switchId: '11111111-1111-4111-8111-111111111111',
      }),
      headers: { cookie: admin.cookie },
    });
    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({ format: 'xlsx' }),
      headers: { cookie: admin.cookie },
    });
    const reversedRange = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({
        from: '2026-09-02T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      }),
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(missingSwitch).toMatchObject({ statusCode: 400, json: expect.any(Function) });
    expect(missingSwitch.json()).toEqual({ error: 'invalid_request' });
    expect(unknownSwitch.statusCode).toBe(404);
    expect(unknownSwitch.json()).toEqual({ error: 'not_found' });
    expect(unknownField.statusCode).toBe(400);
    expect(reversedRange.statusCode).toBe(400);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('records a failed ledger entry when the export exceeds the row cap', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');
    await pool.query(`
      INSERT INTO audit_log (action, details, prev_hash, hash)
      SELECT 'delivery_exportable', '{}'::jsonb, decode('00', 'hex'), decode('01', 'hex')
      FROM generate_series(1, 10000)`);

    // When
    const withinLimit = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({ format: 'json', category: 'delivery' }),
      headers: { cookie: admin.cookie },
    });
    await pool.query(
      `INSERT INTO audit_log (action, details, prev_hash, hash)
       VALUES ('delivery_exportable', '{}'::jsonb, decode('00', 'hex'), decode('01', 'hex'))`,
    );
    const overLimit = await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({ format: 'json', category: 'delivery' }),
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(withinLimit.statusCode).toBe(200);
    expect((withinLimit.json() as { items: unknown[] }).items).toHaveLength(10_000);
    expect(overLimit.statusCode).toBe(400);
    expect(overLimit.json()).toEqual({ error: 'export_limit_exceeded' });

    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      status: 'failed',
      error_code: 'export_limit_exceeded',
      row_count: null,
    });
    expect(ledger[1]).toMatchObject({ status: 'success', row_count: 10_000 });
  });

  it('lists export jobs newest first with actor emails, switch titles, and filters', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');
    const owner = await createUser('owner@example.com');
    const switchId = await createSwitch(owner.id, 'history-plan');
    await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({ format: 'csv' }),
      headers: { cookie: admin.cookie },
    });
    await app.inject({
      method: 'POST',
      url: '/api/reports/exports',
      payload: exportBody({ scope: 'switch', switchId, format: 'json' }),
      headers: { cookie: admin.cookie },
    });

    // When
    const anonymous = await app.inject({ method: 'GET', url: '/api/reports/exports' });
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/reports/exports',
      headers: { cookie: owner.cookie },
    });
    const all = await app.inject({
      method: 'GET',
      url: '/api/reports/exports',
      headers: { cookie: admin.cookie },
    });
    const switchOnly = await app.inject({
      method: 'GET',
      url: '/api/reports/exports?scope=switch',
      headers: { cookie: admin.cookie },
    });
    const csvOnly = await app.inject({
      method: 'GET',
      url: '/api/reports/exports?format=csv',
      headers: { cookie: admin.cookie },
    });
    const paged = await app.inject({
      method: 'GET',
      url: '/api/reports/exports?limit=1',
      headers: { cookie: admin.cookie },
    });
    const allBody = all.json() as {
      items: readonly {
        id: string;
        switchId: string | null;
        switchTitle: string | null;
      }[];
      nextBeforeId: number | null;
    };

    // Then
    expect(anonymous.json()).toEqual({ error: 'unauthorized' });
    expect(forbidden.json()).toEqual({ error: 'forbidden' });
    expect(allBody.items).toHaveLength(2);
    expect(allBody.items[0]).toMatchObject({
      scopeType: 'switch',
      switchId,
      switchTitle: 'history-plan',
      format: 'json',
      status: 'success',
      requestedByEmail: 'admin@example.com',
      rowCount: 0,
    });
    expect(allBody.items[1]).toMatchObject({ scopeType: 'global', format: 'csv' });
    expect(switchOnly.json()).toMatchObject({
      items: [expect.objectContaining({ id: allBody.items[0]!.id })],
    });
    expect(csvOnly.json()).toMatchObject({
      items: [expect.objectContaining({ id: allBody.items[1]!.id })],
    });
    expect(paged.json()).toMatchObject({
      items: [expect.objectContaining({ id: allBody.items[0]!.id })],
      nextBeforeId: expect.any(Number),
    });
    const pagedBody = paged.json() as { nextBeforeId: number | null };
    const afterCursor = await app.inject({
      method: 'GET',
      url: `/api/reports/exports?limit=1&beforeId=${pagedBody.nextBeforeId}`,
      headers: { cookie: admin.cookie },
    });
    expect(afterCursor.json()).toMatchObject({
      items: [expect.objectContaining({ id: allBody.items[1]!.id })],
      nextBeforeId: expect.any(Number),
    });
  });

  it('rejects invalid list queries before querying', async () => {
    // Given
    const admin = await createUser('admin@example.com', 'admin');

    // When
    const badStatus = await app.inject({
      method: 'GET',
      url: '/api/reports/exports?status=cancelled',
      headers: { cookie: admin.cookie },
    });
    const badLimit = await app.inject({
      method: 'GET',
      url: '/api/reports/exports?limit=101',
      headers: { cookie: admin.cookie },
    });
    const unknownParam = await app.inject({
      method: 'GET',
      url: '/api/reports/exports?action=auth_login',
      headers: { cookie: admin.cookie },
    });

    // Then
    expect(badStatus.statusCode).toBe(400);
    expect(badLimit.statusCode).toBe(400);
    expect(unknownParam.statusCode).toBe(400);
  });
});
