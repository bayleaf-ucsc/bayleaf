# BayLeaf Inboxes: design contract (proof of concept)

Implementation of [issue #97](https://github.com/bayleaf-ucsc/bayleaf/issues/97).
**Status: operator-only webhook qualification deployed on 2026-10-20.**
API access is restricted to the operator's account generation. Email and webhook
delivery have been exercised; email sender authentication and campus rollout are
not enabled. See `QUALIFICATION.md` for evidence and remaining gates.

BayLeaf Inboxes give an owner opaque addresses that receive email or HTTP
requests while every client, sandbox and agent is off. Reception stores bounded
data. It never triggers inference, tool execution, forwarding or a reply.

This file is the contract shared by the inbox Worker (`inbox/src/worker.js`), its
tests (`inbox/test/`) and the API facade (`api/src/routes/inboxes.ts`). Change the
contract here first.

## Shape

```text
external sender ──► Email Routing catch-all ──► inbox Worker email()      ─┐
external sender ──► https://{nonce}.bayleaf-inboxes.dev ──► inbox fetch() ─┤─► D1 (metadata) + R2 (bytes)
owner client ──► api.bayleaf.dev /inboxes/* ──► service binding RPC ───────┘
```

- `inbox/` is a separate Worker, `bayleaf-inboxes`, with its **own** D1
  (`bayleaf-inboxes`) and R2 bucket (`bayleaf-inboxes`). It shares no storage with
  the inference API.
- Reception surfaces are the `email()` handler and the `fetch()` handler for
  `*.bayleaf-inboxes.dev`. The apex has a public explanation; it has no owner/read HTTP API.
- Owner operations are the `InboxManagement` `WorkerEntrypoint` RPC class, reachable
  only through the API Worker's service binding `INBOXES`.
- **Owner identity is the API's `user_keys.account_generation`**, passed as the
  first argument to every RPC method. It is opaque, survives key rotation, and
  changes when an account is retired and recreated. The inbox Worker never sees a
  CruzID or email address. The RPC trusts this argument because only the API is bound.
- Inbox-only use never provisions inference credentials or consumes inference budget.

## Domain and addresses

- `INBOX_DOMAIN` (var, default `bayleaf-inboxes.dev`).
- Nonce: 26 characters of lowercase RFC 4648 base32 (`a-z2-7`), from 16 bytes
  (128 bits) of `crypto.getRandomValues`. Hostnames are case-insensitive and DNS
  labels are limited to 63 characters.
- `email` inbox address: `{nonce}@{INBOX_DOMAIN}`.
- `http` inbox URL: `https://{nonce}.{INBOX_DOMAIN}/`. The full path and query
  belong to senders. Nothing is reserved on inbox hosts.
- Every inbox gets a fresh independent nonce. Addresses are never reused or
  reassigned. With 128-bit random values no tombstone table is needed. An unknown or
  destroyed address behaves exactly like one that never existed.
- **Addresses are not secrets.** Hostnames are visible in DNS and TLS SNI, and email
  addresses pass through every relay. Credentials (HTTP only) are the gate. Use only
  the wildcard certificate, never per-host certificates (Certificate Transparency).
- Separate internal handles: inbox `ibx_` + nonce-format random, message `msg_` +
  random, credential `cred_` + random. Handles are useless without owner authority.

## Diagnostic web revision (#113 and #97, deployed)

The public apex explains the operator-only pilot and links to
`https://api.bayleaf.dev/diagnostics/inboxes`. Owner diagnostics live on the API
identity origin, reusing its host-only browser session and exact account generation.
They preserve `INBOXES_ENABLED`, binding presence and `INBOXES_PILOT_OWNER` gates.
Only existing read RPCs are used: at most ten inboxes and five recent unexpired
receipts per inbox, including archived receipts. Counts can include pending or
cleanup work. The rendered view excludes subjects, senders, headers, paths,
credentials, bodies and attachments. Receipt addresses are text, not clickable
delivery links. No new browser mutation or message-content API is introduced.
Read-only inspection does not provision inference credentials or wake compute.

The receiver's `BROWSER_ARRIVALS_ENABLED=true` independently gates apex `/`
arrival instrumentation. Receipt hosts and all their paths remain reception-only:
GET/HEAD still capture deliveries; unknown/destroyed URLs still answer identical
JSON errors. Never instrument those URLs. `/llms.txt` is apex-only plaintext
discovery, not a reserved receipt-host path. Deployment and collection activation
were explicitly approved; actual browser readback passed. See
`../telemetry/qualification/diagnostics.md` for versions, real owner-login evidence
and the unresolved private-preview navigation check. The operator-only service
pilot is unchanged.

## Inbox types

An inbox has exactly one immutable `type`: `email` or `http`. Credentials exist
only on `http` inboxes; credential RPCs on an `email` inbox return `not_found`.

## Data model (D1, `inbox/migrations/0001_inboxes.sql`)

```sql
inboxes(
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,                 -- API account_generation
  type TEXT NOT NULL CHECK (type IN ('email','http')),
  nonce TEXT NOT NULL UNIQUE,          -- local part or host label
  label TEXT,                          -- optional owner label, <= 64 chars
  state TEXT NOT NULL CHECK (state IN ('active','destroying')),
  created_at INTEGER NOT NULL,         -- UTC epoch seconds everywhere
  destroy_requested_at INTEGER,
  auth_required INTEGER NOT NULL DEFAULT 0, -- http: sticky once first credential is added
  bytes_stored INTEGER NOT NULL DEFAULT 0,  -- includes pending reservations
  message_count INTEGER NOT NULL DEFAULT 0, -- includes pending reservations
  day TEXT NOT NULL DEFAULT '',        -- UTC YYYY-MM-DD of day_count
  day_count INTEGER NOT NULL DEFAULT 0
)
messages(
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','stored','deleting')),
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,         -- received_at + RETENTION_SECONDS
  archived INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL,               -- exact stored byte length
  meta_json TEXT NOT NULL,             -- bounded type-specific metadata, below
  search_text TEXT NOT NULL DEFAULT '' -- bounded, lowercased
)
credentials(
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bearer')),  -- 'jwk' is the planned next slice
  name TEXT NOT NULL,
  hint TEXT NOT NULL,                  -- last 4 characters of the token
  secret_hash TEXT NOT NULL UNIQUE,    -- lowercase hex SHA-256 of the full token
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                  -- NULL = until revoked
  last_used_at INTEGER                 -- coalesced, at most one write per hour
)
```

Indexes: `inboxes(owner)`, `messages(inbox_id, state, received_at DESC, id DESC)`,
`messages(state, expires_at)`, `credentials(inbox_id)`.

`cleanup_prefixes(inbox_id TEXT PRIMARY KEY, cursor TEXT, turn INTEGER)` stores
opaque inbox identifiers and reconciliation progress, without owner, address or
content. Records survive removal of inbox/message rows and empty object listings
indefinitely. This is an explicit deletion residual and a metadata-growth cost,
not immediate erasure of every trace.

R2 object key per message: `m/{inbox_id}/{message_id}`. That is one object per
message holding the exact received bytes: raw MIME for email, the exact request body
for HTTP. There is no second content store. Email attachments are extracted from the
raw MIME on demand.

## Limits (vars, all integers; defaults shown)

| Var | Default | Meaning |
|---|---|---|
| `RETENTION_SECONDS` | 7776000 | 90 days from receipt. Archive/read never extend it. |
| `MAX_INBOXES_PER_OWNER` | 10 | Active plus destroying inboxes. |
| `MAX_CREDENTIALS_PER_INBOX` | 20 | |
| `MAX_HTTP_BODY_BYTES` | 10485760 | 10 MiB. |
| `MAX_EMAIL_BYTES` | 26214400 | 25 MiB raw, the platform maximum. |
| `MAX_INBOX_BYTES` | 209715200 | 200 MiB stored per inbox. |
| `MAX_OWNER_BYTES` | 524288000 | 500 MiB stored per owner across inboxes. |
| `MAX_INBOX_MESSAGES` | 5000 | Stored messages per inbox. |
| `MAX_DAILY_RECEIPTS` | 1000 | Accepted receipts per inbox per UTC day. |
| `MAX_SEARCH_TEXT` | 32768 | Characters of indexed text per message. |
| `DESTROY_QUIESCE_SECONDS` | 900 | See destruction below. |

Burst limits use the Workers Rate Limiting binding (approximate and counted per data
center; the D1 quota is the real cap):

- `ACCEPT_LIMIT`, keyed by inbox id: 60 per 60 s for receipts that passed
  authentication (or open inboxes).
- `REJECT_LIMIT`, keyed by inbox id: 30 per 60 s for failed authentication. Kept
  separate so that someone who knows a closed inbox's URL cannot exhaust its
  legitimate senders' budget.

If a rate-limit binding is missing, reception fails closed with 503 (misconfiguration).

## Feature flag

`INBOXES_ENABLED` must be exactly `"true"`. Otherwise `fetch()` returns 503 on inbox
hosts, `email()` calls `setReject("Inbox service unavailable")`, and every RPC
returns `{ error: 'disabled' }`.

## HTTP reception (`fetch`)

Host handling (lowercased, port stripped):
- Apex `INBOX_DOMAIN`: `/` GET/HEAD serves a public HTML explanation, with a link
  to API-hosted owner diagnostics. `/llms.txt` remains plaintext. Other paths or
  methods return 404. These static pages remain available when reception is disabled.
- `{label}.{INBOX_DOMAIN}` with a single label: inbox host. Deeper names, other hosts → 404.

Inbox host, in order (cheap checks first):
1. `OPTIONS` → 204 CORS preflight, not captured: `Access-Control-Allow-Origin: *`,
   `Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE`,
   `Access-Control-Allow-Headers`: echo the request's
   `Access-Control-Request-Headers` (bounded to 1024 chars) or `Authorization, Content-Type`,
   `Access-Control-Max-Age: 86400`. Returned for any host label without a lookup.
2. Look up an **active `http`** inbox by nonce. Missing, `destroying`, or `email` type
   → 404 `{"error":"not_found"}`.
3. An inbox starts **open**. Creating its first credential sets a persistent
   `auth_required` flag, making it **closed**. Revoking or expiring the last
   credential never reopens it: closed with no usable credentials denies all
   arrivals until the owner creates a replacement. There is no reopen operation in
   this slice. The request must carry
   `Authorization: Bearer <token>` (RFC 6750; scheme case-insensitive) whose SHA-256
   matches a credential on **this inbox** that has not expired.
   - Missing header → 401, `WWW-Authenticate: Bearer realm="bayleaf-inbox"`.
   - Present but invalid/expired → 401,
     `WWW-Authenticate: Bearer realm="bayleaf-inbox", error="invalid_token"`.
   - Each failure calls `REJECT_LIMIT`. If that limit is exceeded, return 429 instead,
     with `Retry-After: 60`.
   - Expired credentials are treated as invalid, not deleted at that moment.
   - Authentication is rechecked atomically at quota reservation after the body is
     read, so slow uploads cannot bypass closure, revocation or expiry.
4. `ACCEPT_LIMIT` exceeded → 429, `Retry-After: 60`.
5. `Content-Length` larger than `MAX_HTTP_BODY_BYTES` → 413 without reading. Then read
   the body with a running byte count. Exceeding the cap mid-stream → 413.
6. Reserve quota and insert a `pending` row atomically (below). Daily count exceeded →
   429 `Retry-After` = seconds until the next UTC midnight. Bytes or message count
   exceeded → 507 `{"error":"inbox_full"}`.
7. Put the R2 object, then mark the row `stored`. Storage failure → 503 (senders
   retry); the pending row is cleaned up by the stale-pending sweep or deleted inline.
8. Respond **200** `{"ok":true}`, plus `Access-Control-Allow-Origin: *`. The
   response is fixed and never user-programmable. `HEAD` gets 200 with no body.

All methods except `OPTIONS` are captured, including `GET`/`HEAD` (some providers
verify URLs that way). Link scanners and chat-app link previews will create receipts,
and the rate limits and quotas bound them.

HTTP `meta_json`:
```json
{ "type":"http", "method":"POST", "path":"/github/push", "query":"a=1",
  "headers":[["content-type","application/json"], ...],
  "content_type":"application/json", "credential":{"id":"cred_…","name":"alice"} | null }
```
- Headers are kept in the order the Workers `Headers` iterator yields them (names
  lowercased and sorted, repeated headers combined; exact wire order is not
  available), with a total cap of 16 KiB
  (truncated with `"headers_truncated":true`).
- **Dropped:** `cf-*`, `x-forwarded-for`, `x-real-ip`, `true-client-ip`, `cdn-loop`,
  `x-forwarded-proto`. BayLeaf does not deliberately extract/store a sender network
  address. Exact payloads can still contain personal data and IP addresses: raw
  MIME includes sender/provider headers such as `Received`, and HTTP bodies,
  query strings or other headers may contain addresses or credentials. Redaction
  of three known headers is not a general secret scrubber. Do not put write tokens
  in URLs; they would be retained as part of the captured query/path.
- **Redacted to `[redacted]` value:** `authorization`, `proxy-authorization`, `cookie`.
  The scheme word is kept for authorization (for example `Bearer [redacted]`).
- Provider signature headers (for example `x-hub-signature-256`) are kept, so a reader
  can verify signatures later against the exact stored body. BayLeaf does not verify
  provider-specific HMAC schemes.
- `search_text` = lowercased `method path?query` + a header line, plus the body decoded as
  UTF-8 when `content-type` is textual (`text/*`, `*json*`, `*xml*`,
  `application/x-www-form-urlencoded`), truncated to `MAX_SEARCH_TEXT`.

## Email reception (`email(message, env, ctx)`)

1. Recipient = `message.to` (the **envelope** recipient), lowercased. Domain must equal
   `INBOX_DOMAIN` exactly, and the local part must match an active `email` inbox
   nonce exactly (no plus-address stripping in v1). Otherwise
   `setReject("5.1.1 Address not found")`. MIME `To`/`Cc` headers never route.
2. `message.rawSize > MAX_EMAIL_BYTES` → `setReject("5.3.4 Message too large")`.
3. `ACCEPT_LIMIT` exceeded → `setReject("4.7.0 Rate limited, try later")`. Note:
   Cloudflare documents `setReject` as a **permanent** SMTP error regardless of the
   text. Qualification on a disposable domain must confirm actual sender behavior.
4. Read the raw bytes (`new Response(message.raw).arrayBuffer()`), bounded by
   `MAX_EMAIL_BYTES`. Parse with `postal-mime`. A parse failure still stores the raw
   bytes, with `"parse_error": true` and minimal metadata.
5. Reserve and insert pending (same as HTTP). Over quota →
   `setReject("5.2.2 Mailbox full")`.
6. Put R2, mark stored. On a storage failure, **throw** (do not call `setReject`), so
   the platform's failure behavior applies. Whether that yields a temporary SMTP
   failure is a qualification item.

Email `meta_json`:
```json
{ "type":"email", "envelope_from":"…", "envelope_to":"…",
  "from":{"address":"…","name":"…"} | null, "to":[…], "cc":[…], "reply_to":[…],
  "subject":"…", "date":"ISO-8601|null", "message_id":"…", "in_reply_to":"…",
  "authentication_results":["…"],
  "attachments":[{"index":0,"filename":"a.pdf","mime_type":"application/pdf",
                  "size":1234,"disposition":"attachment","content_id":null}],
  "parse_error": false }
```
- Strings are bounded: subject ≤ 998 chars, each address/name ≤ 320, each list ≤ 50
  entries, `authentication_results` ≤ 10 values of ≤ 2048 chars, attachments ≤ 200
  entries (with `"attachments_truncated": true` beyond that).
- `authentication_results` holds the verbatim `Authentication-Results` header values
  (RFC 8601) as Cloudflare adds them. BayLeaf records them and makes no policy from them.
- Header `From` is untrusted sender-controlled content, not an identity.
- `search_text` = lowercased subject, from, to, plus the text body (or the HTML with tags
  stripped crudely), truncated to `MAX_SEARCH_TEXT`.

## Atomic reservation (shared by both transports)

One `DB.batch` (a single transaction):
1. `INSERT INTO messages (...) SELECT ... FROM inboxes i WHERE i.id=? AND i.state='active'
   AND i.bytes_stored + :size <= MAX_INBOX_BYTES
   AND i.message_count + 1 <= MAX_INBOX_MESSAGES
   AND (i.day <> :today OR i.day_count < MAX_DAILY_RECEIPTS)
   AND (SELECT COALESCE(SUM(bytes_stored),0) FROM inboxes WHERE owner=i.owner) + :size <= MAX_OWNER_BYTES`
   with `state='pending'`.
2. `UPDATE inboxes SET bytes_stored=bytes_stored+:size, message_count=message_count+1,
   day_count=CASE WHEN day=:today THEN day_count+1 ELSE 1 END, day=:today
   WHERE id=? AND EXISTS (SELECT 1 FROM messages WHERE id=:msg)`.

If the insert changed zero rows, diagnose with a follow-up read. Inactive → 404 or
reject. Daily → 429. Otherwise full → 507. Reservation counters are decremented
whenever a message row is removed (expiry, deletion, stale pending), in the same batch
as the row deletion.

## Lifecycle and cleanup

States: message `pending → stored → deleting → (row removed)`. Only `stored` rows with
`expires_at > now` are visible to any read, search, or attachment download. **Reads
hide expired content immediately, even before cleanup runs.**

Removing a message (any cause): set `state='deleting'` (it is hidden at once), delete
the R2 object (idempotent), then in one batch delete the row and decrement
`bytes_stored` and `message_count`. If the R2 delete fails, the row stays `deleting`
and the sweep retries.

**Inbox destruction** (`destroyInbox`):
1. Set `state='destroying'`, `destroy_requested_at=now`. From this moment reception
   returns not-found, and the inbox and all its messages and credentials are invisible
   to reads, except `getInbox`/`listInboxes`, which report `state:"destroying"`.
   Credentials are deleted immediately in the same batch.
2. Delete message objects and rows in bounded batches (inline, best effort, plus the sweep).
3. **Finalize** only when (a) no message rows remain, (b) an R2 list of the prefix
   `m/{inbox_id}/` returns no objects (orphan reconciliation), and (c)
   `now >= destroy_requested_at + DESTROY_QUIESCE_SECONDS`. That is longer than any
   reception attempt, so no receiver that saw the inbox as active can still write.
   Receivers check elapsed time before their R2 put and abort if they have exceeded
   `DESTROY_QUIESCE_SECONDS / 3`. This check alone does not fence a delayed remote
   write: durable cleanup tracking must survive removal of message and inbox rows,
   and the sweep must reconcile late objects even after finalization. Opaque
   cleanup handles are disclosed residuals, never evidence that every trace has
   vanished. Then delete the inbox row. After that, every owner RPC returns
   `not_found`.
4. The RPC returns `{ state: 'destroying' }`. It never claims completion early. Completion
   is observable as `not_found`.

**Scheduled sweep** (`scheduled`, cron `*/15 * * * *`), each step bounded per run (at most
50 items per statement; D1 allows 100 bound parameters per statement):
- Expire: stored rows with `expires_at <= now` → removal path.
- Stale pending: pending rows older than `DESTROY_QUIESCE_SECONDS` → removal path.
- Retry `deleting` rows.
- Continue destroying inboxes, then finalize eligible ones.
- Reconcile up to 50 cleanup prefixes with up to 50 objects per prefix each run.
  Persist pagination and round-robin progress so old prefixes cannot starve later
  ones. Remove orphan objects but preserve ones with live pending/stored message
  rows. Never discard cleanup tracking just because a listing is empty: a remote
  put that was already in flight can finish later.

No content, address, nonce, or credential is ever logged. The sweep may log only counts.

## RPC: `InboxManagement` (WorkerEntrypoint)

Every method is `async method(owner: string, ...args)`. It validates every input
(unknown keys rejected, types and lengths checked) and returns plain JSON objects.
It **never throws to the caller**: errors are returned as `{ error: code }` with
`code` ∈ `disabled | invalid | not_found | limit | conflict | unavailable`.
`owner` must match `/^[A-Za-z0-9-]{16,128}$/`, else `invalid`. Every lookup is scoped
`WHERE owner=?`. Another owner's handle is indistinguishable from a missing one
(`not_found`).

Inbox object:
```json
{ "id":"ibx_…", "type":"email|http", "label":"…"|null, "state":"active|destroying",
  "address":"nonce@domain" /* email only */, "url":"https://nonce.domain/" /* http only */,
  "created_at":0, "usage":{"bytes":0,"messages":0,"receipts_today":0},
  "limits":{"bytes":…,"messages":…,"daily_receipts":…}, "closed": true|false /* http only */ }
```

| Method | Args | Returns |
|---|---|---|
| `createInbox` | `{type, label?}` | inbox (`limit` past `MAX_INBOXES_PER_OWNER`) |
| `listInboxes` | – | `{ inboxes:[inbox], owner_usage:{bytes, limit_bytes} }` |
| `getInbox` | `inboxId` | inbox |
| `destroyInbox` | `inboxId` | `{ id, state:'destroying', cleanup_not_before }` (idempotent while destroying) |
| `listMessages` | `inboxId, {cursor?, limit?, q?, archived?}` | `{ messages:[summary], next_cursor: string|null }` |
| `getMessage` | `inboxId, messageId` | message (summary + full `meta`) |
| `getMessageBody` | `inboxId, messageId` | `Response` (exact bytes; `Content-Type` is `message/rfc822` for email, the stored content type or `application/octet-stream` for http; `Content-Length`) or `{error}` |
| `getAttachment` | `inboxId, messageId, index` | `Response` (decoded attachment bytes, its `mime_type`, `Content-Disposition: attachment; filename*=UTF-8''…`) or `{error}`. Email only. |
| `getMessageText` | `inboxId, messageId` | `{ id, type, source, text, truncated }` JSON, below |
| `setArchived` | `inboxId, messageId, archived:boolean` | message summary |
| `deleteMessage` | `inboxId, messageId` | `{ id, deleted:true }` once the object is gone and the row removed; `{ id, state:'deleting' }` if the R2 delete failed (retried by the sweep) |
| `createCredential` | `inboxId, {name?, expires_at?}` | `{ credential, token, inbox_closed:true, notice }` (http only; `token` is returned **once**; notice explains sticky authentication) |
| `listCredentials` | `inboxId` | `{ credentials:[credential] }` |
| `revokeCredential` | `inboxId, credentialId` | `{ id, revoked:true }` (hard delete) |

- `listMessages`: `limit` 1–100 (default 50). Order is `received_at DESC, id DESC`.
  `cursor` is opaque base64url of `received_at:id`. `archived`: `false` (default, the
  inbox view), `true`, or `"all"`. `q`: 1–200 chars, case-insensitive substring match
  against `search_text` using `LIKE ? ESCAPE '\'` with `%`, `_` and `\` escaped. Search
  covers only the bounded indexed text.
- Message summary: `{ id, inbox_id, type, received_at, expires_at, archived, size,
  preview }`. Email `preview`: `{from, subject, attachments:n}`. HTTP `preview`:
  `{method, path, content_type, credential_name}`.
- Credential object: `{ id, kind:'bearer', name, hint, created_at, expires_at,
  last_used_at }`. There is never any way to read a token back.
  Lose it and revoke it, then create another.
- Bearer token format: `sk-bayleaf-inbox-` + 64 lowercase hex characters (32 random
  bytes). `hint` = last 4 characters. `name` defaults to `token-<4 hex>`; ≤ 64
  printable characters. `expires_at`, when given, must be in the future and ≤ now + 1
  year.
- `getMessageText` gives agents and scripts readable text without a MIME parser:
  at most `MAX_TEXT_CHARS` (default 262144) characters, `truncated` true when cut.
  Email: `source:'text'` (the postal-mime text part), else `'html'` (HTML with tags
  stripped and `&amp; &lt; &gt; &quot; &#39; &nbsp;` decoded), else `'none'` with
  empty text; a `parse_error` message is `'none'`. HTTP: `'body'` (UTF-8 decode,
  replacement characters allowed) when the stored content type is textual by the
  `search_text` rule, else `'none'`. Nothing referenced by the content is fetched.
- Reads never extend retention, mark anything read, or archive.
- Destroy responses and destroying inbox views include `cleanup_not_before`, UTC
  epoch seconds for earliest finalization, not a deadline. Default quiescence is
  15 minutes; the next 15-minute scheduled sweep attempts finalization. Backlog or
  failures can take longer. A later GET returning 404 confirms live-resource
  removal, not destruction of provider history or opaque cleanup metadata.

### Clarifications from implementation

- `DESTROY_QUIESCE_SECONDS` may be `0` (tests only); every other limit must be a
  positive integer or the default applies. Receivers abort once elapsed whole
  seconds exceed a third of it, so production must keep it large.
- With `INBOXES_ENABLED` off, every inbox host (including `OPTIONS`) answers 503;
  the apex text page still answers.
- A missing rate-limit binding makes HTTP reception answer 503 and email reception
  throw (the platform failure path, not `setReject`).
- Email past the daily receipt cap is rejected with `5.2.2 Mailbox full`, like other
  quota failures.
- If a receiver's pending row vanished because the inbox was destroyed meanwhile, the
  receiver deletes its own object and answers as for an unknown address.
- Redaction keeps the scheme word only for `authorization` (`Bearer [redacted]`);
  `proxy-authorization` and `cookie` become `[redacted]`.
- HTTP bodies carry a sender-chosen content type, so owner-facing downloads must be
  inert: the API forces `Content-Disposition: attachment`, `X-Content-Type-Options:
  nosniff` and `Content-Security-Policy: sandbox`.
- Agent-facing adapters present message text as untrusted data, never as
  instructions, and never let reception trigger an agent.
- HTML-to-text conversion is a linear scan over at most
  `min(8 × output limit, 2097152)` input characters with bounded output. Truncation
  reporting is conservative when input is cut. This is not an HTML renderer.

## Aggregate operational telemetry

The existing private metrics collector accepts fixed 15-minute counts for
receipt decisions, inbox lifecycle and scheduled cleanup. No owner/inbox ids,
addresses, paths, content, network identifiers or raw errors enter those records.
Counting is best effort, never billing/delivery accounting. Dedicated source
write authority cannot read telemetry; local export is bounded and expires after
24 hours, while collector observations expire within 90 days of window end.
The exact contract and qualification are in
[`telemetry/qualification/inboxes.md`](../telemetry/qualification/inboxes.md).
Telemetry failures never change reception results or disable ordinary expiry.

## Not in this proof of concept

JWT signers (the planned next slice: owner-registered public JWK, `aud` = inbox URL,
`exp` required, EdDSA/ES256 only, RFC 7638 thumbprint as hint, per-signer revocation);
live event streams; plus-addressing; multipart parsing on read; account-retirement
integration; exports; any sending.

## Gates before enablement

- Qualify real SMTP outcomes on the domain, including `setReject` permanence and
  thrown-exception behavior, Bcc, and envelope-vs-header mismatches.
- Measure memory and CPU for near-25 MiB email with many parts.
- Account retirement must destroy the owner's inboxes. The API's 18-month reaper does
  not yet call the inbox service.
- Privacy, retention and subprocessor disclosures (`PRIVACY.md`, `api/RETENTION.md`)
  updated before any user-content pilot. Inboxes intentionally store content, so this
  is a separate retention/access boundary from the content-free inference proxy:
  ZDR does not apply, and the operator can technically read stored mail.
- D1 Time Travel keeps 30 days of database history (Paid). Verified live-store deletion
  is the promise; provider recovery history is a disclosed residual.
