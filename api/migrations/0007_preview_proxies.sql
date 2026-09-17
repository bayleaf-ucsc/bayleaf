-- Stable browser origins are never reassigned to another canonical owner.
CREATE TABLE preview_owners (
  email TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE preview_identities (
  deployment TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL REFERENCES preview_owners(email),
  PRIMARY KEY (deployment, subject)
);

CREATE TABLE preview_registrations (
  hostname TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES preview_owners(email),
  deployment TEXT NOT NULL,
  slot TEXT NOT NULL,
  generation TEXT NOT NULL,
  upstream_encrypted TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (email, slot)
);

CREATE TABLE preview_flows (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  generation TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  broker_hash TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('started', 'bound', 'proved', 'issued')),
  code_hash TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX preview_flow_expiry ON preview_flows(expires_at);
CREATE INDEX preview_registration_expiry ON preview_registrations(expires_at);
