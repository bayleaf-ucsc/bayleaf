-- Content-free 15-minute aggregate counters/outbox. No sender or owner dimension.
CREATE TABLE telemetry_windows (
  start_at INTEGER PRIMARY KEY CHECK (start_at % 900000 = 0),
  batch_id TEXT NOT NULL UNIQUE,
  sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0,1)),
  sent INTEGER NOT NULL DEFAULT 0 CHECK (sent IN (0,1))
);
CREATE TABLE telemetry_counts (
  start_at INTEGER NOT NULL REFERENCES telemetry_windows(start_at) ON DELETE CASCADE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  outcome TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 1000000000000),
  PRIMARY KEY (start_at, name, transport, outcome),
  CHECK (
    (name = 'inbox.receipts' AND transport IN ('http','email') AND outcome IN
      ('accepted','auth','rate','quota','size','unknown_address','failure')) OR
    (name = 'inbox.lifecycle' AND transport IN ('http','email') AND outcome IN
      ('created','destroy_requested','destroyed')) OR
    (name = 'inbox.cleanup' AND transport = '' AND outcome IN
      ('expired','stale','retried','destroyed_messages','reconciled','success','failure'))
  )
);
