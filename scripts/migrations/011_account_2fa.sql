-- Migration 011 — Login two-factor (confirmation code) toggle
--
-- Adds a per-account switch for the login confirmation code. Default ON: after
-- Google/email sign-in, the account owner must enter a one-time code delivered
-- to their Telegram (or email if no Telegram is linked) before the dashboard
-- unlocks. Owners can turn it off in dashboard Settings → Security.
--
-- Safe to re-run.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS login_2fa_enabled BOOLEAN DEFAULT true;
