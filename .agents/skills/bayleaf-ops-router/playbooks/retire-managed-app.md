---
source-skill: bayleaf-ops-router
description: Retire a managed Sandboxes app (a launcher card backed by SERVICE_DEFS), keeping user files, failing old links closed and coordinating API, frontend, plugin and docs.
status: draft
last-reviewed: 2026-11-28
---

# Retire a Managed Sandboxes App

## When to use

Removing an app that `sandbox.bayleaf.dev` sets up for owners: an entry in
`api/src/serviceDefs.ts`, an adapter in `api/scripts/browser-setup.py` and a
card in `sandbox/services.ts`. Not for removing an API capability that agents
call (use `bayleaf-powered-agent-capabilities.md`), and not for Chat tools.

Read `sandbox/AGENTS.md`, `sandbox/README.md` and the "Browser sandbox
lifecycle" section of `api/AGENTS.md` first.

## Gates

1. **[HUMAN GATE] Depth.** Full retirement (registry, adapter, routes, docs in
   one change) is the default. A frontend-only hide leaves dead code and
   doc drift; choose it only if Adam wants a staged rollout.
2. **[HUMAN GATE] Positioning.** State why the app goes and what replaces it,
   in user terms. That sentence drives every copy edit below.
3. **Sizing is separate.** Removing an app does not by itself permit smaller
   sandboxes: other services keep their `memoryGiB` floors, setup enforces them
   (`requires_2_gib`), and existing machines are never resized. Measure before
   lowering floors or the creation size in `daytonaV2.ts`.

## Steps

1. **Map couplings before editing.** Grep the service ID, display name, port,
   slot and state-root directory across the repo, including the
   `api/sandbox-plugin` and `api/sandbox-cli` packages. Look for:
   - defaults that silently select the app (`?? '<id>'`, argparse defaults,
     unnamed storage keys, `select_service` fallbacks in tests);
   - public routes that only ever drove this app (the Sandboxes adapter
     forwards a service ID; older ordinary-key routes may not);
   - gateway special cases keyed on its slot (framing, header forwarding);
   - credential or config lookups that read its state root first;
   - plugin skills and docs that describe its UI or its native tools.
2. **API registry and controller.** Remove the `SERVICE_DEFS` entry. Reserved
   ports and `managedSlot()` derive from it, so the port frees itself and live
   links on the slot fail closed at the gateway. Remove fallbacks to the app;
   make the service explicit everywhere. Leave the app's old Durable Object
   record unread rather than migrating or deleting it.
3. **Installer.** Remove the adapter functions and any module-level defaults
   that pointed at the app. Keep shared helpers (`configure_agent`,
   `service_environment`) for the remaining apps. Run pyflakes.
4. **Never delete user data.** Do not remove the app's state root or files in
   user sandboxes, and do not wake or touch any sandbox. Its running process
   ends at the next sleep. Say so in the docs.
5. **Frontend.** Remove the card from `sandbox/services.ts`; update the page
   copy in `sandbox/page.tsx`, the examples and the "Not limited to this list"
   section. The Worker passes service IDs through, so `/services/<id>/*` then
   returns the API's 400 without a Worker change.
6. **Plugin.** If skills or tools mention the app, edit the submodule, run its
   tests, then commit and push `bayleaf-ucsc/opencode-sandbox` on `main` and
   rebuild the pin (`python3 api/scripts/build-sandbox-plugin.py` refuses a
   dirty submodule). Pushing is outward-facing: ask first.
7. **Tests.** Add the ID to the retired-service checks in
   `harness-sandbox-browser.mjs` (start returns 400; a legacy slot registration
   is refused in both access modes) and to `harness-service-sessions.mjs`.
   Update `test-browser-setup.py`, `test-sandbox-policy.mjs`,
   `harness-previews.mjs` and `sandbox/test-worker.mjs`. Run the suites in
   "Verification"; the `npm run` wrappers need a clean submodule.
8. **Docs.** Update current-state docs: `llms.ts`, `landing/llms.txt`,
   `GETTING-STARTED.md` (including screenshots), `SANDBOX-BROWSER.md`,
   `PREVIEWS.md`, the AGENTS/README files, these playbooks and the sandbox
   issue template. Rebuild `.sandbox-cli-assets.json` if `sandbox-cli/SKILL.md`
   changes. Leave dated evidence and decision records alone; add a short
   retirement note to canonical records instead.
9. **Deploy.** In order: plugin push, API, then Sandboxes
   (`./api/node_modules/.bin/wrangler deploy --config sandbox/wrangler.jsonc`).
   Before deploying the API:
   - `git fetch` and deploy from current `main` plus only this change. Never
     deploy a tree with someone else's uncommitted work, or with it set
     aside: either can roll back their deployed version.
   - Read every commit you are about to ship for deploy prerequisites
     (migrations, bindings, secrets) and apply them first.
   - Check `wrangler deployments list` to see what you are replacing.

## Verification

- Local: `npx tsc --noEmit`; `npm run test:sandbox-browser`,
  `test:previews`, `test:docs`, `test:sandbox-cli`;
  `node scripts/harness-service-sessions.mjs`, `test-sandbox-policy.mjs`,
  `harness-sandbox-plugin.mjs`, `harness-shared-mcp.mjs`; the plugin's
  `node --test test.mjs`; `node sandbox/test-worker.mjs`.
- Live: the public page has no card for the app; removed routes return 404;
  `/docs/openapi.json` and `/llms.txt` no longer mention them; an owner opens
  a remaining agent app successfully on the new pin.

## Rollback

Redeploy the previous Sandboxes version first, then the API version, from
`wrangler deployments list`. User files were never touched, so a redeployed
registry entry and adapter can set the app up again.

## Recording

One commit (`update: retire <app> ...`) with the submodule pin, after Adam's
go-ahead. Push only when asked. Add a dated entry to
`evidence/retire-managed-app.md` with versions, live results and what went
unverified.
