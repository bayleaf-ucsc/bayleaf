-- Account lifetime is independent of ordinary API-key validity. UTC epoch seconds,
-- matching Chat's account clock. Historical last activity is unknown, not rollout time.
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  created_at INTEGER,
  last_active_at INTEGER
);
INSERT INTO users (email, created_at, last_active_at)
SELECT email, CAST(strftime('%s', created_at) AS INTEGER), NULL FROM user_keys;
