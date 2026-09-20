import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { generateSecret, generateURI } from 'otplib';
import { writeAudit } from '../lib/audit.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { encryptTotpSecret, decryptTotpSecret, verifyTotpCode } from '../lib/totp-store.js';

const TOTP_ISSUER = 'Heartbeat Vault';
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const passwordSchema = z.object({ password: z.string().min(1) });

function rateLimited(request: FastifyRequest, reply: FastifyReply): boolean {
  const rate = checkRateLimit(request.ip, '2fa');
  if (rate.allowed) return false;
  reply.header('Retry-After', String(rate.retryAfterSec ?? 60));
  void reply.status(429).send({ error: 'rate_limited' });
  return true;
}

type TotpDeps = {
  readonly requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly requireAuthWithPending: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export function registerTotpRoutes(app: FastifyInstance, pool: Pool, deps: TotpDeps): void {
  const { requireAuth, requireAuthWithPending } = deps;

  app.post('/api/2fa/totp/enroll', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    const secret = generateSecret();
    const otpauthUrl = generateURI({ issuer: TOTP_ISSUER, label: user.email, secret });
    const blob = encryptTotpSecret(secret);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET totp_secret_encrypted=$2, totp_verified_at=NULL, totp_last_counter=0,
           updated_at=clock_timestamp() WHERE id=$1`,
        [user.id, blob],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: '2fa_totp_enroll_started',
        target: user.id,
        ip: request.ip,
        requestId: request.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // transaction already broken
      }
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    // Secret is shown exactly once, in this response only.
    return reply.status(200).send({ otpauthUrl, secret });
  });

  app.post('/api/2fa/totp/verify', { preHandler: requireAuth }, async (request, reply) => {
    if (rateLimited(request, reply)) return reply;
    const parsed = codeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const user = request.user!;
    const row = await pool.query<{
      totp_secret_encrypted: Buffer | null;
      totp_last_counter: string;
    }>(`SELECT totp_secret_encrypted, totp_last_counter FROM users WHERE id=$1`, [user.id]);
    const blob = row.rows[0]?.totp_secret_encrypted;
    if (!blob) {
      return reply.status(400).send({ error: 'not_enrolled' });
    }
    const secret = decryptTotpSecret(blob);
    const last = Number(row.rows[0]!.totp_last_counter);
    const outcome = await verifyTotpCode(secret, parsed.data.code, last);
    if (!outcome.ok) {
      return reply.status(401).send({ error: 'invalid_code' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET totp_verified_at=clock_timestamp(), totp_last_counter=$2,
           updated_at=clock_timestamp() WHERE id=$1`,
        [user.id, outcome.step],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: '2fa_totp_enabled',
        target: user.id,
        ip: request.ip,
        requestId: request.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // transaction already broken
      }
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ verified: true });
  });

  app.post(
    '/api/2fa/totp/challenge',
    { preHandler: requireAuthWithPending },
    async (request, reply) => {
      if (rateLimited(request, reply)) return reply;
      const parsed = codeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_request' });
      }
      const user = request.user!;
      const row = await pool.query<{
        totp_secret_encrypted: Buffer | null;
        totp_verified_at: string | null;
        totp_last_counter: string;
      }>(
        `SELECT totp_secret_encrypted, totp_verified_at, totp_last_counter FROM users WHERE id=$1`,
        [user.id],
      );
      const blob = row.rows[0]?.totp_secret_encrypted;
      if (!blob || !row.rows[0]!.totp_verified_at) {
        return reply.status(400).send({ error: 'totp_not_enabled' });
      }
      if (!user.sessionTotpPending) {
        return reply.status(400).send({ error: 'not_pending' });
      }
      const secret = decryptTotpSecret(blob);
      const last = Number(row.rows[0]!.totp_last_counter);
      const outcome = await verifyTotpCode(secret, parsed.data.code, last);
      if (!outcome.ok) {
        return reply.status(401).send({ error: 'invalid_code' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE users SET totp_last_counter=$2 WHERE id=$1`, [
          user.id,
          outcome.step,
        ]);
        await client.query(`UPDATE sessions SET totp_pending=false WHERE token_hash=$1`, [
          request.sessionTokenHash,
        ]);
        await writeAudit(client, {
          actorId: user.id,
          action: '2fa_totp_challenge_ok',
          target: user.id,
          ip: request.ip,
          requestId: request.id,
        });
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // transaction already broken
        }
        request.log.error(err);
        return reply.status(500).send({ error: 'internal_error' });
      } finally {
        client.release();
      }
      return reply.status(200).send({ ok: true });
    },
  );

  app.post('/api/2fa/totp/disable', { preHandler: requireAuth }, async (request, reply) => {
    if (rateLimited(request, reply)) return reply;
    const parsed = passwordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const user = request.user!;
    const row = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`,
      [user.id],
    );
    const { verifyPassword } = await import('@heartbeat-vault/crypto');
    const ok = await verifyPassword(row.rows[0]!.password_hash, parsed.data.password);
    if (!ok) {
      return reply.status(401).send({ error: 'invalid_password' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET totp_secret_encrypted=NULL, totp_verified_at=NULL, totp_last_counter=0,
           updated_at=clock_timestamp() WHERE id=$1`,
        [user.id],
      );
      // Nothing left to wait for: pending step-up sessions complete immediately.
      await client.query(`UPDATE sessions SET totp_pending=false WHERE user_id=$1`, [user.id]);
      await client.query(`DELETE FROM recovery_codes WHERE user_id=$1`, [user.id]);
      await writeAudit(client, {
        actorId: user.id,
        action: '2fa_totp_disabled',
        target: user.id,
        ip: request.ip,
        requestId: request.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // transaction already broken
      }
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true });
  });
}
