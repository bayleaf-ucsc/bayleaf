-- API has no Chat-style admin roles or groups. Explicit operator exemptions and
-- records holds are independent of credential validity; only exact zero opts in.
ALTER TABLE users ADD COLUMN retention_exempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN retention_hold INTEGER NOT NULL DEFAULT 0;

-- Atomically detach credentials when retiring an account, then retry upstream
-- revocation. No owner identity or ordinary BayLeaf token is kept in this outbox.
CREATE TABLE user_retention_outbox (
  id TEXT PRIMARY KEY,
  or_key_hash TEXT,
  tinfoil_key TEXT,
  created_at INTEGER NOT NULL
);
