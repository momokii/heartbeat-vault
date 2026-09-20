import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { writeAudit } from '../lib/audit.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
});

export async function registerOpenRegistrationRoute(
  app: FastifyInstance,
  pool: Pool,
): Promise<void> {
  app.post('/api/register', async (request, reply) => {
    // gate: app_config open_registration default 'false' → else 404
    const cfg = await pool.query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = 'open_registration'`,
    );
    const openVal = cfg.rowCount === 0 ? 'false' : cfg.rows[0]!.value;
    if (openVal !== 'true') {
      return reply.status(404).send({ error: 'not_found' });
    }

    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const { email, password } = parsed.data;

    const { hashPassword } = await import('@heartbeat-vault/crypto');
    const passwordHash = await hashPassword(password);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'user') RETURNING id`,
        [email, passwordHash],
      );
      const userId = res.rows[0]!.id;
      await writeAudit(client, {
        actorId: userId,
        action: 'user_registered',
        target: userId,
        ip: request.ip,
        requestId: request.id,
      });
      await client.query('COMMIT');
      return reply.status(201).send({ id: userId, email, role: 'user' });
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
