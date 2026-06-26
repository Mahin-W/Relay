-- ═══════════════════════════════════════════════════════════════
-- STAFF DATE OF BIRTH (migration 041 — Epic 4, WP-4.3)
-- ═══════════════════════════════════════════════════════════════
-- Optional date of birth per staff member. Drives minor-labor compliance:
-- minorLabor.js (WP-4.3) derives age from dob to enforce school-night hours
-- and daily/weekly maximums for workers under 18. Nullable — unknown DOB is
-- treated as an adult (no minor restrictions) by the engine.

ALTER TABLE staff ADD COLUMN IF NOT EXISTS dob DATE;
