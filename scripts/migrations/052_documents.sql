-- ═══════════════════════════════════════════════════════════════
-- DOCUMENTS metadata (migration 052 — Epic 5, WP-5.2) — montreal block 052+
-- ═══════════════════════════════════════════════════════════════
-- HR document metadata (W-4, I-9, direct-deposit auth, handbook ack, ...).
-- Stores only a provider doc_ref + e-sign timestamp — the actual file bytes and
-- e-signature live with the storage/e-sign vendor (blocked-on-human).

CREATE TABLE IF NOT EXISTS documents (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id   TEXT NOT NULL,
  staff_id   BIGINT NOT NULL,
  doc_type   TEXT NOT NULL,
  doc_ref    TEXT,
  signed_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_staff ON documents (group_id, staff_id);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
