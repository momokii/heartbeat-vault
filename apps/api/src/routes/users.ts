import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { writeAudit } from '../lib/audit.js';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { requireRole, requireSelfOrAdmin } from '../lib/roles.js';

export async function registerUserRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);
  const requireAdmin = requireRole('admin');

  // GET /api/users — admin only, list sans hashes
  app.get('/api/users', { preHandler: [requireAuth, requireAdmin] }, async (_request, reply) => {
    const res = await pool.query<{
      id: string;
      email: string;
      role: string;
      created_at: string;
    }>(`SELECT id, email, role, created_at FROM users ORDER BY created_at ASC`);
    return reply.status(200).send(res.rows);
  });

  // GET /api/users/:id — self-or-admin, 404 for others (no enumeration)
  app.get(
    '/api/users/:id',
    { preHandler: [requireAuth, requireSelfOrAdmin('id')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const res = await pool.query<{
        id: string;
        email: string;
        role: string;
        created_at: string;
      }>(`SELECT id, email, role, created_at FROM users WHERE id = $1`, [id]);
      if (res.rowCount === 0 || res.rows.length === 0) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const row = res.rows[0]!;
      return reply.status(200).send(row);
    },
  );

  // POST /api/users/:id/revoke-sessions — self-or-admin
  app.post(
    '/api/users/:id/revoke-sessions',
    { preHandler: [requireAuth, requireSelfOrAdmin('id')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const actor = request.user!;

      // verify target exists (404 same shape if not)
      const exists = await pool.query(`SELECT id FROM users WHERE id = $1`, [id]);
      if (exists.rowCount === 0) {
        return reply.status(404).send({ error: 'not_found' });
      }

      await pool.query(
        `UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );

      const client = await pool.connect();
      try {
        await writeAudit(client, {
          actorId: actor.id,
          action: 'sessions_revoked',
          target: id,
          ip: request.ip,
          requestId: request.id,
        });
      } finally {
        client.release();
      }

      // if actor revoked own sessions, clear cookie
      if (actor.id === id) {
        const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
        const isProd = process.env.APP_ENV === 'production' || isTest;
        const name = isProd || isTest ? '__Host-session' : 'session';
        reply.clearCookie(name, {
          path: '/',
          secure: isProd || isTest,
          httpOnly: true,
          sameSite: 'strict',
        });
      }

      return reply.status(200).send({ ok: true });
    },
  );
}
