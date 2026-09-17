-- Strongly consistent, short-lived state for the browser-mediated device flow.
-- Rows are deleted on delivery and lazily pruned after their 10-minute expiry.
-- The API token itself remains only in user_keys; this table stores approval state.
CREATE TABLE claim_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  client TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  initiator_ip TEXT,
  initiator_country TEXT,
  approved_by TEXT,
  curl_platform TEXT CHECK (curl_platform IN ('windows', 'unix') OR curl_platform IS NULL)
);

CREATE INDEX idx_claim_codes_expires_at ON claim_codes(expires_at);
