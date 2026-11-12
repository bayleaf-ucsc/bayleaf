# Rooms operations

Operational reference for the `bayleaf-rooms` Worker. [DESIGN.md](DESIGN.md) owns
the contract; [QUALIFICATION.md](QUALIFICATION.md) owns dated evidence. Deploying
is separate from publishing docs and `PRIVACY.md`. Never publish credentials,
room ids, account generations, links or room content, including in evidence.

## Configuration

- Account: BayLeaf `1a49fb69291d42e23c4ed4dcffce5bbc`; set `account_id`
  explicitly in `rooms/worker/wrangler.jsonc`. Confirm the `bayleaf-rooms.dev`
  zone is active in that account before the first deploy.
- Route `bayleaf-rooms.dev/*`; `workers_dev: false`, `preview_urls: false`,
  observability off. Never enable observability to debug: it would capture
  participant content.
- Durable Object `Room` (SQLite class), D1 binding `DB`, rate-limit bindings for
  accepted traffic and the separate `REJECT_LIMIT`.
- Vars: `ROOMS_ENABLED`, the limits listed in DESIGN.md, and
  `ROOMS_TELEMETRY_ENABLED` (keep `"false"` until the vocabulary is approved).
- Secrets: `ROOMS_TELEMETRY_WRITE_SECRET` only, set with
  `wrangler secret put` when telemetry is approved. Production never sets
  `DEV_OWNER_TOKEN`; check before every deploy.
- API side: `ROOMS` service binding to `bayleaf-rooms` (entrypoint
  `RoomManagement`) and `ROOMS_ENABLED` in `api/wrangler.jsonc`.

## Deploy order

Inspect remote migration ledgers first and apply only pending migrations, in order.

1. **Telemetry vocabulary**, once approved (see `telemetry/AGENTS.md`). Skip while
   telemetry stays off.
2. **Rooms D1.** First time only: `npx wrangler d1 create bayleaf-rooms`, then put
   the returned id in `wrangler.jsonc`. Then
   `npx wrangler d1 migrations apply bayleaf-rooms --remote` from `rooms/worker/`.
3. **Rooms Worker:** `npx wrangler deploy` from `rooms/worker/`. Read back the
   deployed settings: route, flags, bindings, no `DEV_OWNER_TOKEN`.
4. **API migrations** (the `room_retirements` ledger).
5. **API** with the `ROOMS` binding (see `api/AGENTS.md`).

The Worker must be live before any API deploy that includes the `ROOMS` binding.
After deploying, expect old and new versions to serve together for tens of
seconds; confirm surprising results with repeated requests before debugging.

## Kill switch

To stop the service, set `ROOMS_ENABLED` to anything but `"true"` on both
Workers and redeploy (Worker first, so participants stop at once):

- Worker: participant HTTP and WebSocket return 503; RPC returns `disabled`.
- API: `/rooms` returns 404.
- `retireOwner` keeps working, so account retirement is never blocked.

Rooms keep their stored content and their fixed expiry while disabled; alarms
and the cron backstop still destroy expired rooms. Disabling is not deletion.
Re-enable by restoring `"true"` on the Worker, then the API.

## Retirement

Account deletion writes a `room_retirements` row in the same transaction as
identity deletion (`api/src/userRetention.ts`). A daily API job calls
`ROOMS.retireOwner(owner)` until it returns `{retired:true}`. The Worker writes the
`retired_owners` fence first, then destroys every room the owner held. The fence
and the ledger row are permanent.

### Recovery after a database restore

Follow the Inboxes rule: **remain closed until reconciliation is verified**
([inbox/OPERATIONS.md](../inbox/OPERATIONS.md#recovery-remain-closed-until-reconciliation-is-verified)).

1. Set `ROOMS_ENABLED` off on both Workers before restoring anything.
2. Rooms D1 restored alone: replay every `room_retirements` entry, acknowledged
   or not, through `retireOwner`, and verify each fence exists and no live room
   row remains for those owners.
3. API D1 restored alone: keep the Rooms fences; reconcile their union with the
   restored ledger and write missing ledger rows back.
4. Both rolled back without independent deletion history: stay closed and ask
   the operator. Do not reset generations automatically.
5. Reopen only after verification and explicit operator approval.

Durable Object point-in-time recovery restores one room's storage to a bookmark
in the last 30 days through code running in that object
(`ctx.storage.onNextSessionRestoreBookmark`). Use it only for a documented
incident and never for a room that was destroyed by expiry, deletion or
retirement: restoring one would resurrect content the notice says is gone. There
is no production restore route; adding one is a material change.

## Rollback

- **Worker only:** `npx wrangler rollback` to the previous version. Never roll
  back across a D1 migration the older code does not understand; disable first.
- **API only:** roll back the API. The Worker keeps serving participants; owner
  management stops if the binding disappears.
- **Withdraw the service:** use the kill switch. Removing the Worker or its
  Durable Object class deletes every room immediately and is a destructive,
  operator-approved step, not a rollback.

## Troubleshooting

- 404 for a room the owner can see: it expired, was deleted, or the caller holds
  a credential for another room. All return the same 404 by design.
- 503 on participant requests: `ROOMS_ENABLED` is off, or a rate-limit binding is
  missing (fails closed).
- 429 `room_busy`: `MAX_SOCKETS_PER_ROOM` reached. 507 `room_full`: room byte
  cap. Read `/rooms/limits` before raising anything; never raise limits to make a
  test pass.
- Rows stuck in `destroying` are retried by the 15-minute cron, at most 20 a run.
