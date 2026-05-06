-- Schedule publish tracking columns
ALTER TABLE generated_schedules
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';

ALTER TABLE generated_schedules
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

ALTER TABLE generated_schedules
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- Add unique constraint only if there are no duplicates
-- (skip silently if duplicates exist — clean them up manually if needed)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'generated_schedules_group_week_unique'
  ) THEN
    -- Only add if no duplicates exist
    IF NOT EXISTS (
      SELECT group_id, week_start
      FROM generated_schedules
      GROUP BY group_id, week_start
      HAVING COUNT(*) > 1
    ) THEN
      ALTER TABLE generated_schedules
        ADD CONSTRAINT generated_schedules_group_week_unique
        UNIQUE (group_id, week_start);
    ELSE
      RAISE NOTICE 'Skipping unique constraint: duplicate (group_id, week_start) rows exist in generated_schedules. Clean up duplicates first.';
    END IF;
  END IF;
END $$;
