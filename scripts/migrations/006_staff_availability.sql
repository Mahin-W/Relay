-- Manual staff availability: managers set per-staff per-day availability
-- from the Schedule tab dashboard overlay.
-- available=false blocks that staff on that day during schedule generation.
CREATE TABLE IF NOT EXISTS staff_availability (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id INTEGER NOT NULL,
  week_start DATE NOT NULL,
  day_of_week TEXT NOT NULL,
  available BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, staff_id, week_start, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_staff_avail_group_week
  ON staff_availability(group_id, week_start);

-- RLS: allow anon key (used by dashboard) to read and write
ALTER TABLE staff_availability ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'staff_availability'
      AND policyname = 'Allow all for anon on staff_availability'
  ) THEN
    EXECUTE 'CREATE POLICY "Allow all for anon on staff_availability"
      ON staff_availability FOR ALL TO anon
      USING (true) WITH CHECK (true)';
  END IF;
END $$;
