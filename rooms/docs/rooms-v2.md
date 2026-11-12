# BayLeaf Rooms: durable shared state for apps you build

Status: DRAFT CONTRACT v2 (issue #159). Not deployed. Exists to be playtested.

A room is a durable log of JSON entries that credentialed participants append
to and read, with live delivery over WebSocket and catch-up over HTTP. It keeps
its state while every browser, sandbox and agent is offline. It never runs your
code, runs inference, or wakes an agent.

**Principle: BayLeaf relays, it does not arbitrate.** The room stores, relays and
stamps who sent what. It does not lock, take turns, assign ownership of parts of
your data, or decide whose edit wins. Design your app so participants converge
without an arbiter. Every participant with read access can export the full
room, so the commons does not depend on the owner. The authority that remains
is named here: owners set quotas, issue and revoke credentials, may redact an
entry, and may delete the room (ending the relay, not participants' exports).

Rooms are one of the BayLeaf places where data accumulates while your agent is
away (see also Inboxes); they are a separate service with their own contract.

## Recognize the need

Several people (or people and agents) need to see each other's contributions,
live or later, and nobody wants to run a server: class activities, shared boards,
multi-user documents, co-editing, polls. The app is static HTML/JS hosted anywhere
(GitHub Pages, a preview, a file). Use a room the way you'd use a live
discussion: for the activity itself. Anything that will be graded or kept as a
record is submitted elsewhere (Canvas, a form, a repo). Authorship inside a room
is ephemeral convention, not evidence. Not for: rosters, grades, official
records, private per-user storage, or server-side validation.

## Two planes

| Plane | Host | Who | Credential |
|---|---|---|---|
| Owner | `https://api.bayleaf.dev/rooms` | Owner's agent or script | Ordinary key or sandbox credential |
| Participant | `https://bayleaf-rooms.dev/{room_id}` | Browsers, scripts, agents | Room credential `rk_...` (CORS open) |

Who can own rooms: authenticated BayLeaf campus owners. In hosted OpenChamber
sandboxes, calling the owner plane with `curl` and the sandbox credential is the
sanctioned path. Never put an owner key or sandbox credential in an app, page,
repo or link.

## Owner plane

1. `GET /rooms/limits`: quotas and usage. Call it first.
2. `POST /rooms` `{"label":"...","expires_at":"<ISO time>"}` → `{room_id, label, expires_at}`.
   The room ends at `expires_at`: default 30 days, at most 90 days ahead. Use never
   extends it; you do, with `PATCH`. Leave a buffer past your last use for export.
3. `POST /rooms/{id}/credentials` — one credential `{"scopes":["presence","append"],"label":"students"}`
   or many `{"scopes":[...],"labels":["s01","s02",...]}` →
   `{credentials:[{credential_id, scopes, label, secret:"rk_...", link_fragment}]}`.
   Every credential can read the log, export, and receive presence. Scopes add:
   `presence` (send presence), `append` (write to the log), `manage` (redact). Give each link only what its holder needs: a link shown on a
   projector, which a recording or a passer-by can capture, might carry only
   `presence`. Shorthands: `"role":"read"` = no scopes, `"write"` = presence and
   append, `"manage"` = all three. Labels are unique per room and **visible to
   every participant**: use pseudonyms, never real names. Max 100 credentials per
   room. Secrets are shown once. Optional `expires_at` per credential.
4. `GET /rooms`, `GET /rooms/{id}`, `GET /rooms/{id}/credentials`,
   `DELETE /rooms/{id}/credentials/{cid}`.
5. `PATCH /rooms/{id}` `{"label"?, "expires_at"?, "mode"?}`. `expires_at` may move
   either way, up to 90 days ahead. `"mode":"read_only"` freezes the log: appends
   are refused, reads and presence continue (freezing ends the record, not the
   conversation). `"mode":"open"` unfreezes.
6. `GET /rooms/{id}/export` (also available to participants, see below).
7. `DELETE /rooms/{id}`: ends the relay for everyone. Participants keep only what
   they exported or what their clients hold. Warn them first.

## Sharing: capability links

The secret lives in the URL fragment, which browsers never send to the page host:
`https://you.github.io/app/#room=r_7Hk2...&key=rk_9fQ...`. `link_fragment` is
exactly `room=...&key=...`. Page source holds no secrets, so it is safe in a
public repo. Anyone holding a link has its scopes until it expires or is revoked.
A page that holds two links to one room (a projector and a student view, say)
must store them under different keys.

App code should read the fragment, store `{room, key}` in `localStorage` (so
people can return across days), replace the URL with `history.replaceState`, and
offer a visible "forget this room on this device" control.

## Participant plane

All requests: `Authorization: Bearer rk_...`.

- `GET /{room}` → `{scopes, room_label, cred_label, mode, head, expires_at, limits}`.
  `head` is the highest `seq` stored. A missing scope returns 403 `{error:"scope", need}`.
- `POST /{room}/log` (append) body `{"data": <JSON>}`, header `Idempotency-Key: <uuid>`
  (required) → `{seq, ts}`. Durable before the response. Same key on retry
  returns the original result and never duplicates. 409 `read_only` when frozen.
  In yjs rooms, an update that does not apply is 400 `yjs_update_invalid`.
- `GET /{room}/log?after=<seq>&limit=500` → `{entries:[{seq, ts, cred, data}], head}`.
  Page until `entries` is empty.
- `GET /{room}/export` → JSON lines of every retained entry.
- `POST /{room}/tickets` `{"after": <seq>}` → `{url}`: a complete `wss://` URL
  with a single-use 60-second ticket. Never put `rk_` in a URL.
- `POST /{room}/redact` `{"seq": n}` (manage) → the entry keeps `seq`, `ts`, `cred`;
  `data` becomes `null` with `redacted: true`. Readers see the tombstone.
  Only for self-contained entries: if your entries depend on each other (CRDT
  updates), redacting one corrupts the state for everyone. Use a yjs room for
  co-editing; it has no redact.

### Live WebSocket

The server replays every entry after `after`, then sends `ready`, then streams.
Every accepted append, including your own, arrives as an `entry` frame.

```js
const { url } = await (await fetch(`${BASE}/${room}/tickets`, { method: "POST",
  headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ after: lastSeq }) })).json();
const ws = new WebSocket(url);
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  if (f.type === "entry") apply(f.entry);      // {seq, ts, cred, data, redacted?}; dedupe by seq
  if (f.type === "ready") { live = true; me = f.conn; peers = new Map(f.peers.map((p) => [p.conn, p])); }
  if (f.type === "presence") peers.set(f.peer.conn, f.peer);  // {conn, cred, state}: one peer changed or joined
  if (f.type === "left") peers.delete(f.conn);
  if (f.type === "ack") settle(f.idem, f.seq);
  if (f.type === "error") retryOrFail(f.idem, f.status, f.retry_after);  // 400, 409 read_only, 413, 429
  if (f.type === "end") onEnd(f.reason);       // revoked | deleted | expired: stop; otherwise reconnect
};
ws.onopen = () => {                           // sending while CONNECTING throws
  ws.send(JSON.stringify({ type: "append", idem: crypto.randomUUID(), data: {} }));  // append scope
  ws.send(JSON.stringify({ type: "presence", state: { nick: "Owl" } }));            // presence scope, not stored
};
```

Presence is ephemeral and never stored. `ready` carries a snapshot of everyone else
(`peers`, including those who have sent no state yet: `state: null`) and your own
`conn`; after that you get one frame per change, never an echo of your own. A room
used only for presence, with an empty log, is fine: live signals such as cursors,
hands up or "ready" need nothing stored. Each peer's `cred` is stamped by the
server, so an app can trust it where `state` is only a claim: e.g. follow slide
changes only from the credential labelled `projector`. `state` is any JSON up to 1 KiB, at most 5 updates/s per
connection (429 `presence_rate` otherwise): send the latest state, not every change.

Reconnect with a new ticket and the highest `seq` applied, using bounded backoff.
An open socket does not keep a room alive.

### Attribution

The server stamps each entry with the label of the credential that wrote it
(`cred`). That is the only server-verified authorship; everything in `data` is a
claim. One credential per person gives per-person attribution.

### State design

Design `data` as events, generate ids client-side, and rebuild by replaying.
When several people may edit the same thing at once (a shared text, an outline),
use a CRDT so edits merge without locks: create a `yjs` room and use BayLeaf's
provider (`rooms-v2-yjs.md`), which compacts the log for you. A JSON log is never
compacted: it grows until the room's size cap, so design events to be small.

## Limits (draft defaults; read `/rooms/limits`)

Entry `data` ≤ 64 KiB serialized (≤ 1 MiB base64 in yjs rooms). Room ≤ 10 MiB retained. 20 rooms per owner. 100
credentials per room. 200 sockets per room. 50 appends/s per room; presence
≤ 1 KiB and ≤ 5/s per connection. 413 or 429 with `Retry-After`.

## Lifecycle

A room lives until `expires_at`, whatever its activity; extend it with `PATCH`
before then. At expiry or deletion sockets get `end`, then requests 404.

## Privacy

Rooms store content outside BayLeaf API's zero-data-retention posture: operators
can technically read them. Use pseudonyms in labels, data and presence; keep
real-name mappings, grades and rosters out; export what matters before teardown.
