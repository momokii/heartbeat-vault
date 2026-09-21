import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { decryptTotpSecret, verifyTotpCode } from '../lib/totp-store.js';

const RECOVERY_CODE_COUNT = 10;
// RFC 4648 base32 alphabet — 32 chars, byte&31 is unbiased. Excludes 0/1 so
// handwritten codes stay unambiguous.
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DUMMY_PHC =
  '$argon2id$v=19$m=19456,t=2,p=1$7xMTRCUAskrVin2v5I7PxQ$2zR8iIIQOAbaouop07+izMO8proVleYWEXh0Z0/vDvw';

const totpCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const recoverSchema = z.object({ email: z.string().email(), code: z.string().min(6).max(20) });

function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateRecoveryCode(): string {
  const bytes = randomBytes(8);
  const chars: string[] = [];
  for (const b of bytes) chars.push(CODE_ALPHABET[b & 31]!);
  const code = chars.join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
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

function rateLimited(request: FastifyRequest, reply: FastifyReply): boolean {
  const rate = checkRateLimit(request.ip, '2fa');
  if (rate.allowed) return false;
  reply.header('Retry-After', String(rate.retryAfterSec ?? 60));
  void reply.status(429).send({ error: 'rate_limited' });
  return true;
}

export function registerRecoveryRoutes(
  app: FastifyInstance,
  pool: Pool,
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.post(
    '/api/2fa/recovery-codes/regenerate',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (rateLimited(request, reply)) return reply;
      const parsed = totpCodeSchema.safeParse(request.body);
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
        return reply.status(400).send({ error: 'totp_required' });
      }
      const secret = decryptTotpSecret(blob);
      const outcome = await verifyTotpCode(
        secret,
        parsed.data.code,
        Number(row.rows[0]!.totp_last_counter),
      );
      if (!outcome.ok) {
        return reply.status(401).send({ error: 'invalid_code' });
      }

      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
      const { hashPassword } = await import('@heartbeat-vault/crypto');
      const hashes: string[] = [];
      for (const code of codes) hashes.push(await hashPassword(normalizeRecoveryCode(code)));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Regeneration is a full rotation: the previous batch dies here.
        await client.query(`DELETE FROM recovery_codes WHERE user_id=$1`, [user.id]);
        for (const hash of hashes) {
          await client.query(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1,$2)`, [
            user.id,
            hash,
          ]);
        }
        await client.query(`UPDATE users SET totp_last_counter=$2 WHERE id=$1`, [
          user.id,
          outcome.step,
        ]);
        await writeAudit(client, {
          actorId: user.id,
          action: '2fa_recovery_regenerated',
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
      // Plaintext codes are returned exactly once; only Argon2id hashes persist.
      return reply.status(200).send({ codes });
    },
  );

  app.post('/api/login/recover', async (request, reply) => {
    if (rateLimited(request, reply)) return reply;
    const parsed = recoverSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const { email } = parsed.data;
    const candidate = normalizeRecoveryCode(parsed.data.code);
    const { verifyPassword } = await import('@heartbeat-vault/crypto');

    const userRes = await pool.query<{ id: string; email: string; role: string }>(
      `SELECT id, email, role FROM users WHERE email=$1`,
      [email],
    );
    if (userRes.rowCount === 0 || userRes.rows.length === 0) {
      await verifyPassword(DUMMY_PHC, candidate).catch(() => false);
      return reply.status(401).send({ error: 'invalid_code' });
    }
    const user = userRes.rows[0]!;

    const codes = await pool.query<{ id: number; code_hash: string }>(
      `SELECT id, code_hash FROM recovery_codes WHERE user_id=$1 AND used_at IS NULL`,
      [user.id],
    );
    let matchedId: number | null = null;
    for (const row of codes.rows) {
      if (await verifyPassword(row.code_hash, candidate)) {
        matchedId = row.id;
        break;
      }
    }
    if (matchedId === null) {
      return reply.status(401).send({ error: 'invalid_code' });
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Single-use is enforced atomically: only an unused row can flip used_at.
      const consumed = await client.query(
        `UPDATE recovery_codes SET used_at=clock_timestamp() WHERE id=$1 AND used_at IS NULL`,
        [matchedId],
      );
      if (consumed.rowCount === 0) {
        await client.query('ROLLBACK');
        return reply.status(401).send({ error: 'invalid_code' });
      }
      await client.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at, totp_pending) VALUES ($1,$2,$3,false)`,
        [user.id, tokenHash, expiresAt],
      );
      await writeAudit(client, {
        actorId: user.id,
        action: 'auth_recovery_login',
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
    reply.setCookie(sessionCookieName(), token, { ...cookieOpts(), expires: expiresAt });
    return reply.status(200).send({ id: user.id, email: user.email, role: user.role });
  });
}
