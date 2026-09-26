import { z } from 'zod';

export const AUDIT_CATEGORIES = [
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

export const auditCategorySchema = z.enum(AUDIT_CATEGORIES);
export type AuditCategory = z.infer<typeof auditCategorySchema>;

export const auditItemSchema = z.object({
  id: z.number().int().positive(),
  timestamp: z.string().datetime(),
  actorId: z.string().nullable(),
  actorEmail: z.string().email().nullable(),
  action: z.string(),
  category: auditCategorySchema,
  target: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});

export const auditPageSchema = z.object({
  items: z.array(auditItemSchema),
  nextBeforeId: z.number().int().positive().nullable(),
});

export type AuditItem = z.infer<typeof auditItemSchema>;
export type AuditFilterValues = {
  readonly category: AuditCategory | '';
  readonly from: string;
  readonly to: string;
};

export const EMPTY_AUDIT_FILTERS: AuditFilterValues = { category: '', from: '', to: '' };

export function parseAuditCategory(value: string): AuditCategory | '' {
  const parsed = auditCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : '';
}

function toIsoDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function buildAuditQuery(
  filters: AuditFilterValues,
  beforeId?: number,
): Readonly<Record<string, string | number | undefined>> {
  return {
    beforeId,
    category: filters.category || undefined,
    from: toIsoDate(filters.from),
    to: toIsoDate(filters.to),
  };
}
