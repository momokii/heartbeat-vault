import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { requireRole } from '../lib/roles.js';
import { auditPaginationSchema } from '../lib/audit-pagination.js';
import { loadSwitch } from './switches.js';

const auditLogQuerySchema = auditPaginationSchema.extend({
  action: z.string().min(1).max(100).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

type AuditRow = {
  readonly id: number;
  readonly timestamp: Date;
  readonly actorId: string | null;
  readonly actorEmail: string | null;
  readonly action: string;
  readonly target: string | null;
};

function serializeAuditRow(row: AuditRow) {
  return {
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    action: row.action,
    target: row.target,
  };
}

export async function registerAuditLogRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.get(
    '/api/audit-log',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const parsed = auditLogQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });

      const { beforeId, limit, action, q } = parsed.data;
      const parameters: (number | string)[] = [];
      const clauses: string[] = [];
      if (beforeId !== undefined) {
        parameters.push(beforeId);
        clauses.push(`a.id < $${parameters.length}`);
      }
      if (action !== undefined) {
        parameters.push(action);
        clauses.push(`a.action = $${parameters.length}`);
      }
      if (q !== undefined) {
        parameters.push(`%${q}%`);
        clauses.push(
          `(a.action ILIKE $${parameters.length} OR a.target ILIKE $${parameters.length} OR u.email ILIKE $${parameters.length})`,
        );
      }
      parameters.push(limit);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await pool.query<AuditRow>(
        `SELECT a.id, a.ts AS "timestamp", a.actor_id AS "actorId", u.email AS "actorEmail", a.action, a.target
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       ${where}
       ORDER BY a.id DESC
       LIMIT $${parameters.length}`,
        parameters,
      );
      const items = result.rows.map(serializeAuditRow);
      return reply.status(200).send({
        items,
        nextBeforeId: items.length === limit ? (items.at(-1)?.id ?? null) : null,
      });
    },
  );
}

export async function registerSwitchAuditRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.get('/api/switches/:id/audit', { preHandler: requireAuth }, async (request, reply) => {
    const id = z
      .string()
      .uuid()
      .safeParse((request.params as Record<string, string>)['id']);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const parsed = auditPaginationSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const user = request.user!;
    const switchRow = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!switchRow) return reply.status(404).send({ error: 'not_found' });

    const { beforeId, limit } = parsed.data;
    const result = await pool.query<AuditRow>(
      `SELECT a.id, a.ts AS "timestamp", a.actor_id AS "actorId", u.email AS "actorEmail", a.action, a.target
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.target = $1 AND ($2::int IS NULL OR a.id < $2)
       ORDER BY a.id DESC
       LIMIT $3`,
      [id.data, beforeId ?? null, limit],
    );
    const items = result.rows.map(serializeAuditRow);
    return reply.status(200).send({
      items,
      nextBeforeId: items.length === limit ? (items.at(-1)?.id ?? null) : null,
    });
  });
}
