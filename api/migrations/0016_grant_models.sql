-- Apply as one atomic D1 migration. Production was read-only verified empty
-- on 2026-10-13, but require BOTH tables to remain completely empty at execution.
-- A CHECK failure aborts before either old table is dropped. Never clear rows
-- to satisfy this precondition: wait for cleanup/revocation and recheck instead.
CREATE TABLE grant_models_empty_assertion (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
);
INSERT INTO grant_models_empty_assertion (row_count)
SELECT (SELECT COUNT(*) FROM inference_grants) + (SELECT COUNT(*) FROM grant_transactions);
DROP TABLE grant_models_empty_assertion;

DROP TABLE inference_grants;
CREATE TABLE inference_grants (
  id TEXT PRIMARY KEY,
  name TEXT,
  owner_email TEXT NOT NULL REFERENCES user_keys(email),
  owner_token_hash TEXT NOT NULL,
  models_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  client_name TEXT,
  redirect_uri TEXT
);
CREATE INDEX inference_grants_owner ON inference_grants(owner_email, expires_at);
CREATE INDEX inference_grants_expiry ON inference_grants(expires_at);
CREATE UNIQUE INDEX inference_grants_owner_name ON inference_grants(owner_email, name);

DROP TABLE grant_transactions;
CREATE TABLE grant_transactions (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  models_json TEXT NOT NULL,
  lifetime INTEGER NOT NULL,
  challenge TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  code_hash TEXT UNIQUE,
  owner_email TEXT,
  owner_token_hash TEXT,
  grant_expires_at INTEGER
);
CREATE INDEX grant_transactions_expiry ON grant_transactions(expires_at);
