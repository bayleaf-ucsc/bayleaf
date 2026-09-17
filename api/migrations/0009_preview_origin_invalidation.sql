-- Preserve invalidation work atomically across hostname replacement/deletion.
CREATE TABLE preview_invalidations (
  hostname TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  slot TEXT NOT NULL
);
CREATE TRIGGER preview_origin_replaced AFTER UPDATE OF hostname ON preview_registrations
WHEN OLD.hostname != NEW.hostname
BEGIN
  INSERT OR IGNORE INTO preview_invalidations VALUES (OLD.hostname, OLD.email, OLD.slot);
END;
CREATE TRIGGER preview_origin_revoked AFTER DELETE ON preview_registrations
BEGIN
  INSERT OR IGNORE INTO preview_invalidations VALUES (OLD.hostname, OLD.email, OLD.slot);
END;
