ALTER TABLE reminder_jobs ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE reminder_jobs ADD COLUMN next_attempt_at timestamptz;
--> statement-breakpoint
CREATE INDEX idx_reminder_jobs_due ON reminder_jobs (state, next_attempt_at, created_at);
