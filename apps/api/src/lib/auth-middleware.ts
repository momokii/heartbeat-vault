import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';

export type AuthUser = {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly sessionId: string;
  readonly sessionTotpPending: boolean;
};

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    sessionTokenHash?: string;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type AuthPreHandlerOptions = {
  /**
   * Accept sessions still awaiting their TOTP step-up (totp_pending=true).
   * Only 2FA routes may set this — everything else fails closed with
   * 403 totp_pending so a half-authenticated session can never reach
   * protected surfaces.
   */
  readonly allowTotpPending?: boolean;
};

export function createAuthPreHandler(pool: Pool, options?: AuthPreHandlerOptions) {
  return async function authPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const cookies = (request.cookies as Record<string, string | undefined>) ?? {};
    const raw = cookies['__Host-session'] ?? cookies['session'];
    if (!raw || typeof raw !== 'string' || raw.length === 0) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    const tokenHash = hashToken(raw);
    const res = await pool.query<{
      id: string;
      email: string;
      role: string;
      session_id: string;
      totp_pending: boolean;
    }>(
      `SELECT u.id, u.email, u.role, s.id as session_id, s.totp_pending
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash],
    );
    if (res.rowCount === 0 || res.rows.length === 0) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    const row = res.rows[0]!;
    if (row.totp_pending && !options?.allowTotpPending) {
      await reply.status(403).send({ error: 'totp_pending' });
      return;
    }
    request.user = {
      id: row.id,
      email: row.email,
      role: row.role,
      sessionId: row.session_id,
      sessionTotpPending: row.totp_pending,
    };
    request.sessionTokenHash = tokenHash;
  };
}
