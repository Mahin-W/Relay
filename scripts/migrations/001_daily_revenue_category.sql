-- Add missing category column to daily_revenue
ALTER TABLE daily_revenue
  ADD COLUMN IF NOT EXISTS category TEXT;

ALTER TABLE daily_revenue
  ADD COLUMN IF NOT EXISTS updated_at
  TIMESTAMPTZ DEFAULT NOW();
