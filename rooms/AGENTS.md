# BayLeaf Rooms Worker

Issue [#159](https://github.com/bayleaf-ucsc/bayleaf/issues/159). Durable shared
logs with live WebSocket relay for static apps people build: class activities,
shared boards, co-editing, presence. Participants reach a room on
`https://bayleaf-rooms.dev/{room_id}` with a capability link; owners reach it only
through the API at `https://api.bayleaf.dev/rooms`.

Rooms intentionally store participant content, so the API's zero-data-retention
and zero-operator-access posture does **not** extend here. Say so plainly
anywhere Rooms are described, as with Inboxes.

## Read in this order

1. `DESIGN.md`: the **binding** production contract (Worker shape, owner RPC,
   storage, limits, retirement, telemetry, kill switch, deploy order). Change it
   first, then code and tests.
2. `docs/rooms-v2.md` and `docs/rooms-v2-yjs.md`: the public participant and
   owner contract (published as `https://api.bayleaf.dev/docs/rooms.md`).
3. `DECISIONS.md`: why, with the AX evidence behind each decision. Do not
   relitigate a numbered decision without new evidence and Adam's agreement.
4. `OPERATIONS.md` (deploy, recovery, rollback) and `QUALIFICATION.md`
   (exposure matrix and rollout evidence).
5. `FACET-PLAN.md` (Inboxes precedent) and `SPIKE.md` (spike findings), for
   history.

## Boundaries

- **Public surfaces are participant only:** HTTP and WebSocket on
  `bayleaf-rooms.dev`, plus `GET /` (plain-text docs pointer) and the provider at
  `/client/y-bayleaf.js` and `/client/y-bayleaf@1.js`. No HTML, no cookies.
- **Owners reach it only through the API:** `api/src/routes/rooms.ts` calls the
  `RoomManagement` RPC over the API's `ROOMS` service binding. The owner argument
  is the API's `account_generation`; this Worker never sees an email or CruzID.
  The spike's `/owner/*` HTTP routes exist only when `DEV_OWNER_TOKEN` is set in
  local tests; production config never sets it.
- **Separate storage:** one SQLite-backed Durable Object per room and D1
  `bayleaf-rooms` (owner index, retirement fence, telemetry windows). Nothing is
  shared with the inference API.
- `workers_dev: false`, `preview_urls: false`, observability off.

## Invariants

- **BayLeaf relays, it does not arbitrate** (DECISIONS.md item 2). No locks,
  turn-taking, ownership of parts of the data or server-side merge judgments.
  The authority that remains (quotas, credentials, freeze, redact on JSON rooms,
  delete) is named in the docs. Any credential can export the whole room.
- **Never drop a Yjs update** (DECISIONS.md item 9). A gap in one client's
  updates stalls all its later edits on every peer. Server and provider must
  either store an update or tell its sender it can never sync (`diverged`).
  Compaction uses `Y.mergeUpdates` only and must preserve the merged state
  exactly. Yjs rooms have no redact and carry no `cred` on entries.
- **No content logging.** Never log entries, presence state, labels, room or
  credential ids, secrets, tickets, owners or IPs. Errors map to fixed codes.
  Telemetry, when switched on, uses only the closed vocabulary in DESIGN.md.
- **Presence is relayed, never stored.** Keep it in memory and out of SQLite,
  D1, exports and telemetry attributes.
- **Single destroy path:** `destroy(reason)` marks the D1 row `destroying`, sends
  `end` to sockets, runs `deleteAll`, then deletes the D1 row. Expiry (Durable
  Object alarm), owner delete, retirement and the cron backstop all call it.
  Never add a second cleanup path, and never let use renew `expires_at`.
- **Kill switch:** `ROOMS_ENABLED` must be exactly `"true"` on the Worker and the
  API. Off means 503 for participants, `disabled` for RPC, 404 for `/rooms`.
  `retireOwner` keeps working while disabled.
- **Ownership before touch:** check `rooms.owner = ?` in D1 before any Durable
  Object call; the Durable Object trusts only internal requests from its own
  Worker. Unknown, foreign, expired and destroyed rooms return the same 404.
- **Separate reject bucket:** failed `rk_`/ticket authentication spends
  `REJECT_LIMIT`, keyed by room id; a missing binding fails closed (503).
- **Secrets never in URLs or storage:** credential secrets are stored as SHA-256
  digests and shown once; WebSocket URLs carry only single-use 60-second tickets.
- **Limits come from env vars** and `getLimits` reports what is enforced, never
  hard-coded numbers.

## Commands

```bash
cd rooms/worker
npm install
npm test                    # contract suite (Miniflare, real Durable Objects and SQLite)
node test/browser.mjs       # browser proof of the Yjs provider (playwright-core)
node test/fanout.mjs        # local fan-out measurement; not deployed evidence
npm run dev                 # wrangler dev --local
```

API facade tests live under `api/` (see `api/AGENTS.md`); run them with the
Worker suite whenever the RPC shape changes. Run an adversarial review separate
from the contract tests before rollout, as Inboxes did.

`compatibility_date` is `2026-08-01`, so `deleteAll()` also deletes the alarm
(Cloudflare changed this for dates from `2026-02-24`); keep it at or after that.
