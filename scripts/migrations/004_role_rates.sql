-- Role rates: hourly pay rates per role per group
CREATE TABLE IF NOT EXISTS role_rates (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  role TEXT NOT NULL,
  rate DECIMAL(8,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, role)
);
