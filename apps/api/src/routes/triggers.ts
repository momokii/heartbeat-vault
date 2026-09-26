// Variant trigger routes (T4.6): fixed_date / panic / quorum configuration,
// trusted-contact votes, and the pre-fire cancellation window.
//
// Security posture:
// - Trigger config and cancel are owner/admin only; cancel requires the same
//   TOTP step-up as check-in when the owner has 2FA enabled (the cancel is
//   as sensitive as arming — it silently disarms the switch).
// - Quorum votes are public but IP rate-limited, keyed by the recipient's
//   invite token (SHA-256 hex, constant-time compare via DB lookup + exact
//   match), accepted recipients only.
// - The quorum fire is event-driven and idempotent
//   (idempotency_key 'switch:<id>:quorum'); the materializer never touches
//   quorum switches.
// - Cancel aborts pending trigger jobs and future queued deliveries within
//   the 48 h window (ADR-003), disarms, and clears fixed/panic fire_at.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { writeAudit } from '../lib/audit.js';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { decryptTotpSecret, verifyTotpCode } from '../lib/totp-store.js';

const uuidSchema = z.string().uuid();

const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fixed_date'), fireAt: z.string().datetime() }),
  z.object({ type: z.literal('panic'), confirm: z.literal(true) }),
  z.object({ type: z.literal('quorum'), threshold: z.number().int().min(2).max(255) }),
]);

