-- Decouple backend provider keys from BayLeaf token issuance (issue #55).
--
-- Before this migration, a user's OpenRouter key was created in the same
-- operation as their `sk-bayleaf-` token, so `or_key_hash`/`or_key_secret`
-- could be NOT NULL: no reachable state had a token without a provider key.
--
-- That coupling does not generalize. BayLeaf now has a second backend needing
-- per-user credentials (Tinfoil, for the Sealed lane), and minting every
-- backend's key at token time would mean (a) a Tinfoil outage blocks
-- OpenRouter provisioning for new users, and (b) every user pays for a Sealed
-- key whether or not they ever use the lane. Backend keys become on-demand:
-- minted the first time a user actually touches that backend, by the same code
-- path that heals a key which has gone missing upstream. "Never had one" and
-- "lost the one they had" are now the same case.
--
-- Consequently the OR columns must be genuinely absent-able, and SQLite cannot
-- drop NOT NULL in place: hence a create/copy/drop/rename rebuild rather than
-- an ALTER. NULL is chosen over an empty-string sentinel so that "no key yet"
-- is one representation across all backends, and so a bug that writes an empty
-- credential is a constraint error rather than a silently absent key.
--
-- The `bayleaf_token` NOT NULL UNIQUE constraint is retained and is now the
-- table's only mandatory credential, which matches the invariant that the
-- token is the identity record and provider keys are caches hanging off it.

-- Rebuild with the accumulated shape of migrations 0001-0004, relaxing only
-- the two OR columns, and adding the Tinfoil pair.
CREATE TABLE user_keys_new (
  email               TEXT PRIMARY KEY,
  bayleaf_token       TEXT NOT NULL UNIQUE,
  or_key_hash         TEXT DEFAULT NULL,
  or_key_secret       TEXT DEFAULT NULL,
  revoked             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  daytona_sandbox_id  TEXT DEFAULT NULL,
  vertex_rpd_count    INTEGER DEFAULT 0,
  vertex_rpd_date     TEXT DEFAULT '',
  bedrock_rpd_count   INTEGER DEFAULT 0,
  bedrock_rpd_date    TEXT DEFAULT '',
  -- Tinfoil (Sealed lane). Note there is deliberately no `tinfoil_key_hash`
  -- analogous to `or_key_hash`: OpenRouter needs a separate management handle
  -- because its admin plane is keyed on an opaque `hash` (GET/DELETE
  -- /keys/{hash}) and never re-reveals a secret after creation. Tinfoil has no
  -- such handle -- verified 2026-07-29 that deletion is
  -- `DELETE /api/keys/{tk_...}`, the secret itself in the path, and that
  -- `GET /api/keys` returns every secret in plaintext. So one column serves
  -- both the inference and management planes here.
  --
  -- The corollary is a security asymmetry worth stating: a leaked Tinfoil admin
  -- key exposes every user's inference credential, while a leaked OpenRouter
  -- provisioning key does not. That makes isolating the Tinfoil admin
  -- credential more important than the OpenRouter one, not less.
  --
  -- `tinfoil_key_name` is stored rather than derived because the out-of-band
  -- billing report indexes spend by key *name*, so this is the join column back
  -- to a user; storing it keeps that join valid even if the name template later
  -- changes.
  tinfoil_key         TEXT DEFAULT NULL,
  tinfoil_key_name    TEXT DEFAULT NULL,
  sealed_rpd_count    INTEGER DEFAULT 0,
  sealed_rpd_date     TEXT DEFAULT ''
);

INSERT INTO user_keys_new (
  email, bayleaf_token, or_key_hash, or_key_secret, revoked, created_at,
  daytona_sandbox_id, vertex_rpd_count, vertex_rpd_date,
  bedrock_rpd_count, bedrock_rpd_date
)
SELECT
  email, bayleaf_token, or_key_hash, or_key_secret, revoked, created_at,
  daytona_sandbox_id, vertex_rpd_count, vertex_rpd_date,
  bedrock_rpd_count, bedrock_rpd_date
FROM user_keys;

DROP TABLE user_keys;

ALTER TABLE user_keys_new RENAME TO user_keys;
