// Heartbeat check-in routes (T4.2): manual button, API token, one-time email link.
//
// Security posture:
// - Manual check-in requires a full session; when the owner has TOTP enabled,
//   a valid current code is mandatory (step-up per Brief 5.1).
// - Token + email-link check-ins are public but IP rate-limited; tokens are
//   stored hash-only; email links are single-use and expiring (410 after use).
// - Every check-in resets heartbeat_started_at / next_deadline atomically and
//   lands a row in heartbeats (method-tagged) plus the audit chain.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { writeAudit } from '../lib/audit.js';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { decryptTotpSecret, verifyTotpCode } from '../lib/totp-store.js';

const uuidSchema = z.string().uuid();

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function loadSwitchForOwner(
  pool: Pool,
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<{ id: string; status: string } | null> {
  const res = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM switches WHERE id=$1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  const owner = await pool.query<{ owner_id: string }>(
    `SELECT owner_id FROM switches WHERE id=$1`,
    [id],
  );
  if (!isAdmin && owner.rows[0]!.owner_id !== userId) return null;
  return row;
}

export async function recordHeartbeat(
  client: PoolClient,
  switchId: string,
  method: string,
  audit: { actorId?: string | null; ip?: string | null; requestId?: string | null },
): Promise<void> {
  await client.query(`INSERT INTO heartbeats (switch_id, method) VALUES ($1,$2)`, [
    switchId,
    method,
  ]);
  await client.query(
    `UPDATE switches SET heartbeat_started_at = clock_timestamp(),
        next_deadline = clock_timestamp() + heartbeat_interval,
        updated_at = clock_timestamp()
      WHERE id=$1 AND status='active'`,
    [switchId],
  );
  await client.query(`DELETE FROM vault_waits WHERE switch_id=$1`, [switchId]);
  await writeAudit(client, {
    actorId: audit.actorId ?? null,
    action: 'heartbeat_checkin',
    target: switchId,
    ip: audit.ip ?? null,
    requestId: audit.requestId ?? null,
    details: { method },
  });
}

export async function registerHeartbeatRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.post(
    '/api/switches/:id/heartbeat-token',
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
      if (!id.success) return reply.status(404).send({ error: 'not_found' });
      const user = request.user!;
      const row = await loadSwitchForOwner(pool, id.data, user.id, user.role === 'admin');
      if (!row) return reply.status(404).send({ error: 'not_found' });
      const token = randomBytes(32).toString('base64url');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE switches SET heartbeat_token_hash=$1 WHERE id=$2`, [
          hashToken(token),
          id.data,
        ]);
        await writeAudit(client, {
          actorId: user.id,
          action: 'heartbeat_token_issued',
          target: id.data,
          ip: request.ip,
          requestId: request.id,
          details: { method: 'token' },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        request.log.error(err);
        return reply.status(500).send({ error: 'internal_error' });
      } finally {
        client.release();
      }
      return reply.status(201).send({ token });
    },
  );

  app.post(
    '/api/switches/:id/heartbeat-link',
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
      if (!id.success) return reply.status(404).send({ error: 'not_found' });
      const user = request.user!;
      const row = await loadSwitchForOwner(pool, id.data, user.id, user.role === 'admin');
      if (!row) return reply.status(404).send({ error: 'not_found' });
      const token = randomBytes(32).toString('base64url');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO heartbeat_links (switch_id, token_hash, expires_at)
           VALUES ($1,$2, clock_timestamp() + interval '30 days')`,
          [id.data, hashToken(token)],
        );
        await writeAudit(client, {
          actorId: user.id,
          action: 'heartbeat_link_issued',
          target: id.data,
          ip: request.ip,
          requestId: request.id,
          details: { method: 'email_link', expiresInDays: 30 },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        request.log.error(err);
        return reply.status(500).send({ error: 'internal_error' });
      } finally {
        client.release();
      }
      return reply.status(201).send({ token });
    },
  );

  app.post('/api/switches/:id/check-in', { preHandler: requireAuth }, async (request, reply) => {
    const id = uuidSchema.safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const user = request.user!;
    const row = await loadSwitchForOwner(pool, id.data, user.id, user.role === 'admin');
    if (!row) return reply.status(404).send({ error: 'not_found' });
    if (row.status !== 'active') {
      return reply.status(409).send({ error: 'not_active' });
    }
    const parsed = z
      .object({ totpCode: z.string().min(6).max(8).optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });

    const totpState = await pool.query<{ totp_verified_at: Date | null }>(
      `SELECT totp_verified_at FROM users WHERE id=$1`,
      [user.id],
    );
    const totp = totpState.rows[0]!;
    if (totp.totp_verified_at !== null && !parsed.data.totpCode) {
      return reply.status(403).send({ error: 'totp_required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (totp.totp_verified_at !== null) {
        // Re-read the TOTP state under a row lock inside this transaction so
        // counter advancement commits atomically with the check-in and its
        // audit row: a failure after verification rolls the counter back,
        // and the lock closes the concurrent-replay window.
        const locked = await client.query<{
          totp_verified_at: Date | null;
          totp_secret_encrypted: Buffer | null;
          totp_last_counter: string;
        }>(
          `SELECT totp_verified_at, totp_secret_encrypted, totp_last_counter
             FROM users WHERE id=$1 FOR UPDATE`,
          [user.id],
        );
        const lockedTotp = locked.rows[0]!;
        if (lockedTotp.totp_verified_at !== null) {
          if (!parsed.data.totpCode) {
            await client.query('ROLLBACK');
            return reply.status(403).send({ error: 'totp_required' });
          }
          let secret: string;
          try {
            secret = decryptTotpSecret(lockedTotp.totp_secret_encrypted!);
          } catch {
            await client.query('ROLLBACK');
            return reply.status(500).send({ error: 'internal_error' });
          }
          const outcome = await verifyTotpCode(
            secret,
            parsed.data.totpCode,
            Number(lockedTotp.totp_last_counter),
          );
          if (!outcome.ok) {
            await client.query('ROLLBACK');
            return reply.status(403).send({ error: 'totp_required' });
          }
          await client.query(`UPDATE users SET totp_last_counter=$1 WHERE id=$2`, [
            outcome.step,
            user.id,
          ]);
        }
      }
      await recordHeartbeat(client, id.data, 'manual', {
        actorId: user.id,
        ip: request.ip,
        requestId: request.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true });
  });

  app.post('/api/heartbeat/:token', async (request, reply) => {
    const limit = checkRateLimit(request.ip, '2fa');
    if (!limit.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(limit.retryAfterSec ?? 60))
        .send({ error: 'rate_limited' });
    }
    const token = (request.params as Record<string, string>)['token'] ?? '';
    if (token.length < 16 || token.length > 200) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const res = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM switches WHERE heartbeat_token_hash=$1`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    if (!row) return reply.status(404).send({ error: 'not_found' });
    if (row.status !== 'active') {
      return reply.status(409).send({ error: 'not_active' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordHeartbeat(client, row.id, 'token', { ip: request.ip, requestId: request.id });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true });
  });

  app.get('/api/heartbeat/link/:token', async (request, reply) => {
    const token = (request.params as Record<string, string>)['token'] ?? '';
    if (token.length < 16 || token.length > 200) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const res = await pool.query<{ title: string; used_at: Date | null; expires_at: Date }>(
      `SELECT s.title, l.used_at, l.expires_at
       FROM heartbeat_links l JOIN switches s ON s.id = l.switch_id
       WHERE l.token_hash=$1`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    if (!row) return reply.status(404).send({ error: 'not_found' });
    if (row.used_at !== null || row.expires_at.getTime() <= Date.now()) {
      return reply.status(410).send({ error: 'gone' });
    }
    return reply.status(200).send({ switchTitle: row.title });
  });

  app.post('/api/heartbeat/link/:token', async (request, reply) => {
    const limit = checkRateLimit(request.ip, '2fa');
    if (!limit.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(limit.retryAfterSec ?? 60))
        .send({ error: 'rate_limited' });
    }
    const token = (request.params as Record<string, string>)['token'] ?? '';
    if (token.length < 16 || token.length > 200) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const res = await pool.query<{
      id: string;
      switch_id: string;
      used_at: Date | null;
      expires_at: Date;
      status: string;
    }>(
      `SELECT l.id, l.switch_id, l.used_at, l.expires_at, s.status
       FROM heartbeat_links l JOIN switches s ON s.id = l.switch_id
       WHERE l.token_hash=$1`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    if (!row) return reply.status(404).send({ error: 'not_found' });
    if (row.used_at !== null || row.expires_at.getTime() <= Date.now()) {
      return reply.status(410).send({ error: 'gone' });
    }
    if (row.status !== 'active') {
      return reply.status(409).send({ error: 'not_active' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<{ id: string }>(
        `UPDATE heartbeat_links SET used_at=clock_timestamp()
         WHERE id=$1 AND used_at IS NULL RETURNING id`,
        [row.id],
      );
      if (claimed.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(410).send({ error: 'gone' });
      }
      await recordHeartbeat(client, row.switch_id, 'email_link', {
        ip: request.ip,
        requestId: request.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.status(500).send({ error: 'internal_error' });
    } finally {
      client.release();
    }
    return reply.status(200).send({ ok: true });
  });
}
