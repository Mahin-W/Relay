-- Migration 009 — Soften ON DELETE CASCADE on historical tables
--
-- Background: many child tables (payroll_records, time_entries, etc.) reference
-- staff(id) ON DELETE CASCADE. Deleting a staff row wipes every historical pay
-- record and time clock punch tied to that row, with no undo.
--
-- This migration converts the cascades on historical/audit tables to
-- ON DELETE SET NULL so the FK column becomes null and the row survives.
-- Each block checks the COLUMN exists (not just the table) so the migration
-- tolerates schema drift between supabase-schema.sql and what's deployed.

-- payroll_records.staff_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payroll_records' AND column_name = 'staff_id'
  ) THEN
    ALTER TABLE payroll_records ALTER COLUMN staff_id DROP NOT NULL;
    ALTER TABLE payroll_records DROP CONSTRAINT IF EXISTS payroll_records_staff_id_fkey;
    ALTER TABLE payroll_records
      ADD CONSTRAINT payroll_records_staff_id_fkey
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

-- time_entries.staff_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'time_entries' AND column_name = 'staff_id'
  ) THEN
    ALTER TABLE time_entries ALTER COLUMN staff_id DROP NOT NULL;
    ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_staff_id_fkey;
    ALTER TABLE time_entries
      ADD CONSTRAINT time_entries_staff_id_fkey
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

-- staff_reliability_events.staff_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'staff_reliability_events' AND column_name = 'staff_id'
  ) THEN
    ALTER TABLE staff_reliability_events ALTER COLUMN staff_id DROP NOT NULL;
    ALTER TABLE staff_reliability_events DROP CONSTRAINT IF EXISTS staff_reliability_events_staff_id_fkey;
    ALTER TABLE staff_reliability_events
      ADD CONSTRAINT staff_reliability_events_staff_id_fkey
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

-- recognition_events.recipient_staff_id (NB: column name differs from other tables)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'recognition_events' AND column_name = 'recipient_staff_id'
  ) THEN
    ALTER TABLE recognition_events ALTER COLUMN recipient_staff_id DROP NOT NULL;
    ALTER TABLE recognition_events DROP CONSTRAINT IF EXISTS recognition_events_recipient_staff_id_fkey;
    ALTER TABLE recognition_events
      ADD CONSTRAINT recognition_events_recipient_staff_id_fkey
      FOREIGN KEY (recipient_staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

-- morale_events.staff_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'morale_events' AND column_name = 'staff_id'
  ) THEN
    ALTER TABLE morale_events ALTER COLUMN staff_id DROP NOT NULL;
    ALTER TABLE morale_events DROP CONSTRAINT IF EXISTS morale_events_staff_id_fkey;
    ALTER TABLE morale_events
      ADD CONSTRAINT morale_events_staff_id_fkey
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

-- tip_records.staff_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tip_records' AND column_name = 'staff_id'
  ) THEN
    ALTER TABLE tip_records ALTER COLUMN staff_id DROP NOT NULL;
    ALTER TABLE tip_records DROP CONSTRAINT IF EXISTS tip_records_staff_id_fkey;
    ALTER TABLE tip_records
      ADD CONSTRAINT tip_records_staff_id_fkey
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

-- manager_log_entries.subject_staff_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'manager_log_entries' AND column_name = 'subject_staff_id'
  ) THEN
    ALTER TABLE manager_log_entries DROP CONSTRAINT IF EXISTS manager_log_entries_subject_staff_id_fkey;
    ALTER TABLE manager_log_entries
      ADD CONSTRAINT manager_log_entries_subject_staff_id_fkey
      FOREIGN KEY (subject_staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Prevent double-assigning the same staff to the same shift+week
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'schedule_assignments' AND column_name = 'staff_id'
  ) THEN
    ALTER TABLE schedule_assignments DROP CONSTRAINT IF EXISTS schedule_assignments_unique_per_week;
    ALTER TABLE schedule_assignments
      ADD CONSTRAINT schedule_assignments_unique_per_week
      UNIQUE (group_id, staff_id, shift_id, week_start);
  END IF;
END $$;
