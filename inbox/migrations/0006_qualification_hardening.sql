-- Durable generation fence: do not clear after object deletion or an empty list.
-- Recovery must replay the API retirement ledger before re-enabling this service.
CREATE TABLE retired_owners (
  owner TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL
);
-- Opaque id-only round-robin positions; no owner/content/address in these rows.
CREATE TABLE cleanup_progress (
  name TEXT PRIMARY KEY,
  cursor TEXT NOT NULL
);
