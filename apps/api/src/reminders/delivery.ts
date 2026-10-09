import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { DeliveryChannel } from '../channels/types.js';
import { writeAudit } from '../lib/audit.js';
import { REMINDER_SEND_DEADLINE_MS, sanitizeReminderError, withReminderDeadline } from './index.js';

export { REMINDER_SEND_DEADLINE_MS };

const reminderRowSchema = z.object({
  id: z.string().uuid(),
  switchId: z.string().uuid(),
  ownerEmail: z.string().email(),
  deadlineAt: z.date(),
  stage: z.enum(['warning', 'reminder']),
  channel: z.literal('email'),
  idempotencyKey: z.string().min(1),
});

type ReminderDeliveryRow = z.infer<typeof reminderRowSchema>;

export type ReminderEmailResult =
  | { readonly status: 'sent'; readonly receipt: string }
  | { readonly status: 'retry'; readonly error: string };

export type ReminderEmailSender = (message: {
  readonly to: string;
  readonly switchId: string;
  readonly subject: string;
  readonly text: string;
  readonly idempotencyKey: string;
}) => Promise<ReminderEmailResult>;

export type ReminderDeliverySummary = {
  readonly sent: number;
  readonly failed: number;
};

export function createReminderEmailSender(channel: DeliveryChannel): ReminderEmailSender {
  return async message => {
    const result = await channel.send({
      channel: 'email',
      idempotencyKey: message.idempotencyKey,
      address: message.to,
      payload: {
        kind: 'reminder',
        switchId: message.switchId,
        recipientId: message.to,
      },
    });
    if (result.status === 'sent') return result;
    return { status: 'retry', error: result.error };
  };
}

export async function deliverPendingOwnerReminders(
  pool: Pool,
  sendEmail: ReminderEmailSender,
  _workerId: string,
  now: Date,
): Promise<ReminderDeliverySummary> {
  const summary = { sent: 0, failed: 0 };
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await claimReminder(client, now);
      if (claimed === null) {
        await client.query('COMMIT');
        break;
      }

      let result: ReminderEmailResult;
      try {
        result = await withReminderDeadline(
          sendEmail({
            to: claimed.ownerEmail,
            switchId: claimed.switchId,
            subject: `Heartbeat Vault reminder (${claimed.stage})`,
            text: `Reminder for switch ${claimed.switchId} at ${claimed.deadlineAt.toISOString()}`,
            idempotencyKey: claimed.idempotencyKey,
          }),
          { status: 'retry', error: 'reminder provider deadline exceeded' },
        );
      } catch (error: unknown) {
        result = {
          status: 'retry',
          error: sanitizeReminderError(
            error instanceof Error ? error.message : 'email provider failed',
          ),
        };
      }
      if (result.status === 'sent') {
        await markSent(client, claimed, result.receipt, now);
        summary.sent += 1;
      } else {
        await markFailed(client, claimed, result.error, now);
        summary.failed += 1;
      }
      await client.query('COMMIT');
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return summary;
}

async function claimReminder(client: PoolClient, now: Date): Promise<ReminderDeliveryRow | null> {
  const result = await client.query<{
    readonly id: string;
    readonly switch_id: string;
    readonly owner_email: string;
    readonly deadline_at: Date;
    readonly stage: string;
    readonly channel: string;
    readonly idempotency_key: string;
  }>(
    `SELECT id, switch_id, owner_email, deadline_at, stage, channel, idempotency_key
     FROM reminder_jobs
     WHERE state = 'pending'
       AND created_at <= $1
       AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
     ORDER BY created_at, id
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [now],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return reminderRowSchema.parse({
    id: row.id,
    switchId: row.switch_id,
    ownerEmail: row.owner_email,
    deadlineAt: row.deadline_at,
    stage: row.stage,
    channel: row.channel,
    idempotencyKey: row.idempotency_key,
  });
}

async function markSent(
  client: PoolClient,
  job: ReminderDeliveryRow,
  receipt: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE reminder_jobs SET state = 'sent', sent_at = $2, last_error = NULL
     WHERE id = $1 AND state = 'pending'`,
    [job.id, now],
  );
  await writeAudit(client, {
    action: 'reminder_sent',
    target: job.idempotencyKey,
    details: { receipt },
  });
}

async function markFailed(
  client: PoolClient,
  job: ReminderDeliveryRow,
  error: string,
  now: Date,
): Promise<void> {
  const sanitizedError = sanitizeReminderError(error);
  await client.query(
    `UPDATE reminder_jobs
     SET attempts = attempts + 1,
         state = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
         next_attempt_at = CASE
           WHEN attempts + 1 < 5
           THEN $3::timestamptz + make_interval(mins => LEAST((attempts + 1) * (attempts + 1), 60))
           ELSE NULL
         END,
         last_error = $2
     WHERE id = $1 AND state = 'pending'`,
    [job.id, sanitizedError, now],
  );
  await writeAudit(client, {
    action: 'reminder_failed',
    target: job.idempotencyKey,
    details: { error: sanitizedError },
  });
}
