import { z } from 'zod';
import { auditCategorySchema, type AuditCategory } from '@/lib/audit-contract';

export const REPORT_FORMATS = ['csv', 'json'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_SCOPES = ['global', 'switch'] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

export const REPORT_DATE_SHORTCUTS = ['today', 'yesterday', 'this_week', 'this_month'] as const;
export type ReportDateShortcut = (typeof REPORT_DATE_SHORTCUTS)[number];

export const REPORT_DATE_SHORTCUT_LABELS: Record<ReportDateShortcut, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  this_month: 'This month',
};

export const exportJobSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  requestedByEmail: z.string().email().nullable(),
  scopeType: z.enum(REPORT_SCOPES),
  switchId: z.string().uuid().nullable(),
  switchTitle: z.string().nullable(),
  format: z.enum(REPORT_FORMATS),
  filters: z.record(z.string(), z.unknown()),
  rowCount: z.number().int().nullable(),
  status: z.enum(['success', 'failed']),
  errorCode: z.string().nullable(),
});

export const exportJobPageSchema = z.object({
  items: z.array(exportJobSchema),
  nextBeforeId: z.number().int().positive().nullable(),
});

export type ExportJob = z.infer<typeof exportJobSchema>;

export const switchOptionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  ownerEmail: z.string().email().nullable().optional(),
});

export type SwitchOption = z.infer<typeof switchOptionSchema>;

export type ExportRequestBody = {
  readonly format: ReportFormat;
  readonly scope: ReportScope;
  readonly switchId?: string;
  readonly category?: AuditCategory;
  readonly from?: string;
  readonly to?: string;
};

function toLocalInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59);
}

/** Resolves a shortcut to a local from/to pair covering that period. */
export function applyReportDateShortcut(
  shortcut: ReportDateShortcut,
  now: Date = new Date(),
): { from: string; to: string } {
  if (shortcut === 'today') {
    return { from: toLocalInput(startOfDay(now)), to: toLocalInput(endOfDay(now)) };
  }
  if (shortcut === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return { from: toLocalInput(startOfDay(yesterday)), to: toLocalInput(endOfDay(yesterday)) };
  }
  if (shortcut === 'this_week') {
    const start = startOfDay(now);
    const daysSinceMonday = (now.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
    const end = endOfDay(now);
    end.setDate(end.getDate() + (6 - daysSinceMonday));
    return { from: toLocalInput(start), to: toLocalInput(end) };
  }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59);
  return { from: toLocalInput(monthStart), to: toLocalInput(monthEnd) };
}

/** Builds the POST /api/reports/exports body from dialog state. */
export function buildExportRequest(input: {
  readonly format: ReportFormat;
  readonly scope: ReportScope;
  readonly switchId: string;
  readonly category: AuditCategory | '';
  readonly from: string;
  readonly to: string;
}):
  | { readonly ok: true; readonly body: ExportRequestBody }
  | {
      readonly ok: false;
      readonly error: 'missing_switch' | 'invalid_dates' | 'reversed_range';
    } {
  if (input.scope === 'switch' && input.switchId === '') {
    return { ok: false, error: 'missing_switch' };
  }
  const body: {
    format: ReportFormat;
    scope: ReportScope;
    switchId?: string;
    category?: AuditCategory;
    from?: string;
    to?: string;
  } = { format: input.format, scope: input.scope };
  const fromDate = input.from === '' ? undefined : new Date(input.from);
  const toDate = input.to === '' ? undefined : new Date(input.to);
  if (
    (fromDate !== undefined && Number.isNaN(fromDate.getTime())) ||
    (toDate !== undefined && Number.isNaN(toDate.getTime()))
  ) {
    return { ok: false, error: 'invalid_dates' };
  }
  if (fromDate !== undefined && toDate !== undefined && fromDate > toDate) {
    return { ok: false, error: 'reversed_range' };
  }
  if (input.category !== '') body.category = input.category;
  if (fromDate !== undefined) body.from = fromDate.toISOString();
  if (toDate !== undefined) body.to = toDate.toISOString();
  return { ok: true, body };
}

export function formatReportDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

export function describeExportFilters(filters: Record<string, unknown>): string {
  const parts: string[] = [];
  const category = filters['category'];
  if (typeof category === 'string' && category !== '') parts.push(category);
  const from = filters['from'];
  const to = filters['to'];
  if (typeof from === 'string' && typeof to === 'string' && from !== '' && to !== '') {
    parts.push(`${formatReportDate(from)} → ${formatReportDate(to)}`);
  } else if (typeof from === 'string' && from !== '') {
    parts.push(`from ${formatReportDate(from)}`);
  } else if (typeof to === 'string' && to !== '') {
    parts.push(`until ${formatReportDate(to)}`);
  }
  return parts.length === 0 ? '—' : parts.join(' · ');
}

export { auditCategorySchema };
