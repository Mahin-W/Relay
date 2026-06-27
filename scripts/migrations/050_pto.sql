-- ═══════════════════════════════════════════════════════════════
-- PTO ACCRUAL (migration 050 — Epic 6, WP-6.1/6.2)
-- ═══════════════════════════════════════════════════════════════
-- Migration block 050+ is reserved for the montreal continuation so it never
-- collides with the hong-kong Epic 4 branch (which uses 040–042).
-- Per-group accrual policy; per-employee running balance + an append-only ledger.

CREATE TABLE IF NOT EXISTS pto_policies (
  group_id                 TEXT PRIMARY KEY,
  accrual_hours_per_period NUMERIC(6,2) NOT NULL DEFAULT 0,
  period                   TEXT NOT NULL DEFAULT 'weekly'
                           CHECK (period IN ('weekly','biweekly','monthly')),
  max_balance_hours        NUMERIC(7,2),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pto_policies ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS pto_balances (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id      TEXT NOT NULL,
  staff_id      BIGINT NOT NULL,
  balance_hours NUMERIC(7,2) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, staff_id)
);
ALTER TABLE pto_balances ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS pto_ledger (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id      TEXT NOT NULL,
  staff_id      BIGINT NOT NULL,
  delta_hours   NUMERIC(7,2) NOT NULL,
  reason        TEXT,
  balance_after NUMERIC(7,2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pto_ledger_staff ON pto_ledger (group_id, staff_id);
ALTER TABLE pto_ledger ENABLE ROW LEVEL SECURITY;
