-- Sandbox-file scopes (SCOPES.md): folder names under /home/daytona/bayleaf-apps/ an app
-- token may read or write. NULL binds no folders. Apps name them at authorization.
ALTER TABLE inference_grants ADD COLUMN sandbox_dirs_json TEXT;
ALTER TABLE grant_transactions ADD COLUMN sandbox_dirs_json TEXT;
