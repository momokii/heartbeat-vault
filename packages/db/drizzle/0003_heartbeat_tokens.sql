-- 0003 — Heartbeat check-in tokens + one-time email links (T4.2)
ALTER TABLE "switches" ADD COLUMN "heartbeat_token_hash" text;
--> statement-breakpoint
CREATE TABLE "heartbeat_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"switch_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "heartbeat_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "heartbeat_links" ADD CONSTRAINT "heartbeat_links_switch_id_switches_id_fk" FOREIGN KEY ("switch_id") REFERENCES "public"."switches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "heartbeat_links" TO "app";
