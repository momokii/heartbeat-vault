import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { writeAudit } from '../lib/audit.js';
import {
  webauthnConfig,
  encodeStoredChallenge,
  readStoredChallenge,
  parseTransports,
  authenticationBodySchema,
  type StoredCredential,
} from '../lib/webauthn.js';
import { registerWebauthnRegistrationRoutes } from './webauthn-register.js';

type WebauthnDeps = {
  readonly requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly requireAuthWithPending: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export function registerWebauthnRoutes(app: FastifyInstance, pool: Pool, deps: WebauthnDeps): void {
  const { requireAuth, requireAuthWithPending } = deps;
  registerWebauthnRegistrationRoutes(app, pool, requireAuth);

  app.post(
    '/api/2fa/webauthn/login-options',
    { preHandler: requireAuthWithPending },
    async (request, reply) => {
      const user = request.user!;
      if (!user.sessionTotpPending) {
        return reply.status(400).send({ error: 'not_pending' });
      }
      const cfg = webauthnConfig();
      const creds = await pool.query<{ id: string; transports: string | null }>(
        `SELECT id, transports FROM webauthn_credentials WHERE user_id=$1`,
        [user.id],
      );
      if (creds.rowCount === 0 || creds.rows.length === 0) {
        return reply.status(400).send({ error: 'no_credentials' });
      }
      const options = await generateAuthenticationOptions({
        rpID: cfg.rpID,
        allowCredentials: creds.rows.map(r => {
          const transports = parseTransports(r.transports);
          return transports ? { id: r.id, transports } : { id: r.id };
        }),
      });
      await pool.query(`UPDATE sessions SET webauthn_challenge=$2 WHERE token_hash=$1`, [
        request.sessionTokenHash,
        encodeStoredChallenge(options.challenge),
      ]);
      return reply.status(200).send(options);
    },
  );

  app.post(
    '/api/2fa/webauthn/login-verify',
    { preHandler: requireAuthWithPending },
    async (request, reply) => {
      const user = request.user!;
      const cfg = webauthnConfig();
      const parsed = authenticationBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_request' });
      }

      const sess = await pool.query<{ webauthn_challenge: string | null }>(
        `SELECT webauthn_challenge FROM sessions WHERE token_hash=$1`,
        [request.sessionTokenHash],
      );
      const stored = readStoredChallenge(sess.rows[0]!.webauthn_challenge);
      if (!stored || !stored.fresh) {
        return reply.status(400).send({ error: 'challenge_expired' });
      }

      const credRows = await pool.query<StoredCredential>(
        `SELECT id, public_key, counter, transports FROM webauthn_credentials
         WHERE id=$1 AND user_id=$2`,
        [parsed.data.id, user.id],
      );
      const credential = credRows.rows[0];
      if (!credential) {
        return reply.status(400).send({ error: 'verification_failed' });
      }

      let newCounter: number;
      try {
        const transports = parseTransports(credential.transports);
        const verification = await verifyAuthenticationResponse({
          response: parsed.data as unknown as AuthenticationResponseJSON,
          expectedChallenge: stored.challenge,
          expectedOrigin: cfg.origin,
          expectedRPID: cfg.rpID,
          credential: {
            id: credential.id,
            publicKey: new Uint8Array(credential.publicKey),
            counter: Number(credential.counter),
            ...(transports ? { transports } : {}),
          },
          requireUserVerification: true,
        });
        if (!verification.verified) {
          return reply.status(400).send({ error: 'verification_failed' });
        }
        newCounter = verification.authenticationInfo.newCounter;
      } catch (err) {
        request.log.warn(err);
        return reply.status(400).send({ error: 'verification_failed' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE webauthn_credentials SET counter=$2 WHERE id=$1`, [
          credential.id,
          newCounter,
        ]);
        await client.query(
          `UPDATE sessions SET totp_pending=false, webauthn_challenge=NULL WHERE token_hash=$1`,
          [request.sessionTokenHash],
        );
        await writeAudit(client, {
          actorId: user.id,
          action: '2fa_webauthn_login_ok',
          target: user.id,
          ip: request.ip,
          requestId: request.id,
          details: { method: 'webauthn' },
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
}
