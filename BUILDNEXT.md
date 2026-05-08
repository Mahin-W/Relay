# Build Next

## SQL Migrations needed after split-brain fix (2026-05-08)

Run these before deploying or testing the revenue/receipts fixes from commit 8eab76f.

### 1. daily_revenue — unified revenue entry table

```sql
CREATE TABLE IF NOT EXISTS daily_revenue (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  entry_date DATE NOT NULL,
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  category TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_revenue_group
  ON daily_revenue(group_id, entry_date);
```

### 2. weekly_revenue — add unique constraint for upserts

```sql
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'weekly_revenue_group_week_unique'
  ) THEN
    ALTER TABLE weekly_revenue
      ADD CONSTRAINT weekly_revenue_group_week_unique
      UNIQUE (group_id, week_start);
  END IF;
END $$;
```

### 3. generated_schedules — publish state columns (if not already present)

```sql
ALTER TABLE generated_schedules
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE generated_schedules
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE generated_schedules
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
```

### Why

- `daily_revenue` is required by `src/analytics/revenueDb.js` — bot `/revenue` command now inserts here before rolling up to `weekly_revenue`
- `weekly_revenue` upsert uses `onConflict: 'group_id,week_start'` which requires the unique constraint to exist
- `generated_schedules` status columns are written by the approve route — already in the code, just need the columns if the table predates this feature
