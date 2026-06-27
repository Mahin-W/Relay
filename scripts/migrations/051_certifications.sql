-- ═══════════════════════════════════════════════════════════════
-- CERTIFICATIONS (migration 051 — Epic 5, WP-5.4) — montreal block 051+
-- ═══════════════════════════════════════════════════════════════
-- Tracks staff certifications (food handler, ServSafe, alcohol service, ...) and
-- their expiry. Only metadata + a provider doc_ref here — actual file storage is
-- Supabase Storage / a doc vault (blocked-on-human until live creds).

CREATE TABLE IF NOT EXISTS certifications (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id     TEXT NOT NULL,
  staff_id     BIGINT NOT NULL,
  cert_type    TEXT NOT NULL,
  issued_date  DATE,
  expires_date DATE,
  doc_ref      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_certifications_group   ON certifications (group_id);
CREATE INDEX IF NOT EXISTS idx_certifications_expires ON certifications (expires_date);
ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;
