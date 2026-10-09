# BayLeaf Sandboxes public home

`sandbox.bayleaf.dev` is the public service home for **BayLeaf Sandboxes**.
Use singular “your sandbox” for an individual workspace. The hostname stays
singular. The Worker serves a public overview and an authenticated managed-service
dashboard. OpenChamber is the first service, not the name of the whole workspace.

`worker.js` owns same-origin HTTP/auth adapters; `page.tsx` owns presentation.
`wrangler.jsonc` pins the BayLeaf account, domain and named API service binding.
Deploy from the repository root with:

```sh
./api/node_modules/.bin/wrangler deploy --config sandbox/wrangler.jsonc
```

Authentication reuses the API's CILogon authority through a two-host browser-proof
handoff and single-use authorization code. The API issues a separate, revocable
Sandboxes session; its opaque token stays in a Secure/HttpOnly host-only cookie.
`MANAGEMENT` binds to the API's named `SandboxManagement` entrypoint. This Worker
has no D1 binding, provider credentials, or user API keys. Never broaden cookie
scope or introduce a second OAuth application. See `README.md` and issues #84/#87.

Completed explicit sign-in triggers one best-effort wake/poke of an existing
sandbox. Public visits, authenticated reloads and status reads stay passive.
Login never creates a machine or installs/starts an application. Service setup
and repair are separate exact-Origin POST actions. Existing owner-scoped lifecycle
coordination remains authoritative; low-level controls, including destruction,
live in the API dashboard. Unknown service IDs fail closed at the API binding.

Run `node sandbox/test-worker.mjs` from the root for adapter checks. API broker
and lifecycle tests are documented in `README.md`. Deployment requires the API
migration and entrypoint first; do not deploy the home against the old API.

Verify the public page at desktop/mobile sizes and its links after changes.
The landing-page ACR does not cover this separate surface. Deploy first, commit
only when requested, following the root AGENTS.md.

Initial deployment: `6dd3b8bb-d9f0-4ac0-b33b-23b9bf7ed677` (2026-10-05).
Live GET/HEAD and desktop/mobile rendering of that initial teaser were verified.
Managed dashboard deployment and live handoff evidence are recorded in `README.md`.
