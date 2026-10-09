-- Deterministic owner reminder outbox (0010).
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
--> statement-breakpoint
CREATE TABLE reminder_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  switch_id uuid NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
  owner_email text NOT NULL,
  deadline_at timestamptz NOT NULL,
  stage text NOT NULL,
  channel text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  idempotency_key text NOT NULL UNIQUE,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reminder_jobs_stage_check CHECK (stage IN ('warning', 'reminder')),
  CONSTRAINT reminder_jobs_channel_check CHECK (channel IN ('email')),
  CONSTRAINT reminder_jobs_state_check CHECK (state IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE INDEX idx_reminder_jobs_pending ON reminder_jobs (state, created_at);
