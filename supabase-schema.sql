-- Run this in Supabase SQL Editor → New Query → Run

CREATE TABLE IF NOT EXISTS coverage_requests (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_name TEXT,
  shift_description TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  matched_shift_id UUID,
  week_start DATE,
  status TEXT NOT NULL DEFAULT 'open',
  covered_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  covered_at TIMESTAMPTZ,

  CONSTRAINT valid_status CHECK (status IN ('open','covered','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_group_id
  ON coverage_requests(group_id);
CREATE INDEX IF NOT EXISTS idx_status
  ON coverage_requests(status);
CREATE INDEX IF NOT EXISTS idx_group_status
  ON coverage_requests(group_id, status);

COMMENT ON TABLE coverage_requests IS
  'Shift coverage requests detected from restaurant staff group chats by Relay bot';

-- Staff who have DM'd the bot with /start to register
CREATE TABLE IF NOT EXISTS staff_dms (
  user_id BIGINT PRIMARY KEY,
  first_name TEXT,
  username TEXT,
  dm_chat_id BIGINT NOT NULL,
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

-- Everyone seen sending a message in each group
CREATE TABLE IF NOT EXISTS group_members (
  user_id BIGINT,
  group_id TEXT,
  first_name TEXT,
  username TEXT,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);

-- Tracks which staff were DM'd for a given coverage request
CREATE TABLE IF NOT EXISTS coverage_outreach (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT REFERENCES coverage_requests(id),
  user_id BIGINT,
  asked_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS policies for new tables
CREATE POLICY "Allow all for anon on staff_dms"
  ON staff_dms FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for anon on group_members"
  ON group_members FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for anon on coverage_outreach"
  ON coverage_outreach FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE staff_dms ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE coverage_outreach ENABLE ROW LEVEL SECURITY;

-- Shift trade requests
CREATE TABLE IF NOT EXISTS trade_requests (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_name TEXT,
  requester_id BIGINT NOT NULL,
  requester_name TEXT NOT NULL,
  shift_id UUID,
  shift_description TEXT NOT NULL,
  week_start DATE,
  status TEXT NOT NULL DEFAULT 'open',
  accepted_by_id BIGINT,
  accepted_by_name TEXT,
  accepted_shift_id UUID,
  accepted_shift_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_trade_status CHECK (status IN ('open', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_trade_group_status ON trade_requests(group_id, status);

ALTER TABLE trade_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon on trade_requests"
  ON trade_requests FOR ALL TO anon USING (true) WITH CHECK (true);
