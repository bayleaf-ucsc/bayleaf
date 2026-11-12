# BayLeaf Rooms: durable shared state for apps you build

Status: DRAFT CONTRACT (issue #159). Not deployed. Exists to be playtested.

A room is a durable, ordered log of JSON entries that credentialed participants
append to and read, with live delivery over WebSocket and catch-up over HTTP.
It keeps its state while every browser, sandbox and agent is offline. It never
runs your code, runs inference, or wakes an agent. You build the app; the room
only stores, orders, attributes and relays.

## Recognize the need

Use a room when several people (or people and agents) need to see each other's
contributions live or later, and nobody wants to run a server: class activities
(boards, polls, gallery walks, peer review), shared checklists, multi-user
documents. The app itself is static HTML/JS hosted anywhere (GitHub Pages,
a preview, a file). Not for: rosters, grades, or anything official (export it
to a real destination), private per-user storage, or server-side validation.

## Two planes, two hosts

| Plane | Host | Who | Credential |
|---|---|---|---|
| Owner | `https://api.bayleaf.dev/rooms` | The owner's agent or script | Ordinary key or sandbox credential |
| Participant | `https://rooms.bayleaf.dev/{room_id}` | Browsers, scripts, agents | Room credential `rk_...` (CORS open) |

Never put the owner key or sandbox credential in an app, a page, a repo, or a
link. Apps only ever hold room credentials.

## Owner plane (api.bayleaf.dev)

1. `GET /rooms/limits`: quotas and current usage. Call it first.
2. `POST /rooms` `{"label":"HIST 10 source debate","expires_at":"2026-11-14T23:59:00-08:00"}`
   → `{room_id, label, expires_at, idle_expires_at}`. `expires_at` is a hard
   ceiling (max 90 days); omit it and the room lives until 90 days without
   activity. Prefer an explicit `expires_at` for anything with an end date.
3. `POST /rooms/{room_id}/credentials` `{"role":"write","label":"students"}`
   → `{credential_id, role, label, secret: "rk_...", link_fragment}`.
   Roles: `read` (read and subscribe), `write` (also append and presence),
   `manage` (also checkpoint). The secret is shown once; credentials cannot
   be listed with secrets. Optional `expires_at` per credential.
4. `GET /rooms`, `GET /rooms/{id}`, `PATCH /rooms/{id}` (label, shorten expiry),
   `GET /rooms/{id}/credentials`, `DELETE /rooms/{id}/credentials/{cid}`.
5. `GET /rooms/{id}/export`: JSON lines of all retained entries with seq, ts and
   credential label. Quiesce writers first; export during writes is not a snapshot.
6. `DELETE /rooms/{id}`: destroys the log for everyone, immediately and
   irreversibly for participants. Tell participants before you do it.

## Sharing: capability links

A credential is shared as a link whose secret lives in the URL fragment, which
browsers never send to the page host:

```
https://you.github.io/debate/#room=r_7Hk2...&key=rk_9fQ...
```

`link_fragment` in the credential response is exactly `room=...&key=...`;
append it to your app URL after `#`. The page source contains no secrets, so
it is safe in a public repo. Issue one link per role (e.g. a `write` link
labeled `students`, a `manage` link labeled `teacher`). Anyone holding a link
has that role until you revoke it. Pasting it into Canvas or a projector is
the intended distribution. App code should read the fragment, keep the key in
`sessionStorage`, and replace the URL with `history.replaceState` so the key
does not linger in the address bar.

## Participant plane (rooms.bayleaf.dev)

All requests: `Authorization: Bearer rk_...`.

- `GET /{room}` → `{role, label, cred_label, head, expires_at, limits}`.
- `POST /{room}/log` body `{"data": <any JSON>}`, header `Idempotency-Key: <uuid>`
  (required) → `{seq, ts}`. The entry is durable before the response. Retrying
  with the same key returns the original `{seq, ts}` and never duplicates.
- `GET /{room}/log?after=<seq>&limit=500` → `{entries:[{seq, ts, cred, data}], head}`.
  `after=0` reads from the start (or from the checkpoint, see below).
  Page until `entries` is empty. `seq` is a strictly increasing integer.
- `POST /{room}/tickets` → `{ticket, url}`: a single-use, 60-second WebSocket
  ticket. Browsers cannot set headers on WebSockets; never put `rk_` in a URL.

### Live: WebSocket

```js
const { url } = await (await fetch(`${BASE}/${room}/tickets`, { method: "POST", headers: auth })).json();
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
bounded exponential backoff. An open socket does not keep a room alive.

### Attribution: what `cred` proves

The server stamps each entry with the **label of the credential** that wrote it.
That is the only server-verified authorship. Everything inside `data` (names,
nicknames, roles) is whatever the client claimed. If you need per-person
attribution, issue one credential per person; if a shared `students` link is
fine (cooperative groups), accept client-claimed nicknames and say so in the UI.
Likewise the room cannot enforce app rules ("only reply to peers", phases):
any `write` holder can append any JSON. Encode rules in client logic for
cooperative use; use separate rooms and credentials when enforcement matters.

### State design

Design `data` as events and rebuild views by replaying in `seq` order
(e.g. `{"type":"arg.create","id":"...","text":"..."}`). Generate entity ids
client-side (`crypto.randomUUID()`) so retries and references are safe. For
concurrent rich text, base64-encode CRDT updates (e.g. Yjs) into `data`; the
room never parses them.

### Checkpoint (optional, manage role)

`PUT /{room}/checkpoint` `{"upto": <seq>, "data": <merged state>}` replaces
entries `<= upto` with one checkpoint entry at `upto`. Readers from `after=0`
then receive the checkpoint first. A wrong checkpoint erases others' work;
most apps never need one before hitting the size limit.

## Limits (draft defaults; read `/rooms/limits` for real values)

Entry `data` ≤ 64 KiB. Room ≤ 10 MiB retained. 20 rooms per owner. 200
simultaneous sockets per room. 50 appends/s per room; presence ≤ 5/s per
connection. Over-limit returns 413 or 429 with `Retry-After`.

## Lifecycle

Activity (accepted appends, reads, ticket issuance; coalesced daily) renews the
90-day idle window, never past `expires_at`. At expiry or deletion, sockets get
`end`, then requests return 404. Anything worth keeping must be exported first.

## Privacy

Rooms store content. They are outside BayLeaf API's zero-data-retention posture:
operators can technically read room logs. Use pseudonyms in `data` and presence,
keep any mapping to real names outside the room, keep grades and rosters out,
and export what matters to a real destination before teardown.
