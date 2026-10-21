-- After 0003_lifetimes and 0004_events on integration. Independent table rebuild.
-- Approved content-free export page/byte aggregates. Preserve existing windows.
CREATE TABLE telemetry_counts_export (
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
      ('expired','stale','retried','destroyed_messages','reconciled','success','failure')) OR
    (name IN ('inbox.export.pages','inbox.export.bytes') AND transport IN ('http','email') AND outcome = 'emitted')
  )
);
INSERT INTO telemetry_counts_export SELECT * FROM telemetry_counts;
DROP TABLE telemetry_counts;
ALTER TABLE telemetry_counts_export RENAME TO telemetry_counts;
