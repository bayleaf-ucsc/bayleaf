# glm-discovery: docs-only agent-experience review of TTL/SSE/export interfaces (2026-10-21)

Independent discovery review requested for the overnight GLM session. No mutation
traffic, no deployment polling, no live calls against inbox routes: production SSE
was mid-deployment by another agent. Sources: live `https://api.bayleaf.dev/llms.txt`
(no inbox TTL/SSE/export content today), live `docs/openapi.json` (verified: zero
occurrences of `ttl_seconds`, `streamInboxEvents`, `listInboxEvents`, `exportInbox`),
then the uncommitted proposed docs in this worktree (`api/src/routes/llms.ts`,
`api/src/routes/inboxes.ts`, `api/src/schemas.ts`, `api/src/inboxStream.ts`,
`inbox/DESIGN.md`, `api/scripts/qualify-inbox-stream.mjs`) and the `inbox-export`
worktree's diffs. No live usability is claimed; the live trial remains the
post-deployment task in `STREAM.md`.

## Derived workflow (docs-only, assuming all three slices deployed)

1. **Temporary webhook.** `POST /inboxes` with `{"type":"http","preset":"experiment"}`
   (exactly 900 s) or `ttl_seconds` 60–2592000. Response carries `expires_at`.
   Shorten-only via update; no lengthen/remove. Distinct from the 90-day message
   retention. Expiry is execution-time: reads and reception stop at once, state
   becomes `destroying`, cleanup finalizes on the 15-minute sweep.
2. **Guard sender auth.** `POST /inboxes/{id}/credentials` with `name`, `expires_at`
   (UTC epoch seconds). Token shown once, format `sk-bayleaf-inbox-<64 hex>`,
   stored hashed with a last-4 hint. First credential permanently closes reception;
   senders must send `Authorization: Bearer` (401 challenge realm `bayleaf-inbox`).
   Revoking/expiring the last credential never reopens; create a replacement.
3. **Live SSE while self-posting.** Owner opens
   `GET /inboxes/{id}/events/stream` with the owner bearer in `Authorization`
   (optional `?after=now` or `Last-Event-ID`). Server: `retry: 2000`;
   `message.received` frames with `id:` = cursor and JSON
   `{event_id, type, message_id, cursor, created_at}`; `ready` after first catch-up;
   `checkpoint` on head advance across omitted events; `end {reason, cursor?}`.
   With the stream open, POST the receiving URL with the sender token; the arrival
   appears on the same connection. Bounded: 300 s, 1000 events, 512 KiB, four
   subscribers (429 + `Retry-After: 5`), slow readers dropped.
4. **Reconnect with cursor.** Persist `cursor` from data JSON (or `id:` lines) at the
   processing boundary; reconnect with `Last-Event-ID` (explicit `after` wins).
   `lifetime`/`replay_limit` ends: reconnect. Outage: back off, resume, deduplicate
   by inbox/epoch/event_id or message_id. `auth_revoked`/`not_found`: stop.
   `cursor_expired` (terminal frame, or 410 before headers): discard cursor, replay
   the finite feed `/inboxes/{id}/events` without `after`, deduplicate.
5. **Expiry model.** Four clocks: stream lifetime (300 s, reconnectable), inbox TTL
   (endpoint death), message retention (90 days), credential expiry (sender access).
   TTL expiry mid-stream ends the stream as `not_found` (stop) and reconnecting
   returns 404; no TTL-specific terminal reason exists. Cursor itself does not
   expire unless the database epoch changed or history rewound.
6. **Export.** `GET /inboxes/{id}/export` (`?cursor=` resume, `?limit=` 1–100,
   default 50) returns one POSIX tar page: `payloads/{id}.eml|.body` exact bytes,
   `manifests/{first_id}.json` (per-receipt sha256, `next_cursor`, `omitted`),
   `receipts.har` for HTTP pages. Repeat passing the next cursor until absent.
   Single receipt HAR: `GET .../messages/{mid}/har` (email: 400).
7. **Auth roles.** Owner/reader: `sk-bayleaf-…` account key or sandbox credential
   (management, events, stream, export). Sender: `sk-bayleaf-inbox-…` token,
   receiving URL only. `sk-bayleaf-grant-…` temporary tokens and Campus Pass
   cannot touch inboxes at all.

## Concrete discoverability mismatches (ranked)

