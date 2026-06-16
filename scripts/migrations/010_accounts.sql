-- Migration 010 — Account-centric identity layer
--
-- Background: Relay is group-centric — setup_sessions.group_id (the Telegram
-- chat ID) is the universal tenant key. There is no identity that exists before
-- a Telegram group does, so a person cannot sign up on the web, do setup, and
-- connect Telegram later.
--
-- This migration introduces:
--   1. accounts          — one row per business owner, keyed to a Supabase Auth
--                          user (auth.users.id). Holds web-collected setup data
--                          as a staging JSONB until a group links to the account.
--   2. account_links     — one-time deep-link codes that bind a Telegram user ID
--                          to an account (https://t.me/<bot>?start=link_<code>).
--   3. setup_sessions.account_id — nullable FK; the account<->group bridge.
--                          One business per account => one group per account.
--   4. A trigger on auth.users INSERT that auto-creates the matching accounts
--      row, so an account always exists immediately after signup.
--
-- Tenant isolation stays application-layer (server uses the service-role key,
-- which bypasses RLS). Tightening RLS to auth.uid() is a future hardening step.
--
-- Safe to re-run.

-- ── 1. accounts ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id                 UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email              TEXT,
  business_name      TEXT,
  -- Staging for web-collected setup before a Telegram group exists:
  --   { restaurant_name, shifts:[], staff:[], role_rates:[], overtime:{},
  --     tips:{}, phone, skipped:[] }
  setup_data         JSONB DEFAULT '{}'::jsonb,
  onboarding_complete BOOLEAN DEFAULT false,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;  -- default-deny for anon; service_role bypasses

-- ── 2. account_links ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_links (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code             TEXT NOT NULL UNIQUE,
  telegram_user_id BIGINT,            -- null until the deep link is tapped
  used_at          TIMESTAMPTZ,       -- set when the deep link is tapped
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_links_code ON account_links(code);
CREATE INDEX IF NOT EXISTS idx_account_links_tg_user ON account_links(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_account_links_account ON account_links(account_id);

ALTER TABLE account_links ENABLE ROW LEVEL SECURITY;

-- ── 3. setup_sessions.account_id ─────────────────────────────────────────────
ALTER TABLE setup_sessions
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id);

CREATE INDEX IF NOT EXISTS idx_setup_sessions_account ON setup_sessions(account_id);

-- ── 4. auto-create an accounts row when a Supabase Auth user signs up ─────────
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.accounts (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
