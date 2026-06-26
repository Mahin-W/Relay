-- ═══════════════════════════════════════════════════════════════
-- COMPLIANCE PROFILES (migration 040 — Epic 4, WP-4.1)
-- ═══════════════════════════════════════════════════════════════
-- Per-workplace jurisdiction profile: the governing US state + optional city,
-- and the resolved `ruleset` jsonb the labor-law engines read —
--   breakPlanning.js (WP-4.2) → ruleset.meal / ruleset.rest
--   minorLabor.js    (WP-4.3) → ruleset.minor
--   fair-workweek    (WP-4.4) → ruleset.fairWorkweek / advanceNoticeDays
-- One profile per group_id. Set via Dashboard "Location & compliance" or the
-- `/setlocation` command. Changes are audit-logged (compliance-sensitive).

CREATE TABLE IF NOT EXISTS compliance_profiles (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    TEXT NOT NULL,
  state       TEXT,            -- 2-letter US state code, e.g. 'CA'
  city        TEXT,            -- optional city for Fair-Workweek overlays
  ruleset     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id)
);
CREATE INDEX IF NOT EXISTS idx_compliance_profiles_group ON compliance_profiles (group_id);
ALTER TABLE compliance_profiles ENABLE ROW LEVEL SECURITY;
