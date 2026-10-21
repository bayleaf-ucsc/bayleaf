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
Only read RPCs are used: at most ten inbox cards and five recent unexpired
receipts per inbox, including archived receipts. Counts can include pending or
cleanup work. The rendered view excludes subjects, senders, headers, paths,
credentials, bodies and attachments. Receipt addresses are text, not clickable
delivery links. No new browser mutation or message-content API is introduced.
Read-only inspection does not provision inference credentials or wake compute.
The quota-discovery revision adds effective owner-capacity meters from `getLimits`,
covering all inboxes without increasing the ten-card/five-receipt view caps.

The receiver's `BROWSER_ARRIVALS_ENABLED=true` independently gates apex `/`
arrival instrumentation. Receipt hosts and all their paths remain reception-only:
GET/HEAD still capture deliveries; unknown/destroyed URLs still answer identical
JSON errors. Never instrument those URLs. `/llms.txt` is apex-only plaintext
discovery, not a reserved receipt-host path. Deployment and collection activation
were explicitly approved; actual browser readback passed. See
`../telemetry/qualification/diagnostics.md` for versions, real owner-login evidence
and the unresolved private-preview navigation check. The operator-only service
pilot is unchanged.

## Endpoint lifetimes

An inbox may carry an explicit endpoint lifetime, `expires_at` (UTC epoch seconds).
It is separate from message retention: `RETENTION_SECONDS` bounds how long each
received payload is kept, while `expires_at` bounds how long the address or URL
exists at all. When the endpoint expires, everything it stored goes with it.

- **Opt-in only.** `createInbox` accepts `ttl_seconds` (integer, 60 to
  `MAX_INBOX_TTL_SECONDS`) or `preset: "experiment"` (exactly 900 s, 15 minutes),
  never both. Without either, `expires_at` is `null`: the inbox lives until
  destroyed. Rows created before migration `0003` have `NULL` and never acquire a
  lifetime implicitly.
- **Shorten, never lengthen.** `updateInbox(inboxId, {ttl_seconds | preset})` sets
  `expires_at = now + ttl` only if that is no later than the current `expires_at`;
  otherwise `conflict`. It may give a lifetime to an inbox that had none (an
  explicit owner action). There is no removal or extension operation: create a new
  inbox instead. Reads, arrivals, credential changes and archive changes never
  touch `expires_at`.
- **Expiry is enforced at database execution.** An inbox is *live* when
  `state='active' AND (expires_at IS NULL OR expires_at > unixepoch())`, using
  SQLite's execution-time clock in whole UTC seconds. Reception lookup, atomic
  reservation, the stored-mark after the R2 put, and owner authorization predicates
  use this clock, separately from recorded receipt timestamps. Content and credential
  lists revalidate after their awaited queries; body, text and attachment reads
  revalidate after awaited storage reads and parsing, before releasing results.
  Checks deny expired resources before any sweep runs. This does not recall bytes
  already released, stop an already-started remote R2 write, or guarantee response
  delivery before the deadline. The transition below deletes credentials.
- **Same destruction path.** The scheduled sweep moves expired active inboxes into
  the destruction transition used by `destroyInbox` (one shared code path), with
  `destroy_requested_at = expires_at`, then continues exactly as for explicit
  deletion: bounded message removal, quiescence, R2 prefix check, finalization and
  indefinite opaque prefix reconciliation. Quiescence counts from `expires_at`
  because that is when receivers stopped seeing the inbox as live.
- **Visible status.** Inbox views always include `expires_at` (`null` when none). An
  inbox past `expires_at` reports `state:"destroying"` and `cleanup_not_before =
  expires_at + DESTROY_QUIESCE_SECONDS` even before the sweep has run the
  transition. Completion is observable as `not_found`, as for explicit destruction.
- Walking away leaves an endpoint denied by subsequent access checks. Physical
  removal follows asynchronously; backlog, outages and late writes can delay it.
  The disclosed residuals of
  explicit destruction still apply (opaque cleanup records, D1 Time Travel and
  provider recovery history).

## Arrival events and live SSE

Migration `0004_events.sql` adds per-inbox `event_seq`, minimal `events`, a random
database `event_feed.epoch`, and expiring `event_streams` leases. Existing stored
messages are backfilled in receipt order. New sequence numbers are assigned in the
same D1 transaction as the stored mark, so commit order, not reservation time,
defines traversal. Failed transactions publish neither a stored receipt nor an
event. Message removal deletes its event; inbox finalization removes residual
events and leases. No event contains sender text, paths, addresses or credentials.

