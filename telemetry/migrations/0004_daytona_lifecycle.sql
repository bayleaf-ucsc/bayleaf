-- Aggregated transitions only. No sandbox/organization IDs or event timestamps.
CREATE TABLE lifecycle_buckets (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  event TEXT NOT NULL,
  old_state TEXT NOT NULL,
  new_state TEXT NOT NULL,
  count INTEGER NOT NULL,
  UNIQUE(source, observed_at, event, old_state, new_state)
);
CREATE INDEX lifecycle_time ON lifecycle_buckets(observed_at, id);
CREATE INDEX lifecycle_expiry ON lifecycle_buckets(expires_at);
