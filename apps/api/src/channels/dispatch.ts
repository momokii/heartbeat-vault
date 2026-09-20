// Delivery dispatcher (T5.1): claims due delivery_jobs with FOR UPDATE SKIP
// LOCKED (same primitive as the trigger engine, ADR-002), runs the resolved
// provider, and applies the outcome transactionally:
//   sent  → state='succeeded', receipt merged into payload jsonb
//   retry → attempts+1; below max_attempts requeue with full-jitter backoff,
//           at max move to dead + dead_letter_jobs (never silently dropped)
//   dead  → immediate dead-letter
// Unknown channels dead-letter (defensive: config drift must not crash the
// worker or lose the audit trail).
import type { Pool } from 'pg';
import type { ChannelRegistry, DeliveryPayload } from './types.js';

export const DELIVERY_BATCH = 10;
export const DELIVERY_MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_SECONDS = 2;

type ClaimedDelivery = {
  readonly id: string;
  readonly channel: string;
  readonly idempotencyKey: string;
  readonly payload: DeliveryPayload;
  readonly attempts: number;
  readonly maxAttempts: number;
};

export type DispatchSummary = {
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
};

function jitteredBackoffSeconds(attempts: number): number {
  const base = BACKOFF_BASE_SECONDS * 2 ** attempts;
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

export async function deliverPendingDeliveries(
  pool: Pool,
  registry: ChannelRegistry,
  _workerId: string,
  now: Date,
): Promise<DispatchSummary> {
  const summary = { sent: 0, retried: 0, dead: 0 };
  for (;;) {
    const claimed = await pool.query<ClaimedDelivery>(
      `WITH picked AS (
         SELECT id FROM delivery_jobs
         WHERE state = 'pending' AND available_at <= $1
         ORDER BY available_at, id
         LIMIT ${DELIVERY_BATCH}
         FOR UPDATE SKIP LOCKED
       )
       UPDATE delivery_jobs j
       SET state = 'running', attempts = j.attempts + 1
       FROM picked
       WHERE j.id = picked.id
       RETURNING j.id, j.channel, j.idempotency_key AS "idempotencyKey",
                 j.payload, j.attempts, j.max_attempts AS "maxAttempts"`,
      [now],
    );
    if (claimed.rows.length === 0) break;

    for (const job of claimed.rows) {
      const provider = registry.get(job.channel);
      let result;
      if (!provider) {
        result = { status: 'dead' as const, error: `unknown channel: ${job.channel}` };
      } else {
        try {
          result = await provider.send({
            channel: job.channel,
            idempotencyKey: job.idempotencyKey,
            address: await addressFor(pool, job.payload),
            payload: job.payload,
          });
        } catch (err) {
          result = { status: 'retry' as const, error: (err as Error).message };
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (result.status === 'sent') {
          await client.query(
            `UPDATE delivery_jobs SET state='succeeded',
                payload = payload || jsonb_build_object('receipt', $2::text, 'sentAt', clock_timestamp())
              WHERE id=$1`,
            [job.id, result.receipt],
          );
          summary.sent += 1;
        } else if (result.status === 'retry' && job.attempts < job.maxAttempts) {
          await client.query(
            `UPDATE delivery_jobs SET state='pending', last_error=$2,
                available_at = clock_timestamp() + make_interval(secs => $3::int)
              WHERE id=$1`,
            [job.id, result.error, jitteredBackoffSeconds(job.attempts)],
          );
          summary.retried += 1;
        } else {
          const finalError =
            result.status === 'dead' ? result.error : `max attempts reached: ${result.error}`;
          await client.query(`UPDATE delivery_jobs SET state='dead', last_error=$2 WHERE id=$1`, [
            job.id,
            finalError,
          ]);
          await client.query(
            `INSERT INTO dead_letter_jobs (source, source_id, payload, final_error)
             VALUES ('delivery', $1::text, (SELECT payload FROM delivery_jobs WHERE id=$2::uuid), $3::text)`,
            [job.id, job.id, finalError],
          );
          summary.dead += 1;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
    if (claimed.rows.length < DELIVERY_BATCH) break;
  }
  return summary;
}

/** Recipient address recovery: the delivery payload carries recipientId. */
async function addressFor(pool: Pool, payload: DeliveryPayload): Promise<string> {
  if (!payload || typeof payload.recipientId !== 'string') return '';
  const res = await pool.query<{ address: string }>(`SELECT address FROM recipients WHERE id=$1`, [
    payload.recipientId,
  ]);
  return res.rows[0]?.address ?? '';
}
