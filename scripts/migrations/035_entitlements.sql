-- ═══════════════════════════════════════════════════════════════
-- ENTITLEMENTS / FEATURE FLAGS (migration 035 — Epic 0, WP-0.5)
-- ═══════════════════════════════════════════════════════════════
-- Flat-fee model: ONE row per group holds a tier (free/starter/pro) plus
-- optional per-feature overrides. Pricing NEVER depends on headcount — there
-- is deliberately no per-seat counting anywhere. Tiers gate *which features*
-- are unlocked, not *how many staff*.

CREATE TABLE IF NOT EXISTS entitlements (
  group_id    TEXT PRIMARY KEY,
  tier        TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free','starter','pro')),
  overrides   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { "<feature>": true|false } manual grants/revokes
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
