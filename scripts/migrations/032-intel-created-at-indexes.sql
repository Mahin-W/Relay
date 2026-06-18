-- P1-18: the intelligence tables are read on 8–12 week windows and pruned by
-- age, but had no index on created_at. Add one to each so windowed reads and the
-- nightly pruning delete (rows older than ~2 years) stay fast as they grow.
CREATE INDEX IF NOT EXISTS idx_morale_events_created_at          ON morale_events (created_at);
CREATE INDEX IF NOT EXISTS idx_weekly_quality_scores_created_at  ON weekly_quality_scores (created_at);
CREATE INDEX IF NOT EXISTS idx_schedule_edit_events_created_at   ON schedule_edit_events (created_at);
CREATE INDEX IF NOT EXISTS idx_discovered_patterns_created_at    ON discovered_patterns (created_at);
