-- Add updated_at and unique constraint to weekly_revenue for safe upserts
ALTER TABLE weekly_revenue
  ADD COLUMN IF NOT EXISTS updated_at
  TIMESTAMPTZ DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'weekly_revenue_group_week_unique'
  ) THEN
    ALTER TABLE weekly_revenue
      ADD CONSTRAINT weekly_revenue_group_week_unique
      UNIQUE (group_id, week_start);
  END IF;
END $$;
