-- 0004 — Variant triggers: fixed_date / panic / quorum + cancellation states (T4.6)
ALTER TABLE "switches" ADD COLUMN "trigger_type" text NOT NULL DEFAULT 'heartbeat';
--> statement-breakpoint
ALTER TABLE "switches" ADD COLUMN "fire_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "switches" ADD COLUMN "quorum_threshold" integer;
--> statement-breakpoint
ALTER TABLE "switches" ADD CONSTRAINT "switches_trigger_type_check" CHECK ("trigger_type" IN ('heartbeat','fixed_date','panic','quorum'));
--> statement-breakpoint
ALTER TABLE "switches" ADD CONSTRAINT "switches_quorum_threshold_check" CHECK ("quorum_threshold" IS NULL OR ("quorum_threshold" >= 2 AND "quorum_threshold" <= 255));
--> statement-breakpoint
ALTER TABLE "recipients" ADD COLUMN "vote" text;
--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_vote_check" CHECK ("vote" IS NULL OR "vote" IN ('reachable','deceased'));
--> statement-breakpoint
ALTER TABLE "trigger_jobs" DROP CONSTRAINT "trigger_jobs_state_check";
--> statement-breakpoint
ALTER TABLE "trigger_jobs" ADD CONSTRAINT "trigger_jobs_state_check" CHECK ("state" IN ('pending','running','succeeded','failed','dead','cancelled'));
--> statement-breakpoint
ALTER TABLE "delivery_jobs" DROP CONSTRAINT "delivery_jobs_state_check";
--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_state_check" CHECK ("state" IN ('pending','running','succeeded','failed','dead','cancelled'));
