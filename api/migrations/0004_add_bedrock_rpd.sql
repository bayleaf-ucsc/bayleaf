-- Add bedrock usage tracking columns to the user_keys table.
-- Mirrors the vertex_rpd columns (0003): Bedrock spend goes to AWS, not
-- OpenRouter, so it is not metered by the OpenRouter dollar budget and needs
-- its own per-key requests-per-day counter (issue #41).
ALTER TABLE user_keys ADD COLUMN bedrock_rpd_count INTEGER DEFAULT 0;
ALTER TABLE user_keys ADD COLUMN bedrock_rpd_date TEXT DEFAULT '';