`GET /inboxes/{id}/events` and private RPC `listEvents` return
`{events:[{event_id,type:"message.received",message_id,cursor,created_at}],cursor,more}`.
Optional `limit` is 1–100, default 100. Omit `after` to replay available arrivals;
`after=now` starts at the current head. Cursors encode database epoch, inbox and
sequence. Another inbox's cursor is invalid; foreign epoch or position beyond the
current high-water mark requires resynchronization (HTTP 410). Deletion does not
decrement the high-water mark. Events/head share one snapshot; final liveness and
expiry checks precede release. Empty pages still advance cursors. References do not
promise that a message will remain available when fetched.

`GET /inboxes/{id}/events/stream` is actual authenticated SSE: catch up, emit
`ready`, then follow on the same connection, without client polling. Explicit
`after` overrides `Last-Event-ID`; otherwise replay from the beginning. Frames are
`message.received`, `ready`, `checkpoint`, and terminal `end`, plus keepalive
comments. Save complete event cursors at the client's processing boundary and
deduplicate after reconnect. This is passive observation, never a work queue,
inference trigger or unsolicited agent activation.

The API reauthorizes the actual ordinary/sandbox credential and account generation,
then reads a bounded RPC page every two seconds. The five-second fail-closed target
uses a 4.5-second watchdog. Pilot/feature gates remain in force. Inbox expiry or
destruction ends following; owner revocation, key rotation or generation change
ends authorization. No bearer appears in a URL. Responses use no-store and identity
encoding. The service binding carries JSON pages, not a buffered SSE response.

Atomic D1 leases enforce four subscribers per inbox, with fixed 300-second expiry.
Connections end after at most 300 seconds, 1000 events or 512 KiB. Backpressure
allows one bounded page and a two-second server-observed demand deadline. Edge
buffering can hide a non-consuming client; the 300-second lifetime still bounds
it. Disconnect releases its lease, with fixed expiry as fallback;
the sweep prunes at most 50 expired leases. `after=now` resolves once during lease
acquisition to avoid a handshake gap. API-only test knobs can shorten these limits.

HTTP 429 means subscriber cap, with Retry-After 5. HTTP 410 or terminal
`cursor_expired` requires replay/resynchronization. Terminal `lifetime` and
`replay_limit` permit reconnect; `auth_revoked` and `not_found` mean stop. Outages,
abrupt closes and `unavailable` need bounded backoff/resume. Already delivered
references cannot be recalled. Database restore and runtime replacement require
client reconciliation; this is not an exactly-once guarantee.

Private RPCs `acquireEventStream(owner,id,{after?})`,
`readEventStream(owner,id,leaseId,{after?})` and
`releaseEventStream(owner,id,leaseId)` remain service-binding-only. Leases contain
only id, inbox id and expiry. See `research/STREAM.md` for cost analysis and
`QUALIFICATION.md` for the bounded live recipe and remaining live gates.

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
  expires_at INTEGER,                  -- explicit endpoint lifetime; NULL = none (0003)
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

Indexes: `inboxes(owner)`, `inboxes(state, expires_at)`, `messages(inbox_id, state, received_at DESC, id DESC)`,
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
| `MAX_INBOXES_PER_OWNER` | 100 | Active plus destroying inboxes. |
| `MAX_CREDENTIALS_PER_INBOX` | 20 | |
| `MAX_HTTP_BODY_BYTES` | 10485760 | 10 MiB. |
| `MAX_EMAIL_BYTES` | 26214400 | 25 MiB raw, the platform maximum. |
| `MAX_INBOX_BYTES` | 209715200 | 200 MiB stored per inbox. |
| `MAX_OWNER_BYTES` | 524288000 | 500 MiB stored per owner across inboxes. |
| `MAX_INBOX_MESSAGES` | 5000 | Stored messages per inbox. |
| `MAX_DAILY_RECEIPTS` | 1000 | Accepted receipts per inbox per UTC day. |
| `MAX_SEARCH_TEXT` | 32768 | Characters of indexed text per message. |
| `DESTROY_QUIESCE_SECONDS` | 900 | See destruction below. |
| `MAX_INBOX_TTL_SECONDS` | 2592000 | 30 days: longest explicit endpoint lifetime. |
| `MAX_EXPORT_BYTES` | 104857600 | 100 MiB of payloads per export page, at least one receipt. |
| `MAX_EXPORT_META_BYTES` | 4194304 | 4 MiB of stored metadata JSON per page, at least one receipt. |
| `MAX_HAR_TEXT_BYTES` | 262144 | Per-body HAR text cap, 256 KiB. |
| `MAX_HAR_PAGE_TEXT_BYTES` | 4194304 | Inlined HAR body bytes per page, 4 MiB. |

