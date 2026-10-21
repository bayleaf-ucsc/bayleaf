-- Separate from provider credentials: retained recovery/revocation ledger.
-- Generation is linkable opaque account metadata, not an email or content.
CREATE TABLE inbox_retirements (
  generation TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL,
  fenced_at INTEGER,
  checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inbox_retirements_pending ON inbox_retirements(checked_at,generation) WHERE fenced_at IS NULL;
CREATE INDEX inbox_retirements_replay ON inbox_retirements(checked_at,generation) WHERE fenced_at IS NOT NULL;
