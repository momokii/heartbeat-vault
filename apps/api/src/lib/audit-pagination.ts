import { z } from 'zod';

export const auditCategories = [
  'auth',
  'switch',
  'account',
  'admin',
  'invite',
  '2fa',
  'trigger',
  'heartbeat',
  'delivery',
  'system',
] as const;

export const auditDateSchema = z
  .string()
  .datetime({ offset: true })
  .transform(value => new Date(value));

export const auditPaginationSchema = z.object({
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const auditFilterSchema = {
  q: z.string().trim().min(1).max(200).optional(),
  category: z.enum(auditCategories).optional(),
  from: auditDateSchema.optional(),
  to: auditDateSchema.optional(),
};

function validateDateRange(
  value: { readonly from?: Date | undefined; readonly to?: Date | undefined },
  context: z.RefinementCtx,
): void {
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    context.addIssue({ code: 'custom', message: 'from must not be after to', path: ['to'] });
  }
}

export const auditReadQuerySchema = auditPaginationSchema
  .extend(auditFilterSchema)
  .strict()
  .superRefine(validateDateRange);

export const auditExportQuerySchema = z
  .object({ ...auditFilterSchema, format: z.enum(['csv', 'json']) })
  .strict()
  .superRefine(validateDateRange);

export type AuditReadFilters = {
  readonly beforeId?: number | undefined;
  readonly q?: string | undefined;
  readonly category?: (typeof auditCategories)[number] | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
};

type AuditPredicate = {
  readonly where: string;
  readonly parameters: readonly (number | string | Date)[];
};

function categoryExpression(actionColumn: string): string {
  return `CASE
    WHEN ${actionColumn} LIKE 'auth\\_%' ESCAPE '\\' THEN 'auth'
    WHEN ${actionColumn} LIKE 'switch\\_%' ESCAPE '\\' THEN 'switch'
    WHEN ${actionColumn} LIKE 'account\\_%' ESCAPE '\\' THEN 'account'
    WHEN ${actionColumn} LIKE 'admin\\_%' ESCAPE '\\' THEN 'admin'
    WHEN ${actionColumn} LIKE 'invite\\_%' ESCAPE '\\' THEN 'invite'
    WHEN ${actionColumn} LIKE '2fa\\_%' ESCAPE '\\' THEN '2fa'
    WHEN ${actionColumn} LIKE 'trigger\\_%' ESCAPE '\\' OR ${actionColumn} LIKE 'quorum\\_%' ESCAPE '\\' THEN 'trigger'
    WHEN ${actionColumn} LIKE 'heartbeat\\_%' ESCAPE '\\' THEN 'heartbeat'
    WHEN ${actionColumn} LIKE 'delivery\\_%' ESCAPE '\\' THEN 'delivery'
    ELSE 'system'
  END`;
}

export const auditCategoryExpression = categoryExpression('a.action');

/** Builds every read-path constraint against the immutable audit log. */
export function buildAuditPredicate(filters: AuditReadFilters, target?: string): AuditPredicate {
  const parameters: (number | string | Date)[] = [];
  const clauses: string[] = [];
  const add = (value: number | string | Date): string => {
    parameters.push(value);
    return `$${parameters.length}`;
  };

  if (target !== undefined) clauses.push(`a.target = ${add(target)}`);
  if (filters.beforeId !== undefined) clauses.push(`a.id < ${add(filters.beforeId)}`);
  if (filters.q !== undefined) {
    const query = add(`%${filters.q}%`);
    clauses.push(`(a.target ILIKE ${query} OR u.email ILIKE ${query})`);
  }
  if (filters.category !== undefined) {
    clauses.push(`${auditCategoryExpression} = ${add(filters.category)}`);
  }
  if (filters.from !== undefined) clauses.push(`a.ts >= ${add(filters.from)}`);
  if (filters.to !== undefined) clauses.push(`a.ts <= ${add(filters.to)}`);

  return {
    where: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`,
    parameters,
  };
}