Burst limits use the Workers Rate Limiting binding (approximate and counted per data
center; the D1 quota is the real cap):

- `ACCEPT_LIMIT`, keyed by inbox id: 60 per 60 s for receipts that passed
  authentication (or open inboxes).
- `REJECT_LIMIT`, keyed by inbox id: 30 per 60 s for failed authentication. Kept
  separate so that someone who knows a closed inbox's URL cannot exhaust its
  legitimate senders' budget.

If a rate-limit binding is missing, reception fails closed with 503 (misconfiguration).

### Runtime limits discovery

Authenticated `GET /inboxes/limits` relays private `getLimits(owner)` before any
inbox exists. It uses the same feature/pilot/owner gates as other reads, returns
`Cache-Control: no-store`, and never provisions inference credentials. Values
come from the receiver's enforcement `limits(env)`, including deployed overrides.
`owner` reports `max_inboxes`, current `inboxes`, `remaining_inboxes`, `max_bytes`,
current `bytes`, `remaining_bytes`, and current `messages`. Counts include active
and destroying rows (including expired endpoints awaiting cleanup); bytes and
messages include pending reservations and cleanup backlog. Remaining capacity is
a snapshot, not a reservation. There is no separate owner message-count cap.
`per_inbox` reports `max_bytes`, `max_messages`, `max_daily_receipts` (UTC day),
and `max_credentials`. `payload` reports `http_max_bytes`, `email_max_bytes`,
`restricted_email_max_bytes` and `restricted_email_creation_enabled`. `lifetime`
reports `min_seconds`, `max_seconds`, `presets_seconds` and
`default_ttl_seconds:null`; `retention_seconds` and `destroy_quiesce_seconds`
describe message retention and earliest destruction finalization. Presets above
the effective TTL maximum are omitted. Units are explicit in field names;
unsuffixed usage/limit fields count resources. Approximate per-data-center burst
rate bindings cannot be introspected by the Worker and are not presented as exact
numeric quotas here. The response contains no identities, addresses or secrets.

## Feature flag

`INBOXES_ENABLED` must be exactly `"true"`. Otherwise `fetch()` returns 503 on inbox
hosts, `email()` calls `setReject("Inbox service unavailable")`, and every RPC
returns `{ error: 'disabled' }`, except the trusted retirement/fencing RPC, which
must remain available to revoke old ownership while exposure is off.

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
2. Look up a **live `http`** inbox by nonce (active and not past `expires_at`).
   Missing, `destroying`, expired, or `email` type → 404 `{"error":"not_found"}`.
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

### Opt-in domain restrictions (deployed, creation disabled)

At creation only, an email inbox may set `email_auth: { domains: ["ucsc.edu"],
selector_pins: { "ucsc.edu": ["chosen_selector"] } }`. Domains are exact ASCII
DNS hostnames, lowercased and unique (1–8); optional pins are nonempty unique
selector lists (1–4 per allowlisted domain), DNS case-insensitive. Selectors allow
underscore labels as an explicit interoperability extension. No wildcards,
mailboxes, public-suffix matching or mutable policy endpoint. HTTP inboxes reject
this field. Omitted/null means **unrestricted**, including every existing inbox.
Owner create/list/get responses explicitly report `email_auth` (null or policy)
and `restricted_email_max_bytes: 1048576` for restricted email inboxes.
Migration `0007_email_auth.sql` defaults existing policy to NULL and prevents
policy updates with a database trigger; changing policy requires a new inbox.
Creation additionally requires `EMAIL_AUTH_CREATION_ENABLED=true` (default false,
404 through owner API when disabled). Deploy and verify the receiver first, wait
for old versions to stop serving, then enable creation. Turning this gate off
never bypasses policies already stored. Do not roll back to a pre-verifier build
while any restricted inbox remains active.

