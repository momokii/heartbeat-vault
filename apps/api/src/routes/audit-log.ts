import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { sanitizeAuditDetails } from '../lib/audit.js';
import { requireRole } from '../lib/roles.js';
import {
  auditCategoryExpression,
  auditReadQuerySchema,
  buildAuditPredicate,
} from '../lib/audit-pagination.js';
import { loadSwitch } from './switches.js';

export type AuditRow = {
  readonly id: number;
  readonly timestamp: Date;
  readonly actorId: string | null;
  readonly actorEmail: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly category: string;
  readonly details: unknown;
};

type SerializedAuditRow = {
  readonly id: number;
  readonly timestamp: string;
  readonly actorId: string | null;
  readonly actorEmail: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly category: string;
  readonly details: Record<string, unknown>;
};

function serializeDetails(details: unknown): Record<string, unknown> {
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    const sanitized = sanitizeAuditDetails(details);
    if (sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
      return sanitized as Record<string, unknown>;
    }
  }
  return {};
}

export function serializeAuditRow(row: AuditRow): SerializedAuditRow {
  return {
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    action: row.action,
    target: row.target,
    category: row.category,
    details: serializeDetails(row.details),
  };
}

export const auditSelect = `SELECT a.id, a.ts AS "timestamp", a.actor_id AS "actorId", u.email AS "actorEmail", a.action, a.target,
  ${auditCategoryExpression} AS "category", COALESCE(a.details, '{}'::jsonb) AS "details"
FROM audit_log a
LEFT JOIN users u ON u.id = a.actor_id`;

function quoteCsvCell(value: string): string {
  const safeValue = /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

export function buildAuditCsv(items: readonly SerializedAuditRow[]): string {
  const header = [
    'id',
    'timestamp',
    'category',
    'actorId',
    'actorEmail',
    'action',
    'target',
    'details',
  ];
  const lines = items.map(item =>
    [
      String(item.id),
      item.timestamp,
      item.category,
      item.actorId ?? '',
      item.actorEmail ?? '',
      item.action,
      item.target ?? '',
      JSON.stringify(item.details),
    ]
      .map(quoteCsvCell)
      .join(','),
  );
  return `${header.map(quoteCsvCell).join(',')}\r\n${lines.join('\r\n')}\r\n`;
}

export async function registerAuditLogRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.get(
    '/api/audit-log',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const parsed = auditReadQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });

      const { limit } = parsed.data;
      const predicate = buildAuditPredicate(parsed.data);
      const result = await pool.query<AuditRow>(
        `${auditSelect}
        ${predicate.where}
       ORDER BY a.id DESC
       LIMIT $${predicate.parameters.length + 1}`,
        [...predicate.parameters, limit],
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
    const parsed = auditReadQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const user = request.user;
    if (user === undefined) return reply.status(401).send({ error: 'unauthorized' });
    const switchRow = await loadSwitch(pool, id.data, user.id, user.role === 'admin');
    if (!switchRow) return reply.status(404).send({ error: 'not_found' });

    const { limit } = parsed.data;
    const predicate = buildAuditPredicate(parsed.data, id.data);
    const result = await pool.query<AuditRow>(
      `${auditSelect}
       ${predicate.where}
       ORDER BY a.id DESC
       LIMIT $${predicate.parameters.length + 1}`,
      [...predicate.parameters, limit],
    );
    const items = result.rows.map(serializeAuditRow);
    return reply.status(200).send({
      items,
      nextBeforeId: items.length === limit ? (items.at(-1)?.id ?? null) : null,
    });
  });
}
