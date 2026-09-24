import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { writeAudit } from '../lib/audit.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { createAuthPreHandler } from '../lib/auth-middleware.js';

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FAILED = 5;
const DUMMY_PHC =
  '$argon2id$v=19$m=19456,t=2,p=1$7xMTRCUAskrVin2v5I7PxQ$2zR8iIIQOAbaouop07+izMO8proVleYWEXh0Z0/vDvw';

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sessionCookieName(): string {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return '__Host-session';
  return process.env.APP_ENV === 'production' ? '__Host-session' : 'session';
}

function cookieOpts() {
  const isProd = process.env.APP_ENV === 'production';
  const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  return {
    path: '/',
    httpOnly: true,
    secure: isProd || isTest,
    sameSite: 'strict' as const,
  };
}

export async function registerAuthRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.post('/api/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const ip = request.ip;
    const rate = checkRateLimit(ip);
    if (!rate.allowed) {
      reply.header('Retry-After', String(rate.retryAfterSec ?? 60));
      return reply.status(429).send({ error: 'rate_limited' });
    }

    const { email, password } = parsed.data;

    const userRes = await pool.query<{
      id: string;
      email: string;
      password_hash: string;
      role: string;
      failed_attempts: number;
      locked_until: string | null;
      totp_verified_at: string | null;
    }>(
      `SELECT id, email, password_hash, role, failed_attempts, locked_until, totp_verified_at
       FROM users WHERE email=$1`,
      [email],
    );

    if (userRes.rowCount === 0 || userRes.rows.length === 0) {
      try {
        const { verifyPassword } = await import('@heartbeat-vault/crypto');
        await verifyPassword(DUMMY_PHC, password).catch(() => false);
      } catch {
        // ignore timing dummy errors
      }
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    const user = userRes.rows[0]!;

    if (user.locked_until) {
      const lockedUntil = new Date(user.locked_until);
      if (!Number.isNaN(lockedUntil.getTime()) && lockedUntil.getTime() > Date.now()) {
        return reply.status(401).send({ error: 'invalid_credentials' });
      }
    }

    const { verifyPassword } = await import('@heartbeat-vault/crypto');
    let ok: boolean;
    try {
      ok = await verifyPassword(user.password_hash, password);
    } catch {
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    if (!ok) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const upd = await client.query<{ failed_attempts: number; locked_until: string | null }>(
          `UPDATE users SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END,
            updated_at = clock_timestamp()
           WHERE id = $1 RETURNING failed_attempts, locked_until`,
          [user.id, MAX_FAILED],
        );
        const newCount = upd.rows[0]?.failed_attempts ?? MAX_FAILED;
        if (newCount >= MAX_FAILED) {
          await writeAudit(client, {
            actorId: user.id,
            action: 'auth_lockout',
            target: user.id,
            ip: request.ip,
            requestId: request.id,
          });
        }
        await client.query('COMMIT');
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
      } finally {
        client.release();
      }
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = clock_timestamp() WHERE id = $1`,
        [user.id],
      );
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      // TOTP-enabled users get a step-up session: valid cookie, but every
      // non-2FA route rejects it with 403 totp_pending until the challenge
      // completes. Users without TOTP get a full session (200, unchanged).
      const stepUp = user.totp_verified_at !== null;
      await client.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at, totp_pending) VALUES ($1,$2,$3,$4)`,
        [user.id, tokenHash, expiresAt, stepUp],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: stepUp ? 'auth_stepup_started' : 'auth_login',
        target: user.id,
        ip: request.ip,
        requestId: request.id,
      });
      await client.query('COMMIT');
      reply.setCookie(sessionCookieName(), token, {
        ...cookieOpts(),
        expires: expiresAt,
      });
      if (stepUp) {
        return reply.status(202).send({ stepUp: 'totp' });
      }
      return reply.status(200).send({ id: user.id, email: user.email, role: user.role });
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

  app.post('/api/logout', { preHandler: requireAuth }, async (request, reply) => {
    const tokenHash = (request as unknown as { sessionTokenHash: string })
      .sessionTokenHash as string;
    const user = request.user!;
    await pool.query(`UPDATE sessions SET revoked_at = clock_timestamp() WHERE token_hash=$1`, [
      tokenHash,
    ]);
    const client = await pool.connect();
    try {
      await writeAudit(client, {
        actorId: user.id,
        action: 'auth_logout',
        target: user.id,
        ip: request.ip,
        requestId: request.id,
      });
    } finally {
      client.release();
    }
    reply.clearCookie(sessionCookieName(), {
      ...cookieOpts(),
    });
    return reply.status(200).send({ ok: true });
  });

  app.get('/api/me', { preHandler: requireAuth }, async (request, reply) => {
    const u = request.user!;
    return reply.status(200).send({ id: u.id, email: u.email, role: u.role });
  });

  app.get('/api/sessions', { preHandler: requireAuth }, async (request, reply) => {
    const u = request.user!;
    const currentHash = (request as unknown as { sessionTokenHash: string }).sessionTokenHash;
    const res = await pool.query<{
      id: string;
      created_at: string;
      expires_at: string;
      revoked_at: string | null;
      token_hash: string;
    }>(
      `SELECT id, created_at, expires_at, revoked_at, token_hash FROM sessions WHERE user_id=$1 ORDER BY created_at DESC`,
      [u.id],
    );
    return reply.status(200).send(
      res.rows.map(row => ({
        id: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        current: row.token_hash === currentHash,
      })),
    );
  });

  app.post('/api/sessions/revoke-all', { preHandler: requireAuth }, async (request, reply) => {
    const u = request.user!;
    await pool.query(
      `UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL`,
      [u.id],
    );
    const client = await pool.connect();
    try {
      await writeAudit(client, {
        actorId: u.id,
        action: 'auth_revoke_all',
        target: u.id,
        ip: request.ip,
        requestId: request.id,
      });
    } finally {
      client.release();
    }
    reply.clearCookie(sessionCookieName(), {
      ...cookieOpts(),
    });
    return reply.status(200).send({ ok: true });
  });
}
