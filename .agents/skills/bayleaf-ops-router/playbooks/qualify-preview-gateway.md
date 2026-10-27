---
source-skill: bayleaf-ops-router
description: Qualify the preview gateway (bayleaf-proxies.dev) against the Lathe preview-wrapper contract, synthetically and live, after forwarding/response changes or app compatibility reports.
last-reviewed: 2026-10-27
---

# Qualify the Preview Gateway

## When

- Any change to request-header building or response handling in
  `api/src/routes/previews.ts` (`upstreamRequest()`, `forward()`, the
  WebSocket Durable Object).
- A new revision of the Lathe preview-wrapper contract
  (`preview-wrapper/CONTRACT.md` in rndmcnlly/lathe). BayLeaf is one of its
  implementations; the contract owns the rules and the §9 case table.
- A user report that an app works on localhost but not through a preview
  (the Pi Pocket / `X-Pocket` case, bayleaf#118).
- A question about what Daytona's preview proxy does to requests.

Canonical facts live in `api/PREVIEWS.md` and `api/AGENTS.md`; this playbook is
the workflow. Contract changes go to the Lathe repo first (its §0).

## Gates

- Deploying the API Worker and running against the operator's own sandbox are
  fine once Adam authorizes the change. Committing and pushing still need his
  word.
- Credentials: Adam's key in `~/.tokens/bayleaf-api` (`BAYLEAF_API_KEY=`), and
  the BayLeaf org Daytona key from `api/.dev.vars` (`DAYTONA_API_KEY=`), not
  `~/.tokens/daytona-api` (a different org: its sandbox lookups 404).
  Load with `set -a; source ~/.tokens/bayleaf-api; eval "$(grep '^DAYTONA_API_KEY=' api/.dev.vars)"; set +a`.
- The upstream hostname is a bearer capability. Scripts print only case names,
  booleans, counts and suffixes. Never print hostnames, tokens or bodies.

## Steps

1. **Synthetic first.** `cd api && npm run test:previews` (39 checks) and
   `npm run test:sandbox-browser` (managed slots share the builder). Add cases
   for any new rule in `scripts/harness-previews.mjs`, reusing the `/status`,
   `/app-error`, `/large-error` fixtures.
2. **Type-check and deploy.** `npx tsc --noEmit && npm run deploy`; record the
   version ID. Allow tens of seconds for propagation before trusting results.
3. **Live contract cases.**
   `uv run --script api/scripts/qualify-preview-passthrough.py` starts a
   disposable echo app on port 5077 in the operator's sandbox (wakes it via
   `/sandbox/exec`), exposes it **public** via `/sandbox/expose`, runs the F, R,
   E and navigation cases, then revokes and kills the app (also on failure).
   Expect `{"passed": 25, "failed": []}`. Private mode is not covered live
   (needs a browser login); rely on the harness for it.
4. **Provider probes when needed.**
   `uv run --script api/scripts/probe-daytona-forwarded-host.py` mints a
   120-second signed URL directly from Daytona and reports which app-visible
   headers carry the capability, with and without
   `X-Daytona-Trust-Forwarded-Host`.
5. **Real app check** for compatibility reports: ask Adam (or the reporter) to
   retry the app with no `upstream_headers`, then a deliberately failing request
   to confirm the app's own error body arrives.
6. **Record.** Evidence and version ID in `api/PREVIEWS.md`; conformance
   changes in the Lathe contract §12; a line in the log below.

## Known traps

- `browser()` in the harness defaults to `Sec-Fetch-Mode: navigate`, so
  script-set headers are (correctly) dropped. App-request cases must pass
  `Sec-Fetch-Mode: cors` and `Sec-Fetch-Dest: empty`.
- The local client drops `Connection` before workerd, so nominated-header
  removal is not observable in the BayLeaf harness. The Lathe reference
  Worker's tests do cover it.
- Cloudflare's edge 403s any client request carrying `CF-Connecting-IP` before
  the Worker runs. Don't bundle it with other headers in one live request, or
  everything fails.
- Daytona rewrites `Host` to `localhost:<port>`, and **appends a second
  `X-Forwarded-Host` with the signed capability hostname** after ours. Echo
  fixtures must use `headers.get_all()`; a dict comprehension keeps the last
  (Daytona's) value and `get()` the first (ours), which looks like inconsistent
  behaviour across paths.
- `X-Daytona-Trust-Forwarded-Host` has no effect on signed preview URLs.
- `api/scripts/test-preview-compatibility.mjs` does not bundle (missing
  `.py` loader and `cloudflare:workers` external); it is not in `package.json`.
  Not a regression signal.

## Evidence and refinement log

- 2026-10-27 (bayleaf#118, Lathe #111/#112): header passthrough and app error
  bodies. Harness 39/39 and sandbox-browser 33/33; deployed
  `30d5e815-9621-48ad-906b-a5d9e73fede7`; live script 25/25. Found Daytona's
  appended `X-Forwarded-Host` and the trust header's inertness on signed URLs.
  First run of this playbook (written from that session); expect deviations.
