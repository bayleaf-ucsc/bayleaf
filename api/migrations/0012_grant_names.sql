-- Names are recognition aids, never credentials. NULL preserves older tokens.
ALTER TABLE inference_grants ADD COLUMN name TEXT;
CREATE UNIQUE INDEX inference_grants_owner_name ON inference_grants(owner_email, name);