For restricted inboxes, reception requires a locally verified DKIM signature with
`d=` exactly equal to the single syntactically valid From mailbox's domain AND an
allowlisted domain. RSA >=2048, rsa-sha256 or ed25519-sha256, strict validation,
valid signature times, signed From, no `l=` (even full-body), no testing key. An
optional selector pin must match that SAME passing signature, not a different one.
Sender-supplied `Authentication-Results` is never trusted. This authenticates
delegated domain signing authority, not a person or campus mailbox holder;
provider provisioning/sender controls are unknown. Replay and unsigned-header
modifications remain possible. Stored `dkim_auth` contains only the passing
domain, selector and algorithm, separate from copied authentication headers.

Hard restricted-message ceiling: min(MAX_EMAIL_BYTES, 1 MiB), enforced against
both rawSize and streamed bytes before verification or MIME parsing. Larger mail
gets readable `5.3.4 Restricted inbox supports DKIM mail up to 1 MiB` rejection,
never unverified fallback. Unrestricted reception retains its configured 25 MiB
ceiling. Verification caps: 32 KiB headers, 200 header lines, four DKIM signatures,
four TXT lookups, 1.5 seconds per lookup, one TXT record (8 KiB), 32 KiB DoH
response, and bounded total verification wait. DNS uses fixed HTTPS Cloudflare
DoH with no redirects, never a URL supplied by mail. A dedicated pre-verification
rate bucket spends REJECT_LIMIT (bounded expensive attempts); successful mail also
spends ACCEPT_LIMIT. Thus invalid signatures cannot spend acceptance budget,
but an attacker knowing the address can exhaust verification-attempt budget.
Failures never reserve storage. DNS timeouts/temporary failures throw a fixed,
content-free error instead of setReject; live SMTP retry behavior remains a gate.
Other failed verification uses `5.7.1 DKIM domain authorization required`.
Restricted MIME metadata parsing also bounds parts (256), depth (16), total
headers (64 KiB) and forwarded addresses (256). Nested messages remain inert
attachments (nesting depth zero). MIME resource-budget failures reject explicitly
after DKIM verification, before storage; other parse failures retain verified raw
bytes with parse_error. Retrieval still treats all content as untrusted.

Creation-only policy removes the management race: reservation still atomically
checks active inbox state and exact policy snapshot, in addition to quotas. Old
receivers passing no verified snapshot cannot insert into restricted inboxes.
Rollback must disable restricted creation/reception and not run an old receiver
on a database containing restricted inboxes: old binaries lack enforcement.

Build: pinned mailauth 8.0.1, guarded digest-name and selector patches generated
before Wrangler/tests. `nodejs_compat` is required; verifier source is shared by
research and production. No user-controlled DNS override or test fetch endpoint
is present in production. Specimen and isolated live policy evidence is recorded
in `QUALIFICATION.md`; full SMTP/storage semantics and worst-case concurrent
memory remain unqualified.

Exposure for this pilot: HTTP owner API/OpenAPI and llms orientation expose
creation/readback; existing hosted and desktop adapters do not gain new mutation
authority or policy UI. Adapter option delivery/ordinary-user discovery remains
deferred to the integration owner after pilot qualification. Chat remains omitted
(no new owner credential path). Upstream issue drafts stay local.

The following legacy sequence describes unrestricted reception; restricted
reception adds the pre-reservation verification and tighter bounds above.

1. Recipient = `message.to` (the **envelope** recipient), lowercased. Domain must equal
   `INBOX_DOMAIN` exactly, and the local part must match a live `email` inbox
   nonce exactly (active and not past `expires_at`) (no plus-address stripping in v1). Otherwise
   `setReject("5.1.1 Address not found")`. MIME `To`/`Cc` headers never route.
2. `message.rawSize > MAX_EMAIL_BYTES` → `setReject("5.3.4 Message too large")`.
3. `ACCEPT_LIMIT` exceeded → `setReject("4.7.0 Rate limited, try later")`. Note:
   Cloudflare documents `setReject` as a **permanent** SMTP error regardless of the
   text. Qualification on a disposable domain must confirm actual sender behavior.
