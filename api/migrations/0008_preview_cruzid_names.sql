-- Use the campus identity namespace directly: cruzid-port, without a digest.
-- Upstream ciphertext is bound to the old hostname by AES-GCM additional data.
-- Refuse migration while any registrations exist rather than rename unusable
-- ciphertext or silently revoke grants. The POC fixtures were already revoked.
CREATE TABLE preview_cruzid_migration_guard (
  registrations INTEGER NOT NULL CHECK (registrations = 0)
);
INSERT INTO preview_cruzid_migration_guard
  SELECT COUNT(*) FROM preview_registrations;

UPDATE preview_owners
  SET slug = lower(substr(email, 1, instr(email, '@') - 1));

DROP TABLE preview_cruzid_migration_guard;
