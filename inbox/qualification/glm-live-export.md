# GLM independent live export AX trial (2026-10-21 UTC)

Independent, docs-first export trial against the integrated deployment (Inboxes
`a5b7b69f…`, API `b751f1c0…`, collector `ba47b369…`). The client was written from
the public docs alone (`/llms.txt`, `/docs/inboxes.md`, `/docs/openapi.json`), not
by rerunning the fixed smoke; only credential acquisition reuses the reviewed
private-launcher pattern (operator bearer and sender token lived in process memory
only, never printed or written). Honest UA `BayLeafInboxAXClient/1.0` throughout;
the Cloudflare 1010 urllib-UA trap described in `/llms.txt` never fired. Archives
were held in two private per-page directories under the approved temp dir and
deleted after verification; only this report and redacted logs remain.

## Qualifying run: measured results

Live resources (all synthetic, this run only): one http inbox, `ttl_seconds: 600`;
one sender credential, `expires_at` 590 s after issue. `inbox_closed: true`
observed at credential creation. Counts and byte totals below are exact.

- **Receipts posted:** 3 distinct bodies, each with its own path
  (`/hook/alpha|beta|gamma`), query, custom header (`X-Trial-Run: glm-ax-N`),
  plus `Authorization: Bearer` sender token; receipt 1 also carried a `Cookie`.
  Content types: `application/json` (33 B), `text/plain` (26 B),
  `application/octet-stream` (82 B, binary with 0x00–0x3f prefix). All acked
  HTTP 200.
- **Owner usage cross-check:** `usage = {messages: 3, bytes: 141,
  receipts_today: 3}`; 141 = 33 + 26 + 82 exactly.
- **Export pagination (`limit=2`):** page 1 = 200, `application/x-tar`, 12,800
  archive bytes, 4 members (2 `payloads/*.body`, 1 `receipts.har` 5,042 B, 1
  `manifests/msg_*.json` 3,279 B), `Content-Disposition: attachment`,
  `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`,
  `X-Inbox-Export-Next-Cursor` present (58-char opaque value). Page 2 = sent that
  header value as `?cursor=` (query parameter, not a header): 200, tar, 8,192
  bytes, 3 members (1 payload, `receipts.har` 2,747 B, 1 manifest), and no next
  cursor header. The page-1 header value equals the page-1 manifest
  `next_cursor`; the page-2 manifest echoes `cursor` and has `next_cursor: null`.
  Stop-when-absent works as documented.
- **Byte-exactness:** 3/3 payload files' SHA-256 equal the digests of the exact
  bytes sent, computed independently client-side; 3/3 manifest `sha256`+`size`
  entries verified against actual tar member bytes. Receipt `expires_at` =
  `received_at` + 7,776,000 s (90-day retention) on all 3.
- **Preservation in manifest metadata:** paths, full query strings, custom header
  values, `content_type`, and `credential {id, name}` (name `glm-ax-sender`)
  preserved exactly on all 3 receipts; headers stored lowercased as `[name,
  value]` pairs with `_headersNormalized`-equivalent behavior.
- **Redaction:** `authorization` stored as `Bearer [redacted]`, the sent `Cookie`
  as `[redacted]` (only on the receipt that sent one), `_redacted` union =
  `["authorization", "cookie"]`; `_dropped` union = `cf-*`, `x-forwarded-for`,
  `x-real-ip`, `true-client-ip`, `cdn-loop`, `x-forwarded-proto`; no sender-IP
  fields anywhere. Defense in depth: the raw archive bytes of both pages contain
  zero occurrences of any `sk-` token material and zero occurrences of the
  synthetic cookie value.
- **`receipts.har` (nonstandard profile understood):** `log._profile =
  bayleaf-inbox-receipt-1` while `log.version = "1.2"` and creator `BayLeaf
  Inboxes/1`; entries carry `_receiptId`, `_redacted`, `_dropped`, `_observed`,
  `_headersNormalized`, `_timingsUnknown`, `_expectedAcknowledgement`,
  `_expiresAt`, `_archived`, `_credentialName`. Response `status: 0` and `time:
  -1` with all seven timings `-1` on every entry: meaning "unknown, not
  observed", exactly as the docs say, never a wire capture. Per-page entry counts
  2 + 1 track each page's receipts. Text bodies are inlined in `postData.text`
  with a matching `_sha256`; the binary body instead uses `postData._file`.
- **Manual `_file` attachment:** the `_file` reference names a `payloads/*.body`
  member in the same tar; extracting that member and hashing its bytes reproduces
  the sent body's digest (and the declared `_sha256`), so a strict importer that
  ignores `_file` can be satisfied by hand with zero ambiguity.
