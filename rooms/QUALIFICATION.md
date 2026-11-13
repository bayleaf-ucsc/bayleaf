# Rooms qualification

Status as of **2026-11-12**: deployed and open to campus (Worker `4f3ad454`);
evidence under "Launch evidence" and "Post-launch qualification" below. **Known
defect:** presence at the published limits gets a room shed by the runtime (see
the fan-out results); batched presence is the proposed fix, a wire-format change
not yet designed. Still pending: the live retirement (armed, fires at the
2026-11-13 08:17 UTC retention run), the phone-on-another-network and dashboard
checks, and the fresh-session discovery playtests. Contract: [DESIGN.md](DESIGN.md). Deployment and recovery:
[OPERATIONS.md](OPERATIONS.md). Exposure decisions: DECISIONS.md item 13 (Adam,
2026-11-11), recorded here per
`.agents/skills/bayleaf-ops-router/playbooks/bayleaf-powered-agent-capabilities.md`.

## Exposure matrix

Verbs: owner plane (limits, create, list, get, update, delete, credentials,
export) on `api.bayleaf.dev/rooms`; participant plane on `bayleaf-rooms.dev` with
room credentials. Owner credentials are ordinary keys, sandbox credentials and
`rooms.*` app tokens; Campus Pass is denied.

| Surface / verbs | Decision and reason | Discovery + invocation | Auth / consent boundary | Delivery / follow-up owner | Verification |
|---|---|---|---|---|---|
| Desktop OpenChamber / OpenCode, all owner verbs | **Expose.** Agents build the apps that use rooms; the HTTP API plus a skill suffices | Catalog skill `bayleaf-rooms` in `api/src/routes/docs.ts`, pointing at `/docs/rooms.md`; curl/fetch with the user's key | Server enforces owner, quotas, expiry. No native approval: the skill tells agents to ask before create, delete, revoke and before sharing links | API deploy; catalog version bump for existing clients | Pending: fresh-session discovery prompt, authorized create/issue/delete, negative discovery while disabled |
| Hosted OpenChamber, all owner verbs | **Expose.** Same reason; the sandbox credential is the sanctioned owner path | Plugin skill `api/sandbox-plugin/skills/bayleaf-rooms/SKILL.md`; curl with `$BAYLEAF_API_KEY` to `api.bayleaf.dev` only | Same server enforcement. Credential substituted by Daytona for `api.bayleaf.dev` only; skill forbids putting it in apps or links | Plugin `c13babd` (gated on `BAYLEAF_ROOMS_ENABLED`, kept under shared MCP; 36/36 plugin tests), then API pin | Pending: installed skill text and pin read back, behavioral discovery in a fresh session |
| MCP tools (hosted shared MCP, plugin tools) | **Omit**, by decision. Rooms is multi-step app building, better taught than wrapped; secrets would land in tool output | None | n/a | Revisit if AX shows agents failing with curl | Negative discovery: no `rooms` tool in plugin or shared MCP inventory |
| BayLeaf Chat | **Omit**, by decision. No owner credential path in Chat; copying room content into Chat adds stored history | None | n/a | Revisit on a concrete course request | Negative discovery: no Chat tool, model or prompt mentions Rooms as usable |
| API dashboard card | **Expose.** Owners need to see expiry and delete without an agent | Card listing rooms with label, codec, expiry, delete | Session-gated; delete confirms | API deploy | Pending: real owner login, list, delete of a synthetic room |
| App-token scopes | **Expose.** `rooms.read` (limits, list, get, export), `rooms.manage` (create, update, delete, credentials), following `api/src/grants.ts` and `SCOPES.md` | Consent page lists the scopes | Grant gate; `rooms.manage` lets an app mint room links (each can read and export its room, so effectively read too) and delete rooms | API deploy | Pending: scope denial both ways, export under `rooms.read` only |
| API docs (`/llms.txt`, OpenAPI tag `Rooms`, `apiReference.ts`, `/docs/rooms.md`) | **Expose.** Canonical orientation and exact contracts | Published docs | Docs only | API deploy | Pending: `npm run test:docs`, live readback |
| `landing/llms.txt` | **Expose** (auxiliary-domains line and a one-line gloss deferring to the API guide) | Static | n/a | Pages on push to `main` | Pending: published readback |
| Landing page (`landing/index.html`) | **Omit.** Inboxes are absent too; the page is the project frame, not a catalog. Adding it would also trigger the VPAT re-measurement | None | n/a | Revisit when the "Inboxes and Rooms" family is presented to people | n/a |

## Launch evidence (2026-11-11, Pacific)

Opened to campus at launch (DECISIONS.md item 13). Deployed in order, each step
confirmed by Adam:

1. Telemetry collector `bayleaf-telemetry` version `a8d9859f` (policy 5, 30 Rooms
   series, `ROOMS_METRICS_ENABLED` true), then the merged `WRITE_KEYS_JSON` with a
   new `rooms` writer. All 8 writers verified to authenticate afterwards (empty
   body: 400 `invalid_payload`, never 401/503).
