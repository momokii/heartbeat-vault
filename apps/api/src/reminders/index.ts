import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';

export const REMINDER_SEND_DEADLINE_MS = 30_000;
const REMINDER_SEND_TIMEOUT = Symbol('reminder-send-timeout');

export function sanitizeReminderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const printable = Array.from(message, character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('');
  return printable.replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function withReminderDeadline<T, U>(
  operation: Promise<T>,
  timeoutValue: U,
): Promise<T | U> {
  operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise: Promise<U> = new Promise(resolve => {
    timer = setTimeout(() => resolve(timeoutValue), REMINDER_SEND_DEADLINE_MS);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const reminderStages = ['warning', 'reminder'] as const;
const reminderChannels = ['email'] as const;

export const ownerReminderInputSchema = z.object({
  switchId: z.string().uuid(),
  ownerEmail: z.string().email(),
  deadlineAt: z.string().datetime({ offset: true }),
  stage: z.enum(reminderStages),
  channel: z.enum(reminderChannels),
});

type OwnerReminderInput = Omit<z.infer<typeof ownerReminderInputSchema>, 'ownerEmail'>;

export type ReminderJob = {
  readonly id: string;
  readonly switchId: string;
  readonly ownerEmail: string;
  readonly deadlineAt: Date;
  readonly stage: (typeof reminderStages)[number];
  readonly channel: (typeof reminderChannels)[number];
  readonly state: 'pending' | 'sent' | 'failed';
  readonly idempotencyKey: string;
};

export type SendEmail = (message: {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}) => Promise<Readonly<{ status: string; receipt: string }>>;

export class ReminderValidationError extends Error {
  override readonly name = 'ReminderValidationError';

  constructor(readonly switchId: string) {
    super(`owner email is required for switch ${switchId}`);
  }
}

export function buildReminderKey(input: OwnerReminderInput): string {
  return `reminder:${input.switchId}:${input.deadlineAt}:` + `${input.stage}:${input.channel}`;
}

function toReminderJob(row: {
  readonly id: string;
  readonly switch_id: string;
  readonly owner_email: string;
  readonly deadline_at: Date;
  readonly stage: (typeof reminderStages)[number];
  readonly channel: (typeof reminderChannels)[number];
  readonly state: 'pending' | 'sent' | 'failed';
  readonly idempotency_key: string;
}): ReminderJob {
  return {
    id: row.id,
    switchId: row.switch_id,
    ownerEmail: row.owner_email,
    deadlineAt: row.deadline_at,
    stage: row.stage,
    channel: row.channel,
    state: row.state,
    idempotencyKey: row.idempotency_key,
  };
}

type ReminderRow = Parameters<typeof toReminderJob>[0];

async function recordAudit(client: PoolClient, action: string, key: string): Promise<void> {
  await writeAudit(client, { action, target: key });
}

export async function materializeOwnerReminder(
  pool: Pool,
  input: OwnerReminderInput,
  now: Date,
): Promise<ReminderJob> {
  const idempotencyKey = buildReminderKey(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query<{ readonly email: string | null }>(
      `SELECT u.email FROM switches s JOIN users u ON u.id = s.owner_id WHERE s.id = $1 FOR UPDATE`,
      [input.switchId],
    );
    const email = owner.rows[0]?.email;
    if (email === null || email === undefined) {
      await client.query('ROLLBACK');
      throw new ReminderValidationError(input.switchId);
    }

    const inserted = await client.query<ReminderRow>(
      `INSERT INTO reminder_jobs
         (switch_id, owner_email, deadline_at, stage, channel, state, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, switch_id, owner_email, deadline_at, stage, channel, state, idempotency_key`,
      [input.switchId, email, input.deadlineAt, input.stage, input.channel, idempotencyKey, now],
    );
    let row: ReminderRow | undefined = inserted.rows[0];
    if (row === undefined) {
      const existing = await client.query<ReminderRow>(
        `SELECT id, switch_id, owner_email, deadline_at, stage, channel, state, idempotency_key
         FROM reminder_jobs WHERE idempotency_key = $1 FOR UPDATE`,
        [idempotencyKey],
      );
      row = existing.rows[0];
    }
    if (row === undefined) throw new Error('reminder job was not materialized');
    if (inserted.rows.length === 1)
      await recordAudit(client, 'reminder_materialized', idempotencyKey);
    await client.query('COMMIT');
    return toReminderJob(row);
  } catch (error: unknown) {
    if (error instanceof ReminderValidationError) throw error;
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function executeOwnerReminder(
  pool: Pool,
  job: ReminderJob,
  options: Readonly<{ sendEmail: SendEmail; now: Date }>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{ readonly state: ReminderJob['state'] }>(
      `SELECT state FROM reminder_jobs WHERE id = $1 FOR UPDATE`,
      [job.id],
    );
    const state = locked.rows[0]?.state;
    if (state === 'sent') {
      await client.query('COMMIT');
      return;
    }
    const sendResult = await withReminderDeadline(
      options.sendEmail({
        to: job.ownerEmail,
        subject: `Heartbeat Vault reminder (${job.stage})`,
        text: `Reminder for switch ${job.switchId} at ${job.deadlineAt.toISOString()}`,
      }),
      REMINDER_SEND_TIMEOUT,
    );
    if (sendResult === REMINDER_SEND_TIMEOUT)
      throw new Error('reminder provider deadline exceeded');
    await client.query(
      `UPDATE reminder_jobs SET state = 'sent', sent_at = $2 WHERE id = $1 AND state <> 'sent'`,
      [job.id, options.now],
    );
    await recordAudit(client, 'reminder_sent', job.idempotencyKey);
    await client.query('COMMIT');
  } catch (error: unknown) {
    try {
      await client.query(
        `UPDATE reminder_jobs SET state = 'failed', last_error = $2 WHERE id = $1`,
        [
          job.id,
          sanitizeReminderError(error instanceof Error ? error.message : 'email send failed'),
        ],
      );
      await recordAudit(client, 'reminder_failed', job.idempotencyKey);
      await client.query('COMMIT');
    } catch (failure: unknown) {
      await client.query('ROLLBACK');
      throw failure;
    }
    throw error;
  } finally {
    client.release();
  }
}
