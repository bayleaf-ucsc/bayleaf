-- Existing Tinfoil keys were minted with a lifetime token cap. New keys are
-- unlimited, and existing keys have that cap cleared lazily on their next
-- Sealed request. This marker prevents an admin-plane update on every request.
ALTER TABLE user_keys ADD COLUMN tinfoil_unlimited INTEGER NOT NULL DEFAULT 0;
