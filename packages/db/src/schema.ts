import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  serial,
  bigint,
  boolean,
  timestamp,
  jsonb,
  interval,
  customType,
  check,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// bytea via customType — stored as Buffer, exposed as Buffer/Uint8Array
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// ── users ────────────────────────────────────────────────────────────────
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    totpSecretEncrypted: bytea('totp_secret_encrypted'),
    webauthnUserId: bytea('webauthn_user_id'),
    totpVerifiedAt: timestamp('totp_verified_at', { withTimezone: true }),
    totpLastCounter: bigint('totp_last_counter', { mode: 'number' }).notNull().default(0),
    role: text('role').notNull().default('user'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  t => [check('users_role_check', sql`${t.role} IN ('admin','user')`)],
);

// ── switches ─────────────────────────────────────────────────────────────
export const switches = pgTable(
  'switches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('active'),
    heartbeatInterval: interval('heartbeat_interval').notNull(),
    graceWindow: interval('grace_window').notNull(),
    dryRun: boolean('dry_run').notNull().default(false),
    releasePolicy: text('release_policy').notNull().default('fail_safe'),
    heartbeatStartedAt: timestamp('heartbeat_started_at', { withTimezone: true }),
    nextDeadline: timestamp('next_deadline', { withTimezone: true }),
    heartbeatTokenHash: text('heartbeat_token_hash'),
    triggerType: text('trigger_type').notNull().default('heartbeat'),
    fireAt: timestamp('fire_at', { withTimezone: true }),
    quorumThreshold: integer('quorum_threshold'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  t => [
    uniqueIndex('switches_owner_id_title_unique').on(t.ownerId, t.title),
    check('switches_mode_check', sql`${t.mode} IN ('asymmetric_key','direct_delivery')`),
    check('switches_status_check', sql`${t.status} IN ('active','paused','released')`),
    check('switches_release_policy_check', sql`${t.releasePolicy} IN ('fail_safe','fail_deadly')`),
    check(
      'switches_trigger_type_check',
      sql`${t.triggerType} IN ('heartbeat','fixed_date','panic','quorum')`,
    ),
    check(
      'switches_quorum_threshold_check',
      sql`${t.quorumThreshold} IS NULL OR (${t.quorumThreshold} >= 2 AND ${t.quorumThreshold} <= 255)`,
    ),
  ],
);

// ── recipients ───────────────────────────────────────────────────────────
export const recipients = pgTable(
  'recipients',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    switchId: uuid('switch_id')
      .notNull()
      .references(() => switches.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    address: text('address').notNull(),
    status: text('status').notNull().default('invited'),
    inviteTokenHash: text('invite_token_hash'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    vote: text('vote'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  t => [
    check('recipients_status_check', sql`${t.status} IN ('invited','accepted')`),
    check('recipients_vote_check', sql`${t.vote} IS NULL OR ${t.vote} IN ('reachable','deceased')`),
  ],
);

// ── sealed_payloads ──────────────────────────────────────────────────────
export const sealedPayloads = pgTable('sealed_payloads', {
  id: uuid('id').defaultRandom().primaryKey(),
  switchId: uuid('switch_id')
    .notNull()
    .unique()
    .references(() => switches.id, { onDelete: 'cascade' }),
  kid: text('kid').notNull(),
  kekVersion: integer('kek_version').notNull(),
  wrappedDekNonce: bytea('wrapped_dek_nonce').notNull(),
  wrappedDekCt: bytea('wrapped_dek_ct').notNull(),
  payloadNonce: bytea('payload_nonce').notNull(),
  payloadCt: bytea('payload_ct').notNull(),
  payloadTag: bytea('payload_tag').notNull(),
  aad: jsonb('aad').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

// ── heartbeats ───────────────────────────────────────────────────────────
export const heartbeats = pgTable('heartbeats', {
  id: uuid('id').defaultRandom().primaryKey(),
  switchId: uuid('switch_id')
    .notNull()
    .references(() => switches.id, { onDelete: 'cascade' }),
  method: text('method').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

// ── trigger_jobs ─────────────────────────────────────────────────────────
export const triggerJobs = pgTable(
  'trigger_jobs',
  {
    id: serial('id').primaryKey(),
    switchId: uuid('switch_id')
      .notNull()
      .references(() => switches.id, { onDelete: 'cascade' }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    runAt: timestamp('run_at', { withTimezone: true }),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    ownerId: text('owner_id'),
    leaseExpires: timestamp('lease_expires', { withTimezone: true }),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  t => [
    unique('trigger_jobs_switch_deadline_unique').on(t.switchId, t.deadlineAt),
    check(
      'trigger_jobs_state_check',
      sql`${t.state} IN ('pending','running','succeeded','failed','dead','cancelled')`,
    ),
  ],
);

// ── vault_waits ──────────────────────────────────────────────────────────
export const vaultWaits = pgTable('vault_waits', {
  switchId: uuid('switch_id')
    .primaryKey()
    .references(() => switches.id, { onDelete: 'cascade' }),
  wakeAt: timestamp('wake_at', { withTimezone: true }).notNull(),
  reason: text('reason'),
});

// ── delivery_jobs ────────────────────────────────────────────────────────
export const deliveryJobs = pgTable(
  'delivery_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    switchId: uuid('switch_id')
      .notNull()
      .references(() => switches.id, { onDelete: 'cascade' }),
    triggerJobId: integer('trigger_job_id').references(() => triggerJobs.id, {
      onDelete: 'set null',
    }),
    channel: text('channel').notNull(),
    state: text('state').notNull().default('pending'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payload: jsonb('payload'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  t => [
    check(
      'delivery_jobs_state_check',
      sql`${t.state} IN ('pending','running','succeeded','failed','dead','cancelled')`,
    ),
  ],
);

// ── dead_letter_jobs ─────────────────────────────────────────────────────
export const deadLetterJobs = pgTable('dead_letter_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  source: text('source').notNull(),
  sourceId: text('source_id').notNull(),
  payload: jsonb('payload'),
  finalError: text('final_error'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

// ── scheduler_heartbeat ──────────────────────────────────────────────────
export const schedulerHeartbeat = pgTable(
  'scheduler_heartbeat',
  {
    id: integer('id').primaryKey(),
    lastTickAt: timestamp('last_tick_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    tickOwner: text('tick_owner'),
  },
  t => [check('scheduler_heartbeat_singleton_check', sql`${t.id} = 1`)],
);

// ── audit_log ────────────────────────────────────────────────────────────
export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  ts: timestamp('ts', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  target: text('target'),
  ip: text('ip'),
  requestId: text('request_id'),
  details: jsonb('details')
    .notNull()
    .default(sql`'{}'::jsonb`),
  prevHash: bytea('prev_hash'),
  hash: bytea('hash').notNull(),
});

// ── invites ──────────────────────────────────────────────────────────────
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    role: text('role').notNull(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  t => [check('invites_role_check', sql`${t.role} IN ('admin','user')`)],
);

// ── password_resets ───────────────────────────────────────────────────────
export const passwordResets = pgTable('password_resets', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

// ── sessions ─────────────────────────────────────────────────────────────
export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  totpPending: boolean('totp_pending').notNull().default(false),
  webauthnChallenge: text('webauthn_challenge'),
});

// ── app_config ───────────────────────────────────────────────────────────
export const appConfig = pgTable('app_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const recoveryCodes = pgTable('recovery_codes', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull().unique(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  publicKey: bytea('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: text('transports'),
  deviceType: text('device_type'),
  backedUp: boolean('backed_up').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const heartbeatLinks = pgTable('heartbeat_links', {
  id: uuid('id').defaultRandom().primaryKey(),
  switchId: uuid('switch_id')
    .notNull()
    .references(() => switches.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

// ── export_jobs ──────────────────────────────────────────────────────────
export const exportJobs = pgTable('export_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
  requestedBy: uuid('requested_by')
    .notNull()
    .references(() => users.id),
  scopeType: text('scope_type').notNull(),
  switchId: uuid('switch_id').references(() => switches.id, { onDelete: 'set null' }),
  format: text('format').notNull(),
  filters: jsonb('filters')
    .notNull()
    .default(sql`'{}'::jsonb`),
  rowCount: integer('row_count'),
  status: text('status').notNull(),
  errorCode: text('error_code'),
});
