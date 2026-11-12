-- BayLeaf Rooms owner index (rooms/DESIGN.md, "Storage"). Times are UTC epoch
-- milliseconds, matching the Durable Object. Room content never lives here.

-- One row per room. The row is reserved before the Durable Object is touched, so
-- quota checks are atomic and every room has a row that cleanup can find.
CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  label TEXT,
  codec TEXT NOT NULL CHECK (codec IN ('json','yjs')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live','destroying'))
);
CREATE INDEX rooms_owner_state ON rooms (owner, state);
CREATE INDEX rooms_expires_at ON rooms (expires_at);

-- Written first by retireOwner; a retired owner gets not_found forever.
CREATE TABLE retired_owners (
  owner TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL
);

-- Aggregate telemetry counts in fixed 15-minute windows, closed vocabularies
-- only (DESIGN.md, "Telemetry"). Exported by cron, then deleted.
CREATE TABLE metric_windows (
  window_start INTEGER NOT NULL,
  name TEXT NOT NULL,
  attrs TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (window_start, name, attrs)
);
