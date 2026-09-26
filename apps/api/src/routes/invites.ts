import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeAudit } from '../lib/audit.js';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { requireRole } from '../lib/roles.js';
import { checkRateLimit } from '../lib/rate-limit.js';

const inviteCreateSchema = z.object({
  email: z.string().email(),
  role: z.enum(['user', 'admin']),
});

const inviteConsumeSchema = z.object({
  token: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(12),
});

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'utf8');
  const b = Buffer.from(bHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function registerInviteRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);
  const requireAdmin = requireRole('admin');

  // POST /api/invites — admin only
  app.post('/api/invites', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const parsed = inviteCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const { email, role } = parsed.data;
    const user = request.user!;

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ id: string }>(
        `INSERT INTO invites (role, email, token_hash, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [role, email, tokenHash, expiresAt, user.id],
      );
      const inviteId = res.rows[0]!.id;
      await writeAudit(client, {
        actorId: user.id,
        action: 'invite_created',
        target: inviteId,
        ip: request.ip,
        requestId: request.id,
        details: { role, expiresInHours: 24 },
      });
      await client.query('COMMIT');
      return reply.status(201).send({ id: inviteId, token });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return reply.status(400).send({ error: 'invalid_request' });
      }
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
  });

  // POST /api/invites/consume — public, rate-limited, single-use atomic
  app.post('/api/invites/consume', async (request, reply) => {
    const ip = request.ip;
    const rate = checkRateLimit(ip);
    if (!rate.allowed) {
      reply.header('Retry-After', String(rate.retryAfterSec ?? 60));
      return reply.status(429).send({ error: 'rate_limited' });
    }

    const parsed = inviteConsumeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const { token, email, password } = parsed.data;
    const tokenHash = hashToken(token);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{
        id: string;
        role: string;
        email: string;
        token_hash: string;
        expires_at: string;
        consumed_at: string | null;
      }>(
        `SELECT id, role, email, token_hash, expires_at, consumed_at
         FROM invites WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );

      if (res.rowCount === 0 || res.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }
      const invite = res.rows[0]!;

      // constant-time compare of stored hash vs computed hash (defense even though WHERE matched)
      if (!constantTimeEqualHex(invite.token_hash, tokenHash)) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }

      if (invite.consumed_at !== null) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }

      const expiresAt = new Date(invite.expires_at);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }

      // email must match invite email (generic error, no enumeration)
      if (invite.email.toLowerCase() !== email.toLowerCase()) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }

      // create user with invited role
      const { hashPassword } = await import('@heartbeat-vault/crypto');
      const passwordHash = await hashPassword(password);

      let userId: string;
      try {
        const userRes = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id`,
          [email, passwordHash, invite.role],
        );
        userId = userRes.rows[0]!.id;
      } catch (err) {
        await client.query('ROLLBACK');
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          return reply.status(400).send({ error: 'invalid_request' });
        }
        throw err;
      }

      await client.query(`UPDATE invites SET consumed_at = clock_timestamp() WHERE id = $1`, [
        invite.id,
      ]);

      await writeAudit(client, {
        actorId: userId,
        action: 'invite_consumed',
        target: invite.id,
        ip: request.ip,
        requestId: request.id,
        details: { role: invite.role },
      });

      await client.query('COMMIT');
      return reply.status(201).send({ id: userId, email, role: invite.role });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
  });
}
