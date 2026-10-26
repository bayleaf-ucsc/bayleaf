---
source-skill: bayleaf-ops-router
description: Bump a dependency in BayLeaf API (api/) in response to a Dependabot alert, then deploy and smoke test.
status: rough
last-reviewed: 2026-08-25
---

# API Dependency Bump

## When to use

A Dependabot alert or issue names a dependency of `api/` (runtime or dev).
Most bumps need no behavior change; deployments are cheap.

Not for: OWUI image bumps (that is `owui-version-bump.md`), or a dependency
change that alters request handling in a way that could touch the ZOA posture
(see the gate below).

## Prerequisites

- Read `api/AGENTS.md` first, especially "Data posture: ZDR + ZOA target".
- Note: there is no `dependabot.yml` in this repo; alerts arrive via GitHub
  UI settings. Adding `.github/dependabot.yml` (npm ecosystem, `api/`)
  would make the cadence visible in-repo; propose it if alerts seem sporadic.

## Steps

1. Read the Dependabot alert. Classify the change: security fix, breaking
   major, or routine patch. Breaking majors get a closer read of the
   dependency's changelog; anything else proceeds.
2. **[HUMAN GATE]** If the change could alter how request bodies are handled
   (middleware, proxy libs, anything in the request path), confirm with the
   user that it does not add body logging or response caching. A revision
   that stores or logs request content is a material break of the ZOA
   posture per `api/AGENTS.md`.
3. Bump the version in `api/package.json` (or let `npm install pkg@version`
   do it) and regenerate the lockfile:

   ```bash
    cd api && npm install <pkg>@<version>
    ```

   For a transitive dependency pinned by its parent, use an npm override for
   the patched version rather than updating unrelated tooling. Check every
   installed copy with `npm ls <pkg>` and run `npm audit`; regenerate the
   lockfile and inspect it for unrelated changes. A nested override scoped to
   Wrangler does not necessarily cover a directly installed Miniflare.

4. Type check: `npx tsc --noEmit` in `api/`. Expected: no errors.
5. Deploy only if requested: `npm run deploy`. For development-only patches,
   local checks and `npx wrangler deploy --dry-run` can verify tooling without
   touching production.
6. Smoke test (see Verification).
7. Record: commit `api/package.json` + `api/package-lock.json` as
   `chore: bump <pkg> to <version>` (or `fix:` if it closes a vulnerability,
   referencing the alert).

## Verification

```bash
curl -sS https://api.bayleaf.dev/recommended-model       # JSON with slug + display name
curl -sS https://api.bayleaf.dev/docs/openapi.json | head -c 200   # OpenAPI 3.1 spec JSON
curl -sS https://api.bayleaf.dev/sealed/health           # kill-switch state JSON
```

Expect all three to return coherent JSON. **Propagation gotcha** (from
`api/AGENTS.md`): for tens of seconds after `wrangler deploy`, old and new
versions serve concurrently, so a surprising status immediately after deploy
is propagation, not a bug. Probe twice before investigating.

If the dependency touches the key lifecycle (`provision.ts`) or the Sealed
lane, also run the relevant harness from `api/TESTING.md` before committing.

## Rollback

For an authorized production rollback, `npx wrangler rollback` redeploys the
previous upload. For local dependency edits, reverse only this run's changes
and reinstall; never restore whole files that contain unrelated user work.

## Refinement log

- 2026-08-25: drafted from issue #65 and api/AGENTS.md; never yet run.
- 2026-09-30: local-only Undici patch in API and Probe used overrides because Miniflare pins 7.29.0. Fixed the API Sharp override's direct-Miniflare coverage; no deploy/commit requested. GitHub documents Security → Dependabot → gear → Refresh Dependabot alerts for stale deleted manifests.
- 2026-10-12: Sharp 0.35.5 patch applied to API and Probe, preserving override coverage. Audits, credential harness, Probe tests, type checking and dry-runs passed. With approval, deployed API `e8613439-08de-4092-9db4-37f6d5a800d2` and Probe `e9ec7528-6a96-4a56-81ae-023b6935c6d0`; API JSON endpoints, authenticated catalog/plaintext inference and anonymous denial passed. GitHub CodeQL dismissal comments must fit 280 characters.
- 2026-10-26: repo-wide sweep (13 alerts: api, sandbox-cli, inbox, probe, vpat-recordings) in a fresh worktree. A global undici override in `inbox/` clobbered mailauth's undici 8; scope overrides under `miniflare`. `npm audit` found unflagged issues (api zod/hono, inbox sharp), so audit every lockfile, not just alerted ones. In a fresh worktree run `test:shared-mcp` (it builds plugin/nanobot assets) before `tsc`, `test:docs` or `test:computer`, or they fail on missing generated JSON. Test pretests leave `--fixture` Nanobot assets behind: before `wrangler deploy`, rerun `build-nanobot-assets.py` (no flag), `build-sandbox-plugin.py` and `build-sandbox-cli.mjs`. Deployed API `8a4f57b5-b7e6-4e8b-8b99-8ea026e8e767`; JSON smoke checks passed.
