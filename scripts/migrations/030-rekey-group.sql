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
