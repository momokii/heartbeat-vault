CREATE TABLE switch_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  switch_id uuid NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
  delegate_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT switch_delegations_switch_delegate_unique UNIQUE (switch_id, delegate_user_id)
);
--> statement-breakpoint
CREATE INDEX idx_switch_delegations_delegate_user ON switch_delegations (delegate_user_id);
