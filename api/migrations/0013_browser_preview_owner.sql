-- Bind managed browser access to the current ordinary owner credential.
-- No credential or user content is stored in the new column.
ALTER TABLE preview_registrations ADD COLUMN owner_key_hash TEXT;
