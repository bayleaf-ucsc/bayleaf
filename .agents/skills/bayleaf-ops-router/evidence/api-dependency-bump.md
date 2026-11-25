# Run evidence: api-dependency-bump

Dated record of past runs of [`api-dependency-bump.md`](../playbooks/api-dependency-bump.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-11-20: The SDK allows either major of `@hono/node-server`; GitHub's suggested patch on the old major did not address all advisories, and npm caught additional affected 2.x versions. The CLI/MCP checks passed with 2.1.6. For a repo-wide sweep, finish parent installs before running nested qualification suites that import from the parent's `node_modules`. Deployed API `438b3c1a-0262-437b-aa29-592743b25b65`; public JSON, Campus Pass identity and catalog, and owner-only grant denial passed. On campus, a request without a bearer is not necessarily anonymous.

- 2026-11-04 (Nanobot retirement): The Nanobot asset/build instructions in the
  2026-10-26 record below are historical. That managed surface is retired; use
  current package build hooks, not the removed adapter builder or fixture suite.

- 2026-08-25: drafted from issue #65 and api/AGENTS.md; never yet run.
- 2026-09-30: local-only Undici patch in API and Probe used overrides because Miniflare pins 7.29.0. Fixed the API Sharp override's direct-Miniflare coverage; no deploy/commit requested. GitHub documents Security → Dependabot → gear → Refresh Dependabot alerts for stale deleted manifests.
- 2026-10-12: Sharp 0.35.5 patch applied to API and Probe, preserving override coverage. Audits, credential harness, Probe tests, type checking and dry-runs passed. With approval, deployed API `e8613439-08de-4092-9db4-37f6d5a800d2` and Probe `e9ec7528-6a96-4a56-81ae-023b6935c6d0`; API JSON endpoints, authenticated catalog/plaintext inference and anonymous denial passed. GitHub CodeQL dismissal comments must fit 280 characters.
- 2026-10-26: repo-wide sweep (13 alerts: api, sandbox-cli, inbox, probe, vpat-recordings) in a fresh worktree. A global undici override in `inbox/` clobbered mailauth's undici 8; scope overrides under `miniflare`. `npm audit` found unflagged issues (api zod/hono, inbox sharp), so audit every lockfile, not just alerted ones. In a fresh worktree run `test:shared-mcp` (it builds plugin/nanobot assets) before `tsc`, `test:docs` or `test:computer`, or they fail on missing generated JSON. Test pretests leave `--fixture` Nanobot assets behind: before `wrangler deploy`, rerun `build-nanobot-assets.py` (no flag), `build-sandbox-plugin.py` and `build-sandbox-cli.mjs`. Deployed API `8a4f57b5-b7e6-4e8b-8b99-8ea026e8e767`; JSON smoke checks passed.
