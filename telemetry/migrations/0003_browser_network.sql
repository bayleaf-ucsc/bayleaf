-- Browser-only coarse network location. Never backfill historical addresses.
-- Existing rows retain their original schema/policy versions and become unknown.
ALTER TABLE browser_observations ADD COLUMN network_location TEXT NOT NULL DEFAULT 'unknown'
  CHECK (network_location IN ('campus-network','other-network','unknown'));
