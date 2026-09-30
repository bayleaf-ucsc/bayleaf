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
