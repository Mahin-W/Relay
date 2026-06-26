-- ═══════════════════════════════════════════════════════════════
-- PAY RUNS + ITEMS (migration 038 — Epic 1, WP-1.3)
-- ═══════════════════════════════════════════════════════════════
-- Owner-initiated pay run ledger. One pay_runs row per run; one pay_run_items
-- row per employee paid. Each item carries its own idempotency key + provider
-- reference so a retried run never double-pays.

CREATE TABLE IF NOT EXISTS pay_runs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id     TEXT NOT NULL,
  week_start   DATE,
  status       TEXT NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing','completed','completed_with_errors','failed')),
  total_cents  BIGINT NOT NULL DEFAULT 0,
  initiated_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pay_runs_group ON pay_runs (group_id);
ALTER TABLE pay_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS pay_run_items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pay_run_id      BIGINT NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
  group_id        TEXT NOT NULL,
  staff_id        BIGINT NOT NULL,
  wage_cents      BIGINT NOT NULL DEFAULT 0,
  tip_cents       BIGINT NOT NULL DEFAULT 0,
  deduction_cents BIGINT NOT NULL DEFAULT 0,
  net_cents       BIGINT NOT NULL DEFAULT 0,
  tax_type        TEXT NOT NULL DEFAULT 'w2',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','failed')),
  provider_ref    TEXT,
  idem_key        TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pay_run_items_run ON pay_run_items (pay_run_id);
ALTER TABLE pay_run_items ENABLE ROW LEVEL SECURITY;
