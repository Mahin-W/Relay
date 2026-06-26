-- ═══════════════════════════════════════════════════════════════
-- EMPLOYEE PAYROLL SETTINGS (migration 037 — Epic 2, WP-2.6)
-- ═══════════════════════════════════════════════════════════════
-- Per-employee tax classification + withholding fields. DEFAULT = W-2; the
-- owner can switch any employee to 1099. payRunEngine (WP-1.4) and Check tax
-- config (WP-2.2) read tax_type to choose withholding vs. contractor pay and
-- W-2 vs. 1099-NEC. Every change is audit-logged (compliance-sensitive).

CREATE TABLE IF NOT EXISTS employee_payroll_settings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id      TEXT NOT NULL,
  staff_id      BIGINT NOT NULL,
  tax_type      TEXT NOT NULL DEFAULT 'w2' CHECK (tax_type IN ('w2','1099')),
  filing_status TEXT,
  allowances    INT,
  w4_ref        TEXT,
  w9_ref        TEXT,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_emp_payroll_settings_group ON employee_payroll_settings (group_id);
ALTER TABLE employee_payroll_settings ENABLE ROW LEVEL SECURITY;
