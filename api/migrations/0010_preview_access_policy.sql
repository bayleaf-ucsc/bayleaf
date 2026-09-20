-- Existing BayLeaf previews were all owner-authenticated. Record the policy so
-- new Lathe registrations can require either public or private enforcement.
ALTER TABLE preview_registrations
ADD COLUMN access TEXT NOT NULL DEFAULT 'private'
CHECK (access IN ('public', 'private'));
