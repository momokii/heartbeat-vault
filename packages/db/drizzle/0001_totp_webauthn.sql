-- 0001 — TOTP / WebAuthn / recovery codes (T3.3)
ALTER TABLE "users" ADD COLUMN "webauthn_user_id" "bytea";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_counter" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "totp_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "webauthn_challenge" text;
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "recovery_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "recovery_codes" TO "app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webauthn_credentials" TO "app";
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "recovery_codes_id_seq" TO "app";
