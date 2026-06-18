-- ============================================================================
-- RESET ALL DATA  —  empties every table in the `public` schema.
-- Keeps the schema (tables, columns, constraints, RLS) intact; deletes all rows
-- and resets identity sequences. Run in the Supabase SQL Editor.
--
-- ⚠️  DESTRUCTIVE & IRREVERSIBLE. There is no undo. Take a backup first if in
--     doubt (Supabase Dashboard → Database → Backups).
--
-- Project: khfyiapeoiatnxbhcbto
-- ============================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Disable FK/trigger checks so order doesn't matter and CASCADE is clean.
  EXECUTE 'SET session_replication_role = replica';

  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', r.tablename);
    RAISE NOTICE 'Truncated %', r.tablename;
  END LOOP;

  EXECUTE 'SET session_replication_role = DEFAULT';
END $$;

-- Verify everything is empty (every row_count should be 0):
SELECT
  schemaname,
  relname  AS table_name,
  n_live_tup AS approx_rows
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_live_tup DESC, relname;
