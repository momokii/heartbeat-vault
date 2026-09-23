import { hashPassword } from '@heartbeat-vault/crypto';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { requireRole } from '../lib/roles.js';

const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;

const passwordResetTargetSchema = z.object({
  id: z.string().uuid(),
});

const passwordResetConsumeSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(12),
});

type IssuedPasswordReset = {
  readonly id: string;
  readonly expires_at: Date;
};

type PasswordResetToConsume = {
  readonly id: string;
  readonly user_id: string;
  readonly token_hash: string;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hasMatchingTokenHash(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash, 'utf8');
  const candidate = Buffer.from(candidateHash, 'utf8');
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

/** Registers administrator-issued and public password-reset endpoints. */
export async function registerPasswordResetRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);
  const requireAdmin = requireRole('admin');

  app.post(
    '/api/users/:id/password-reset',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const parsedParams = passwordResetTargetSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(400).send({ error: 'invalid_request' });
      }

      const actor = request.user;
      if (actor === undefined) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
      if (parsedParams.data.id === actor.id) {
        return reply.status(403).send({ error: 'cannot_reset_own_password' });
      }

      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const targetUser = await client.query<{ readonly id: string }>(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [parsedParams.data.id],
        );
        if (targetUser.rows.at(0) === undefined) {
          await client.query('ROLLBACK');
          return reply.status(404).send({ error: 'not_found' });
        }

        await client.query(
          `UPDATE password_resets
           SET consumed_at = clock_timestamp()
           WHERE user_id = $1 AND consumed_at IS NULL`,
          [parsedParams.data.id],
        );

        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
        const issued = await client.query<IssuedPasswordReset>(
          `INSERT INTO password_resets (user_id, token_hash, expires_at, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, expires_at`,
          [parsedParams.data.id, tokenHash, expiresAt, actor.id],
        );
        const passwordReset = issued.rows.at(0);
        if (passwordReset === undefined) {
          await client.query('ROLLBACK');
          return reply.status(500).send({ error: 'internal_error' });
        }

        await writeAudit(client, {
          actorId: actor.id,
          action: 'password_reset_issued',
          target: passwordReset.id,
          ip: request.ip,
          requestId: request.id,
        });
        await client.query('COMMIT');

        return reply.status(201).send({
          id: passwordReset.id,
          token,
          expiresAt: passwordReset.expires_at.toISOString(),
        });
      } catch {
        await client.query('ROLLBACK');
        request.log.error('Password reset issuance failed');
        return reply.status(500).send({ error: 'internal_error' });
      } finally {
        client.release();
      }
    },
  );

  app.post('/api/account/password/reset', async (request, reply) => {
    const rate = checkRateLimit(request.ip, 'password-reset');
    if (!rate.allowed) {
      reply.header('Retry-After', String(rate.retryAfterSec ?? 60));
      return reply.status(429).send({ error: 'rate_limited' });
    }

    const parsedBody = passwordResetConsumeSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }

    const tokenHash = hashToken(parsedBody.data.token);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const result = await client.query<PasswordResetToConsume>(
        `SELECT id, user_id, token_hash, expires_at, consumed_at
         FROM password_resets WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const passwordReset = result.rows.at(0);
      if (passwordReset === undefined) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }

      if (!hasMatchingTokenHash(passwordReset.token_hash, tokenHash)) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }

      const expiryTime = passwordReset.expires_at.getTime();
      if (
        passwordReset.consumed_at !== null ||
        Number.isNaN(expiryTime) ||
        expiryTime <= Date.now()
      ) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }

      const newPasswordHash = await hashPassword(parsedBody.data.newPassword);
      const updatedUser = await client.query(
        `UPDATE users
         SET password_hash = $1, updated_at = clock_timestamp()
         WHERE id = $2`,
        [newPasswordHash, passwordReset.user_id],
      );
      if (updatedUser.rowCount !== 1) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }

      await client.query(
        `UPDATE sessions
         SET revoked_at = clock_timestamp()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [passwordReset.user_id],
      );
      await client.query(
        'UPDATE password_resets SET consumed_at = clock_timestamp() WHERE id = $1',
        [passwordReset.id],
      );
      await writeAudit(client, {
        actorId: passwordReset.user_id,
        action: 'password_reset_consumed',
        target: passwordReset.id,
        ip: request.ip,
        requestId: request.id,
      });
      await client.query('COMMIT');

      return reply.status(200).send({ ok: true });
    } catch {
      await client.query('ROLLBACK');
      request.log.error('Password reset consumption failed');
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
  });
}
