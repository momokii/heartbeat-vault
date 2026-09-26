import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthPreHandler } from '../lib/auth-middleware.js';
import { requireRole } from '../lib/roles.js';
import {
  auditCategories,
  auditDateSchema,
  buildAuditPredicate,
  escapeLikePattern,
} from '../lib/audit-pagination.js';
import { auditSelect, buildAuditCsv, serializeAuditRow, type AuditRow } from './audit-log.js';

const EXPORT_ROW_LIMIT = 10_000;

const exportRequestSchema = z
  .object({
    format: z.enum(['csv', 'json']),
    scope: z.enum(['global', 'switch']),
    switchId: z.string().uuid().optional(),
    category: z.enum(auditCategories).optional(),
    from: auditDateSchema.optional(),
    to: auditDateSchema.optional(),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === 'switch' && value.switchId === undefined) {
      ctx.addIssue({ code: 'custom', message: 'switchId is required', path: ['switchId'] });
    }
    if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
      ctx.addIssue({ code: 'custom', message: 'from must not be after to', path: ['to'] });
    }
  });

type ExportRequest = z.infer<typeof exportRequestSchema>;

const exportListQuerySchema = z
  .object({
    beforeId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: z.enum(['success', 'failed']).optional(),
    format: z.enum(['csv', 'json']).optional(),
    scope: z.enum(['global', 'switch']).optional(),
    switchId: z.string().uuid().optional(),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

type ExportJobRow = {
  readonly seq: string;
  readonly id: string;
  readonly createdAt: Date;
  readonly requestedByEmail: string | null;
  readonly scopeType: string;
  readonly switchId: string | null;
  readonly switchTitle: string | null;
  readonly format: string;
  readonly filters: unknown;
  readonly rowCount: number | null;
  readonly status: string;
  readonly errorCode: string | null;
};

function recordedFilters(request: ExportRequest): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (request.category !== undefined) filters['category'] = request.category;
  if (request.from !== undefined) filters['from'] = request.from.toISOString();
  if (request.to !== undefined) filters['to'] = request.to.toISOString();
  if (request.q !== undefined) filters['q'] = request.q;
  return filters;
}

async function recordExportJob(
  pool: Pool,
  request: ExportRequest,
  requestedBy: string,
  status: 'success' | 'failed',
  rowCount: number | null,
  errorCode: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO export_jobs (requested_by, scope_type, switch_id, format, filters, row_count, status, error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      requestedBy,
      request.scope,
      request.scope === 'switch' ? (request.switchId ?? null) : null,
      request.format,
      JSON.stringify(recordedFilters(request)),
      rowCount,
      status,
      errorCode,
    ],
  );
}

export async function registerReportsRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireAuth = createAuthPreHandler(pool);

  app.post(
    '/api/reports/exports',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const parsed = exportRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const body = parsed.data;
      const user = request.user;
      if (user === undefined) return reply.status(401).send({ error: 'unauthorized' });

      if (body.scope === 'switch') {
        const switchRow = await pool.query<{ id: string }>(`SELECT id FROM switches WHERE id=$1`, [
          body.switchId,
        ]);
        if (switchRow.rows.length === 0) return reply.status(404).send({ error: 'not_found' });
      }

      try {
        const predicate = buildAuditPredicate(
          { category: body.category, from: body.from, to: body.to, q: body.q },
          body.scope === 'switch' ? body.switchId : undefined,
        );
        const result = await pool.query<AuditRow>(
          `${auditSelect}
           ${predicate.where}
           ORDER BY a.id DESC
           LIMIT $${predicate.parameters.length + 1}`,
          [...predicate.parameters, EXPORT_ROW_LIMIT + 1],
        );
        if (result.rows.length > EXPORT_ROW_LIMIT) {
          await recordExportJob(pool, body, user.id, 'failed', null, 'export_limit_exceeded');
          return reply.status(400).send({ error: 'export_limit_exceeded' });
        }

        const items = result.rows.map(serializeAuditRow);
        await recordExportJob(pool, body, user.id, 'success', items.length, null);
        const baseName = body.scope === 'switch' ? 'switch-audit' : 'audit-log';
        const headers = reply
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff');
        if (body.format === 'json') {
          return headers
            .header('content-disposition', `attachment; filename="${baseName}.json"`)
            .type('application/json; charset=utf-8')
            .send({ items });
        }
        return headers
          .header('content-disposition', `attachment; filename="${baseName}.csv"`)
          .type('text/csv; charset=utf-8')
          .send(buildAuditCsv(items));
      } catch (error) {
        request.log.error(error);
        try {
          await recordExportJob(pool, body, user.id, 'failed', null, 'internal_error');
        } catch (ledgerError) {
          request.log.error(ledgerError);
        }
        return reply.status(500).send({ error: 'internal_error' });
      }
    },
  );

  app.get(
    '/api/reports/exports',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const parsed = exportListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });

      const { limit } = parsed.data;
      const parameters: (number | string)[] = [];
      const clauses: string[] = [];
      const add = (value: number | string): string => {
        parameters.push(value);
        return `$${parameters.length}`;
      };
      if (parsed.data.beforeId !== undefined) clauses.push(`j.seq < ${add(parsed.data.beforeId)}`);
      if (parsed.data.status !== undefined) clauses.push(`j.status = ${add(parsed.data.status)}`);
      if (parsed.data.format !== undefined) clauses.push(`j.format = ${add(parsed.data.format)}`);
      if (parsed.data.scope !== undefined) clauses.push(`j.scope_type = ${add(parsed.data.scope)}`);
      if (parsed.data.switchId !== undefined)
        clauses.push(`j.switch_id = ${add(parsed.data.switchId)}`);
      if (parsed.data.q !== undefined) {
        const pattern = `%${escapeLikePattern(parsed.data.q)}%`;
        const emailPlaceholder = add(pattern);
        const titlePlaceholder = add(pattern);
        clauses.push(
          `(u.email ILIKE ${emailPlaceholder} ESCAPE '\\' OR s.title ILIKE ${titlePlaceholder} ESCAPE '\\')`,
        );
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const result = await pool.query<ExportJobRow>(
        `SELECT j.seq, j.id, j.created_at AS "createdAt", u.email AS "requestedByEmail",
                j.scope_type AS "scopeType", j.switch_id AS "switchId", s.title AS "switchTitle",
                j.format, j.filters, j.row_count AS "rowCount", j.status, j.error_code AS "errorCode"
         FROM export_jobs j
         LEFT JOIN users u ON u.id = j.requested_by
         LEFT JOIN switches s ON s.id = j.switch_id
         ${where}
         ORDER BY j.seq DESC
         LIMIT $${parameters.length + 1}`,
        [...parameters, limit + 1],
      );
      const rows = result.rows.slice(0, limit);
      const items = rows.map(row => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        requestedByEmail: row.requestedByEmail,
        scopeType: row.scopeType,
        switchId: row.switchId,
        switchTitle: row.switchTitle,
        format: row.format,
        filters:
          row.filters !== null && typeof row.filters === 'object' && !Array.isArray(row.filters)
            ? (row.filters as Record<string, unknown>)
            : {},
        rowCount: row.rowCount,
        status: row.status,
        errorCode: row.errorCode,
      }));
      return reply.status(200).send({
        items,
        nextBeforeId: result.rows.length > limit ? Number(rows.at(-1)?.seq ?? 0) || null : null,
      });
    },
  );
}
