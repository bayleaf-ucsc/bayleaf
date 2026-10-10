# BayLeaf Sandboxes dashboard

The public home explains the shared workspace and available managed services.
Signed-in owners can set up, resume, open or repair OpenChamber, code-server and dufs.
The code-server and dufs additions are implemented locally, pending deployment and live
qualification. All use the same workspace and owner-authenticated private proxy.

## Managed-service seams

- `api/src/serviceDefs.ts` provides orchestration metadata: service ID, state root,
  reserved port, preview slot, credential requirement, memory floor and diagnostic
  allowlists. It does not duplicate Python's installation or health logic.
- `api/scripts/browser-setup.py` provides named per-app install, configure, launch,
  bootstrap and health functions, selected through `SERVICES`. Shared locks,
  atomic state, verified archive checks and process identities stay common.
- `sandbox/services.ts` provides card copy, labels and errors. Only OpenChamber
  has a measured progress estimate; other services show steps and elapsed time.
- The owner controller retains legacy OpenChamber storage key `operation` and
  uses `operation/<service>` for other apps. A central scheduler owns the single
  Durable Object alarm, including independent link expiries and revocation retries.
  One setup may be opening per owner. Another service's start/restart returns
  `409 service_busy`, with no borrowed operation ID and no implicit queued job.
  Status remains independently readable. Each short provider callback is serialized,
  not the entire alarm-spanning setup. Ambiguous machine-creation intent is persisted
  owner-wide; an absent result cannot trigger another service's duplicate create.

dufs tested the third-service seam: registry entries, Python adapters and UI copy,
plus isolation/readiness tests. The common archive installer gained asset naming
and layout callbacks for dufs's flat musl archive. No new DO, controller/gateway
branch, login authority or synchronous installation route was needed. dufs serves
`~/workspace`, with browsing, upload/download, text editing, deletion, search,
archive download and hashes; outside-root symlinks stay disabled.

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

Local code-server qualification, 2026-10-09: 21 Python installer tests, 21 workerd
lifecycle checks, creation-policy/rendering tests, service-session/adapter checks,
35 preview-security checks plus five fixture tests, and TypeScript passed. Local
browser inspection exercised the two cards, mobile layout, and busy/retry message.
Verified behavior includes independent expiry/restart, central alarm retention,
sleep-wake sibling invalidation, ambiguous creation, no editor key upload, and
passive reconciliation of legacy shorter preview deadlines. ✨

Review-fix/dufs qualification, 2026-10-09: 24 Python installer checks and 25
workerd lifecycle checks passed, including fake-clock due-time scheduling,
401/403 correction/retry, ambiguous response/transport outcomes, archive symlink
chains and size bounds, inherited-key stripping, dufs on a 1-GiB machine, private
binding, three coexisting links and isolated restart. Session-binding, dashboard,
35 preview-security/five fixture checks and TypeScript also passed. These remain
synthetic tests; real Linux descendant cleanup and live app use need qualification. ✨

For a synthetic interactive preview (no real login or compute):
`cd api && node scripts/preview-sandbox-status.mjs`, then open
`http://127.0.0.1:8766`. Its identity and ready application URL are fixtures.

Local qualification, 2026-10-08: the actual two-Worker handoff, broker security,
browser adapter, installer/lifecycle, progress animation, preview-security and
temporary-token regressions passed, along with API TypeScript checks. Synthetic
browser setup reached ready. Production compute setup remains for owner evaluation. ✨

## Rollout

### code-server and dufs additions: deployed 2026-10-09

Deployed with approval, API first: `bc025e0d-bec5-4f51-b1db-c79e4fdaf3fc`,
then Sandboxes `5ca9bc28-17e2-4a87-9eec-8f6ffef451b6`. Plugin pin unchanged.
The live authenticated desktop dashboard renders all three cards and returns
passive service status (the owner's machine was stopped). Initial browser
navigation received the previous revision during propagation; reload confirmed
the new revision. No application was launched during this deployment check.
The application-level live gates below remain pending.

Live code-server qualification exposed a readiness bug: v4.141.0 returns
HTTP 200 with `status: expired` and `lastHeartbeat: 0` before a browser connects.
That describes browser activity, not application failure. The installer now
accepts both documented activity states (`alive`, `expired`) while retaining
the configured-release/process-identity checks. The 25-test installer suite
includes the observed response. API fix deployed as
`f26c40ad-edb4-4185-aad1-322347d386bc`; dashboard Refresh buttons were separately
removed in Sandboxes `a1113816-ba2d-4a5f-b961-829f2a95d516`.
The compact app-card redesign was deployed as
`17875140-11ce-4c35-8fe1-77a745c58f19`, with shared Chat/workspace orientation
and collapsed app diagnostics and retention/privacy details.

No new D1 migration: all slots use deployment `__browser` and migration 0013's
existing owner-key fingerprint column. OpenChamber retains slot `__browser`;
code-server uses `__code-server`; dufs uses `__dufs`. Existing service-session migration 0014 is a
prerequisite on a fresh environment. With approval, deploy the API first, then
the Sandboxes Worker. This also corrects the managed gateway's old six-hour cap
to the advertised 24-hour maximum; existing registrations are not extended.

Live gates: verify signed-out desktop/mobile cards, owner sign-in, fresh editor
installation, editor and terminal interaction through the private proxy, anonymous
and other-owner denial, dufs browsing/upload/edit/download and outside-root denial,
repeat launch, isolated restarts, all three apps together,
sleep/relaunch, expiry/relink, key rotation, and memory under representative work.
Record versions and evidence here and in `api/SANDBOX-BROWSER.md` and
`api/PREVIEWS.md`; synthetic tests do not establish those results. Roll back the
frontend first if needed, preserving application files and existing schema.

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
## Local Nanobot and Jupyter additions (not deployed)

The presentation registry now includes Nanobot (preview) and JupyterLab alongside
OpenChamber, code-server and Files. Five cards use two desktop columns, with the
last card spanning the row, and a mobile stack. The API must be deployed first.
See [`../api/NANOBOT-POC.md`](../api/NANOBOT-POC.md) and
[`../api/JUPYTER-POC.md`](../api/JUPYTER-POC.md) for implementation, tests and
remaining live gates. Neither addition changes the CILogon/session authority.
## Shell (ttyd)

Deployed 2026-10-09: API `9f3ffc16-b694-47b5-b54d-a6071e82424f`, then
dashboard `a847518f-85c5-4e32-8a09-9f58a7b1cafb`. Initial `invalid_operation`
resolved without code changes after operator verification of the active bundles
and service binding. Adam's dashboard launched ttyd alone and reached ready in
16 seconds. Anonymous management/app HTTP and WebSocket requests returned 401.
Other apps were not restarted. Opening the private shell requires a fresh
CruzID Gold login, so live browser command execution remains pending Adam's login.

The sixth managed card opens a writable shell in the shared `~/workspace`.
Its service ID is `ttyd`, private port 8794, slot `__ttyd`. No inference key is
uploaded. Each connection gets a new shell; disconnecting ends that shell.
See [`api/SANDBOX-BROWSER.md`](../api/SANDBOX-BROWSER.md#shell-ttyd)
for the verified binary pin, Basic-auth/origin boundary and qualification.
Deploy API first, then this dashboard; no migration or plugin release is needed.
