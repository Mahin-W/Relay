-- ═══════════════════════════════════════════════════════════════
-- API KEYS (migration 053 — Epic 7, WP-7.4) — montreal block 053+
-- ═══════════════════════════════════════════════════════════════
-- Scoped API keys for the public API / webhooks. We store ONLY a sha256 hash of
-- the key — the plaintext is shown to the user once at creation and never kept.

CREATE TABLE IF NOT EXISTS api_keys (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id   TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  scopes     TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_keys_group ON api_keys (group_id);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
