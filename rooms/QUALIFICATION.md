# Rooms qualification

Status as of **2026-11-11**: local only. Nothing is deployed, and no row below has
live evidence yet. Contract: [DESIGN.md](DESIGN.md). Deployment and recovery:
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
| Hosted OpenChamber, all owner verbs | **Expose.** Same reason; the sandbox credential is the sanctioned owner path | Plugin skill `api/sandbox-plugin/skills/bayleaf-rooms/SKILL.md`; curl with `$BAYLEAF_API_KEY` to `api.bayleaf.dev` only | Same server enforcement. Credential substituted by Daytona for `api.bayleaf.dev` only; skill forbids putting it in apps or links | Plugin commit, push, then API pin. Plugin `index.mjs`/`test.mjs` need a Rooms gate and updated skill-set assertions (not yet done) | Pending: installed skill text and pin read back, behavioral discovery in a fresh session |
| MCP tools (hosted shared MCP, plugin tools) | **Omit**, by decision. Rooms is multi-step app building, better taught than wrapped; secrets would land in tool output | None | n/a | Revisit if AX shows agents failing with curl | Negative discovery: no `rooms` tool in plugin or shared MCP inventory |
| BayLeaf Chat | **Omit**, by decision. No owner credential path in Chat; copying room content into Chat adds stored history | None | n/a | Revisit on a concrete course request | Negative discovery: no Chat tool, model or prompt mentions Rooms as usable |
| API dashboard card | **Expose.** Owners need to see expiry and delete without an agent | Card listing rooms with label, codec, expiry, delete | Session-gated; delete confirms | API deploy | Pending: real owner login, list, delete of a synthetic room |
| App-token scopes | **Expose.** `rooms.read` (limits, list, get, export), `rooms.manage` (create, update, delete, credentials), following `api/src/grants.ts` and `SCOPES.md` | Consent page lists the scopes | Grant gate; `rooms.manage` lets an app mint room links and delete rooms | API deploy | Pending: scope denial both ways, export under `rooms.read` only |
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

Pending: one exported telemetry window from real traffic; deployed fan-out
measurement; browser proof against production; retirement exercised live.
Note: a client that looked up `bayleaf-rooms.dev` before the domain existed may
cache the negative answer for up to 30 minutes (zone SOA minimum 1800 s).

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

- [ ] Ramp sockets in one room to `MAX_SOCKETS_PER_ROOM` (200), then one more
      (expect 429 `room_busy`).
- [ ] At 50 appends/s and at the presence limit, measure delivery latency
      percentiles to every socket, dropped or delayed frames, and Durable Object
      CPU/duration from billing metrics (observability stays off).
- [ ] Repeat with a 30–150 phone presence-only workload shape (audience-cursor
      deck in DECISIONS.md) to price fan-in rooms.
- [ ] Record cost per room-hour; adjust limits only by DESIGN.md change.
- [ ] Delete every synthetic room and confirm 404.

### Browser proof against production

- [ ] Load `client/demo/editor.html` (Tiptap 3, pinned import map) with
      `https://bayleaf-rooms.dev/client/y-bayleaf@1.js` in two real browsers on
      different networks; co-edit, show carets, reload, catch up.
- [ ] Freeze mid-edit: editors report `read_only`, queued edits sync after
      unfreeze, nothing dropped. Oversize paste reports `diverged`.
- [ ] Export `?format=yjs` and rebuild the document with no BayLeaf dependency.
- [ ] Provider served with `Access-Control-Allow-Origin: *` and one-hour cache.

### Retirement and recovery

- [ ] Synthetic owner retirement: ledger row written with identity deletion,
      daily job acknowledges, fence present, rooms destroyed, sockets ended.
- [ ] `retireOwner` succeeds while `ROOMS_ENABLED` is off.
- [ ] Local restore drill for the recovery steps in OPERATIONS.md.

### Exposure verification

- [ ] Desktop and hosted: fresh-session discovery with a natural task ("I want
      my students to share sticky notes live from a page I host on GitHub")
      without naming BayLeaf or Rooms; record harness, model and behavior.
- [ ] Negative discovery: no Rooms tools, no Chat mention, skill absent or
      explicit when disabled.
- [ ] Installed skill text and plugin pin read back from a real sandbox.

## Accepted limitations

None yet. Record any the operator accepts for launch here, with the date.
