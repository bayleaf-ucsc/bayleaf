# glm-qualification: fresh-agent webhook inbox usability trial (2026-10-20)

Independent fresh-user trial. Started from https://api.bayleaf.dev/llms.txt only.
No repo source, internal design, or qualification docs were read.

## Chronological diary

1. **Orientation.** llms.txt inbox section was self-sufficient: create inbox, issue
   credential, send, list, read, revoke, destroy, all as one curl narrative.
   No OpenAPI lookup needed for orientation. Expectation: smooth run.
2. **Create inbox** `POST /inboxes` `{"type":"http","label":"glm-qualification build reports"}`
   -> 201 with id/url/state/usage/limits in one response. Note: I truncated the id in my
   terminal display; had to keep the raw response in a 0600 temp file to recover it.
3. **Issue sender credential** `POST /inboxes/{id}/credentials` with `expires_at` as
   UTC epoch seconds. First attempt hit my own jq parse error: I had appended
   `curl -w '\nHTTP:%{http_code}'` into the saved JSON file, so the file was
   `{...}\nHTTP:201` and jq/python both refused it. Recovery: split on first newline.
   Lesson: the docs' example silently encourages a debugging flag that poisons saved JSON.
4. **Send webhook** to the receiving URL with `Authorization: Bearer <sender token>` ->
   200 `{"ok":true}`. No message id in the reception response; the id only appears
   when the owner lists messages.
5. **List messages** as owner -> messages array with preview (method, path,
   content_type, credential_name), received_at, expires_at, size. Good.
6. **Read body** (first attempt failed twice for shell reasons: missing `import sys`,
   then empty `$MSG_ID` produced `/messages//body`, which returned the *full HTML
   "Not Found" page* instead of JSON). Retry with the real id -> 200; `/body` returned
   byte-exact original payload; `/text` returned a JSON envelope
   `{id, type, source, text, truncated}` wrapping the derived text.
7. **Credential listing** showed name, hint (last 4), created/expires/last_used_at.
8. **Cleanup sequencing mistake:** I destroyed the inbox before revoking the
   credential (my credid temp file was never written because the step-3 parse crash
   short-circuited the script). After `DELETE /inboxes/{id}` -> 202
   `{"state":"destroying","cleanup_not_before":...}`, credential sub-routes returned
   JSON 404 immediately; a standalone successful credential DELETE was therefore never
   exercised. Sender probe to the receiving URL -> `{"error":"not_found"}` 404.
   Token file deleted; no secret values in any output.

## Ergonomics findings

- 404 response format is inconsistent by path shape, not by resource: malformed
  segments (e.g. `/messages//body`, `/credentials/`) return the generic HTML 404 page;
  well-formed routes return `{"error":{"message":"Not found","code":404}}`. Same status
  code, two body formats; scripts must sniff content type.
- `GET .../messages/{id}/text` is named "text" but returns a JSON envelope, not the
  derived text directly.
- Reception gives no receipt id or echoed metadata; owners learn delivery only by listing.
- `credential_name` in message preview is a good provenance touch.
- Docs' curl examples embed `-w` output alongside saved JSON (easy to misuse verbatim).

## Ranked small improvements

1. Return machine-readable JSON 404s for malformed inbox sub-paths, or document the split.
2. Include a receipt id (or echoed message id) in the reception 2xx body.
3. Rename `/text` to something like `/extracted` or return bare text.
4. Suggest `-o file` (not bare `-w` into a variable) in the docs' capture example.
5. Warn in docs that destroy makes credential routes 404 immediately; revoke first.

## Cleanup status

- Inbox `ibx_wzx4wfryddi4vy45cb4w6dyvaa`: DELETE accepted (202), state `destroying`,
  `closed:true`, `cleanup_not_before` epoch 1792557066. Finalization by the 15-minute
  sweep is pending and unverified this session.
- Sender credential `cred_lshh4yb7iqsaxc6kd2r7j7y2nq`: not individually revoked
  (sequencing error above); unreachable (404) in destroying state and expires within
  ~2 hours regardless. Treat revocation as unverified pending sweep.
- Receiving URL observed closed to a sender probe. No tokens or live URLs committed.
