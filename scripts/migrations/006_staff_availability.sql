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
