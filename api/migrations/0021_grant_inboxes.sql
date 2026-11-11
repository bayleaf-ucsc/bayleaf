-- Inbox scopes (SCOPES.md): the inbox handles an app token may read or manage.
-- NULL binds no inboxes. On transactions the visitor chooses inboxes on the
-- consent page, so the column stays NULL until approval.
ALTER TABLE inference_grants ADD COLUMN inboxes_json TEXT;
ALTER TABLE grant_transactions ADD COLUMN inboxes_json TEXT;
