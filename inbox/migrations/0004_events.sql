-- Arrival events (DESIGN.md, "Arrival events"). Minimal references, never content.

ALTER TABLE inboxes ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0;

-- Random per database: a cursor from a rebuilt or exported database is detectably foreign.
CREATE TABLE event_feed (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL
);
INSERT INTO event_feed (id, epoch) VALUES (1, lower(hex(randomblob(8))));

CREATE TABLE events (
  inbox_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('message.received')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (inbox_id, seq)
);

-- Fixed-lived subscriber leases, not message claims. No credentials or content.
CREATE TABLE event_streams (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX event_streams_inbox ON event_streams (inbox_id, expires_at);
CREATE INDEX event_streams_expiry ON event_streams (expires_at);

-- Backfill already stored messages in arrival order, then set each high-water mark.
INSERT INTO events (inbox_id, seq, message_id, type, created_at)
  SELECT inbox_id, ROW_NUMBER() OVER (PARTITION BY inbox_id ORDER BY received_at, id), id, 'message.received', received_at
  FROM messages WHERE state = 'stored';
UPDATE inboxes SET event_seq = (SELECT COALESCE(MAX(seq), 0) FROM events WHERE events.inbox_id = inboxes.id);
