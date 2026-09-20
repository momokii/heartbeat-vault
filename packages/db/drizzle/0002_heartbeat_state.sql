-- 0002 — Switch heartbeat state + title for arming (T4.1)
ALTER TABLE "switches" ADD COLUMN "title" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "switches" ADD COLUMN "heartbeat_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "switches" ADD COLUMN "next_deadline" timestamp with time zone;