2. D1 `bayleaf-rooms` (`6f0017bc-c31f-4fb6-b9f6-6f992d8d8893`, WNAM), migration
   0001, `ROOMS_TELEMETRY_WRITE_SECRET`, Worker `bayleaf-rooms` version `3a399ca6`
   on the custom domain. Smoke: `GET /` plain text without `Set-Cookie`; provider
   `@1` byte-identical, `text/javascript`, CORS open; unknown room 404; dev owner
   shim 404.
3. Sandbox plugin `bayleaf-ucsc/opencode-sandbox` `c13babd` (gated skill).
4. API migration 0023, API version `70e0ea4b` (main's committed code plus Rooms;
   live variables matched source except the new `ROOMS_ENABLED`). Plugin pin
   `c13babd`.

End to end: `rooms/worker/test/prod-smoke.mjs` passed 19/19 with Adam's key
(owner plane via the API, participant HTTP and WebSocket, presence-only scope,
freeze with presence flowing, ndjson and yjs exports, two providers converging),
and left zero rooms (API `rooms_used` 0, D1 count 0). The desktop `bayleaf-rooms`
skill appeared in a live harness catalog right after the API deploy.

Review fixes from PR #164 (check-then-use revalidation, yjs update validation, expired-socket ending,
byte-accurate caps, provider storage and reconnect fixes, manage-scope consent wording) redeployed the
same day: Worker `57bca987`, API `c050152b`; `prod-smoke.mjs` 19/19 again, 0 rooms left. Round 2 (log range parsing, upgrade revalidation, paged export) redeployed
2026-11-12: Worker `5c59d23e`, smoke 19/19.

Telemetry: exported windows read back privately on 2026-11-12 (all six names, closed vocabulary only). Pending: deployed fan-out
measurement; browser proof against production; retirement exercised live.
Note: a client that looked up `bayleaf-rooms.dev` before the domain existed may
cache the negative answer for up to 30 minutes (zone SOA minimum 1800 s).

## Post-launch qualification (2026-11-12, Pacific)

Raw logs in `/tmp/rooms-prod-*.log` on the operator's machine, outside the
repository. Every synthetic room was deleted and confirmed 404.

**Deployed fan-out** (`rooms/worker/test/prod-fanout.mjs`, one laptop client, one
clock, real network; client CPU 2.7 s of 19.5 s wall, so not client-bound):

| Workload | Result |
|---|---|
| Ramp one room to 200 sockets, then one more | 200 ready in 3.1 s; the 201st gets 429 `room_busy` |
| 50 appends/s over the socket, 200 listeners, 20 s | 200,000 frames, 0 dropped, 0 errors; p50 50, p95 128, p99 138 ms |
| Audience deck: 150 presence-only phones + read-only projector, Poisson tap every ~5 s | projector p50 34, p99 140 ms; burst of 150 taps in 2 s: p99 185 ms, 11k frames/s |
| 12 y-bayleaf writers, one keystroke each per 500 ms | p50 54, p99 148 ms; converged |
| **Presence, 200 sockets at 1/s or 5/s** | **FAIL:** every socket closed by the runtime with `1013 Service overloaded` within 1.3–3 s; ~2–10% of frames delivered |
| Presence, 50 senders at 5/s to 200 sockets | sockets survive, but p50 415–700 ms and growing queues |

Diagnosis: a Durable Object sustains roughly 16–20k outbound frames/s, and
per-peer presence frames scale as N² (200 × 5/s demands ~200k/s). Billing
analytics show no `exceededCpuErrors`; the signal is Worker
`scriptThrewException` plus client `1013` closes. Worker `4f3ad454` replaced the
per-broadcast sweep of every socket attachment with a query of stale credentials
by socket tag (DESIGN.md), which is sound (135/135 local, smoke 19/19) but did
not raise the ceiling. Not an accepted limitation: the published limits let an
honest class kill its own room.

Cost (Durable Objects pricing, 2026-10-18; Cloudflare GraphQL analytics):
audience deck about $0.0025 per room-hour; a room saturated at 50 appends/s about
$1.44 per room-hour beyond the monthly row allowance, dominated by ~8 SQLite rows
written per append (worth reducing).

