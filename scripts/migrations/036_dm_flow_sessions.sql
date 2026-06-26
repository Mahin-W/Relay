-- ═══════════════════════════════════════════════════════════════
-- DM FLOW SESSIONS (migration 036 — Epic 0, WP-0.2)
-- ═══════════════════════════════════════════════════════════════
-- Generic multi-step DM wizard state (generalizes the setup_sessions
-- step/stage pattern). Flow DEFINITIONS live in code (restart-safe);
-- a row here only holds collected answers + which step we're on.

CREATE TABLE IF NOT EXISTS dm_flow_sessions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id TEXT NOT NULL,        -- caller-chosen, stable per recipient (staff id or telegram id)
  group_id     TEXT,
  flow_name    TEXT NOT NULL,
  step_index   INT NOT NULL DEFAULT 0,
  answers      JSONB NOT NULL DEFAULT '{}'::jsonb,
  context      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','complete','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one ACTIVE flow per recipient at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dm_flow_active
  ON dm_flow_sessions (recipient_id) WHERE status = 'active';
ALTER TABLE dm_flow_sessions ENABLE ROW LEVEL SECURITY;
