import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as triggerEngine from '../lib/trigger-engine.js';

const reminderModulePath = './index.js';

async function loadReminderModule() {
  return import(reminderModulePath);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = new Date('2026-10-01T00:00:00.000Z');
const SWITCH_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';

let container: StartedPostgreSqlContainer;
let pool: Pool;

async function applyMigrations(database: Pool): Promise<void> {
  const migrationsFolder = join(__dirname, '..', '..', '..', '..', 'packages', 'db', 'drizzle');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(drizzle(database), { migrationsFolder });
}

async function truncateAll(database: Pool): Promise<void> {
  await database.query(`
    TRUNCATE audit_log, delivery_jobs, vault_waits, trigger_jobs, heartbeats,
      sealed_payloads, recipients, switches, sessions, invites, dead_letter_jobs,
      scheduler_heartbeat, app_config, recovery_codes, webauthn_credentials, users CASCADE`);
}

async function seedOwner(email: string | null): Promise<void> {
  await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'test-hash')`, [
    OWNER_ID,
    email,
  ]);
  await pool.query(
    `INSERT INTO switches (id, owner_id, title, mode, status, heartbeat_interval, grace_window)
     VALUES ($1, $2, 'reminder contract', 'direct_delivery', 'active',
       make_interval(secs => 604800), make_interval(secs => 3600))`,
    [SWITCH_ID, OWNER_ID],
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await applyMigrations(pool);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await truncateAll(pool);
});

describe('owner reminder materialization', () => {
  it('materializing twice creates exactly one reminder job', async () => {
    const { materializeOwnerReminder } = await loadReminderModule();
    await seedOwner('owner@example.test');
    const input = {
      switchId: SWITCH_ID,
      deadlineAt: FIXED_NOW.toISOString(),
      stage: 'reminder' as const,
      channel: 'email' as const,
    };

    await materializeOwnerReminder(pool, input, FIXED_NOW);
    await materializeOwnerReminder(pool, input, FIXED_NOW);

    const rows = await pool.query<{ readonly id: string }>(
      `SELECT id FROM reminder_jobs WHERE idempotency_key = $1`,
      [`reminder:${SWITCH_ID}:${FIXED_NOW.toISOString()}:reminder:email`],
    );
    expect(rows.rows).toHaveLength(1);
  });
});

describe('owner reminder execution', () => {
  it('does not resend a sent job on redelivery', async () => {
    const { executeOwnerReminder, materializeOwnerReminder } = await loadReminderModule();
    await seedOwner('owner@example.test');
    const job = await materializeOwnerReminder(
      pool,
      {
        switchId: SWITCH_ID,
        deadlineAt: FIXED_NOW.toISOString(),
        stage: 'reminder',
        channel: 'email',
      },
      FIXED_NOW,
    );
    const sendEmail = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'smtp-1' });

    await executeOwnerReminder(pool, job, { sendEmail, now: FIXED_NOW });
    await executeOwnerReminder(pool, job, { sendEmail, now: FIXED_NOW });

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('uses only the reminder path: no delivery rows and no processJob call', async () => {
    const { executeOwnerReminder, materializeOwnerReminder } = await loadReminderModule();
    await seedOwner('owner@example.test');
    const processJob = vi.spyOn(triggerEngine, 'processJob');
    const job = await materializeOwnerReminder(
      pool,
      {
        switchId: SWITCH_ID,
        deadlineAt: FIXED_NOW.toISOString(),
        stage: 'warning',
        channel: 'email',
      },
      FIXED_NOW,
    );

    await executeOwnerReminder(pool, job, {
      sendEmail: vi.fn().mockResolvedValue({ status: 'sent', receipt: 'smtp-2' }),
      now: FIXED_NOW,
    });

    const deliveries = await pool.query(`SELECT id FROM delivery_jobs`);
    expect(deliveries.rows).toHaveLength(0);
    expect(processJob).not.toHaveBeenCalled();
    processJob.mockRestore();
  });
});

describe('owner reminder audit trail', () => {
  it('records materialize and send audit entries', async () => {
    const { executeOwnerReminder, materializeOwnerReminder } = await loadReminderModule();
    await seedOwner('owner@example.test');
    const job = await materializeOwnerReminder(
      pool,
      {
        switchId: SWITCH_ID,
        deadlineAt: FIXED_NOW.toISOString(),
        stage: 'reminder',
        channel: 'email',
      },
      FIXED_NOW,
    );
    await executeOwnerReminder(pool, job, {
      sendEmail: vi.fn().mockResolvedValue({ status: 'sent', receipt: 'smtp-3' }),
      now: FIXED_NOW,
    });

    const rows = await pool.query<{ readonly action: string }>(
      `SELECT action FROM audit_log WHERE target = $1 ORDER BY id`,
      [job.idempotencyKey],
    );
    expect(rows.rows.map(row => row.action)).toEqual(['reminder_materialized', 'reminder_sent']);
  });

  it('records a failure audit entry when email sending fails', async () => {
    const { executeOwnerReminder, materializeOwnerReminder } = await loadReminderModule();
    await seedOwner('owner@example.test');
    const job = await materializeOwnerReminder(
      pool,
      {
        switchId: SWITCH_ID,
        deadlineAt: FIXED_NOW.toISOString(),
        stage: 'reminder',
        channel: 'email',
      },
      FIXED_NOW,
    );

    await expect(
      executeOwnerReminder(pool, job, {
        sendEmail: vi.fn().mockRejectedValue(new Error('smtp unavailable')),
        now: FIXED_NOW,
      }),
    ).rejects.toThrow('smtp unavailable');

    const rows = await pool.query<{ readonly action: string }>(
      `SELECT action FROM audit_log WHERE target = $1`,
      [job.idempotencyKey],
    );
    expect(rows.rows.map(row => row.action)).toContain('reminder_failed');
  });
});
