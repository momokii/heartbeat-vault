import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { writeAudit } from '../lib/audit.js';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { requireRole } from '../lib/roles.js';

const settingsSchema = z.object({
  openRegistration: z.boolean(),
});

export async function registerAdminRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);
  const requireAdmin = requireRole('admin');

  app.put(
    '/api/admin/settings',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_request' });
      }
      const { openRegistration } = parsed.data;
      const value = openRegistration ? 'true' : 'false';
      const actor = request.user!;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const previous = await client.query<{ value: string }>(
          `SELECT value FROM app_config WHERE key='open_registration' FOR UPDATE`,
        );
        const from = previous.rows[0]?.value === 'true';
        await client.query(
          `INSERT INTO app_config (key, value, updated_at) VALUES ('open_registration', $1, clock_timestamp())
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = clock_timestamp()`,
          [value],
        );
        await writeAudit(client, {
          actorId: actor.id,
          action: 'admin_settings_updated',
          target: 'open_registration',
          ip: request.ip,
          requestId: request.id,
          details: { setting: 'openRegistration', from, to: openRegistration },
        });
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
        request.log.error(err);
        return reply.status(500).send({ error: 'internal_error' });
      } finally {
        client.release();
      }

      return reply.status(200).send({ openRegistration });
    },
  );
}