**Browser proof** (`rooms/worker/test/prod-browser.mjs`, the production provider
`@1` swapped in by route): two isolated contexts co-edit, show carets, reload and
catch up (611 ms); a mid-edit freeze locks both editors in 657 ms and queued edits
sync after unfreeze with nothing dropped; a 1.15 MB paste reports `diverged`
(caught client-side, so the server's own rejection was not exercised); the yjs
export rebuilds the text with plain `yjs`; the provider is served with
`Access-Control-Allow-Origin: *` and `max-age=3600`, byte-identical to source.
Two contexts on one machine; the different-networks check is pending.

**Scopes** (`rooms/worker/test/prod-scopes.mjs`, 49/49 twice): `rooms.read`
reads and exports, refused every write; `rooms.manage` creates, updates, issues,
revokes and deletes but is refused limits, list, get and export (it reads only
through links it mints, and it can delete any of the owner's rooms);
`identity.read` refused all nine verbs; Campus Pass 403; revoked grants 401.

**Restore drill** (`rooms/worker/test/restore-drill.mjs`, local, 37/37):
retirement erases Durable Object content and ends sockets; restoring the Rooms D1
alone does not resurrect content but removes the fence, so the retired owner
could create a new room and collect content until reconciliation, and ghost rows
count against quota. The OPERATIONS.md order (disable, replay ledger, verify,
reopen) cleared every case. `retireOwner` works while disabled. Not drilled: API
D1 restored alone; Durable Object point-in-time recovery.

**Exposure readbacks:** `npm run test:docs` passes; `/llms.txt`,
`/docs/rooms.md`, the OpenAPI `Rooms` tag (10 routes), the desktop skill catalog
and `bayleaf.dev/llms.txt` read back live; no Rooms tool in the plugin at the pin
or the shared MCP, none in Chat source; production serves plugin `c13babd`. A
local checkout of the submodule at an older commit would have rolled the hosted
skill back on the next API deploy: check `git submodule status` before deploying.

**Live retirement (armed):** a synthetic account on the `.invalid` domain with no
provider keys or sandbox, two rooms and a watcher socket, backdated 24 months;
the only eligible account. Driver: `rooms/worker/test/prod-retire.mjs`.

## Rollout checklist

Run in order; record dated evidence in this file, raw logs in a private path
outside the repository.

### Before deploy

- [ ] Worker contract suite, browser proof and fan-out harness pass locally
      (`rooms/worker`), plus API facade tests and `npm run test:docs`.
- [ ] Adversarial review separate from the contract tests: ownership checks
      after every `await`, same 404 for unknown/foreign/destroyed, reject bucket,
      ticket single use, no secrets in URLs, no content in logs.
- [ ] Production config read: account id, route, `workers_dev:false`,
      `preview_urls:false`, observability off, no `DEV_OWNER_TOKEN`,
      `ROOMS_TELEMETRY_ENABLED` off.
- [ ] `PRIVACY.md` and `api/RETENTION.md` diff approved by Adam
      (`privacy-notice-change.md`); notice decision recorded.
- [ ] Plugin skill gated and plugin tests updated (see matrix).

### Deploy (OPERATIONS.md order) and smoke

- [ ] D1 created and migrated; Worker deployed; settings read back.
- [ ] API migrated and deployed; `/rooms/limits` returns the enforced limits.
- [ ] Owner flow with the operator's key: create json and yjs rooms, issue bulk
      credentials, list, get, update expiry, freeze, export, revoke, delete.
- [ ] Participant flow: append with idempotency retry, catch-up paging, ticket
      WebSocket, presence, `end` frames for revoked, deleted and expired.
- [ ] Denials: Campus Pass 403, foreign owner 404, missing scope 403, expired
      ticket, kill switch off (503 / `disabled` / 404) and back on.
- [ ] Expiry: a short-lived synthetic room is destroyed by its alarm; record the
      delay after `expires_at`. Verify the D1 row and Durable Object are empty.

### Deployed fan-out measurement

The spike's fan-out numbers are local only (FACET-PLAN.md risks). Against
production, with synthetic rooms and the operator's key:

- [x] Ramp sockets in one room to `MAX_SOCKETS_PER_ROOM` (200), then one more
      (expect 429 `room_busy`).
- [ ] At 50 appends/s and at the presence limit, measure delivery latency
      percentiles to every socket, dropped or delayed frames, and Durable Object
      CPU/duration from billing metrics (observability stays off).
- [x] Repeat with a 30–150 phone presence-only workload shape (audience-cursor
      deck in DECISIONS.md) to price fan-in rooms.
- [x] Record cost per room-hour; adjust limits only by DESIGN.md change.
- [x] Delete every synthetic room and confirm 404.

### Browser proof against production

- [ ] Load `client/demo/editor.html` (Tiptap 3, pinned import map) with
      `https://bayleaf-rooms.dev/client/y-bayleaf@1.js` in two real browsers on
      different networks; co-edit, show carets, reload, catch up.
- [x] Freeze mid-edit: editors report `read_only`, queued edits sync after
      unfreeze, nothing dropped. Oversize paste reports `diverged`.
- [x] Export `?format=yjs` and rebuild the document with no BayLeaf dependency.
- [x] Provider served with `Access-Control-Allow-Origin: *` and one-hour cache.

### Retirement and recovery

- [ ] Synthetic owner retirement: ledger row written with identity deletion,
      daily job acknowledges, fence present, rooms destroyed, sockets ended.
- [x] `retireOwner` succeeds while `ROOMS_ENABLED` is off.
- [x] Local restore drill for the recovery steps in OPERATIONS.md.

### Exposure verification

- [ ] Desktop and hosted: fresh-session discovery with a natural task ("I want
      my students to share sticky notes live from a page I host on GitHub")
      without naming BayLeaf or Rooms; record harness, model and behavior.
- [ ] Negative discovery: no Rooms tools, no Chat mention, skill absent or
      explicit when disabled.
- [ ] Installed skill text and plugin pin read back from a real sandbox.

## Accepted limitations

None yet. Record any the operator accepts for launch here, with the date.
