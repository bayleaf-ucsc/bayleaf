-- Track who initiated the claim (before verification)
ALTER TABLE courses ADD COLUMN claim_email TEXT;
