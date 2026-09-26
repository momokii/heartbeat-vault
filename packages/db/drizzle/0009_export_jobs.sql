-- Report export ledger: one row per audit-log export attempt (0009).
-- Exports are streamed on demand; this table records who exported what,
-- with which filters, in which format, and whether it succeeded.
CREATE TABLE export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  requested_by uuid NOT NULL REFERENCES users(id),
  scope_type text NOT NULL,
  switch_id uuid REFERENCES switches(id) ON DELETE SET NULL,
  format text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count integer,
  status text NOT NULL,
  error_code text,
  CONSTRAINT export_jobs_scope_type_check CHECK (scope_type IN ('global', 'switch')),
  CONSTRAINT export_jobs_format_check CHECK (format IN ('csv', 'json')),
  CONSTRAINT export_jobs_status_check CHECK (status IN ('success', 'failed'))
);

CREATE UNIQUE INDEX idx_export_jobs_seq ON export_jobs (seq);
CREATE INDEX idx_export_jobs_recent ON export_jobs (created_at DESC);
