import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { writeAudit } from '../lib/audit.js';
import {
  webauthnConfig,
  encodeStoredChallenge,
  readStoredChallenge,
  parseTransports,
  registrationBodySchema,
} from '../lib/webauthn.js';

export function registerWebauthnRegistrationRoutes(
  app: FastifyInstance,
  pool: Pool,
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.post(
    '/api/2fa/webauthn/register-options',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user!;
      const cfg = webauthnConfig();

      const userRow = await pool.query<{ webauthn_user_id: Buffer | null }>(
        `SELECT webauthn_user_id FROM users WHERE id=$1`,
        [user.id],
      );
      let webauthnUserId = userRow.rows[0]!.webauthn_user_id;
      if (!webauthnUserId) {
        webauthnUserId = Buffer.from(randomBytes(32));
        await pool.query(`UPDATE users SET webauthn_user_id=$2 WHERE id=$1`, [
          user.id,
          webauthnUserId,
        ]);
      }

      const existing = await pool.query<{ id: string; transports: string | null }>(
        `SELECT id, transports FROM webauthn_credentials WHERE user_id=$1`,
        [user.id],
      );

      const options = await generateRegistrationOptions({
        rpName: cfg.rpName,
        rpID: cfg.rpID,
        userName: user.email,
        userID: new Uint8Array(webauthnUserId),
        excludeCredentials: existing.rows.map(r => {
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
    '/api/2fa/webauthn/register-verify',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.user!;
      const cfg = webauthnConfig();
      const parsed = registrationBodySchema.safeParse(request.body);
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

      let registrationInfo;
      try {
        const verification = await verifyRegistrationResponse({
          // Untrusted wire payload — the verifier fail-closes on any malformed
          // field, which is exactly the boundary behavior this route relies on.
          response: parsed.data as unknown as RegistrationResponseJSON,
          expectedChallenge: stored.challenge,
          expectedOrigin: cfg.origin,
          expectedRPID: cfg.rpID,
          requireUserVerification: true,
        });
        if (!verification.verified || !verification.registrationInfo) {
          return reply.status(400).send({ error: 'verification_failed' });
        }
        registrationInfo = verification.registrationInfo;
      } catch (err) {
        request.log.warn(err);
        return reply.status(400).send({ error: 'verification_failed' });
      }

      const transports = registrationInfo.credential.transports?.join(',') ?? null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO webauthn_credentials
             (id, user_id, public_key, counter, transports, device_type, backed_up)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET
             public_key=EXCLUDED.public_key, counter=EXCLUDED.counter,
             transports=EXCLUDED.transports, device_type=EXCLUDED.device_type,
             backed_up=EXCLUDED.backed_up`,
          [
            registrationInfo.credential.id,
            user.id,
            Buffer.from(registrationInfo.credential.publicKey),
            registrationInfo.credential.counter,
            transports,
            registrationInfo.credentialDeviceType,
            registrationInfo.credentialBackedUp,
          ],
        );
        await client.query(`UPDATE sessions SET webauthn_challenge=NULL WHERE token_hash=$1`, [
          request.sessionTokenHash,
        ]);
        await writeAudit(client, {
          actorId: user.id,
          action: '2fa_webauthn_registered',
          target: user.id,
          ip: request.ip,
          requestId: request.id,
          details: { method: 'webauthn' },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return reply.status(200).send({ verified: true });
    },
  );
}
