-- Revenue types: manager-configured category list for income tracking
CREATE TABLE IF NOT EXISTS revenue_types (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, name)
);

CREATE INDEX IF NOT EXISTS idx_revenue_types_group
  ON revenue_types(group_id, active);
