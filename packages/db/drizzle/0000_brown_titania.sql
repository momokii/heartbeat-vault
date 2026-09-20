CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"ip" text,
	"request_id" text,
	"prev_hash" "bytea",
	"hash" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dead_letter_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"payload" jsonb,
	"final_error" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"switch_id" uuid NOT NULL,
	"trigger_job_id" integer,
	"channel" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "delivery_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "delivery_jobs_state_check" CHECK ("delivery_jobs"."state" IN ('pending','running','succeeded','failed','dead'))
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"switch_id" uuid NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_role_check" CHECK ("invites"."role" IN ('admin','user'))
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"switch_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invite_token_hash" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "recipients_status_check" CHECK ("recipients"."status" IN ('invited','accepted'))
);
--> statement-breakpoint
CREATE TABLE "scheduler_heartbeat" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_tick_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"tick_owner" text,
	CONSTRAINT "scheduler_heartbeat_singleton_check" CHECK ("scheduler_heartbeat"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sealed_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"switch_id" uuid NOT NULL,
	"kid" text NOT NULL,
	"kek_version" integer NOT NULL,
	"wrapped_dek_nonce" "bytea" NOT NULL,
	"wrapped_dek_ct" "bytea" NOT NULL,
	"payload_nonce" "bytea" NOT NULL,
	"payload_ct" "bytea" NOT NULL,
	"payload_tag" "bytea" NOT NULL,
	"aad" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "sealed_payloads_switch_id_unique" UNIQUE("switch_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"heartbeat_interval" interval NOT NULL,
	"grace_window" interval NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"release_policy" text DEFAULT 'fail_safe' NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "switches_mode_check" CHECK ("switches"."mode" IN ('asymmetric_key','direct_delivery')),
	CONSTRAINT "switches_status_check" CHECK ("switches"."status" IN ('active','paused','released')),
	CONSTRAINT "switches_release_policy_check" CHECK ("switches"."release_policy" IN ('fail_safe','fail_deadly'))
);
--> statement-breakpoint
CREATE TABLE "trigger_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"switch_id" uuid NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"run_at" timestamp with time zone,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"owner_id" text,
	"lease_expires" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "trigger_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "trigger_jobs_switch_deadline_unique" UNIQUE("switch_id","deadline_at"),
	CONSTRAINT "trigger_jobs_state_check" CHECK ("trigger_jobs"."state" IN ('pending','running','succeeded','failed','dead'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_encrypted" "bytea",
	"role" text DEFAULT 'user' NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('admin','user'))
);
--> statement-breakpoint
CREATE TABLE "vault_waits" (
	"switch_id" uuid PRIMARY KEY NOT NULL,
	"wake_at" timestamp with time zone NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_switch_id_switches_id_fk" FOREIGN KEY ("switch_id") REFERENCES "public"."switches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_trigger_job_id_trigger_jobs_id_fk" FOREIGN KEY ("trigger_job_id") REFERENCES "public"."trigger_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_switch_id_switches_id_fk" FOREIGN KEY ("switch_id") REFERENCES "public"."switches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_switch_id_switches_id_fk" FOREIGN KEY ("switch_id") REFERENCES "public"."switches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sealed_payloads" ADD CONSTRAINT "sealed_payloads_switch_id_switches_id_fk" FOREIGN KEY ("switch_id") REFERENCES "public"."switches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switches" ADD CONSTRAINT "switches_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_jobs" ADD CONSTRAINT "trigger_jobs_switch_id_switches_id_fk" FOREIGN KEY ("switch_id") REFERENCES "public"."switches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_waits" ADD CONSTRAINT "vault_waits_switch_id_switches_id_fk" FOREIGN KEY ("switch_id") REFERENCES "public"."switches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
    CREATE ROLE migrator;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO migrator;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO migrator;--> statement-breakpoint
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO migrator;--> statement-breakpoint
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO migrator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE audit_log FROM app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO migrator;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO migrator;