// Step-up gate for 2FA-protected operations (heartbeat mutate, panic trigger — T4).
// A session must be fully authenticated (not totp_pending) AND the user must
// have at least one second factor enrolled (TOTP verified or a WebAuthn
// credential). Fails closed with 403 step_up_required.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { createAuthPreHandler } from './auth-middleware.js';

export function requireStepUp(
  pool: Pool,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const auth = createAuthPreHandler(pool);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await auth(request, reply);
    if (reply.raw.headersSent) return;
    const user = request.user;
    if (!user) return;
    const res = await pool.query<{
      totp_ok: boolean;
      wa_ok: boolean;
    }>(
      `SELECT (u.totp_verified_at IS NOT NULL) AS totp_ok,
              EXISTS(SELECT 1 FROM webauthn_credentials w WHERE w.user_id = u.id) AS wa_ok
       FROM users u WHERE u.id = $1`,
      [user.id],
    );
    const row = res.rows[0];
    if (!row || (!row.totp_ok && !row.wa_ok)) {
      await reply.status(403).send({ error: 'step_up_required' });
    }
  };
}
