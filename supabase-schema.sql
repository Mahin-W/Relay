-- Relay Bot — Complete Supabase Schema
-- Run this in Supabase SQL Editor → New Query → Run

-- ═══════════════════════════════════════════════════════════════
-- SETUP TABLES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS setup_sessions (
  group_id TEXT PRIMARY KEY,
  group_name TEXT,
  manager_id BIGINT,
  dm_chat_id BIGINT,
  phone TEXT,
  step TEXT NOT NULL DEFAULT 'welcome',
  setup_data JSONB DEFAULT '{}',
  setup_complete BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  day_of_week TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shifts_group ON shifts(group_id);

CREATE TABLE IF NOT EXISTS shift_requirements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id BIGINT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'Staff',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_group ON staff(group_id);

CREATE TABLE IF NOT EXISTS role_rates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  role_name TEXT NOT NULL,
  hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, role_name)
);

CREATE TABLE IF NOT EXISTS overtime_settings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  overtime_enabled BOOLEAN DEFAULT false,
  weekly_threshold NUMERIC(5,1) DEFAULT 40,
  weekly_multiplier NUMERIC(3,2) DEFAULT 1.5,
  daily_overtime_enabled BOOLEAN DEFAULT false,
  daily_threshold NUMERIC(5,1) DEFAULT 8,
  daily_multiplier NUMERIC(3,2) DEFAULT 1.5,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- COVERAGE & TRADE TABLES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS coverage_requests (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_name TEXT,
  shift_description TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requester_telegram_id BIGINT,
  matched_shift_id BIGINT,
  week_start DATE,
  status TEXT NOT NULL DEFAULT 'open',
  covered_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  covered_at TIMESTAMPTZ,
  partial_coverage_needed BOOLEAN DEFAULT FALSE,
  CONSTRAINT valid_status CHECK (status IN ('open','covered','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_coverage_group_status ON coverage_requests(group_id, status);

CREATE TABLE IF NOT EXISTS staff_dms (
  user_id BIGINT PRIMARY KEY,
  first_name TEXT,
  username TEXT,
  dm_chat_id BIGINT NOT NULL,
  registered_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  user_id BIGINT,
  group_id TEXT,
  first_name TEXT,
  username TEXT,
  last_seen TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS coverage_outreach (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT REFERENCES coverage_requests(id),
  user_id BIGINT,
  asked_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_requests (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_name TEXT,
  requester_id BIGINT NOT NULL,
  requester_name TEXT NOT NULL,
  shift_id BIGINT,
  shift_description TEXT NOT NULL,
  week_start DATE,
  status TEXT NOT NULL DEFAULT 'open',
  accepted_by_id BIGINT,
  accepted_by_name TEXT,
  accepted_shift_id BIGINT,
  accepted_shift_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_trade_status CHECK (status IN ('open', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_trade_group_status ON trade_requests(group_id, status);

-- ═══════════════════════════════════════════════════════════════
-- AVAILABILITY & SCHEDULING
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS availability (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  available_shift_ids BIGINT[] DEFAULT '{}',
  available_all BOOLEAN DEFAULT false,
  unavailable BOOLEAN DEFAULT false,
  raw_response TEXT,
  collected_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, week_start, group_id)
);

CREATE TABLE IF NOT EXISTS availability_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL,
  group_id TEXT NOT NULL,
  dm_chat_id BIGINT,
  week_start DATE NOT NULL,
  shift_map JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, week_start, group_id)
);

CREATE TABLE IF NOT EXISTS passive_availability (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  day_of_week TEXT NOT NULL,
  status TEXT,
  raw_text TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, group_id, week_start, day_of_week)
);

CREATE TABLE IF NOT EXISTS generated_schedules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  assignments JSONB DEFAULT '[]',
  gaps JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  published_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_schedules_group_status ON generated_schedules(group_id, status);

CREATE TABLE IF NOT EXISTS schedule_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  shift_id BIGINT NOT NULL,
  staff_id BIGINT NOT NULL,
  week_start DATE NOT NULL,
  status TEXT DEFAULT 'scheduled',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assignments_group_week ON schedule_assignments(group_id, week_start);
CREATE INDEX IF NOT EXISTS idx_assignments_staff_week ON schedule_assignments(staff_id, week_start);

CREATE TABLE IF NOT EXISTS partial_coverage (
  id BIGSERIAL PRIMARY KEY,
  coverage_request_id BIGINT REFERENCES coverage_requests(id) ON DELETE CASCADE,
  staff_id BIGINT,
  staff_name TEXT NOT NULL,
  cover_from TEXT NOT NULL,
  cover_until TEXT NOT NULL,
  group_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partial_coverage_request ON partial_coverage(coverage_request_id);

CREATE TABLE IF NOT EXISTS schedule_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id BIGINT NOT NULL,
  week_start DATE NOT NULL,
  dm_chat_id BIGINT,
  status TEXT DEFAULT 'sent',
  sent_at TIMESTAMPTZ DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  UNIQUE(staff_id, week_start)
);

-- ═══════════════════════════════════════════════════════════════
-- OPERATIONS — RELIABILITY, ON-CALL, TIME-OFF, NO-SHOW
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS staff_reliability_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id BIGINT NOT NULL,
  group_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  recorded_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reliability_staff ON staff_reliability_events(staff_id, recorded_at);

CREATE TABLE IF NOT EXISTS on_call (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id BIGINT NOT NULL,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  days JSONB DEFAULT '[]',
  all_week BOOLEAN DEFAULT false,
  UNIQUE(staff_id, week_start)
);

CREATE TABLE IF NOT EXISTS time_off_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_telegram_id BIGINT,
  staff_name TEXT NOT NULL,
  requested_date DATE,
  week_start DATE,
  status TEXT DEFAULT 'pending',
  requested_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS noshow_warnings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id BIGINT NOT NULL UNIQUE,
  group_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_pending (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  start_date DATE,
  status TEXT DEFAULT 'pending',
  announced_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- ═══════════════════════════════════════════════════════════════
-- PAYROLL & ANALYTICS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payroll_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id BIGINT NOT NULL,
  week_start DATE NOT NULL,
  total_hours NUMERIC(6,2) DEFAULT 0,
  total_late_minutes INTEGER DEFAULT 0,
  total_late_deduction NUMERIC(10,2) DEFAULT 0,
  total_gross_pay NUMERIC(10,2) DEFAULT 0,
  shift_breakdown JSONB DEFAULT '[]',
  UNIQUE(staff_id, week_start, group_id)
);

CREATE TABLE IF NOT EXISTS weekly_revenue (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  revenue NUMERIC(10,2),
  total_labor_cost NUMERIC(10,2),
  labor_percent NUMERIC(5,2),
  UNIQUE(group_id, week_start)
);

CREATE TABLE IF NOT EXISTS labor_budgets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  weekly_budget NUMERIC(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD'
);

CREATE TABLE IF NOT EXISTS manager_log_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  manager_id BIGINT NOT NULL,
  entry_text TEXT NOT NULL,
  shift_name TEXT,
  day_of_week TEXT,
  week_start DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manager_log_group_week
  ON manager_log_entries(group_id, week_start);

-- ═══════════════════════════════════════════════════════════════
-- TIME CLOCK
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS time_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  staff_id BIGINT,
  shift_id BIGINT,
  clock_in TIMESTAMPTZ NOT NULL,
  clock_out TIMESTAMPTZ,
  clock_in_raw TEXT,
  clock_out_raw TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_time_entries_user_open
  ON time_entries (user_id, group_id) WHERE clock_out IS NULL;

CREATE INDEX IF NOT EXISTS idx_time_entries_group_week
  ON time_entries (group_id, clock_in);

-- ═══════════════════════════════════════════════════════════════
-- INTELLIGENCE LAYER
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS business_rules (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  type TEXT NOT NULL,
  subject_staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  object_staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  constraint_text TEXT NOT NULL,
  raw_message TEXT NOT NULL,
  day_of_week TEXT,
  latest_end_time TEXT,
  shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL,
  shift_preference TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_rules_group
  ON business_rules(group_id, active);

CREATE TABLE IF NOT EXISTS schedule_edit_events (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  type TEXT NOT NULL,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  staff_name TEXT NOT NULL,
  from_shift_id BIGINT,
  to_shift_id BIGINT,
  day_of_week TEXT,
  reason TEXT,
  week_start DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_edit_events_group_staff
  ON schedule_edit_events(group_id, staff_id, created_at DESC);

CREATE TABLE IF NOT EXISTS learned_preferences (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  type TEXT NOT NULL,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  staff_name TEXT NOT NULL,
  day_of_week TEXT,
  shift_id BIGINT,
  confidence DECIMAL(3,2) DEFAULT 0,
  sample_size INTEGER DEFAULT 0,
  auto_apply BOOLEAN DEFAULT FALSE,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, type, staff_id, shift_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS morale_events (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  response_minutes INTEGER,
  sentiment TEXT,
  week_start DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_morale_events_group_staff
  ON morale_events(group_id, staff_id, created_at DESC);

CREATE TABLE IF NOT EXISTS demand_signals (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  day_of_week TEXT,
  is_week_level BOOLEAN DEFAULT FALSE,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('high', 'low', 'normal')),
  raw_mention TEXT NOT NULL,
  source_user_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, week_start, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_demand_signals_group_week
  ON demand_signals(group_id, week_start);

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY — anon access for all tables
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'setup_sessions', 'shifts', 'shift_requirements', 'staff', 'role_rates',
      'overtime_settings', 'coverage_requests', 'staff_dms', 'group_members',
      'coverage_outreach', 'trade_requests', 'availability', 'availability_sessions',
      'passive_availability', 'generated_schedules', 'schedule_assignments',
      'schedule_receipts', 'staff_reliability_events', 'on_call', 'time_off_requests',
      'noshow_warnings', 'onboarding_pending', 'payroll_records', 'weekly_revenue',
      'labor_budgets', 'manager_log_entries', 'time_entries',
      'business_rules', 'schedule_edit_events', 'learned_preferences', 'morale_events',
      'demand_signals', 'partial_coverage'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY IF NOT EXISTS "Allow all for anon on %I" ON %I FOR ALL TO anon USING (true) WITH CHECK (true)',
      tbl, tbl
    );
  END LOOP;
END $$;

-- Platform contacts (multi-platform identity mapping)
CREATE TABLE IF NOT EXISTS platform_contacts (
  id BIGSERIAL PRIMARY KEY,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('telegram','sms','whatsapp')),
  platform_user_id TEXT NOT NULL,
  platform_chat_id TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_contacts_staff ON platform_contacts(staff_id);

ALTER TABLE platform_contacts ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- TIPS, RECOGNITION & SCHEDULE QUALITY
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tip_records (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  shift_id BIGINT,
  shift_date DATE NOT NULL,
  total_tips DECIMAL(10,2) NOT NULL,
  split_method TEXT,
  splits JSONB,
  mode TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recognition_events (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  recipient_id BIGINT REFERENCES staff(id),
  recipient_name TEXT,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schedule_quality_scores (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  score INTEGER CHECK (score >= 0 AND score <= 100),
  grade TEXT,
  draft_edits INTEGER DEFAULT 0,
  coverage_requests INTEGER DEFAULT 0,
  no_shows INTEGER DEFAULT 0,
  avg_fill_minutes INTEGER,
  UNIQUE(group_id, week_start)
);

-- ═══════════════════════════════════════════════════════════════
-- DAILY REVENUE (granular per-day entries; weekly_revenue is a cache)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS daily_revenue (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  entry_date DATE NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_revenue_group_date
  ON daily_revenue(group_id, entry_date);

-- ═══════════════════════════════════════════════════════════════
-- DAILY REVENUE — add category column (run after daily_revenue exists)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE daily_revenue ADD COLUMN IF NOT EXISTS category TEXT;

-- ═══════════════════════════════════════════════════════════════
-- REVENUE TYPES (manager-configured category list)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS revenue_types (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, name)
);

CREATE INDEX IF NOT EXISTS idx_revenue_types_group
  ON revenue_types(group_id, active);
