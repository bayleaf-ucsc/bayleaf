-- BayLeaf Rooms retirement ledger (rooms/DESIGN.md), the same shape as inbox_retirements
-- (0019) so one sweep serves both. Generation is linkable opaque account metadata, not an
-- email or content. Written in the same transaction as identity deletion.
CREATE TABLE room_retirements (
  generation TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL,
  fenced_at INTEGER,
  checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX room_retirements_pending ON room_retirements(checked_at,generation) WHERE fenced_at IS NULL;
CREATE INDEX room_retirements_replay ON room_retirements(checked_at,generation) WHERE fenced_at IS NOT NULL;