4. Read the raw bytes (`new Response(message.raw).arrayBuffer()`), bounded by
   `MAX_EMAIL_BYTES`. Parse with `postal-mime`. A parse failure still stores the raw
   bytes, with `"parse_error": true` and minimal metadata. Resource-limit failures
   instead reject with `5.3.4 MIME resource limit exceeded` and store no receipt;
   see the preflight and maintained-parser limits in the hardening revision below.
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
- Restricted accepted messages additionally store `dkim_auth: {domain, selector,
  algo}` produced by BayLeaf's verifier, not copied from a header. This proves
  domain authority over signed content, never that all headers or a person are trusted.
- Header `From` is untrusted sender-controlled content, not an identity.
- `search_text` = lowercased subject, from, to, plus the text body (or the HTML with tags
  stripped crudely), truncated to `MAX_SEARCH_TEXT`.

## Atomic reservation (shared by both transports)

One `DB.batch` (a single transaction):
1. `INSERT INTO messages (...) SELECT ... FROM inboxes i WHERE i.id=? AND i.state='active'
   AND (i.expires_at IS NULL OR i.expires_at > unixepoch())
   AND i.bytes_stored + :size <= MAX_INBOX_BYTES
   AND i.message_count + 1 <= MAX_INBOX_MESSAGES
   AND (i.day <> :today OR i.day_count < MAX_DAILY_RECEIPTS)
   AND (SELECT COALESCE(SUM(bytes_stored),0) FROM inboxes WHERE owner=i.owner) + :size <= MAX_OWNER_BYTES`
   with `state='pending'`.
2. `UPDATE inboxes SET bytes_stored=bytes_stored+:size, message_count=message_count+1,
   day_count=CASE WHEN day=:today THEN day_count+1 ELSE 1 END, day=:today
   WHERE id=? AND EXISTS (SELECT 1 FROM messages WHERE id=:msg)`.

If the insert changed zero rows, diagnose with a follow-up read. Inactive or expired
→ 404 or reject. The lifetime is rechecked here, after a slow body or message has been
read, exactly like authentication; marking the row `stored` after the R2 put checks
liveness once more, and a receiver that loses either check removes its own row and
object and answers as for an unknown address. Daily → 429. Otherwise full → 507. Reservation counters are decremented
whenever a message row is removed (expiry, deletion, stale pending), in the same batch
as the row deletion.

## Lifecycle and cleanup

States: message `pending → stored → deleting → (row removed)`. Only `stored` rows with
`expires_at > unixepoch()` are visible to any read, search, or attachment download.
Reads revalidate after awaited work before releasing content; already released
bytes cannot be recalled. Cleanup is not required for access denial.

Removing a message (any cause): set `state='deleting'` (it is hidden at once), delete
the R2 object (idempotent), then in one batch delete the row and decrement
`bytes_stored` and `message_count`. If the R2 delete fails, the row stays `deleting`
and the sweep retries.

**Inbox destruction** (`destroyInbox`, or the sweep for an expired lifetime; one
shared transition):
1. Set `state='destroying'`, `destroy_requested_at=min(now, expires_at)`. From this moment reception
   returns not-found, and the inbox and all its messages and credentials are invisible
   to reads, except `getInbox`/`listInboxes`, which report `state:"destroying"`.
   Credentials are deleted immediately in the same batch.
2. Delete message objects and rows in bounded batches (inline, best effort, plus the sweep).
3. **Finalize** only when (a) no message rows remain, (b) an R2 list of the prefix
   `m/{inbox_id}/` returns no objects (orphan reconciliation), and (c)
   `now >= destroy_requested_at + DESTROY_QUIESCE_SECONDS`. This is an earliest
   finalization condition, not a bound on remote writes or a cleanup deadline.
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
- Finally admit at most five expired active inboxes into the shared destruction
  transition, oldest expiry first. Existing cleanup and reconciliation get their
  turn before this additional work; newly admitted destruction is cleaned on a
  later sweep. Admission errors stop this bounded phase and retry on a later run.
   Access denial remains immediate. The integrated bounded sweep and its measured
   budget are described under resource hardening below and in `QUALIFICATION.md`.

No content, address, nonce, or credential is ever logged. The sweep may log only counts.

## RPC: `InboxManagement` (WorkerEntrypoint)

Every method is `async method(owner: string, ...args)`. It validates every input
(unknown keys rejected, types and lengths checked) and returns plain JSON objects.
It **never throws to the caller**: errors are returned as `{ error: code }` with
`code` ∈ `disabled | invalid | not_found | limit | conflict | unavailable`.
The deployed hardening revision adds `resource_limit` for bounded MIME read failures.
`owner` must match `/^[A-Za-z0-9-]{16,128}$/`, else `invalid`. Every lookup is scoped
`WHERE owner=?`. Another owner's handle is indistinguishable from a missing one
(`not_found`).

