-- ============================================================================
-- DROP UNUSED TABLES  (Part 2 cleanup, 2026-06-18)
--
-- Removes 3 tables that NO live code path references. DDL for all three is
-- backed up in scripts/dropped-tables-backup.sql — restore by running that file.
--
--   login_otps              legacy manager phone-OTP login; replaced by
--                           account-based Supabase Auth. String "login_otps"
--                           appears nowhere in src/. Was not even in
--                           supabase-schema.sql.
--   platform_contacts       unbuilt "Phase 2+" stub; only referenced in a code
--                           comment (src/platform/UnifiedBot.js).
--   schedule_quality_scores superseded by weekly_quality_scores (per the schema
--                           comment); code only ever queries weekly_quality_scores.
--
-- Verified before drop: zero foreign keys from any retained table point at these.
-- Project: khfyiapeoiatnxbhcbto
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS public.login_otps;
DROP TABLE IF EXISTS public.platform_contacts;
DROP TABLE IF EXISTS public.schedule_quality_scores;

COMMIT;
