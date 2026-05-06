-- Hotfix: staff_availability was created without an RLS policy,
-- blocking all reads and writes via the anon key (dashboard).
-- This adds the permissive policy that every other table has.

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