Inbox object:
```json
{ "id":"ibx_…", "type":"email|http", "label":"…"|null, "state":"active|destroying",
  "address":"nonce@domain" /* email only */, "url":"https://nonce.domain/" /* http only */,
  "created_at":0, "expires_at":0|null, "usage":{"bytes":0,"messages":0,"receipts_today":0},
  "limits":{"bytes":…,"messages":…,"daily_receipts":…}, "closed": true|false /* http only */ }
```

| Method | Args | Returns |
|---|---|---|
| `retireOwner` | – | `{retired:true}`; trusted service-binding-only, bypasses the exposure flag, idempotent durable generation fence |
| `createInbox` | `{type, label?, ttl_seconds? \| preset?, email_auth?}` | inbox (`limit` past `MAX_INBOXES_PER_OWNER`); email policy is creation-only and gated off by default |
| `updateInbox` | `inboxId, {ttl_seconds \| preset}` | inbox; shortens or sets the lifetime only (`conflict` if later than the current `expires_at`; `not_found` if not live) |
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
  The cursor advances over the fetched SQL page before fresh expiry filtering.
  A page can therefore be short or empty with a non-null `next_cursor`; continue
  until the cursor is null rather than treating an empty page as completion.
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
- Reads never extend retention or an endpoint lifetime, mark anything read, or archive.
- Destroy responses and destroying inbox views include `cleanup_not_before`, UTC
  epoch seconds for earliest finalization, not a deadline. Default quiescence is
  15 minutes; the next 15-minute scheduled sweep attempts finalization. Backlog or
  failures can take longer. A later GET returning 404 confirms live-resource
  removal, not destruction of provider history or opaque cleanup metadata.

### Portable export (`exportInbox`)

An owner-controlled way to carry exact payloads and stored metadata elsewhere,
not a backup service or portable address. `GET /inboxes/{id}/export` and private
`exportInbox(owner,id,{cursor?,limit?})` return one streamed POSIX ustar page:

```text
payloads/{message_id}.eml    exact raw MIME for email
payloads/{message_id}.body   exact HTTP request body, possibly empty
receipts.har                HTTP pages only, derived profile below
manifests/{first_id}.json    page manifest, written last (empty.json for no rows)
```

There is exactly one manifest per page, not per receipt. Its filename uses the
first selected row's ID, even if that receipt is subsequently omitted; discover
the member under `manifests/` rather than assuming `manifest.json`.
The canonical export is exact payload files plus the manifest. The manifest has
`format:"bayleaf-inbox-export"`, `version:1`, `exported_at`, an inbox descriptor
(id/type/label/address or URL/created_at), `order:"received_at_asc"`, `cursor`,
`next_cursor`, `har` (filename or null), `receipts` and `omitted`. Each receipt has
`id`, `file`, `received_at`, `expires_at`, `archived` (boolean), `size` (bytes),
`sha256` (lowercase hex digest of the exact payload member) and stored `meta`.
Timestamps are Unix seconds; `omitted` lists selected receipt IDs unavailable
before their payload header was emitted. `cursor` is the supplied cursor or null;
`next_cursor` equals the response cursor header, or null when that header is absent.
Email
attachments derive from the raw MIME; there is no separate attachment copy.
Credentials/hashes are never exported. Sender-controlled metadata, including URLs,
is untrusted; network headers remain dropped and authentication headers redacted.

Order is `received_at ASC,id ASC`; optional limit is 1–100, default 50. Payload
and metadata budgets are separate, with at least one receipt to guarantee
progress. Cursor is base64url of `x:{received_at}:{id}`, distinct from message
list and event cursors. Read the response `X-Inbox-Export-Next-Cursor` header or
manifest `next_cursor`, then pass that value as **`?cursor=` in the next request**,
never as a request header. Stop when absent/null. Extract pages into separate
directories and verify hashes. Quiesce senders and in-flight receipts for complete
exports: this is not a snapshot, and later commits behind a cursor can be missed.

