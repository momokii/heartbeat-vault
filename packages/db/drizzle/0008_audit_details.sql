-- 0008 — Audit chain v2 canonical details
ALTER TABLE audit_log ADD COLUMN details jsonb;
--> statement-breakpoint
UPDATE audit_log SET details = '{}'::jsonb WHERE details IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  chain_previous_hash bytea := decode(repeat('00', 32), 'hex');
  current_hash bytea;
  audit_entry record;
  canonical_ts text;
BEGIN
  FOR audit_entry IN
    SELECT id, ts, actor_id, action, target
    FROM audit_log
    ORDER BY id ASC
  LOOP
    canonical_ts := to_char(
      date_trunc('milliseconds', audit_entry.ts AT TIME ZONE 'UTC'),
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    current_hash := digest(
      chain_previous_hash || convert_to(
        '|' || canonical_ts || '|' || coalesce(audit_entry.actor_id::text, '') ||
        '|' || audit_entry.action || '|' || coalesce(audit_entry.target, '') || '{}',
        'UTF8'
      ),
      'sha256'
    );
    UPDATE audit_log
    SET prev_hash = chain_previous_hash, hash = current_hash
    WHERE id = audit_entry.id;
    chain_previous_hash := current_hash;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE audit_log ALTER COLUMN details SET DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE audit_log ALTER COLUMN details SET NOT NULL;
--> statement-breakpoint
GRANT SELECT (details) ON audit_log TO app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM app;
