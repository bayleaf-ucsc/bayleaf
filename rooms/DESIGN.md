# BayLeaf Rooms: production design contract (issue #159)

Status: binding for the production build. The public behavior is
`docs/rooms-v2.md` and `docs/rooms-v2-yjs.md`; this file fixes what they leave
to implementers: the Worker's shape, the owner RPC, storage, limits,
retirement and telemetry. Decisions cite `DECISIONS.md`; the Inboxes precedent
is summarized in `FACET-PLAN.md`.

Principle: BayLeaf relays, it does not arbitrate (DECISIONS.md item 2). Rooms
store participant content, outside the API's ZDR/ZOA posture, like Inboxes.

## Components

| Component | Where | Role |
|---|---|---|
| Worker `bayleaf-rooms` | `rooms/worker/`, account BayLeaf `1a49fb69291d42e23c4ed4dcffce5bbc` | Participant plane on `https://bayleaf-rooms.dev`, the `RoomManagement` RPC entrypoint, the static provider, cron |
| Durable Object `Room` | same Worker | One per room: log, credentials, sockets (from the spike) |
| D1 `bayleaf-rooms` | binding `DB` | Owner index, retirement fence, telemetry windows |
| API facade | `api/src/routes/rooms.ts` | Owner plane at `https://api.bayleaf.dev/rooms`, auth, OpenAPI; calls the `ROOMS` service binding |