Only stored, unexpired owner-visible receipts are eligible, including archived
ones. Each receipt is checked before R2 get, after R2 get and after copying.
Loss before its payload header produces an omission; loss after output starts
truncates the page because emitted bytes cannot be retracted. A change after the
last receipt check may still appear in the page. The inbox is rechecked after
listing and before derived files, including empty pages. Wholly omitted pages
advance over scanned rows. Retry the same cursor on interruption. Use never
renews retention or changes archive/read state.

Pull-based streaming owns at most one R2 reader and hashes through native
`crypto.DigestStream`. Reader ownership begins before the payload header.
Cancellation interrupts reader reads, waits for an outstanding get to settle,
aborts unfinished digests, observes their rejection and releases locks. Never
cancel a locked stream directly. A recorded-size mismatch or mid-read failure
truncates the archive rather than silently returning a partial entry. At most
4 MiB stored metadata and 4 MiB HAR inline text are retained per normal page;
JSON escaping/derived fields add bounded overhead. Standalone HAR buffers only
eligible capped body text, not a whole arbitrary payload.

### HAR rendering of HTTP receipts

`GET /inboxes/{id}/messages/{mid}/har` and private
`getMessageHar(owner,id,messageId)` return an inert single-entry JSON download.
Email returns `unsupported` (HTTP 400) only after owner/visibility checks.
Each HTTP export includes the same rendering in manifest order, with page text
caps applied. The log uses `_profile:"bayleaf-inbox-receipt-1"` and
`version:"1.2"`, but is explicitly **not conformant HAR 1.2** or a wire capture.

Request method, reconstructed URL, normalized stored headers, parsed query pairs
and exact body size come from storage. HTTP version and durations were never
stored: `httpVersion:"unknown"`, total time and every timing field `-1` are
BayLeaf placeholders. Response status 0 is unknown, not an HTTP success;
response body is uncaptured, with `_observed:false` and `_captured:false`.
`_expectedAcknowledgement` separately describes configured 200/JSON/CORS success
(HEAD has no expected body), never proof that a sender received it. HAR 1.2's
nonnegative send/wait/receive and additive total rules cannot honestly be met.

Nonempty textual bodies are inlined only when strict UTF-8 decoding succeeds,
any declared charset is UTF-8/US-ASCII, US-ASCII contains no non-ASCII bytes,
and per-body/page caps permit. Other bodies use custom `_file` and `_sha256`;
cap-limited text adds `_truncated:true`. Empty bodies have no postData. Custom
fields identify receipt/archive/expiry, credential name, unknown timings,
normalized/redacted/dropped headers and truncation. Exact files plus manifest
remain canonical. Never invent durations or a request-body encoding for importers.

Pinned legacy `insomnia-importers@3.6.0` preserved inline request text but imported
an empty body for `_file`: manual exact-file attachment is necessary.
`har-validator@5.1.5` accepts the profile without enforcing frozen timing rules,
so acceptance is not conformance evidence. Current GUI interoperability remains
unqualified. See `QUALIFICATION.md` and `SELF-HOSTING.md`. Exposure is
HTTP/scripts-only; dedicated hosted/desktop/Chat export adapters are deferred.

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
Expiry-driven destruction is counted as `inbox.lifecycle` `destroy_requested` (and
later `destroyed`), the same counters as owner requests, because both use one
transition; the collector vocabulary has no separate expiry outcome.

Export adds `inbox.export.pages` (unit `1`) and `inbox.export.bytes` (unit `By`)
with only `transport:http|email` and `outcome:emitted`. Count fully generated tar
pages and exact enqueued archive bytes including overhead, not client delivery.
Repeated exports count again; cancelled/failed incomplete pages and standalone
HAR/body reads do not count. Counts are independent best-effort writes, so they
can fail separately or split windows. Existing switch, 15-minute windows, 24-hour
local outbox and 90-day collector retention remain unchanged; no content or ids.
Migration `0005_export_telemetry.sql` rebuilds the local counter table while
preserving values/windows. Deploy collector vocabulary before receiver, API last.

## Not in this proof of concept

JWT signers (the planned next slice: owner-registered public JWK, `aud` = inbox URL,
`exp` required, EdDSA/ES256 only, RFC 7638 thumbprint as hint, per-signer revocation);
plus-addressing; multipart parsing on read;
import into a deployment; any sending. Self-hosting is a documented
recipe, not a supported product.

## Retirement, recovery and resource hardening

### Deployed hardening contract