- **Standalone HAR (`getInboxMessageHar`, live, non-destructive):** 200 for the
  binary receipt; same `_profile`, same `_file` reference and `_sha256` as the
  export page's HAR entry, custom header present, full path+query preserved in
  `request.url`, `authorization` redacted, `status: 0`. Export-derived and
  standalone HAR are consistent.
- **Owner/sender token distinction (non-destructive):** sender token
  (`sk-bayleaf-inbox-…`) on `GET …/messages`, `GET …/export?limit=2` and
  `GET …/credentials` all returned 401 (the export attempt returned a JSON error,
  not a tar); the same routes with the owner key returned 200. Write-only sender
  authority holds.
- **Destruction:** `DELETE` returned 202 with `state: "destroying"` and
  `cleanup_not_before` set; an immediate `GET` still returned 200 with state
  `destroying` (live resource present, as documented). Cleanup was requested;
  physical completion is not proven and was not claimed.

## Iteration ledger (honesty)

Five script iterations produced five trial inboxes total (each `ttl_seconds: 600`,
each with one 590 s sender credential, each destroyed by its own run's `finally`
block with a 202). The three earlier runs crashed on my errors, not the service's:
two parser assumptions (a single `manifest.json` per page, and parsing only page
1's HAR), one omitted bearer on an export call (the resulting 401 body is a clear,
actionable missing-key message that correctly does not leak which routes exist),
and one bad assertion (unpacking HAR header objects as pairs). 15 receipts were
posted in total across runs (3 per run); 8 tar pages were fetched across the four
runs that reached export. All five inboxes are past their TTL backstop and
reported `destroying`; no existing inbox, email policy, key, or deployment was
touched, and no worktree was accessed.

## Docs observations

**Post-trial implementation audit (2026-10-21):** the per-receipt-manifest
interpretation below is incorrect. `exportStream` writes one page manifest at
`manifests/{first_selected_id}.json`, containing every emitted receipt on that
page. The measured four-member first page above (two payloads, HAR, one manifest)
agrees with this. The original observation is retained as AX evidence, not as a
schema contract. The focused guide now documents the actual layout and fields.

- **Accurate and load-bearing:** cursor semantics (header value into the next
  request's `?cursor=`, absent on the final page, distinct from event/SSE
  cursors); `limit` as receipts-per-page 1–100 with byte/metadata budgets and
  at-least-one progress; the `bayleaf-inbox-receipt-1` profile warning with
  status 0 / `-1` semantics and manual `_file` attachment guidance; redaction
  behavior; `inbox_closed` permanence; sender-token write-only role; the urllib
  UA/Cloudflare 1010 trap; destroy as async 202 with `cleanup_not_before`.
- **Minor gap (would have saved two of five iterations):** the OpenAPI types the
  export 200 as opaque binary and the prose says "a manifest" (singular), but the
  real page carries one JSON per receipt under `manifests/{message_id}.json`
  (top-level `format: bayleaf-inbox-export`, `version: 1`, `inbox`, `order:
  received_at_asc`, `cursor`, `next_cursor`, `har`, `receipts[]` with
  `id`/`file`/`received_at`/`expires_at`/`archived`/`size`/`sha256`/`meta`,
  `omitted`). A JSON example of one tar page in `/docs/inboxes.md` (or a schema
  reference) would make docs-first client work single-pass. The tar is
  self-describing, so severity is low.
- **Small nuance worth a phrase in the guide:** text bodies are inlined in HAR
  `postData.text` with `_sha256`; only binary bodies use `_file`. The docs cover
  the `_file` case; stating the split would preempt "where is my JSON body?"
  confusion in GUI-importer work.
- No misleading errors encountered. The 401 missing-key body, the 415/400
  contracts, and the 404 indistinguishability note all behaved as documented.

## Subjective agent experience

As an agent with shell access, the whole flow felt clean and legible: create,
credential, post, page, verify, destroy, with the tar telling me everything once
opened and the service never fighting my client. Secret hygiene is easy because
the one-time token flow and redaction contract keep credentials out of stored
data by construction; verifying "no token material anywhere in the archive" from
raw bytes is a strong, checkable property. The one friction point was
discovering the per-receipt manifest layout by experiment. I finished with high
confidence that a captured HTTP receipt can move losslessly: exact bytes, exact
metadata, honest non-capture markers, and hashes that tie every derived view
back to the canonical payloads.

## Limits

Small synthetic payloads only (the 1 MiB production case was already qualified
elsewhere). No client polling or SSE (out of scope here), no GUI importer test,
no concurrent-isolate stress, sender-token checks were read-only and
non-destructive, and physical D1/R2 cleanup after destruction remains unproven
(requested and TTL-backstopped only). Recorded usage context: this subagent ran
inside a main session at ~1.01 M cumulative tokens; no new permissions or
deploy/commit actions were taken.
