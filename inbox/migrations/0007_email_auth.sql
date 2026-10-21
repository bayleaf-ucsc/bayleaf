-- Existing and omitted policies remain unrestricted. Restriction is creation-only.
ALTER TABLE inboxes ADD COLUMN email_auth_json TEXT DEFAULT NULL
  CHECK (email_auth_json IS NULL OR (type = 'email' AND json_valid(email_auth_json)));

CREATE TRIGGER inbox_email_auth_immutable
BEFORE UPDATE OF email_auth_json ON inboxes
WHEN NEW.email_auth_json IS NOT OLD.email_auth_json
BEGIN
  SELECT RAISE(ABORT, 'email_auth is immutable; create a new inbox');
END;
