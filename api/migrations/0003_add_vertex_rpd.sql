-- Add vertex usage tracking columns to the keys table
ALTER TABLE keys ADD COLUMN vertex_rpd_count INTEGER DEFAULT 0;
ALTER TABLE keys ADD COLUMN vertex_rpd_date TEXT DEFAULT '';
