-- Record the initiating network of a device claim so the approval page can
-- compare it with the approver's (claim phishing defence, routes/claim.tsx).
-- Both columns come from Cloudflare's edge (request.cf.asn, asOrganization).
-- Nullable: rows created before this migration, local dev, and edges that
-- omit the fields all fall back to the "unknown" comparison.
ALTER TABLE claim_codes ADD COLUMN initiator_asn INTEGER;
ALTER TABLE claim_codes ADD COLUMN initiator_network TEXT;
