-- Physical types only. Collection allowlists and retention policy live in JS.
CREATE TABLE browser_observations (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  destination TEXT NOT NULL,
  referring_hostname TEXT
);
CREATE INDEX browser_time ON browser_observations(observed_at, id);
CREATE INDEX browser_expiry ON browser_observations(expires_at);

CREATE TABLE receipts (
  source TEXT NOT NULL,
  class TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (source, class, batch_id)
);
CREATE INDEX receipt_expiry ON receipts(expires_at);

CREATE TABLE metric_points (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  point_index INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  unit TEXT NOT NULL,
  start_at INTEGER,
  time_unix_nano TEXT,
  start_time_unix_nano TEXT,
  temporality TEXT,
  monotonic INTEGER,
  value REAL,
  count INTEGER,
  sum REAL,
  min REAL,
  max REAL,
  attributes_json TEXT NOT NULL CHECK(json_valid(attributes_json)),
  bounds_json TEXT CHECK(bounds_json IS NULL OR json_valid(bounds_json)),
  bucket_counts_json TEXT CHECK(bucket_counts_json IS NULL OR json_valid(bucket_counts_json)),
  UNIQUE(source, batch_id, point_index)
);
CREATE INDEX metric_time ON metric_points(observed_at, id);
CREATE INDEX metric_expiry ON metric_points(expires_at);

CREATE TABLE deletion_runs (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  job TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  deleted INTEGER NOT NULL,
  extensions_json TEXT NOT NULL CHECK(json_valid(extensions_json)),
  UNIQUE(source, batch_id)
);
CREATE INDEX deletion_time ON deletion_runs(observed_at, id);
CREATE INDEX deletion_expiry ON deletion_runs(expires_at);

CREATE TABLE probe_runs (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  layer TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  phases_json TEXT NOT NULL CHECK(json_valid(phases_json)),
  events_json TEXT NOT NULL CHECK(json_valid(events_json)),
  extensions_json TEXT NOT NULL CHECK(json_valid(extensions_json)),
  UNIQUE(source, batch_id)
);
CREATE INDEX probe_time ON probe_runs(observed_at, id);
CREATE INDEX probe_expiry ON probe_runs(expires_at);

-- Status means accepted measurement, not source liveness or delivery success.
CREATE TABLE source_status (
  source TEXT NOT NULL,
  class TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(source, class)
);
CREATE INDEX status_expiry ON source_status(expires_at);

-- Identity-free fixed source/class minute buckets, not per-client counters.
CREATE TABLE ingress_budgets (
  bucket TEXT PRIMARY KEY,
  used INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX budget_expiry ON ingress_budgets(expires_at);
