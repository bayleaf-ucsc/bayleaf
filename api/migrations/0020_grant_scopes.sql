-- App-token scopes (SCOPES.md). Existing grants and pending authorizations are
-- backfilled with the three inference.* scopes they implicitly held; afterwards
-- NULL fails closed. Rows the previous Worker inserts between this migration and
-- the new deploy also need these UPDATEs: re-run them once after deploying
-- (idempotent).
ALTER TABLE inference_grants ADD COLUMN scopes_json TEXT;
ALTER TABLE grant_transactions ADD COLUMN scopes_json TEXT;
UPDATE inference_grants SET scopes_json = '["inference.chat","inference.responses","inference.decisions"]'
  WHERE scopes_json IS NULL;
UPDATE grant_transactions SET scopes_json = '["inference.chat","inference.responses","inference.decisions"]'
  WHERE scopes_json IS NULL;
