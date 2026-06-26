-- ═══════════════════════════════════════════════════════════════
-- COMPLIANCE EVENTS (migration 042 — Epic 4, WP-4.6)
-- ═══════════════════════════════════════════════════════════════
-- Append-only log of labor-law compliance events: detected minor-labor
-- violations, required-break notices, predictive-scheduling changes and
-- predictability-pay accruals, plus manager overrides. Feeds the exportable
-- compliance audit report (Dashboard + /complianceaudit). group_id-scoped.

CREATE TABLE IF NOT EXISTS compliance_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    TEXT NOT NULL,
  staff_id    BIGINT,
  event_type  TEXT NOT NULL,   -- minor_violation | break_required | schedule_change | predictability_pay | override
  code        TEXT,            -- specific rule code (after_latest, over_daily_max, …)
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','block')),
  week_start  DATE,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_events_group ON compliance_events (group_id);
CREATE INDEX IF NOT EXISTS idx_compliance_events_group_created ON compliance_events (group_id, created_at DESC);
ALTER TABLE compliance_events ENABLE ROW LEVEL SECURITY;
