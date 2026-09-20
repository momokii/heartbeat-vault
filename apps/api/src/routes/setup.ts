import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { writeAudit } from '../lib/audit.js';

// Name field intentionally removed: users table has no name column.
// Accepting then dropping it would be sloppy — see DECISIONS_LOG.
const setupBodySchema = z.object({
  token: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(12),
});

function verifyTokenHash(token: string, expectedHex: string): boolean {
  if (!expectedHex || expectedHex.length === 0) return false;
  const actualHex = createHash('sha256').update(token, 'utf8').digest('hex');
  const a = Buffer.from(actualHex, 'utf8');
  const b = Buffer.from(expectedHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function registerSetupRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/api/setup', async (request, reply) => {
    let body: unknown;
    try {
      body = request.body;
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }

    const parsed = setupBodySchema.safeParse(body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const { token, email, password } = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const configRes = await client.query<{ key: string; value: string }>(
        `SELECT key, value FROM app_config WHERE key IN ('setup_completed','setup_token_hash','setup_token_expires_at') FOR UPDATE`,
      );
      const configMap = new Map<string, string>();
      for (const row of configRes.rows) configMap.set(row.key, row.value);

      const completed = configMap.get('setup_completed') ?? 'false';
      if (completed === 'true') {
        await client.query('ROLLBACK');
        return reply.status(410).send({ error: 'gone' });
      }

      const storedHash = configMap.get('setup_token_hash') ?? '';
      const expiresAtRaw = configMap.get('setup_token_expires_at');

      if (!storedHash || storedHash.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(410).send({ error: 'gone' });
      }

      if (expiresAtRaw) {
        const expiresAt = new Date(expiresAtRaw);
        if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
          await client.query('ROLLBACK');
          return reply.status(410).send({ error: 'gone' });
        }
      }

      if (!verifyTokenHash(token, storedHash)) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'invalid_request' });
      }

      const { hashPassword } = await import('@heartbeat-vault/crypto');
      const passwordHash = await hashPassword(password);

      const userRes = await client.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`,
        [email, passwordHash],
      );
      const userId: string = userRes.rows[0].id as string;

      await client.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ('setup_completed','true', clock_timestamp())
         ON CONFLICT (key) DO UPDATE SET value='true', updated_at=clock_timestamp()`,
      );
      await client.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ('setup_token_hash','', clock_timestamp())
         ON CONFLICT (key) DO UPDATE SET value='', updated_at=clock_timestamp()`,
      );
      await client.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ('setup_token_consumed_at', clock_timestamp()::text, clock_timestamp())
         ON CONFLICT (key) DO UPDATE SET value=clock_timestamp()::text, updated_at=clock_timestamp()`,
      );

      await writeAudit(client, {
        actorId: userId,
        action: 'setup_completed',
        target: userId,
        ip: request.ip,
        requestId: request.id,
      });

      await client.query('COMMIT');
      return reply.status(201).send({ id: userId, email, role: 'admin' });
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
}
