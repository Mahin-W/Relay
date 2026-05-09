-- Migration 008 — Lock down Row Level Security
--
-- Background: supabase-schema.sql lines 616-644 created an
--   "Allow all for anon ... USING (true) WITH CHECK (true)"
-- policy on every tenant table. Combined with the public anon key, this means
-- anyone with the Supabase URL can read and modify every restaurant's data.
-- The app-layer JWT check is the only protection, and it can be bypassed by
-- talking to Supabase directly.
--
-- This migration:
--   1. Drops every "Allow all for anon" policy (where the table exists).
--   2. Leaves RLS enabled with no permissive anon policy. After this, anon
--      traffic gets zero rows back from any tenant table.
--   3. Trusted server traffic must use the service-role key
--      (SUPABASE_SERVICE_ROLE_KEY) — service_role bypasses RLS by design.
--
-- Operator action required BEFORE running this migration:
--   - In Render, set SUPABASE_SERVICE_ROLE_KEY (Project Settings → API → service_role).
--   - Verify src/db/client.js is using the service role (it falls back to anon if unset).
--   - Roll the deploy and confirm the bot + dashboard still work.
--
-- This migration is safe to re-run. Tables in the candidate list that don't
-- exist in the local schema are silently skipped.

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
      'tip_records', 'recognition_events', 'schedule_quality_scores',
      'daily_revenue', 'revenue_types',
      'weekly_quality_scores', 'restaurant_tip_settings', 'cross_training',
      'recurring_constraints', 'discovered_patterns', 'coverage_confirmations',
      'staff_availability_windows', 'staff_members', 'availability_outcomes'
    ])
  LOOP
    -- Skip tables that don't exist in this schema. Schema drift between
    -- supabase-schema.sql and what's actually deployed is normal here.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      RAISE NOTICE 'Skipping % (table does not exist)', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Allow all for anon on %I" ON %I', tbl, tbl);
    -- No replacement permissive policy is created. Default deny applies to anon.
    -- service_role bypasses RLS automatically.
  END LOOP;
END $$;
