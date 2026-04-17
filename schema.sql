-- cf-usage-watcher/schema.sql
-- Minimal D1 schema for the usage watcher history store.

CREATE TABLE IF NOT EXISTS usage_runs (
  run_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  limit_exceeded INTEGER NOT NULL,
  active_breaches TEXT NOT NULL,
  metrics TEXT NOT NULL,
  error_json TEXT,
  warning TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_usage_runs_checked_at
  ON usage_runs(checked_at DESC);
