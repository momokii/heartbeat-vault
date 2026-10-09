import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { decryptTotpSecret, verifyTotpCode } from '../lib/totp-store.js';
import { recordHeartbeat } from './heartbeat.js';

const bulkCheckInSchema = z.object({
  switchIds: z.array(z.string().uuid()),
  totpCode: z.string().min(6).max(8).optional(),
});

export async function registerBulkCheckInRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.post('/api/switches/check-in/all', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = bulkCheckInSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });

    const user = request.user!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const active = await client.query<{ id: string }>(
        `SELECT id FROM switches
         WHERE id = ANY($1::uuid[]) AND owner_id=$2 AND status='active'
         FOR UPDATE`,
        [parsed.data.switchIds, user.id],
      );
      const activeIds = new Set(active.rows.map(row => row.id));

      const locked = await client.query<{
        totp_verified_at: Date | null;
        totp_secret_encrypted: Buffer | null;
        totp_last_counter: string;
      }>(
        `SELECT totp_verified_at, totp_secret_encrypted, totp_last_counter
         FROM users WHERE id=$1 FOR UPDATE`,
        [user.id],
      );
      const totp = locked.rows[0];
      if (totp === undefined) {
        await client.query('ROLLBACK');
        return reply.status(500).send({ error: 'internal_error' });
      }
      if (totp.totp_verified_at !== null) {
        if (!parsed.data.totpCode || totp.totp_secret_encrypted === null) {
          await client.query('ROLLBACK');
          return reply.status(403).send({ error: 'totp_required' });
        }
        let secret: string;
        try {
          secret = decryptTotpSecret(totp.totp_secret_encrypted);
        } catch {
          await client.query('ROLLBACK');
          return reply.status(500).send({ error: 'internal_error' });
        }
        const outcome = await verifyTotpCode(
          secret,
          parsed.data.totpCode,
          Number(totp.totp_last_counter),
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

      const results = [];
      for (const switchId of parsed.data.switchIds) {
        if (!activeIds.has(switchId)) {
          results.push({ switchId, ok: false, error: 'not_found' });
          continue;
        }
        await recordHeartbeat(client, switchId, 'manual', {
          actorId: user.id,
          ip: request.ip,
          requestId: request.id,
        });
        results.push({ switchId, ok: true });
      }

      await client.query('COMMIT');
      return reply.status(200).send(results);
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
  });
}
