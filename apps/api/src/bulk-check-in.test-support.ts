import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { generate as generateTotp } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';
import { resetRateLimitForTests } from './lib/rate-limit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = 'postgres:17-alpine';
export const TEST_MASTER_KEY = randomBytes(32).toString('hex');

export let pool: Pool;
export let app: FastifyInstance;
let container: StartedPostgreSqlContainer;

async function applyMigrations(databasePool: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', '..', '..', 'packages', 'db', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(drizzle(databasePool), { migrationsFolder });
}

export async function startHarness(): Promise<void> {
  process.env['MASTER_KEY'] = TEST_MASTER_KEY;
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await applyMigrations(pool);
  app = await buildServer(pool);
}

export async function stopHarness(): Promise<void> {
  await app?.close();
  await pool?.end();
  await container?.stop();
}

export async function truncateAll(): Promise<void> {
  await pool.query(`
    TRUNCATE audit_log, delivery_jobs, vault_waits, trigger_jobs, heartbeats, heartbeat_links,
      sealed_payloads, recipients, switches, sessions, invites, dead_letter_jobs,
      scheduler_heartbeat, app_config, recovery_codes, webauthn_credentials, users CASCADE`);
  resetRateLimitForTests();
}

export async function createUser(email: string): Promise<string> {
  const { hashPassword } = await import('@heartbeat-vault/crypto');
  const passwordHash = await hashPassword('password-12-chars');
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user') RETURNING id`,
    [email, passwordHash],
  );
  return result.rows[0]!.id;
}

function authCookie(cookie: string): { readonly cookie: string } {
  return { cookie: `__Host-session=${cookie}` };
}

export async function createOwner(email: string): Promise<string> {
  await createUser(email);
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password: 'password-12-chars' },
  });
  if (response.statusCode !== 200) throw new Error('Expected test user login to succeed');
  const rawCookie = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(rawCookie) ? rawCookie.join('; ') : rawCookie;
  const cookie = cookieHeader?.match(/__Host-session=([^;]+)/)?.[1];
  if (cookie === undefined) throw new Error('Expected session cookie');
  return cookie;
}

export async function createActiveSwitch(cookie: string, title: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/switches',
    headers: authCookie(cookie),
    payload: {
      title,
      mode: 'direct_delivery',
      heartbeatIntervalHours: 24,
      graceWindowHours: 2,
    },
  });
  if (created.statusCode !== 201) throw new Error('Expected switch creation to succeed');
  const switchId = (JSON.parse(created.body) as { id: string }).id;
  const recipient = await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/recipients`,
    headers: authCookie(cookie),
    payload: { channel: 'email', address: `${title}@example.com` },
  });
  if (recipient.statusCode !== 201) throw new Error('Expected recipient creation to succeed');
  const inviteToken = (JSON.parse(recipient.body) as { inviteToken: string }).inviteToken;
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/recipients/accept',
    payload: { token: inviteToken },
  });
  if (accepted.statusCode !== 200) throw new Error('Expected recipient acceptance to succeed');
  const payload = await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/payload`,
    headers: authCookie(cookie),
    payload: { plaintext: 'bulk-check-in-test-payload' },
  });
  if (payload.statusCode !== 201) throw new Error('Expected payload storage to succeed');
  const armed = await app.inject({
    method: 'POST',
    url: `/api/switches/${switchId}/arm`,
    headers: authCookie(cookie),
    payload: { confirm: true },
  });
  if (armed.statusCode !== 200) throw new Error('Expected switch arming to succeed');
  return switchId;
}

export async function enableTotp(userId: string): Promise<string> {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const { encrypt } = await import('@heartbeat-vault/crypto');
  const envelope = encrypt(
    new TextEncoder().encode(secret),
    { tenantId: 'default', switchId: 'totp' },
    new Uint8Array(Buffer.from(TEST_MASTER_KEY, 'hex')),
    'totp',
    1,
  );
  const encryptedSecret = Buffer.from(
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
    `UPDATE users SET totp_secret_encrypted=$1, totp_verified_at=clock_timestamp(),
       totp_last_counter=0 WHERE id=$2`,
    [encryptedSecret, userId],
  );
  return secret;
}

export async function totpLogin(email: string, secret: string): Promise<string> {
  const pending = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password: 'password-12-chars' },
  });
  if (pending.statusCode !== 202) throw new Error('Expected TOTP step-up login');
  const rawCookie = pending.headers['set-cookie'];
  const cookieHeader = Array.isArray(rawCookie) ? rawCookie.join('; ') : rawCookie;
  const cookie = cookieHeader?.match(/__Host-session=([^;]+)/)?.[1];
  if (cookie === undefined) throw new Error('Expected pending session cookie');
  const challenge = await app.inject({
    method: 'POST',
    url: '/api/2fa/totp/challenge',
    headers: authCookie(cookie),
    payload: { code: await generateTotp({ secret }) },
  });
  if (challenge.statusCode !== 200) throw new Error('Expected TOTP challenge to succeed');
  return cookie;
}

export async function checkInAll(cookie: string, switchIds: readonly string[]) {
  return app.inject({
    method: 'POST',
    url: '/api/switches/check-in/all',
    headers: authCookie(cookie),
    payload: { switchIds },
  });
}
