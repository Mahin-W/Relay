-- Relay Bot — Complete Supabase Schema
-- Run this in Supabase SQL Editor → New Query → Run

-- ═══════════════════════════════════════════════════════════════
-- SETUP TABLES
-- ═══════════════════════════════════════════════════════════════

-- Account-centric identity layer (see scripts/migrations/010_accounts.sql).
-- One row per business owner, keyed to a Supabase Auth user. Holds web-collected
-- setup as staging JSONB until a Telegram group links to the account.
CREATE TABLE IF NOT EXISTS accounts (
  id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email               TEXT,
  business_name       TEXT,
  setup_data          JSONB DEFAULT '{}'::jsonb,
  onboarding_complete BOOLEAN DEFAULT false,
  login_2fa_enabled   BOOLEAN DEFAULT true,  -- login confirmation code (migration 011)
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- One-time deep-link codes that bind a Telegram user ID to an account.
CREATE TABLE IF NOT EXISTS account_links (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code             TEXT NOT NULL UNIQUE,
  telegram_user_id BIGINT,
  used_at          TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_links_code ON account_links(code);
CREATE INDEX IF NOT EXISTS idx_account_links_tg_user ON account_links(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_account_links_account ON account_links(account_id);

CREATE TABLE IF NOT EXISTS setup_sessions (
  group_id TEXT PRIMARY KEY,
  group_name TEXT,
  manager_id BIGINT,
  dm_chat_id BIGINT,
  phone TEXT,
  step TEXT NOT NULL DEFAULT 'welcome',
  setup_data JSONB DEFAULT '{}',
  setup_complete BOOLEAN DEFAULT false,
  account_id UUID REFERENCES accounts(id),  -- account<->group bridge (migration 010)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_setup_sessions_account ON setup_sessions(account_id);

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
  dob DATE,  -- date of birth — drives minor-labor compliance (Epic 4, WP-4.3)
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
-- INTELLIGENCE LAYER — patterns, learning, recurring constraints
-- ═══════════════════════════════════════════════════════════════

-- weekly_quality_scores — per-week schedule quality grade
-- Note: superseded `schedule_quality_scores`; both names accepted for back-compat.
CREATE TABLE IF NOT EXISTS weekly_quality_scores (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  score INTEGER CHECK (score >= 0 AND score <= 100),
  grade TEXT,
  draft_edits INTEGER DEFAULT 0,
  coverage_requests INTEGER DEFAULT 0,
  no_shows INTEGER DEFAULT 0,
  avg_fill_minutes INTEGER,
  unconfirmed_count INTEGER DEFAULT 0,
  weeks_of_data INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_quality_group_week
  ON weekly_quality_scores(group_id, week_start DESC);

-- restaurant_tip_settings — tip mode/split-method configuration per group
CREATE TABLE IF NOT EXISTS restaurant_tip_settings (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  mode TEXT DEFAULT 'pool',                  -- 'pool' | 'individual'
  split_method TEXT DEFAULT 'hours',         -- 'hours' | 'equal'
  boh_included BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- cross_training — which roles each staff member is qualified to work
CREATE TABLE IF NOT EXISTS cross_training (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  role_id BIGINT,                            -- nullable; some callsites store role_name
  role_name TEXT,
  proficiency TEXT DEFAULT 'training',       -- 'training' | 'competent' | 'proficient'
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, staff_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_cross_training_group_staff
  ON cross_training(group_id, staff_id) WHERE active;

-- recurring_constraints — durable "never on Mondays" / "out by 4pm" preferences
CREATE TABLE IF NOT EXISTS recurring_constraints (
  id BIGSERIAL PRIMARY KEY,
  staff_id BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  type TEXT NOT NULL,                        -- 'day_off' | 'available_days' | 'time_constraint' | etc.
  day_of_week TEXT,
  days JSONB,                                -- list of days for available_days/day_off
  before_time TEXT,
  after_time TEXT,
  latest_end TEXT,
  latest_end_mon_thu TEXT,
  reason TEXT,
  note TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(staff_id, group_id, day_of_week, type)
);

CREATE INDEX IF NOT EXISTS idx_recurring_constraints_staff
  ON recurring_constraints(staff_id, group_id) WHERE active;

-- discovered_patterns — auto-detected scheduling patterns awaiting manager review
CREATE TABLE IF NOT EXISTS discovered_patterns (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  type TEXT NOT NULL,                        -- 'avoid_day' | 'staff_pairing' | 'shift_preference' | etc.
  staff_id_a BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  staff_id_b BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL,
  day_of_week TEXT,
  confidence DECIMAL(3,2),
  weeks_analyzed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',             -- 'pending' | 'accepted' | 'dismissed'
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discovered_patterns_group
  ON discovered_patterns(group_id, status);

-- coverage_confirmations — historical record of who covered which shift
CREATE TABLE IF NOT EXISTS coverage_confirmations (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  request_id BIGINT REFERENCES coverage_requests(id) ON DELETE CASCADE,
  staff_id BIGINT REFERENCES staff(id) ON DELETE SET NULL,
  covered_by TEXT,
  response_minutes INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coverage_confirmations_group
  ON coverage_confirmations(group_id, created_at DESC);

-- staff_availability_windows — bounded availability (days + before/after time)
CREATE TABLE IF NOT EXISTS staff_availability_windows (
  id BIGSERIAL PRIMARY KEY,
  staff_id BIGINT NOT NULL UNIQUE REFERENCES staff(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  days_available JSONB,
  before_time TEXT,
  after_time TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- staff_members — registered staff identity (telegram_id ↔ staff link)
-- Used by availability learning. Distinct from `staff` (which is the roster).
CREATE TABLE IF NOT EXISTS staff_members (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  telegram_id BIGINT,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_members_group_telegram
  ON staff_members(group_id, telegram_id);

-- availability_outcomes — per-day comparison of stated vs actual availability
CREATE TABLE IF NOT EXISTS availability_outcomes (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  day_of_week TEXT NOT NULL,
  stated_available BOOLEAN,
  actual_outcome TEXT,                       -- 'worked' | 'callout' | 'no_show' | 'unavailable'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_availability_outcomes_group_staff
  ON availability_outcomes(group_id, staff_id, week_start DESC);

-- Make sure role_rates has updated_at (some deploys missed the column)
ALTER TABLE role_rates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Make sure time_entries has alerted_at (used by missed clock-out cron)
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;

-- Add the missing FK so PostgREST can embed `staff(...)` in time-clock selects
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'time_entries_staff_id_fkey'
  ) THEN
    ALTER TABLE time_entries
      ADD CONSTRAINT time_entries_staff_id_fkey
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE;
  END IF;
END $$;

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
      'demand_signals', 'partial_coverage',
      -- Tables added in the schema reconciliation pass
      'tip_records', 'recognition_events', 'schedule_quality_scores',
      'daily_revenue', 'revenue_types',
      'weekly_quality_scores', 'restaurant_tip_settings', 'cross_training',
      'recurring_constraints', 'discovered_patterns', 'coverage_confirmations',
      'staff_availability_windows', 'staff_members', 'availability_outcomes'
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

-- ═══════════════════════════════════════════════════════════════
-- MANUAL STAFF AVAILABILITY (dashboard overlay)
-- Managers can set per-staff per-day availability directly from
-- the Schedule tab. Takes precedence over Telegram-collected data
-- during schedule generation.
-- ═══════════════��═══════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════
-- UTILITY FUNCTIONS
-- ═══════════════════════════════════════════════════════════════

-- Rekey a tenant: rewrite group_id on every public table that has the column.
-- Future-proof — any new group_id table is covered automatically.
CREATE OR REPLACE FUNCTION rekey_group(old_group text, new_group text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'group_id'
  LOOP
    EXECUTE format('UPDATE public.%I SET group_id = $1 WHERE group_id = $2', t.table_name)
      USING new_group, old_group;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- REMINDER DEDUP (migration 031)
-- ═══════════════════════════════════════════════════════════════

-- P1-29: persist schedule-reminder dedup so a restart doesn't resend reminders.
CREATE TABLE IF NOT EXISTS reminder_sends (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key  TEXT NOT NULL UNIQUE,
  sent_on    DATE NOT NULL DEFAULT current_date,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminder_sends_sent_on ON reminder_sends (sent_on);

-- ═══════════════════════════════════════════════════════════════
-- INTELLIGENCE INDEXES + PHONE UNIQUENESS (migrations 032, 033)
-- ═══════════════════════════════════════════════════════════════

-- P1-18: index created_at so windowed reads + nightly age-based pruning stay fast.
CREATE INDEX IF NOT EXISTS idx_morale_events_created_at          ON morale_events (created_at);
CREATE INDEX IF NOT EXISTS idx_weekly_quality_scores_created_at  ON weekly_quality_scores (created_at);
CREATE INDEX IF NOT EXISTS idx_schedule_edit_events_created_at   ON schedule_edit_events (created_at);
CREATE INDEX IF NOT EXISTS idx_discovered_patterns_created_at    ON discovered_patterns (created_at);

-- P1-14: one manager phone → one group. Partial so NULL/empty phones (provisional
-- and chat-only sessions) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_setup_sessions_phone
  ON setup_sessions (phone)
  WHERE phone IS NOT NULL AND phone <> '';

-- ═══════════════════════════════════════════════════════════════
-- AUDIT LOG + IDEMPOTENCY (migration 034 — Epic 0, WP-0.4)
-- ═══════════════════════════════════════════════════════════════
-- Immutable, append-only audit trail. logEvent() only ever INSERTs.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    TEXT NOT NULL,
  actor_id    TEXT,
  actor_type  TEXT NOT NULL DEFAULT 'system'
              CHECK (actor_type IN ('system','owner','manager','staff','provider')),
  action      TEXT NOT NULL,
  target      TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_group   ON audit_log (group_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action  ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Generalized at-most-once guard (claim → run → complete; release on failure).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','completed')),
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys (created_at);
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- ENTITLEMENTS / FEATURE FLAGS (migration 035 — Epic 0, WP-0.5)
-- ═══════════════════════════════════════════════════════════════
-- Flat-fee: one tier per group, no per-seat metering. Tiers gate features.
CREATE TABLE IF NOT EXISTS entitlements (
  group_id    TEXT PRIMARY KEY,
  tier        TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free','starter','pro')),
  overrides   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- DM FLOW SESSIONS (migration 036 — Epic 0, WP-0.2)
-- ═══════════════════════════════════════════════════════════════
-- Generic multi-step DM wizard state. Flow definitions live in code; a row
-- holds only collected answers + the step index (restart-safe).
CREATE TABLE IF NOT EXISTS dm_flow_sessions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  group_id     TEXT,
  flow_name    TEXT NOT NULL,
  step_index   INT NOT NULL DEFAULT 0,
  answers      JSONB NOT NULL DEFAULT '{}'::jsonb,
  context      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','complete','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dm_flow_active
  ON dm_flow_sessions (recipient_id) WHERE status = 'active';
ALTER TABLE dm_flow_sessions ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- EMPLOYEE PAYROLL SETTINGS (migration 037 — Epic 2, WP-2.6)
-- ═══════════════════════════════════════════════════════════════
-- Per-employee tax classification. Default W-2; owner can switch to 1099.
CREATE TABLE IF NOT EXISTS employee_payroll_settings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id      TEXT NOT NULL,
  staff_id      BIGINT NOT NULL,
  tax_type      TEXT NOT NULL DEFAULT 'w2' CHECK (tax_type IN ('w2','1099')),
  filing_status TEXT,
  allowances    INT,
  w4_ref        TEXT,
  w9_ref        TEXT,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_emp_payroll_settings_group ON employee_payroll_settings (group_id);
ALTER TABLE employee_payroll_settings ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- PAY RUNS + ITEMS (migration 038 — Epic 1, WP-1.3)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pay_runs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id     TEXT NOT NULL,
  week_start   DATE,
  status       TEXT NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing','completed','completed_with_errors','failed')),
  total_cents  BIGINT NOT NULL DEFAULT 0,
  initiated_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pay_runs_group ON pay_runs (group_id);
ALTER TABLE pay_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS pay_run_items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pay_run_id      BIGINT NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
  group_id        TEXT NOT NULL,
  staff_id        BIGINT NOT NULL,
  wage_cents      BIGINT NOT NULL DEFAULT 0,
  tip_cents       BIGINT NOT NULL DEFAULT 0,
  deduction_cents BIGINT NOT NULL DEFAULT 0,
  net_cents       BIGINT NOT NULL DEFAULT 0,
  tax_type        TEXT NOT NULL DEFAULT 'w2',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','failed')),
  provider_ref    TEXT,
  idem_key        TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pay_run_items_run ON pay_run_items (pay_run_id);
ALTER TABLE pay_run_items ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- EMPLOYEE BANK ACCOUNTS (migration 039 — Epic 1, WP-1.2)
-- ═══════════════════════════════════════════════════════════════
-- Provider reference + KYC status ONLY — never raw bank data.
CREATE TABLE IF NOT EXISTS employee_bank_accounts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id     TEXT NOT NULL,
  staff_id     BIGINT NOT NULL,
  provider     TEXT,
  provider_ref TEXT,
  kyc_status   TEXT NOT NULL DEFAULT 'pending'
               CHECK (kyc_status IN ('pending','verified','rejected')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_employee_bank_accounts_group ON employee_bank_accounts (group_id);
ALTER TABLE employee_bank_accounts ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- COMPLIANCE PROFILES (migration 040 — Epic 4, WP-4.1)
-- ═══════════════════════════════════════════════════════════════
-- Per-workplace jurisdiction (state + optional city) and the resolved
-- labor-law `ruleset` jsonb consumed by the break/minor/fair-workweek engines.
CREATE TABLE IF NOT EXISTS compliance_profiles (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    TEXT NOT NULL,
  state       TEXT,
  city        TEXT,
  ruleset     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id)
);
CREATE INDEX IF NOT EXISTS idx_compliance_profiles_group ON compliance_profiles (group_id);
ALTER TABLE compliance_profiles ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- COMPLIANCE EVENTS (migration 042 — Epic 4, WP-4.6)
-- ═══════════════════════════════════════════════════════════════
-- Append-only labor-law compliance log feeding the exportable audit report.
CREATE TABLE IF NOT EXISTS compliance_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    TEXT NOT NULL,
  staff_id    BIGINT,
  event_type  TEXT NOT NULL,
  code        TEXT,
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','block')),
  week_start  DATE,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_events_group ON compliance_events (group_id);
CREATE INDEX IF NOT EXISTS idx_compliance_events_group_created ON compliance_events (group_id, created_at DESC);
ALTER TABLE compliance_events ENABLE ROW LEVEL SECURITY;
