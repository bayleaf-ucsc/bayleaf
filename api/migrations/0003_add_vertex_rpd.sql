-- Add vertex usage tracking columns to the user_keys table
ALTER TABLE user_keys ADD COLUMN vertex_rpd_count INTEGER DEFAULT 0;
ALTER TABLE user_keys ADD COLUMN vertex_rpd_date TEXT DEFAULT '';
