# BayLeaf Sandboxes dashboard

The public home explains the shared workspace and available managed services.
Signed-in owners can set up, resume, open or repair OpenChamber. The service
catalog is deliberately small: add a service description and its lifecycle
adapter when another service is actually supported.

## Boundaries

- `worker.js`: same-origin browser routes and host-only cookies. No provider
  credentials, user API keys, D1 access or general-purpose proxy.
- `page.tsx`: public overview and authenticated service cards with setup progress.
- API `SandboxManagement` named Worker entrypoint: session issuance/validation,
  a fixed managed-service allowlist, and access to the existing owner-scoped
  lifecycle controller. It is not mounted as a public HTTP route.
- API OIDC remains the identity authority. A two-host browser proof binds the
  login to both the initiating Sandboxes browser and the API browser. A short-lived
  single-use code is exchanged over the private binding; return destinations are
  fixed. Cookies never use a shared parent domain.
- Applications run on the existing private preview origins, never on the
  dashboard origin. The API dashboard retains key management, machine status,
  keep-alive and destructive deletion.

Successful sign-in schedules one bounded best-effort wake of **existing** compute.
If it is running, sign-in refreshes its activity timestamp. This counts as
recorded activity under the existing inactivity policy. Provider outages do not
block sign-in or cause replacement machines. Setup is the deliberate action that
can create compute and install/start an application. Page reloads and status
polling never wake compute or refresh activity.

Wake uses the existing owner's serialized controller queue. A sleeping machine's
old ready application state is retired before wake, because starting a machine
does not restore its application processes. Other managed services must apply
the same distinction between compute state, application state and link validity.

Signing out here revokes the Sandboxes session only. API and application preview
sessions remain separate. No inference-content retention changes are involved;
workspace files and histories still persist under the existing sandbox policy.

## Local qualification

```sh
node sandbox/test-worker.mjs
cd api
node scripts/harness-service-sessions.mjs
npm run test:sandbox-browser
npx tsc --noEmit
```

These use synthetic identities/providers. They do not qualify live CILogon,
production bindings, or actual app installation.

For a synthetic interactive preview (no real login or compute):
`cd api && node scripts/preview-sandbox-status.mjs`, then open
`http://127.0.0.1:8766`. Its identity and ready application URL are fixtures.

Local qualification, 2026-10-08: the actual two-Worker handoff, broker security,
browser adapter, installer/lifecycle, progress animation, preview-security and
temporary-token regressions passed, along with API TypeScript checks. Synthetic
browser setup reached ready. Production compute setup remains for owner evaluation. ✨

## Rollout

Deployed with approval on 2026-10-08: migration `0014_service_sessions.sql`,
API `92c3b96b-aa76-4e82-a2b6-decb408c7f8b`, Sandboxes
`b6007714-d648-4cab-b44d-57c4c2f5e893`. Live public overview, HEAD, API health,
browser sign-in handoff, authenticated service status and the API's expanded
machine controls passed. Live inspection also exposed an old managed-machine
record: passive status now rediscovers a replacement after a confirmed 404,
without inheriting the old app URL. Eighteen synthetic lifecycle checks passed.
The live dashboard subsequently reported OpenChamber ready. Application interaction
remains owner evaluation; a fresh CILogon challenge was not separately qualified.

Live browsers exposed two issues absent from HTTP fixtures: `no-referrer`
suppresses native form Origin, and Chromium applies `form-action` across redirect
chains. Form-bearing pages now use `strict-origin`; login POST ends with a
same-origin continuation document that starts a fresh navigation to the broker.
Auth responses otherwise retain `no-referrer`. Exact-Origin CSRF remains enforced.
Updated adapter/two-Worker checks passed before the final frontend deployment.

This is a coordinated two-Worker change. With approval:

1. Apply the service-session D1 migration using the API's existing database.
2. Deploy the API with its named `SandboxManagement` entrypoint.
3. Deploy `sandbox/wrangler.jsonc` using the existing root command.
4. Verify anonymous desktop/mobile presentation; sign-in return; session-only
   wake; setup/resume/repair; private application access; and low-level API links.
5. Record Worker versions and live qualification here. Commit/push separately
   only when requested.

If the frontend must be rolled back, redeploy its previous version first. Do not
remove the API entrypoint while the new frontend still depends on it. The new
tables can remain inert; no destructive schema rollback is needed.
