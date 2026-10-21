-- BayLeaf Inboxes schema (DESIGN.md, "Data model"). Times are UTC epoch seconds.

CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('email','http')),
  nonce TEXT NOT NULL UNIQUE,
  label TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','destroying')),
  created_at INTEGER NOT NULL,
  destroy_requested_at INTEGER,
  auth_required INTEGER NOT NULL DEFAULT 0,
  bytes_stored INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL DEFAULT '',
  day_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','stored','deleting')),
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL,
  meta_json TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT ''
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bearer')),
  name TEXT NOT NULL,
  hint TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER
);

CREATE INDEX inboxes_owner ON inboxes (owner);
CREATE INDEX messages_listing ON messages (inbox_id, state, received_at DESC, id DESC);
CREATE INDEX messages_expiry ON messages (state, expires_at);
CREATE INDEX credentials_inbox ON credentials (inbox_id);

-- Durable residual: opaque internal inbox ids and reconciliation progress only.
-- Never removed after an empty listing: an already-started R2 put can finish late.
CREATE TABLE cleanup_prefixes (
  inbox_id TEXT PRIMARY KEY,
  cursor TEXT,
  turn INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cleanup_prefixes_turn ON cleanup_prefixes (turn, inbox_id);
