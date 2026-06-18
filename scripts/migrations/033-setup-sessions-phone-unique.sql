-- P1-14: a manager phone number must map to one group. Enforce uniqueness with a
-- PARTIAL unique index so the many NULL/empty phones on provisional (web:<id>)
-- and chat-only sessions don't collide — only real phone values are constrained.
-- (Verified zero existing duplicate non-empty phones before applying.)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_setup_sessions_phone
  ON setup_sessions (phone)
  WHERE phone IS NOT NULL AND phone <> '';
