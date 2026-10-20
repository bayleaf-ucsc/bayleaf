-- Four content-free rows, never purged. A shorter TTL is an irreversible ceiling
-- without an explicitly reviewed policy migration; cutoffs never move backwards.
CREATE TABLE retention_state (
  class TEXT PRIMARY KEY,
  ttl_ms INTEGER NOT NULL CHECK(ttl_ms > 0),
  cutoff_ms INTEGER NOT NULL
);
