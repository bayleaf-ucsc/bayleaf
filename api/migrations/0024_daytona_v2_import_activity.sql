-- Preserve the pre-import inactivity clock until Daytona records new activity.
-- Keyed by provider IDs only; ownership remains in Daytona and user_keys.
CREATE TABLE sandbox_import_activity (
  sandbox_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE,
  source_activity_ms INTEGER NOT NULL,
  baseline_activity_ms INTEGER NOT NULL
);
