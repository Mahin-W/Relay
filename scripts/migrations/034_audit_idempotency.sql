-- ═══════════════════════════════════════════════════════════════
-- AUDIT LOG + IDEMPOTENCY (migration 034 — Epic 0, WP-0.4)
-- ═══════════════════════════════════════════════════════════════
-- Foundational spine for the platform build. Every money/POS/payroll
-- mutation will write an immutable audit row and guard external calls
-- through an idempotency key. Generalizes the reminder_sends dedup.

-- Immutable, append-only audit trail. No UPDATE/DELETE happen in code
-- (logEvent only ever INSERTs) — service-role bypasses RLS, so immutability
-- is enforced by convention at the data-access layer.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    TEXT NOT NULL,
  actor_id    TEXT,                                   -- telegram/staff id, account id, or null
  actor_type  TEXT NOT NULL DEFAULT 'system'
              CHECK (actor_type IN ('system','owner','manager','staff','provider')),
  action      TEXT NOT NULL,                          -- e.g. 'payroll.run', 'tax_type.change'
  target      TEXT,                                   -- affected entity id (staff_id, pay_run_id, ...)
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,     -- before/after, amounts, refs
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_group    ON audit_log (group_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action   ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created  ON audit_log (created_at);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Generalized idempotency guard for any external/at-most-once operation.
-- claim → run → complete; on failure the claim is released so a deliberate
-- retry can re-run. A completed row caches the result for replay.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','completed')),
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys (created_at);
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