1. **TTL is invisible where agents will look, and the only "expiry" in the llms.txt
   example is the wrong one.** The llms.txt inbox workflow never mentions
   `ttl_seconds` or `preset:"experiment"`; the OpenAPI field description (good) is
   never pointed to. The example comment `# An expiry is UTC epoch seconds … Omit it
   only for until-revoked access` sits directly after inbox creation and before
   credential issuance, introducing an expiry that names neither resource. Asked to
   "create a temporary webhook" from llms.txt alone, a model builds an *immortal*
   inbox whose *sender credential* expires, after which reception is permanently
   closed: the exact inverse of intent. Minimal fix: after the create example, add
   `# For a temporary endpoint, pass {"preset":"experiment"} (15 minutes) or
   {"ttl_seconds":N}; expires_at is returned. This endpoint lifetime is separate
   from 90-day message retention.` and disambiguate the credential comment
   (`# The credential's expires_at is UTC epoch seconds…`).
2. **Export resume direction is ambiguous.** llms.txt says "Repeat with the
   X-Inbox-Export-Next-Cursor header until it is absent". The header is where you
   *read* the cursor; the next request passes it as the `?cursor=` query parameter.
   A literal reader re-sends it as a request header and loops on page 1. Minimal
   fix: "Pass the value of the response's `X-Inbox-Export-Next-Cursor` header (or
   the manifest's `next_cursor`) as `?cursor=` on the next request; stop when both
   are absent." Ideally show the page-2 curl line.
3. **The llms.txt operations pointer list omits the event operations.** The closing
   list still names only `createInbox`, `createInboxCredential`,
   `listInboxMessages`, `getInboxMessageText` (the export slice adds
   `getInboxMessageHar`/`exportInbox` to the same sentence; neither slice adds
   `listInboxEvents`/`streamInboxEvents`). The prose describes `/events` and
   `/events/stream` but never names their operation IDs, breaking the stated
   llms.txt→OpenAPI contract hop exactly where the operations are new.
4. **Self-post ordering rule is implicit.** Nothing states the safe sequence: open
   the stream, treat `ready`/first catch-up page as the checkpoint, *then* post. A
   model that posts first and then connects with `after=now` will never see that
   arrival (nothing before head is replayed). One sentence fix in llms.txt:
   "Open the stream and wait for the `ready` frame before self-posting, or omit
   `after` to replay earlier arrivals."
5. **SSE frame grammar lives only in `inbox/DESIGN.md`.** The OpenAPI types the 200
   as a bare `text/event-stream` string; its description names frames but not the
   wire serialization (`event:`/`data:`/`id:`/`retry:` lines, JSON data shape), and
   llms.txt names no frames at all. A parser-writing model must hop to the repo
   DESIGN.md to know `ready`/`checkpoint` exist. Minor: the cursor is also in each
   frame's data JSON, so a from-llms.txt client still works.
6. **Token-prefix collision is never spelled out.** Sender tokens
   (`sk-bayleaf-inbox-…`) and account keys (`sk-bayleaf-…`) share the `sk-bayleaf-`
   prefix and no doc names either format. The docs warn against sending the owner
   credential to the receiving URL but not the symmetric error: presenting the
   sender token to `/events/stream` or management routes. Naming both prefixes in
   llms.txt would let a model self-check which role it holds after a confusing 401.
7. **Mid-stream TTL expiry is indistinguishable from revocation.** The terminal
   reason list has no TTL value; an expiring inbox surfaces as
   `end {reason:"not_found"}` then 404, identical to deletion or (for
   `auth_revoked`) key revocation. Behavior is correct (stop), but the TTL prose
   and the stream reason list never connect. One line: "Expiry of the inbox ends an
   open stream with `not_found`; a subsequent read returns 404."

Minor notes: the four-subscriber cap and `Retry-After: 5` appear only in the OpenAPI
description, not llms.txt; `preset:"experiment"` is guessable only from the enum;
the workflow's `--argjson expires` step requires jq (stated, easy to skim past).

## Explicitly not tested / not claimed

- No production request was sent to any inbox route; no deployment state observed.
- Derivations above are from worktree docs and verified-against-source behavior
  (frame shapes from `api/src/inboxStream.ts`, resume semantics from
  `api/src/routes/inboxes.ts`, export pagination from `inbox/src/worker.js` and
  `inbox/DESIGN.md`). Live edge behavior (5-minute lifetime, TTL terminal timing,
  compression/abort propagation) remains the post-deployment live trial in
  `qualification/STREAM.md`, which this report complements rather than replaces.
- No credentials, addresses or received content appear in this report.
