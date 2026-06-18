-- P1-29: persist schedule-reminder dedup so a restart (e.g. Render free-tier
-- sleep/wake) doesn't resend every reminder. Keyed by the full dedup string the
-- reminder jobs build (which already encodes recipient + shift + kind + date),
-- with a UNIQUE constraint so a concurrent/duplicate insert is a no-op.
CREATE TABLE IF NOT EXISTS reminder_sends (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key  TEXT NOT NULL UNIQUE,
  sent_on    DATE NOT NULL DEFAULT current_date,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the pruning query (delete rows older than a retention window).
CREATE INDEX IF NOT EXISTS idx_reminder_sends_sent_on ON reminder_sends (sent_on);
