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
4. **Provider probes when needed.** Both mint a 120-second signed URL directly
   from Daytona (no gateway) for a throwaway echo app:
   - `api/scripts/probe-daytona-forwarded-host.py`: which app-visible headers
     carry the capability, with and without `X-Daytona-Trust-Forwarded-Host`.
   - `api/scripts/probe-daytona-proxy.py`: Daytona's default CORS layer, the
     `X-Daytona-Disable-CORS` opt-out, and auth cookies on signed responses.
5. **Fetch Metadata check.**
   `uv run --script api/scripts/qualify-preview-fetch-metadata.py` cross-compiles
   a Go app using `http.CrossOriginProtection` (needs local Go >= 1.25; the
   sandbox cannot download Go) and expects 200 for same-origin `fetch` and form
   POSTs. A 403 "Sec-Fetch-Site is missing, and Origin does not match Host"
   means `Sec-Fetch-*` stopped being forwarded.
6. **Real app check** for compatibility reports: ask Adam (or the reporter) to
   retry the app with no `upstream_headers`, then a deliberately failing request
   to confirm the app's own error body arrives.
7. **Record.** Evidence and version ID in `api/PREVIEWS.md`; conformance
   changes in the Lathe contract §12; a line in the log below.

## Daytona references

Daytona's production code is **closed source since 2026-06-11**
([announcement](https://www.daytona.io/dotfiles/updates/daytona-is-going-closed-source),
citing AI-assisted vulnerability discovery). The public repository
<https://github.com/daytonaio/daytona> is archived and unmaintained; its last
tag is `v0.190.0` (`01c502bb1f1f`), while hosted docs were at v0.226 by
2026-10-27. SDKs and docs now live under <https://github.com/daytona>.

Consequences for this playbook: archived source is a **hypothesis generator**
(the 2026-10-27 audit found every behaviour below in `libs/common-go/pkg/proxy`
and `apps/proxy`), and only the live probes are evidence about production.
Re-probe after Daytona changelog entries touching previews.

Authoritative documentation:
- Preview URLs, signed vs standard tokens, reserved ports:
  <https://www.daytona.io/docs/en/preview>
- Custom preview proxy (appended `X-Forwarded-Host`,
  `X-Daytona-Trust-Forwarded-Host`, other `X-Daytona-*` controls):
  <https://www.daytona.io/docs/en/custom-preview-proxy>
- Changelog: <https://www.daytona.io/changelog>

Behaviours observed live on signed URLs (2026-10-27):
- `Host` becomes `localhost:<port>`; a second `X-Forwarded-Host` with the
  signed capability hostname is appended after the client's value.
- `X-Daytona-Trust-Forwarded-Host` has no effect (signed URLs never pass its
  preview-token gate).
- Default CORS echoes any `Origin` with `Access-Control-Allow-Credentials:
  true` and answers preflights itself (204, app never sees them).
  `X-Daytona-Disable-CORS: true` turns that off, is stripped, and lets the app
  handle CORS and preflights. BayLeaf sends it (and drops `Access-Control-*`
  response headers regardless).
- No `daytona-sandbox-auth-*` cookie is set on signed-URL responses.
- From source only (unverified live): a valid Daytona Bearer in
  `Authorization` is consumed by the proxy; a client `X-Daytona-Authorization`
  shadows the runner credential (401); `?DAYTONA_SANDBOX_AUTH_KEY=` is an auth
  query parameter; `X-Daytona-Skip-Last-Activity-Update: true` reaches the app.

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
- 2026-10-27 (open-question pass): Go 1.25+ `http.CrossOriginProtection`
  rejected same-origin POSTs behind BayLeaf (no `Sec-Fetch-Site`, `Host` is
  localhost). Forwarded `Sec-Fetch-*` as browser basics and added
  `X-Daytona-Disable-CORS`; deployed `066869e8-0779-4673-9b25-55bd2c4fff02`;
  Go check 200 and contract script 25/25. Daytona source audit used the
  archived repo; see Daytona references.
