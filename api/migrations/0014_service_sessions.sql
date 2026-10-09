-- Fixed sandbox.bayleaf.dev login transactions and opaque management sessions.
-- Never store raw verifiers, authorization codes, sessions, or provider keys.
CREATE TABLE service_login_flows (
  id TEXT PRIMARY KEY,
  verifier_hash TEXT NOT NULL,
  broker_hash TEXT,
  stage TEXT NOT NULL CHECK(stage IN ('started', 'bound', 'proved', 'issued')),
  code_hash TEXT,
  email TEXT,
  name TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX service_login_flows_expiry ON service_login_flows(expires_at);
CREATE TABLE service_sessions (
  session_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX service_sessions_expiry ON service_sessions(expires_at);
