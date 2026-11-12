# Shared inboxes (type "shared"): addendum to docs/inboxes.md

Status: DRAFT (issue #159, framing experiment). Not deployed.

Inboxes are opaquely named places where data from the wild accumulates until
someone checks in. Email and HTTP inboxes have one reader, the owner. A
**shared inbox** has many: everyone holding a link can append JSON entries and
read everyone else's, live or later. It keeps its contents while every browser,
sandbox and agent is offline. It never runs your code, runs inference, or wakes
an agent. Use it for class activities (boards, polls, gallery walks, peer
review), shared checklists and multi-user documents built as static HTML/JS
hosted anywhere (GitHub Pages, a preview, a file).

## How shared inboxes differ from email and HTTP inboxes

| | Email / HTTP | Shared |
|---|---|---|
| Who reads | Owner only | Every link holder with read or write |
| Contents | Independent receipts, each expiring after 90 days | One ordered log; entries never expire individually |
| Live delivery | Owner SSE stream, 4 subscribers, 300 s | Participant WebSocket, 200 sockets per inbox |
| Sender credential | Write-only `sk-bayleaf-inbox-...` | Role-scoped `rk_...` (read, write, manage) |
| Receiving host | `bayleaf-inboxes.dev` | `https://shared.bayleaf-inboxes.dev/{inbox_id}` (CORS open) |

## Owner plane (api.bayleaf.dev, ordinary key or sandbox credential)

1. `GET /inboxes/limits`: includes a `shared` section with quotas and usage.
2. `POST /inboxes` `{"type":"shared","label":"HIST 10 source debate","expires_at":"2026-11-14T23:59:00-08:00"}`
   → `{id, type, label, expires_at, idle_expires_at}`. `expires_at` is a hard
   ceiling (max 90 days); omit it and the inbox lives until 90 days without
   activity. Prefer an explicit `expires_at` for anything with an end date.
3. `POST /inboxes/{id}/credentials` `{"role":"write","label":"students"}`
   → `{credential_id, role, label, secret: "rk_...", link_fragment}`.
   Roles: `read` (read and subscribe), `write` (also append and presence),
   `manage` (also checkpoint). The secret is shown once. Optional `expires_at`.
4. `GET /inboxes`, `GET /inboxes/{id}`, `PATCH /inboxes/{id}` (label, shorten expiry),
   `GET /inboxes/{id}/credentials`, `DELETE /inboxes/{id}/credentials/{cid}`.
5. `GET /inboxes/{id}/export`: for shared inboxes, JSON lines of all retained
   entries with seq, ts and credential label (not the tar format of other types).
   Quiesce writers first; export during writes is not a snapshot.
6. `DELETE /inboxes/{id}`: destroys the log for everyone, immediately and
   irreversibly for participants. Tell participants before you do it.

Never put the owner key or sandbox credential in an app, a page, a repo, or a link.

## Sharing: capability links

A credential is shared as a link whose secret lives in the URL fragment, which
browsers never send to the page host:

```
https://you.github.io/debate/#inbox=ib_7Hk2...&key=rk_9fQ...
```

`link_fragment` is exactly `inbox=...&key=...`; append it to your app URL after
`#`. The page source contains no secrets, so it is safe in a public repo. Issue
one link per role (e.g. a `write` link labeled `students`, a `manage` link
labeled `teacher`). Anyone holding a link has that role until you revoke it.
App code should read the fragment, keep the key in `sessionStorage`, and
replace the URL with `history.replaceState`.

## Participant plane (shared.bayleaf-inboxes.dev)

All requests: `Authorization: Bearer rk_...`.

- `GET /{inbox}` → `{role, label, cred_label, head, expires_at, limits}`.
- `POST /{inbox}/log` body `{"data": <any JSON>}`, header `Idempotency-Key: <uuid>`
  (required) → `{seq, ts}`. Durable before the response. Retrying with the same
  key returns the original `{seq, ts}` and never duplicates.
- `GET /{inbox}/log?after=<seq>&limit=500` → `{entries:[{seq, ts, cred, data}], head}`.
  `after=0` reads from the start (or the checkpoint). Page until empty.
- `POST /{inbox}/tickets` → `{ticket, url}`: single-use, 60-second WebSocket
  ticket. Browsers cannot set headers on WebSockets; never put `rk_` in a URL.

### Live: WebSocket

```js
const { url } = await (await fetch(`${BASE}/${inbox}/tickets`, { method: "POST", headers: auth })).json();
const ws = new WebSocket(`${url}&after=${lastSeq}`);
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  if (f.type === "entry") apply(f.entry);           // {seq, ts, cred, data}; may repeat after reconnect: dedupe by seq
  if (f.type === "ready") live = true;             // catch-up complete
  if (f.type === "presence") peers = f.peers;      // [{conn, cred, state}], ephemeral
  if (f.type === "ack") resolvePending(f.idem, f.seq);
  if (f.type === "end") reconnect(f.reason);       // "revoked" | "deleted" | "expired": stop; others: reconnect
};
ws.send(JSON.stringify({ type: "append", idem: crypto.randomUUID(), data: {...} }));  // write role
ws.send(JSON.stringify({ type: "presence", state: { nick: "Owl", view: "src-3" } }));   // write role, not stored
```

On reconnect, fetch a new ticket and pass the highest `seq` you applied. Use
bounded exponential backoff. An open socket does not keep the inbox alive.

### Attribution: what `cred` proves

The server stamps each entry with the **label of the credential** that wrote it.
That is the only server-verified authorship. Everything inside `data` is
whatever the client claimed. For per-person attribution, issue one credential
per person; for cooperative groups a shared link with client-claimed nicknames
is fine (say so in the UI). The inbox cannot enforce app rules: any `write`
holder can append any JSON.

### State design

Design `data` as events and rebuild views by replaying in `seq` order. Generate
entity ids client-side (`crypto.randomUUID()`). For concurrent rich text,
base64-encode CRDT updates (e.g. Yjs) into `data`; the inbox never parses them.

### Checkpoint (optional, manage role)

`PUT /{inbox}/checkpoint` `{"upto": <seq>, "data": <merged state>}` replaces
entries `<= upto` with one checkpoint entry. A wrong checkpoint erases others'
work; most apps never need one before hitting the size limit.

## Limits (draft defaults; read `/inboxes/limits` for real values)

Entry `data` ≤ 64 KiB. Shared inbox ≤ 10 MiB retained. 20 shared inboxes per
owner (separate from the email/HTTP quota). 200 simultaneous sockets per inbox.
50 appends/s per inbox; presence ≤ 5/s per connection. 413 or 429 with `Retry-After`.

## Lifecycle

Activity (appends, reads, ticket issuance; coalesced daily) renews the 90-day
idle window, never past `expires_at`. This differs from email/HTTP inboxes, where
use never renews a lifetime. At expiry or deletion, sockets get `end`, then
requests return 404. Export anything worth keeping first.

## Privacy

Like all inboxes, shared inboxes store content and are outside BayLeaf API's
zero-data-retention posture: operators can technically read them. Use
pseudonyms, keep real-name mappings, grades and rosters out, and export what
matters before teardown.
