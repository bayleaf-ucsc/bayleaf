# bayleaf-rooms Worker

The production Worker for BayLeaf Rooms (issue #159). Contract: `../DESIGN.md`
(binding), public behavior in `../docs/`. Not deployed yet.

- `src/index.js`: everything in one file. The participant plane (`fetch`), the
  `RoomManagement` owner RPC, the `Room` Durable Object, the cron (expiry
  backstop and telemetry export) and the dev-only owner shim.
- `migrations/`: D1 owner index (`rooms`), retirement fence (`retired_owners`),
  telemetry windows (`metric_windows`).
- `client/y-bayleaf.js`: the Yjs provider, served as bytes at
  `/client/y-bayleaf.js` and `/client/y-bayleaf@1.js` through a wrangler `Text` rule.

## Run locally

```bash
npm install
printf 'DEV_OWNER_TOKEN=dev-owner\n' > .dev.vars   # enables the /owner/... shim, local only
npm run dev            # migrations, then wrangler dev on :8791 with ROOMS_ENABLED=true
```

`npm run dev` passes `--var ROOMS_ENABLED:true` because the source default is
`"false"`. It also passes `--local-upstream localhost:8791`: with a route in the
config, wrangler dev otherwise rewrites `request.url` to `bayleaf-rooms.dev`,
and ticket URLs would point there. `--test-scheduled` exposes
`/__scheduled` for triggering the cron.

The owner shim (`/owner/rooms...`, `/owner/retire`) calls the same `call()` as the
RPC entrypoint, so local tests exercise the real owner path. The owner is the
`X-Dev-Owner` header (16 to 128 of `[A-Za-z0-9-]`), defaulting to a fixed dev owner.

## Tests

```bash
npm test                       # fresh state; three wrangler runs on :8791 (main, low limits + telemetry, kill switch off)
node test/browser.mjs          # with npm run dev and: python3 -m http.server 8790 --directory client
node test/fanout.mjs           # with npm run dev; a local measurement, not deployed evidence
```

`npm test` runs `test/spike.mjs` (the spike's checks), `spike.mjs verify` (state
survives a restart) and `test/prod.mjs` (quota, foreign owners, retirement, kill
switch, limits, expiry by alarm, cron backstop, telemetry export to a local stub,
public surfaces). It inspects D1 with `wrangler d1 execute --local`.

## Config notes

- Limits are vars in `wrangler.jsonc`; code defaults match DESIGN.md if one is
  missing. `getLimits` reports what is enforced.
- `ACCEPT_LIMIT` (1000/60 s per room) is spent by authenticated participant HTTP
  requests; `REJECT_LIMIT` (30/60 s per room) by failed `rk_` and ticket
  authentication. Missing bindings fail closed with 503.
- Telemetry counts and writes nothing unless `ROOMS_TELEMETRY_ENABLED` is exactly
  `"true"` and `ROOMS_TELEMETRY_WRITE_SECRET` is set. `ROOMS_TELEMETRY_URL`
  overrides the collector for local tests only; production leaves it unset.
- Timestamps are epoch ms in storage and ISO 8601 in every response.

## Placeholders before the first deploy

- `database_id` in `wrangler.jsonc` is all zeros: create the D1 database and
  paste its id (`../OPERATIONS.md`, deploy order step 2).
- `ROOMS_ENABLED` is `"false"` in source; set it to `"true"` in the deploying change.
- `ROOMS_TELEMETRY_WRITE_SECRET` is unset; add it with `wrangler secret put`
  only when the vocabulary is approved.
- Check that `DEV_OWNER_TOKEN` is not set on the deployed Worker.
