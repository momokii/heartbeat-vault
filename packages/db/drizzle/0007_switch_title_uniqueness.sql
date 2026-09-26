-- 0007 — Per-owner switch title uniqueness
DO $$
DECLARE
  duplicate_switch record;
  suffix integer;
  suffix_text text;
  candidate_title text;
BEGIN
  FOR duplicate_switch IN
    SELECT id, owner_id, title
    FROM (
      SELECT
        id,
        owner_id,
        title,
        created_at,
        row_number() OVER (
          PARTITION BY owner_id, title
          ORDER BY created_at DESC, id DESC
        ) AS title_rank
      FROM switches
    ) ranked
    WHERE title_rank > 1
    ORDER BY owner_id, title, created_at ASC, id ASC
  LOOP
    suffix := 1;
    LOOP
      suffix_text := format(' (duplicate %s)', suffix);
      IF length(suffix_text) >= 200 THEN
        RAISE EXCEPTION 'unable to make duplicate switch title unique within 200 characters';
      END IF;
      candidate_title := left(duplicate_switch.title, 200 - length(suffix_text)) || suffix_text;
      EXIT WHEN NOT EXISTS (
        SELECT FROM switches
        WHERE owner_id = duplicate_switch.owner_id AND title = candidate_title
      );
      suffix := suffix + 1;
    END LOOP;
    UPDATE switches SET title = candidate_title WHERE id = duplicate_switch.id;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE switches ADD CONSTRAINT switches_owner_id_title_unique UNIQUE(owner_id, title);
