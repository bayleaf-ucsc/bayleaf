-- Explicit endpoint lifetimes (DESIGN.md, "Endpoint lifetimes"). NULL means none:
-- existing inboxes never acquire a lifetime from this migration.
ALTER TABLE inboxes ADD COLUMN expires_at INTEGER;
CREATE INDEX inboxes_expiry ON inboxes (state, expires_at);