Migration `0006_qualification_hardening.sql` adds durable retired-owner fences
and cleanup rotation cursors. A trusted binding-only `retireOwner(owner)` RPC
works even with reception disabled: one D1 transaction fences the generation,
marks all its inboxes destroying, removes credentials and retains cleanup prefixes.
It acknowledges logical revocation, not physical deletion. Every subsequent owner
RPC, creation and receipt reservation denies a fenced generation. Already-started
reads cannot recall bytes already obtained. Fences persist indefinitely and contain
the opaque generation and timestamp, not email or content.

API migration `0019_inbox_retirement.sql` captures the old generation in a separate
durable retirement ledger in the same transaction as identity deletion. Daily
cleanup retries up to 20 pending inbox fences and replays up to 20 acknowledged
fences per invocation, independently of provider-key cleanup and user-facing
feature/pilot flags. The cross-service handoff is eventual, not atomic: reception
can continue until the inbox transaction acknowledges. Pending work fails the
scheduled report rather than claiming completed deletion. A newly created account
gets a new generation; ordinary key rotation preserves the existing one.

Recovery must stay offline until fences have been replayed and verified. Restoring inbox D1
requires replay of the surviving API ledger before enabling reception/reads;
restoring API D1 alone does not remove surviving inbox fences. Restoring both
databases from before a retirement without complete independent deletion history
must leave Inboxes closed pending an operator recovery decision. Sufficient history
may be restored to preserve surviving access; invalidating pre-recovery generations
and endpoints is a tested emergency option requiring explicit later operator
authorization, never a preauthorized reset. Standard backups do not guarantee that
history. Automatic safe recovery of both rolled-back ledgers is not claimed. This
is an operator enablement gate; see [the recovery runbook](OPERATIONS.md#recovery-remain-closed-until-reconciliation-is-verified).

Cleanup retains the existing 200-row per-stage bounds, but processes only five
destroying inboxes per invocation (four 50-row rounds each), with durable
round-robin cursors for every row-removal stage and destruction. Counter updates
and row deletion are set-based in one D1 transaction; reconciliation uses one
bounded row lookup per prefix, never one statement per object. Together these
caps form a whole-sweep budget with headroom for telemetry and at most five
TTL transitions after existing cleanup. Preserve the five-transition cap and
combined budget regression. Persist cursor progress before attempted cleanup so one failed object
cannot pin later work indefinitely. R2 failures still leave deleting rows to retry.

Before any email MIME parsing on ingress or owner read, a byte-only preflight
limits raw input to the configured email size and at most 350,000 LF bytes. This
is a work-allocation guard, not a MIME parser. Postal-mime's maintained limits
remain authoritative for nesting, header and part complexity. Set its supported
`maxRfc822NestingDepth:0`: nested message/rfc822 content remains an inert attachment,
not recursively flattened into text or parsed into inner attachments. This stops
encoded nested messages bypassing the raw-line work guard. Its resource-limit
exceptions reject new reception with `5.3.4 MIME resource limit exceeded`; other
syntax errors still store exact raw bytes with `parse_error:true`. Owner text and
attachment reads of resource-heavy legacy objects return `resource_limit` (API
HTTP 413); exact raw downloads remain available and unchanged. No accepted payload
is rewritten. The line cap admits standard 76-column base64 near 25 MiB but rejects
the demonstrated line-heavy allocation bomb. It does not prove concurrency or
total isolate memory safety for every near-limit message; that gate remains open.

## Gates before enablement

Current dated measurements and reproduction commands are in [QUALIFICATION.md](QUALIFICATION.md);
only unfinished work belongs in [TODO.md](TODO.md).

- Qualify real SMTP outcomes on the domain, including `setReject` permanence and
  thrown-exception behavior, Bcc, and envelope-vs-header mismatches.
- Measure memory and CPU for near-25 MiB email with many parts.
- Account retirement uses the deployed durable handoff and fences above; live
  recovery/drain qualification remains separate from passing local restore tests.
- Privacy, retention and subprocessor disclosures (`PRIVACY.md`, `api/RETENTION.md`)
  updated before any user-content pilot. Inboxes intentionally store content, so this
  is a separate retention/access boundary from the content-free inference proxy:
  ZDR does not apply, and the operator can technically read stored mail.
- D1 Time Travel keeps 30 days of database history (Paid). Verified live-store deletion
  is the promise; provider recovery history is a disclosed residual.
