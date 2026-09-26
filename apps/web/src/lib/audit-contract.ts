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

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  auth: 'Authentication',
  switch: 'Switch',
  account: 'Account',
  admin: 'Administration',
  invite: 'Invitation',
  '2fa': 'Two-factor authentication',
  trigger: 'Trigger',
  heartbeat: 'Heartbeat',
  delivery: 'Delivery',
  system: 'System',
};

const AUDIT_ACTION_LABELS: Record<string, string> = {
  auth_login: 'Signed in',
  auth_stepup_started: 'Step-up started',
  auth_logout: 'Signed out',
  auth_revoke_all: 'Revoked all sessions',
  auth_lockout: 'Account locked',
  auth_recovery_login: 'Recovered with code',
  account_password_changed: 'Password changed',
  sessions_revoked: 'Sessions revoked',
  password_reset_issued: 'Password reset issued',
  password_reset_consumed: 'Password reset used',
  admin_settings_updated: 'Settings updated',
  invite_created: 'Invitation created',
  invite_consumed: 'Invitation accepted',
  setup_completed: 'Setup completed',
  user_registered: 'User registered',
  switch_created: 'Switch created',
  switch_updated: 'Switch updated',
  switch_deleted: 'Switch deleted',
  switch_armed: 'Switch armed',
  switch_disarmed: 'Switch disarmed',
  payload_stored: 'Payload stored',
  recipient_invited: 'Recipient invited',
  recipient_deleted: 'Recipient removed',
  recipient_accepted: 'Recipient accepted',
  trigger_configured: 'Trigger configured',
  quorum_vote: 'Quorum vote recorded',
  trigger_cancelled: 'Trigger cancelled',
  heartbeat_checkin: 'Heartbeat checked in',
  heartbeat_token_issued: 'Heartbeat token issued',
  heartbeat_link_issued: 'Heartbeat link issued',
  downtime_recovery: 'Recovered from downtime',
  '2fa_totp_enroll_started': '2FA enrollment started',
  '2fa_totp_enabled': '2FA enabled',
  '2fa_totp_challenge_ok': '2FA verified',
  '2fa_totp_disabled': '2FA disabled',
  '2fa_recovery_regenerated': 'Recovery codes regenerated',
  '2fa_webauthn_registered': 'Passkey registered',
  '2fa_webauthn_login_ok': 'Signed in with passkey',
};

export function getAuditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
}

export function getAuditCategoryLabel(category: AuditCategory): string {
  return AUDIT_CATEGORY_LABELS[category];
}

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