const voteSchema = z.object({
  token: z.string().min(16).max(200),
  vote: z.literal('deceased'),
});

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function loadSwitchForOwner(
  pool: Pool,
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<{ id: string; status: string } | null> {
  const res = await pool.query<{ id: string; status: string; owner_id: string }>(
    `SELECT id, status, owner_id FROM switches WHERE id=$1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (!isAdmin && row.owner_id !== userId) return null;
  return row;
}

export async function registerTriggerRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.post('/api/switches/:id/trigger', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const parsed = triggerSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const user = request.user!;
    const sw = await loadSwitchForOwner(pool, id.data, user.id, user.role === 'admin');
    if (!sw) return reply.status(404).send({ error: 'not_found' });
    if (sw.status === 'released') {
      return reply.status(409).send({ error: 'released_immutable' });
    }
    const d = parsed.data;
    const details: Record<string, unknown> = { triggerType: d.type };
    if (d.type === 'fixed_date') details['fireAt'] = d.fireAt;
    if (d.type === 'quorum') details['quorumThreshold'] = d.threshold;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM switches WHERE id=$1 FOR UPDATE`, [id.data]);
      if (d.type === 'fixed_date') {
        const fireAt = new Date(d.fireAt);
        if (Number.isNaN(fireAt.getTime()) || fireAt.getTime() <= Date.now()) {
          await client.query('ROLLBACK');
          return reply.status(400).send({ error: 'invalid_request' });
        }
        await client.query(
          `UPDATE switches SET trigger_type='fixed_date', fire_at=$2, quorum_threshold=NULL,
              updated_at=clock_timestamp() WHERE id=$1`,
          [id.data, fireAt],
        );
      } else if (d.type === 'panic') {
        await client.query(
          `UPDATE switches SET trigger_type='panic', fire_at=clock_timestamp(), quorum_threshold=NULL,
              updated_at=clock_timestamp() WHERE id=$1`,
          [id.data],
        );
      } else {
        await client.query(
          `UPDATE switches SET trigger_type='quorum', fire_at=NULL, quorum_threshold=$2,
              updated_at=clock_timestamp() WHERE id=$1`,
          [id.data, d.threshold],
        );
      }
      await writeAudit(client, {
        actorId: user.id,
        action: 'trigger_configured',
        target: id.data,
        ip: request.ip,
        requestId: request.id,
        details,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true, triggerType: d.type });
  });

  app.post('/api/recipients/vote', async (request, reply) => {
    const limit = checkRateLimit(request.ip, '2fa');
    if (!limit.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(limit.retryAfterSec ?? 60))
        .send({ error: 'rate_limited' });
    }
    const parsed = voteSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const tokenHash = hashToken(parsed.data.token);
    const recip = await pool.query<{ id: string; switch_id: string; status: string }>(
      `SELECT id, switch_id, status FROM recipients WHERE invite_token_hash=$1`,
      [tokenHash],
    );
    const recipient = recip.rows[0];
    if (!recipient || recipient.status !== 'accepted') {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const sw = await pool.query<{
      trigger_type: string;
      quorum_threshold: number | null;
      status: string;
    }>(`SELECT trigger_type, quorum_threshold, status FROM switches WHERE id=$1`, [
      recipient.switch_id,
    ]);
    const swRow = sw.rows[0]!;
    if (
      swRow.status !== 'active' ||
      swRow.trigger_type !== 'quorum' ||
      swRow.quorum_threshold === null
    ) {
      return reply.status(409).send({ error: 'not_quorum' });
    }
    const client = await pool.connect();
    let votes = 0;
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE recipients SET vote=$2 WHERE id=$1`, [
        recipient.id,
        parsed.data.vote,
      ]);
      const counted = await client.query<{ votes: string }>(
        `SELECT COUNT(*)::text AS votes FROM recipients WHERE switch_id=$1 AND vote='deceased'`,
        [recipient.switch_id],
      );
      votes = Number(counted.rows[0]!.votes);
      if (votes >= swRow.quorum_threshold) {
        await client.query(
          `INSERT INTO trigger_jobs (switch_id, deadline_at, run_at, state, idempotency_key, payload)
           VALUES ($1, clock_timestamp(), clock_timestamp(), 'pending', $2, '{"kind":"fire","variant":true}'::jsonb)
           ON CONFLICT DO NOTHING`,
          [recipient.switch_id, `switch:${recipient.switch_id}:quorum`],
        );
      }
      await writeAudit(client, {
        action: 'quorum_vote',
        target: recipient.id,
        ip: request.ip,
        requestId: request.id,
        details: {
          vote: 'deceased',
          quorumThreshold: swRow.quorum_threshold,
          confirmedVotes: votes,
        },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true, votes, threshold: swRow.quorum_threshold });
  });

  app.post('/api/switches/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const user = request.user!;
    const sw = await loadSwitchForOwner(pool, id.data, user.id, user.role === 'admin');
    if (!sw) return reply.status(404).send({ error: 'not_found' });

    const parsed = z
      .object({ totpCode: z.string().min(6).max(8).optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });

    const totpState = await pool.query<{ totp_verified_at: Date | null }>(
      `SELECT totp_verified_at FROM users WHERE id=$1`,
      [user.id],
    );
    const totp = totpState.rows[0]!;
    if (totp.totp_verified_at !== null && !parsed.data.totpCode) {
      return reply.status(403).send({ error: 'totp_required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The locked re-read is authoritative: branch solely on the locked row
      // so TOTP enabled concurrently with this request cannot skip
      // verification, counter advancement shares this transaction (rollback
      // on failure), and the lock closes the concurrent-replay window.
      const locked = await client.query<{
        totp_verified_at: Date | null;
        totp_secret_encrypted: Buffer | null;
        totp_last_counter: string;
      }>(
        `SELECT totp_verified_at, totp_secret_encrypted, totp_last_counter
           FROM users WHERE id=$1 FOR UPDATE`,
        [user.id],
      );
      const lockedTotp = locked.rows[0]!;
      if (lockedTotp.totp_verified_at !== null) {
        if (!parsed.data.totpCode) {
          await client.query('ROLLBACK');
          return reply.status(403).send({ error: 'totp_required' });
        }
        let secret: string;
        try {
          secret = decryptTotpSecret(lockedTotp.totp_secret_encrypted!);
        } catch {
          await client.query('ROLLBACK');
          return reply.status(500).send({ error: 'internal_error' });
        }
        const outcome = await verifyTotpCode(
          secret,
          parsed.data.totpCode,
          Number(lockedTotp.totp_last_counter),
        );
        if (!outcome.ok) {
          await client.query('ROLLBACK');
          return reply.status(403).send({ error: 'totp_required' });
        }
        await client.query(`UPDATE users SET totp_last_counter=$1 WHERE id=$2`, [
          outcome.step,
          user.id,
        ]);
      }
      await client.query(
        `UPDATE trigger_jobs SET state='cancelled'
         WHERE switch_id=$1 AND state IN ('pending','running')`,
        [id.data],
      );
      await client.query(
        `UPDATE delivery_jobs SET state='cancelled'
         WHERE switch_id=$1 AND state='pending' AND available_at > clock_timestamp()`,
        [id.data],
      );
      await client.query(
        `UPDATE switches SET status='paused', next_deadline=NULL, fire_at=NULL,
            updated_at=clock_timestamp() WHERE id=$1`,
        [id.data],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: 'trigger_cancelled',
        target: id.data,
        ip: request.ip,
        requestId: request.id,
        details: { cancellation: 'pre_fire' },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true, status: 'paused' });
  });
}
