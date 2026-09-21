import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { hashPassword, verifyPassword } from '@heartbeat-vault/crypto';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { createAuthPreHandler } from '../lib/auth-middleware.js';

const passwordChangeBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});

export async function registerAccountRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.post('/api/account/password', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = passwordChangeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }

    const user = request.user;
    if (user === undefined) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1 FOR UPDATE`,
        [user.id],
      );
      const currentPasswordHash = result.rows[0]?.password_hash;
      if (currentPasswordHash === undefined) {
        await client.query('ROLLBACK');
        return reply.status(401).send({ error: 'invalid_current_password' });
      }

      let currentPasswordMatches: boolean;
      try {
        currentPasswordMatches = await verifyPassword(
          currentPasswordHash,
          parsed.data.currentPassword,
        );
      } catch (error) {
        request.log.error(error);
        await client.query('ROLLBACK');
        return reply.status(401).send({ error: 'invalid_current_password' });
      }
      if (!currentPasswordMatches) {
        await client.query('ROLLBACK');
        return reply.status(401).send({ error: 'invalid_current_password' });
      }

      const newPasswordHash = await hashPassword(parsed.data.newPassword);
      await client.query(
        `UPDATE users SET password_hash = $1, updated_at = clock_timestamp() WHERE id = $2`,
        [newPasswordHash, user.id],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: 'account_password_changed',
        target: user.id,
        ip: request.ip,
        requestId: request.id,
      });
      await client.query('COMMIT');
      return reply.status(200).send({ ok: true });
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        request.log.error(rollbackError);
      }
      request.log.error(error);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
  });
}
