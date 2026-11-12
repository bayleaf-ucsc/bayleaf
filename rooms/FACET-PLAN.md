# Rooms as a production facet: plan from the Inboxes precedent (2026-11-11)

This is research, read-only, done for `playbooks/new-service-facet.md`, with
Inboxes (#97) as the template. Paths are relative to the repo root; line numbers
were taken on 2026-11-11 and will drift.

## Settled by Adam (DECISIONS.md items 10–14), overriding the generic plan below

- **Participant host:** `bayleaf-rooms.dev`, registered 2026-11-11 and owned by the
  BayLeaf Cloudflare account. Verify the zone is in that account before deploying.
  Add it to the auxiliary-domains line in `landing/llms.txt`.
- **Lifetime:** fixed expiry (default 30 days, at most 90 days ahead), extended
  only by owner `PATCH`; no idle renewal. The Durable Object alarm is the reaper.
  A probe can't renew anything.
- **Rollout:** open to campus at launch. **No** `ROOMS_PILOT_OWNER`;
  `ROOMS_ENABLED` stays as the kill switch on both Workers.
- **Telemetry:** propose a vocabulary now for policy review (as with Inboxes: a
  dedicated writer key, a switch, 15-minute aggregates, no identifiers or content).
- **Exposure:**
  - Skills only, no agent tools (no MCP tools in `browser-setup.py`): the
    desktop catalog skill plus a hosted OpenChamber plugin skill, both teaching
    the HTTP API.
  - Full API docs: OpenAPI routes, `apiReference.ts`, `llms.ts`, `/docs/rooms.md`.
  - **App-token scopes** for the owner plane, plus a **dashboard card**.
  - **No Chat coverage.**
- **API shape:** scopes (`presence`, `append`, `manage`) with role shorthands,
  as in `docs/rooms-v2.md`.

## Inboxes precedent, by topic

1. **Owner plane.**
   - **Mount:** `api/src/index.ts:229` mounts `api/src/routes/inboxes.ts`.
   - **Request order:** disabled-404 gate before auth (`:63-67`), then auth
     middleware, then Zod; owner bodies capped at 4 KiB (`:55`).
   - **Who can own:** `owner()` (`:72-83`) accepts ordinary keys and sandbox
     credentials; Campus Pass gets 403.
   - **Identity** is `user_keys.account_generation`, never an email.
   - **Calls** are RPC over a service binding: `relay()` (`:137-150`) calls
     `c.env.INBOXES.<method>`, and `RPC_ERRORS` (`:47-54`) maps error codes to
     HTTP statuses.
   - **Trust** comes from the binding, not a secret. `InboxManagement extends
     WorkerEntrypoint` (`inbox/src/worker.js:1593-1617`), with
     `workers_dev:false` and `preview_urls:false`. Every method goes through
     `call()` (`:1581-1591`): flag, owner regex, retired fence, never throws.
   - **Quotas** are atomic in D1 inside the Worker; `getLimits` returns the
     limits actually enforced.
2. **Kill switches.**
   - `INBOXES_ENABLED` must be exactly `"true"` on both the API and the Worker.
     Off on the API means 404; off on the Worker means 503 and RPC `disabled`.
     `retireOwner` keeps working while disabled.
   - `INBOXES_PILOT_OWNER` restricts access to one operator's account
     generation, then is set to `""` to open the campus.
   - Pilot state appears in `docs.ts`, `apiReference.ts` and `llms.ts`.
   - **Deploy order:** telemetry vocabulary → Worker migrations → Worker → API
     migrations → API. Staging script: `api/scripts/stage-inboxes-deploy.py`.
3. **Lifecycle.**
   - One destruction path; use never renews a lifetime; sweeps run on a fixed
     work budget.
   - **Account deletion:**
     1. A `inbox_retirements` ledger is written in the same transaction as
        identity deletion (`api/src/userRetention.ts:62-63`).
     2. A daily retry calls the `retireOwner` RPC.
     3. The Worker writes a permanent `retired_owners` fence.
4. **Disclosure.**
   - `PRIVACY.md:33-44` (collection), `:45-58` (telemetry), `:213-243`
     (retention); `api/RETENTION.md:15-26`; `landing/llms.txt:33` lists the
     auxiliary domains "kept apart from bayleaf.dev for cookie isolation".
   - The landing page and README don't mention Inboxes.
   - `PRIVACY.md:43` is stale (it still says campus access is disabled).
   - `privacy-notice-change.md`: one revision, Adam approves the diff, and
     commit equals publish.
5. **Telemetry.** 15-minute aggregate counts with their own writer key and
   switch, needing collector policy approval (`telemetry/AGENTS.md:26-29`).
   The HF gateway shipped with no telemetry.
6. **Monitoring.** Inboxes have no probe. The pattern to copy is the passive
   `/api/sandbox` existence probe (`chat/probe/AGENTS.md`, `probe-extension.md`),
   which needed a reaper exemption.
7. **Agent exposure.**
   - **Required:** an exposure matrix (expose / defer / omit / not applicable
     per surface), negative-discovery checks, and a human gate on scope
     (`bayleaf-powered-agent-capabilities.md`). Inboxes' matrix is at
     `inbox/QUALIFICATION.md:55`.
   - **Desktop:** skill catalog in `api/src/routes/docs.ts`.
   - **Hosted:** skills live in the `api/sandbox-plugin` submodule
     (`bayleaf-ucsc/opencode-sandbox`, not checked out in this worktree); MCP
     allowlist and flags in `api/scripts/browser-setup.py:617-770`.
8. **Lessons not to relearn.**
   - Use a separate rate-limit bucket for failed auth; a missing binding fails
     closed with 503.
   - Reserve quota before writing; recheck authorization after any `await`.
   - Return the same 404 for unknown, foreign and destroyed resources.
   - Log no content or identifiers; keep observability off.
   - Report the limits actually enforced, not hard-coded numbers.
   - Label stored content as untrusted.
   - Disclose point-in-time recovery history as a residual (Durable Object PITR,
     like D1 Time Travel).
   - Run an adversarial review separate from the contract tests.

## Plan for Rooms

1. **Posture and docs.**
   - Rooms add no new subprocessor but are a new content store outside
     ZDR/ZOA, so the full `privacy-notice-change.md` workflow applies.
   - Edit `PRIVACY.md`, `api/RETENTION.md` and the root `AGENTS.md`.
   - Create `rooms/AGENTS.md`, `rooms/DESIGN.md` and `rooms/OPERATIONS.md`.
2. **Production Worker `bayleaf-rooms`.**
   - Explicit `account_id`, `workers_dev:false`, `preview_urls:false`,
     observability off, participant host route.
   - Rate-limit bindings: accept/append plus a separate failed-auth bucket.
   - `ROOMS_ENABLED`, plus a telemetry switch if telemetry is adopted.
3. **Owner index.**
   - `RoomManagement extends WorkerEntrypoint` replaces `/owner/*` and
     `OWNER_TOKEN`.
   - A D1 table `rooms(id, owner_generation, state, expires_at, ...)` handles
     listing, the atomic per-owner cap and retirement. Durable Objects alone
     can't enumerate rooms by owner.
4. **API facade.**
   - `api/src/routes/rooms.ts`, copying `inboxes.ts`.
   - Schemas, types, the mount, and `ROOMS`/`ROOMS_ENABLED`/`ROOMS_PILOT_OWNER`
     in `api/wrangler.jsonc`.
   - Mentions in `apiReference.ts` and `llms.ts`; tests in
     `api/scripts/test-rooms.mjs`.
5. **Retirement.** An API migration adds a `room_retirements` ledger, plus a
   `userRetention.ts` hook. `retireOwner` works while disabled and closes
   sockets.
6. **Limits** as config variables, reported by `getLimits`.
7. **Telemetry:** none at launch, or a reviewed vocabulary.
8. **Monitoring:** optionally a passive existence probe that must not renew
   any lifetime.
9. **Exposure:** `rooms/QUALIFICATION.md` matrix; desktop skill and
   `/docs/rooms.md`; hosted plugin skill; Chat and dashboard deferred;
   `landing/llms.txt` line.
10. **Deploy order:** Rooms Worker → API migration → API with pilot owner set
    → qualify → open to campus. One commit set linked to #159.

## Risks

- Fan-out cost and abuse at 200 sockets, untested on deployed Durable Objects.
- Capability links leak (fragment, localStorage, projected QR codes).
- Durable Object PITR means deletion isn't literal erasure.
- Retirement is eventual and must tear down live sockets.
- The hosted skill source lives in a submodule absent from this worktree.
