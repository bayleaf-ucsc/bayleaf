-- Account/session authorization is independent of ordinary-key validity.
ALTER TABLE user_keys ADD COLUMN account_generation TEXT NOT NULL DEFAULT '';
UPDATE user_keys SET account_generation = lower(hex(randomblob(32)));

-- Pending/revoked rows are a durable cleanup outbox. Never store the bearer.
CREATE TABLE sandbox_credentials (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES user_keys(email),
  sandbox_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  secret_name TEXT NOT NULL UNIQUE,
  secret_id TEXT,
  placeholder TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','active','revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX sandbox_credentials_live ON sandbox_credentials(email, sandbox_id)
  WHERE state IN ('pending','active');
CREATE INDEX sandbox_credentials_cleanup ON sandbox_credentials(state, updated_at);
