-- ═══════════════════════════════════════════════════════════════
-- EMPLOYEE BANK ACCOUNTS (migration 039 — Epic 1, WP-1.2)
-- ═══════════════════════════════════════════════════════════════
-- Direct-deposit enrollment state. We store ONLY the provider's reference and
-- KYC status — NEVER raw bank/account numbers (those live with the provider via
-- its hosted onboarding; keeps Relay out of PCI/bank-data scope).

CREATE TABLE IF NOT EXISTS employee_bank_accounts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id     TEXT NOT NULL,
  staff_id     BIGINT NOT NULL,
  provider     TEXT,
  provider_ref TEXT,
  kyc_status   TEXT NOT NULL DEFAULT 'pending'
               CHECK (kyc_status IN ('pending','verified','rejected')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_employee_bank_accounts_group ON employee_bank_accounts (group_id);
ALTER TABLE employee_bank_accounts ENABLE ROW LEVEL SECURITY;
