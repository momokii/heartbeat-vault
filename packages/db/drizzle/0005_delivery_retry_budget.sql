-- 0005 — Per-delivery retry budget (T5.1)
ALTER TABLE "delivery_jobs" ADD COLUMN "max_attempts" integer NOT NULL DEFAULT 5;
--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_max_attempts_check" CHECK ("max_attempts" >= 1 AND "max_attempts" <= 20);
