-- Disposable permissions, not an app registry. No inference content is stored.
CREATE TABLE inference_grants (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL REFERENCES user_keys(email),
  owner_token_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  client_name TEXT,
  redirect_uri TEXT
);
CREATE INDEX inference_grants_owner ON inference_grants(owner_email, expires_at);
CREATE INDEX inference_grants_expiry ON inference_grants(expires_at);

CREATE TABLE grant_transactions (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  model TEXT NOT NULL,
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