Worker config: `workers_dev: false`, `preview_urls: false`, observability off,
Workers Custom Domain `bayleaf-rooms.dev` (zone active in the BayLeaf account;
the custom domain creates its own DNS record and certificate, which a zone route
plus Wrangler's OAuth scope could not). No HTTP owner plane in production: the spike's `/owner/*` routes exist
only when `DEV_OWNER_TOKEN` is set (local tests); production config never sets it.

## Participant plane (HTTP and WebSocket on bayleaf-rooms.dev)

As in `rooms-v2.md`, plus:

- `GET /` returns a short plain-text pointer to the docs (no HTML, no cookies, ever).
- `GET /client/y-bayleaf.js` and `GET /client/y-bayleaf@1.js` serve the provider
  (same bytes; `@1` is the pinned major), `Content-Type: text/javascript`,
  `Access-Control-Allow-Origin: *`, cache one hour.
- Unknown, foreign, expired and destroyed rooms all return the same 404.
- Failed `rk_`/ticket authentication counts against a separate `REJECT_LIMIT`
  rate-limit binding keyed by room id, so a leaked URL cannot drain the
  legitimate budget. A missing binding fails closed (503).
- A yjs append is validated by applying it to a scratch `Y.Doc` before it is
  stored; an update that does not apply is 400 `yjs_update_invalid`, so the log
  never holds bytes that would break compaction or catch-up.
- Every handler revalidates the room (still live) and its credential (not
  revoked, not expired) after its last `await` and before mutating, so a
  revoke, delete or expiry that lands mid-request is never outrun.
- A socket ends when its credential expires, not only on revoke: the Durable
  Object alarm is set to the earlier of `expires_at` and the earliest live
  credential expiry, and on firing sends `end` `expired` to those sockets.
- The provider stores `{room, key, base}` together under one page-stable
  `storageKey`, so a page reloaded without a fragment finds its link, and a
  stored key is always read back with the room and base it was issued for.

## Owner RPC: `class RoomManagement extends WorkerEntrypoint`

`owner` is the API's `user_keys.account_generation` string, never an email.
Every method runs through `call(env, name, owner, args)`, in this order:
1. Kill switch: anything but `retireOwner` returns `{error:"disabled"}` unless
   `ROOMS_ENABLED === "true"`.
2. Owner shape: a non-matching owner returns `invalid`.
3. Retired fence: a retired owner gets `not_found`.
4. The operation. A thrown error becomes `invalid` or `unavailable`; nothing
   ever throws to the caller.

Results are plain JSON objects, or `{error: code}`. Error codes: `invalid`,
`not_found`, `disabled`, `limit` (room quota), `credential_limit`, `label_taken`
(with `label`), `unavailable`.

| Method | Args | Returns |
|---|---|---|
| `getLimits(owner)` | | `{rooms_used, max_rooms, max_credentials_per_room, max_entry_bytes:{json,yjs}, max_room_bytes, max_sockets_per_room, max_appends_per_second, presence:{max_bytes, per_second}, default_life_days, max_life_days}`, from the limits actually enforced (env vars) |
| `createRoom(owner, {label?, codec?, expires_at?})` | codec `json`/`yjs`, fixed once created | `{room_id, label, codec, mode, expires_at, created_at}`; index row reserved first, quota checked atomically in D1 |
| `listRooms(owner)` | | `{rooms:[...same shape, head?]}` from D1, live rows only |
| `getRoom(owner, roomId)` | | room plus `head`, `bytes`, `sockets`, `credentials:[{credential_id, label, scopes, expires_at, revoked}]` (no secrets) |
| `updateRoom(owner, roomId, {label?, expires_at?, mode?})` | `mode` `open`/`read_only`; `expires_at` in (now, now+90d] | room |
| `deleteRoom(owner, roomId)` | | `{deleted:true}`; sockets get `end` `deleted` |
| `issueCredentials(owner, roomId, {scopes?\|role?, label?\|labels?, expires_at?})` | as in `rooms-v2.md` | `{credentials:[{credential_id, label, scopes, secret, link_fragment, expires_at}]}` |
| `listCredentials(owner, roomId)` | | `{credentials:[...]}` |
| `revokeCredential(owner, roomId, credentialId)` | | `{credential_id, revoked:true}`; that credential's sockets get `end` `revoked` |
| `exportRoom(owner, roomId, {format?})` | `format` `jsonl` (default) or `yjs` (yjs rooms) | `{content_type, body}`; `body` is a string (jsonl) or a `Uint8Array` (yjs) |
| `retireOwner(owner)` | | `{retired:true, rooms:n}`; works while disabled; writes the fence first, then destroys every room (sockets get `end` `deleted`) |

Ownership is checked in D1 (`rooms.owner = ?`) before any Durable Object is
touched. The Durable Object trusts only internal requests from its own Worker.

## Storage

D1 (`rooms/worker/migrations/`):

- `rooms(room_id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT, codec TEXT,
  created_at INTEGER, expires_at INTEGER, state TEXT CHECK(state IN ('live','destroying')))`,
  indexed on `(owner, state)` and `expires_at`.
- `retired_owners(owner TEXT PRIMARY KEY, retired_at INTEGER)`.
- `metric_windows(window_start INTEGER, name TEXT, attrs TEXT, value INTEGER,
  PRIMARY KEY (window_start, name, attrs))`, with telemetry windows only.

Durable Object SQLite: as in the spike (meta, creds with `scopes`, entries,
chunks, idem, tickets), plus `bytes` in meta for the room cap. Idempotency rows
older than 24 hours are pruned on the next append after that; otherwise they are
removed when the room ends.

Lifecycle (DECISIONS.md item 11): a fixed `expires_at` (default 30 days, at most
90 days ahead). Use never renews it. There is one destruction path, `destroy(reason)`:
mark the D1 row `destroying` → `end` to sockets → `deleteAll` → delete the D1 row.
The DO alarm fires at `expires_at` (or earlier, to end sockets of an expiring
credential, then re-arms). A cron every 15 minutes is the backstop: it
destroys index rows past expiry or stuck in `destroying`, at most 20 per run.

## Limits (env vars, read by `getLimits`)

`MAX_ROOMS_PER_OWNER=20`, `MAX_CREDENTIALS_PER_ROOM=100`,
`MAX_ENTRY_BYTES_JSON=65536`, `MAX_ENTRY_BYTES_YJS=1048576`,
`MAX_ROOM_BYTES=10485760` (sum of stored entry bytes; yjs counts post-compaction
size; an over-cap append returns 507 `room_full`), `MAX_SOCKETS_PER_ROOM=200`
(the next upgrade gets 429 `room_busy`), `MAX_APPENDS_PER_SECOND=50` (per room,
in-memory token bucket; 429 with `retry_after`), presence 1 KiB and 5/s per
connection, `DEFAULT_LIFE_DAYS=30`, `MAX_LIFE_DAYS=90`, `COMPACT_ENTRIES=500`.

## Retirement (account deletion)

As with Inboxes:
- API migration `0023_room_retirements.sql` adds a `room_retirements` ledger,
  written in the same transaction as identity deletion
  (`api/src/userRetention.ts`). Its columns match the inbox ledger
  (`generation, retired_at, fenced_at, checked_at`), so one retry routine serves
  both services.
- A daily API job retries `ROOMS.retireOwner` until it succeeds. Each call is
  bounded to 8 seconds; a timeout leaves `fenced_at` NULL and ends that ledger's
  pass for the run, so a hung binding never blocks the rest of the job.
- `retireOwner` keeps working while `ROOMS_ENABLED` is off.

## Telemetry (approved 2026-11-11; DECISIONS.md item 13)

These are aggregate counts in fixed 15-minute windows, written to the existing
collector by a dedicated writer key, `ROOMS_TELEMETRY_WRITE_SECRET`, behind the
switch `ROOMS_TELEMETRY_ENABLED`. Never included: room or credential ids, labels,
owners, IPs, paths, content or presence state.

| Name | Unit | Attributes (closed vocabularies) |
|---|---|---|
| `room.lifecycle` | `1` | `codec` json\|yjs; `outcome` created\|expired\|deleted\|retired |
| `room.appends` | `1` | `codec`; `outcome` accepted\|frozen\|too_large\|room_full\|scope\|rate_limited |
| `room.append.bytes` | `By` | `codec`; `outcome` accepted |
| `room.connections` | `1` | `outcome` opened\|auth_failed\|room_busy |
| `room.presence` | `1` | `outcome` relayed\|rate_limited\|too_large |
| `room.fanout.frames` | `1` | `kind` entry\|presence (frames sent: the cost signal) |

Counting is best-effort. A Durable Object keeps counters in memory and adds them
to `metric_windows` at most every 10 s and when it hibernates or is destroyed;
counts since the last write are lost if the object is evicted. The 15-minute cron
exports completed windows and deletes them. Adam approved the proposal on
2026-11-11 with two changes: `room.connections` carries no `codec`, and
`room.compactions` is dropped. That leaves 6 names and 30 fixed series (policy 5),
never published (`telemetry/qualification/rooms.md`).

## Kill switches and deploy order

- `ROOMS_ENABLED` must be exactly `"true"` on both the API and the Worker. Off on
  the API means `/rooms` returns 404. Off on the Worker means participant
  requests get 503 and RPC returns `disabled` (`retireOwner` still works).
- No pilot-owner stage: the service opens to campus at launch (DECISIONS.md
  item 13).
- Deploy order:
  1. telemetry vocabulary (once approved)
  2. Rooms D1 migrations
  3. Rooms Worker
  4. API migrations
  5. API

## Exposure (DECISIONS.md item 13)

- **Skills, not tools:**
  - a desktop catalog skill `bayleaf-rooms` (`api/src/routes/docs.ts`)
    pointing at `/docs/rooms.md`;
  - a hosted OpenChamber skill in `api/sandbox-plugin/skills/bayleaf-rooms`.
  - No MCP tools.
- **API docs:** OpenAPI tag `Rooms`, `apiReference.ts`, `llms.ts`, and
  `landing/llms.txt` (auxiliary-domains line).
- **App-token scopes** for the owner plane, following `api/src/grants.ts` and
  `SCOPES.md`. Proposed:
  - `rooms.read`: limits, list, get, export
  - `rooms.manage`: create, update, delete, credentials. Every participant link
    can read and export its room, so `rooms.manage` effectively grants read of
    every room too.
- App tokens cover the whole account, not single rooms: `rooms.manage`
  creates rooms and `rooms.read` lists them, which a room-bound token couldn't
  do. To share one room, use its capability link.
- **A dashboard card** listing the owner's rooms, with "End in 90 days" and
  "Delete room". It calls session-only `/dashboard/rooms` endpoints, so `/rooms`
  stays Bearer-only. It never shows `rk_` secrets; creating rooms and links stays
  an agent or API action.
- **No Chat coverage.** Record all of this in `rooms/QUALIFICATION.md`.
