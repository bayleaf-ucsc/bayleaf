# Browser sandbox lifecycle

Issue [#81](https://github.com/bayleaf-ucsc/bayleaf/issues/81).
**Deployed and enabled on 2026-10-03 with explicit owner approval.**
The earlier amsmith-only spike is recorded in `SANDBOX-BROWSER-SPIKE.md`.

## Ownership and packet flow

The existing API dashboard is the durable management surface. No personalized
hostname is needed. A passive visit never creates or wakes a sandbox.

```text
Browser → API dashboard → owner-scoped SandboxBrowser Durable Object
                            ├→ Daytona control plane: observe/create/start
                            └→ Toolbox: transfer setup, launch, inspect breadcrumbs

Ready browser → private nonce origin → existing preview Worker/connection DO
                                     → private Daytona preview → OpenChamber
                                                                → local OpenCode
                                                                → BayLeaf inference
```

There is one lifecycle Durable Object per canonical owner email, reused across
setup operations and expiring private links. The existing gateway also has one connection DO
per preview hostname. These are evictable coordinators, not permanently running
VMs. A current operation's metadata and the latest failure summary are retained in lifecycle storage:
owner email, credential fingerprint, sandbox ID, operation ID, phase/step,
timestamps, deadline, content-free failure code, and the wrapped application URL.
It contains no credential, request content, file content, or application logs.

Setup status includes a bounded 40-event step timeline, start time, installer
heartbeat, and the previous failed attempt's code/time/duration across retries.
The dashboard polls every five seconds while opening and updates elapsed timers
locally. Installer/supervisor breadcrumbs preserve fast intermediate steps;
only allowlisted step/error codes and bounded timestamps enter the controller.

Deployed 2026-10-05 as Worker `02c431f1-90d0-4d19-b7dd-d6d942677a17`
(plugin `da32f3a`). Qualification: 16 installer tests, 17 synthetic lifecycle
checks, TypeScript, browser preview of progress/failure, and live OpenAPI/status.
The readiness check accepts current OpenChamber versions rather than requiring
2.1.0. Adam verified fresh production setup and supplied the 26-second timeline
used to calibrate the initial progress estimate.

## External contract

Current production: Worker `2208920e-1fd0-46f9-b2cb-fa7eb4de5193`, plugin
`6a393ed387d3d53e75a7a498f952c1e6b24bdd89`. Adam approved the production flow.
The animated meter is visible only during active setup; completion or failure
hides it, while the diagnostic timeline remains available.

Animation follow-up: Worker `31be04a1-0c8d-482a-82fe-fada4060b754` advances
estimated step progress with an exponential ease-out, capped at 97% of the
unconfirmed step. CSS smooths updates and pulses the active segment; reduced
motion disables both effects. All animation is local, with no extra polling.

2026-10-06 progress revision: one continuous time-weighted bar replaces the five
equal-width segment fills, retaining milestone labels. The owner's fresh run
calibrates a 26-second approximate baseline (13 seconds installing OpenChamber).
One animation-frame loop interpolates progress; each unconfirmed step caps at
90% of its budget, then pulses while waiting. Duplicate step events keep the
earliest timestamp. Reduced motion disables interpolation/pulsing; the loop stops
when setup exits. Status polling remains five seconds. Background tabs can suspend
animation frames; estimates reconcile on the next status response or visible frame.
Regression checks exercise timing, waiting, duplicate events and cleanup, not only
script syntax. The synthetic preview replays the owner's supplied timeline.

2026-10-05 follow-up: Worker `f034aaac-1cd7-49ed-8f46-7901cb7439c8`
pins plugin `6a393ed` with the renamed `bayleaf-sandboxes` skill. The dashboard
has five progress milestones using the observed 26-second fresh setup plus one
second per step (41 seconds estimated). Estimates stop short of unconfirmed
completion; overdue steps say so. The later setup-only display hides the meter
when the workspace becomes ready.
Plugin tests (13), installer tests (16), lifecycle checks (17), TypeScript, and
the synthetic browser preview passed; live authenticated config selects the pin.

All endpoints accept an ordinary personal BayLeaf key. Campus Pass and temporary
inference tokens are excluded. The dashboard uses the existing browser session;
mutations additionally require exact same-origin `Origin` and
`X-BayLeaf-Action: sandbox-browser`. Ownership never comes from request JSON.

| Endpoint | Effect |
| --- | --- |
| `GET /sandbox/browser/status` | Inspect controller metadata and passive control-plane status only |
| `POST /sandbox/browser/start` | Join active setup, reuse a ready link, or set up/resume browser access |
| `POST /sandbox/browser/restart` | Repair setup and restart the managed browser interface |

Start/restart returns 202 while opening. Concurrent requests converge on one
operation. The dashboard polls while setup is opening, not throughout ordinary
use. Even its status polls never call Toolbox. There is no countdown, extension
window, or end-session action. Refresh/focus checks only observe status.

Opening already-ready browser access keeps the URL and link expiry. Stopped or
archived machines need a deliberate start action. Sleep loses processes, so
the managed application is relaunched and gets a fresh preview generation.
No OpenChamber Desktop discovery or background reconnect can start compute or renew links.

The gateway caps the managed preview at the controller deadline and binds it
to a hash of the current owner key. Rotation/revocation denies new gateway
requests; socket sweep/revocation follows the existing preview contract.
Only managed browser previews forward `X-Opencode-Directory` for OpenChamber
workspace selection. This header has no role in gateway authentication.

Expired/unknown preview navigation offers a fixed link to the API dashboard.
Cached application/service-worker pages can still appear on an old origin;
this is not a promise to erase browser storage. Every replacement uses a nonce.

## State and durable orchestration

Machine state, installation state, and browser-link validity are separate. The DO
persists steps: discover → wake → prepare → inspect → register. Before side
effects it arms an alarm for retry/reconciliation. It does not keep the original
HTTP request open for installation, or rely on `waitUntil` to finish a job.

The operation has a 20-minute setup deadline, separate from its private link's
24-hour maximum lifetime. Link expiry is measured from setup initiation, so the
usable lifetime is slightly shorter. Signed Daytona tokens persist across
restart until expiry; the current resume flow still replaces the BayLeaf origin.
The owner-authenticated sleeping-page/resume enhancement is deferred to
[issue #85](https://github.com/bayleaf-ucsc/bayleaf/issues/85).
Provider calls are individually bounded. Definitive failures produce a visible
failure code and require an owner retry. An ambiguous create is not automatically
repeated: discovery must find the prior result or report `creation_uncertain`.
Provider lookup failure never means “absent.” Creation still shares Daytona's
label namespace with Lathe; cross-client creation races remain a qualification
concern, not something an owner-scoped BayLeaf lock can solve alone.

Setup status polling ends when ready. The next controller alarm is the link
expiry. At expiry the controller revokes the browser registration
without contacting Toolbox or stopping the shared sandbox. This avoids extending
inactivity or interrupting independent Chat/API work.

The local supervisor does not kill managed processes at link expiry. It waits
for application exit; Daytona idle stop governs compute lifetime. Owner-editable
files cannot authorize network access or extend the edge link expiry. Background
activity and new sockets do not renew the link.

**Compute cutoff qualification remains necessary:** loss of external activity should
lead to idle sleep after the configured grace period; concurrent independent
Chat/API work may legitimately keep the shared machine active. The implementation
does not claim a daily budget or forcibly stop unrelated work.

## Versioned installer contract

### V2 plugin integration

The Worker uses `sandbox-plugin/` for web search, page extraction, and curated
skills, with live sandbox-specific well-known config. Fresh setup installs
current OpenChamber and delegates OpenCode installation to it. The plugin is the submodule
`https://github.com/bayleaf-ucsc/opencode-sandbox`; the build derives its full
Git pin from the clean checkout. Push plugin changes before deploying the
Worker. The main repo's submodule update can remain uncommitted during evaluation.

Worker version `660d3221-4feb-4d9c-bb99-998308c5a4cf` deploys plugin commit
`da32f3a1f8051a33eaba56495e3b69e4ec1ebb03`, with usage and preview tools.
The redundant in-sandbox status tool was removed. Public discovery was verified
on the initial deployment.
This Worker also deploys the upstream-owned first-install flow described below.
Adam subsequently verified production onboarding by destroying and regrowing his sandbox.
Real isolated V2 Git installation, tools, skills, permissions and reload pass;
Adam rebuilt his sandbox and verified live search with the BayLeaf provider tag.
The new management tools pass isolated V2 Git-installation and permission tests;
their live production use remains to be verified. ✨

### Sandbox-specific agent skills

`api/sandbox-plugin/skills/` contains canonical environment guidance. OpenCode
registers them directly from the installed Git package. Initialize the submodule
with `git submodule update --init api/sandbox-plugin`, then run
`python3 scripts/build-sandbox-plugin.py` from `api/` before a standalone typecheck.
Running locations refresh the remote configuration every ten minutes. Local
user skills remain separate; the installer does not copy package skills globally.

The plugin exposes `bayleaf_usage`, `bayleaf_expose`, and `bayleaf_unexpose`
directly. Usage is a passive read; preview changes
request native permissions with distinct private/public resources. Credentials
stay inside the plugin, outputs are filtered, and private access is the default.
The `bayleaf-sandboxes` skill explains persistence, connected
services, budgets and preview workflow. `bayleaf-scheduling` is discoverable
before using OpenChamber's `schedule.*` tools: task definitions survive same-machine
sleep/restart, but execution requires running compute, missed runs are not replayed,
and sandbox deletion loses schedules. Near-term awake-workspace tasks are best effort,
not durable unattended automation. This scheduler behavior is source-inspected in
OpenChamber 2.1.1, not a live sleep/scheduling qualification.
No Python helper invocation is needed.
`/usage` reports USD and request allowances separately; unknown limits remain null.

Historical version `24a3b943-f7f7-4d32-a733-6846beba8790`: production restart reached
ready, OpenChamber discovered both skills, deletion/restoration of a bundled
skill passed, and the status helper retrieved live USD/Sealed allowances.
A synthetic server exposed through the helper denied anonymous private requests,
served the exact synthetic content with explicit public access, and returned 404
after revocation. The test server, preview, and files were cleaned up. Helpers'
captured tool traffic contained no owner key. Private fetches without navigation
headers correctly return 401 rather than redirecting.

`scripts/browser-setup.py` is embedded in the Worker as text. It uses Python's
standard library and a narrow Linux/Node-22-or-newer starting environment.
It reports unsupported prerequisites rather than installing arbitrary system
packages or repairing a mutated machine. It requires at least 2 GiB RAM and
1.5 GiB free disk for installation. Existing completed installations skip the
package-install step.

Managed root: `/home/daytona/.local/share/bayleaf/browser`, mode 0700.

```text
setup.py                   transferred, versioned setup program
request.json               operation ID, bounded setup deadline, explicit restart intent
setup.lock / runtime.lock  exclusive kernel file locks
releases/<release>/        user-owned global npm prefix for OpenChamber
current                    atomically switched release symlink
credentials/owner-key      mode 0600; separate authenticated file transfer
config/ data/ cache/       isolated XDG roots for the managed environment
openchamber/               managed application settings and histories
state/operation.json       atomic progress, timestamps, process identity
state/installation.json    completed release manifest
state/runtime.json         supervised process identity and credential fingerprint
state/task.json            currently owned setup subprocess
state/cancelled.json        explicit cancellation marker
state/setup.log             bounded, content-free phase/error events
```

Operations: `inspect`, `setup --operation <uuid>`, `supervise --operation <uuid>`
(internal), and `stop` (internal recovery only, not an API or dashboard action).
Repeated setup uses an exclusive lock, stages installation
separately, and switches current only after executable checks. Interrupted
staging is rebuilt; old releases and user files are preserved. Failed setup
never destroys the shared sandbox. Process cleanup checks PID, Linux boot ID,
process start ticks, and process-group leadership to avoid killing a reused PID.

First installation resolves `@openchamber/web@latest` into a private global npm
prefix. The application environment's `npm_config_prefix` points there too, so
OpenChamber's updater replaces the installation the launcher actually uses.
The release label versions our installation layout, not upstream applications.
Subsequent setup reuses the installation; it does not downgrade user updates.

BayLeaf does not install an OpenCode npm package or set `OPENCODE_BINARY`.
When `~/.opencode/bin/opencode` is absent, setup calls OpenChamber's own
`installOpenCodeV2` implementation. In OpenChamber 2.1.1 the web install action
rejects a completely missing binary, so the launcher imports that implementation
directly. OpenChamber selects the current stable V2 version and installation
path. This internal module path is a dependency to recheck when upstream changes.
BayLeaf no longer writes `update: disable` into fresh OpenCode configuration.

An isolated clean-HOME test with OpenChamber 2.1.1 installed OpenCode 2.0.24,
verified discovery/readiness and npm update ownership, and confirmed repeat setup
does not reinstall. Run `scripts/test-openchamber-onboarding.py --prefix <prefix>`
against a global OpenChamber installation to repeat it. This does not establish a
full self-update/restart: upstream's container updater leaves the server running,
and its foreground update UI can report a service-manager restriction. A deliberate
dashboard workspace restart uses updated files; no unattended restart is promised.

The script registers the
sandbox well-known connection and owner credential through authenticated V2 APIs.
Bootstrap explicitly targets `/home/daytona/workspace` and waits for its plugin
activation. The browser can discover that location before the connection is added;
checking only the server's default `/home/daytona` can report ready before the
workspace's remote configuration converges. Qualification covers this ordering
and plugin discovery in a subsequently opened project.
Local configuration contains installation policy, not a remote-config snapshot. A changed
credential restarts the managed application so it cannot retain the old key in
its environment. It does not provision backend keys or reset inference budgets.
User OpenChamber settings survive repeated setup. First setup seeds the shared
`/home/daytona/workspace` as the **workspace** project and selects a custom
light green **BayLeaf** theme with system-theme switching off. The theme uses
upstream's custom-theme loader under the managed `openchamber/themes/` directory;
it does not patch the application or change desktop defaults. Later theme and
project choices survive setup. Original global tooling/configuration is
not overwritten; project-local configuration still participates normally.

The ordinary owner key intentionally delegates broad API authority to code
running as that sandbox owner. It is never placed in argv, breadcrumbs, logs,
browser URLs, or setup stdout. Inference stays on BayLeaf's ZDR path; sandbox
files, histories, configuration, and credentials deliberately persist and are
not zero-operator-access data.

Port 3100 is exclusively reserved for this managed installation. At the owner's
request, setup reclaims it automatically: matching same-user listening processes
receive TERM, then KILL if necessary, with process identity checked before each
signal. Other ports and unrelated process groups are not targeted. An unrecoverable
conflict remains `port_in_use` in diagnostic state, with plain-language UI copy.
OpenChamber uses the supported unauthenticated-LAN override behind **private
Daytona transport and BayLeaf owner authentication**. Its relay is off. Managed
OpenCode uses OpenChamber's secured loopback connection. Public Daytona sandbox
exposure is incompatible with this design and must be ruled out before rollout.

The installer's port-availability probe binds all IPv4 interfaces to match the
application, then immediately closes without listening or accepting traffic.
A loopback-only probe could miss a conflict on a non-loopback interface. This
intentional wildcard bind is distinct from the application's real listener,
whose access depends on the private transport and owner-authenticated gateway.

## Verification and rollout

**2026-10-06, 24-hour-link simplification:** deployed Worker
`09db2448-eb9f-4c72-98a7-6e4ac9834125`, pinned to published plugin
`5e20fdfebb2ff7592eb176d552d21597200d9ea4`. Verified live OpenAPI has only
status/start/restart browser routes, authenticated sandbox config has the new
plugin pin, passive status works, and the daily reaper remains enabled. Installer,
shared creation policy, synthetic lifecycle and gateway security tests passed;
the simplified controls were exercised in a synthetic desktop/mobile browser.
No existing user's machine was restarted or resized for qualification. Old
six-hour links/runtimes transition on their next deliberate setup, not through
an automatic migration. The first new live 24-hour setup/expiry cycle remains
a separate production qualification. ✨

### Export before a manual migration

For a consistent migration backup, stop the managed application through the
sandbox shell first so it closes its databases (the installer's internal `stop`
action is available for operator recovery). Link expiry does not close them. Using
the existing sandbox exec/file API, archive the managed `openchamber/`, `data/`,
and `config/` directories plus `/home/daytona/workspace`. Download the archive
through the file API and confirm that it contains the wanted histories and files.
These exports contain user content and should stay in the owner's storage.
Do not copy `credentials/`, process state, locks, or installed releases into a
new machine. Setup must obtain the current key and regenerate runtime state.
Archive restoration has not yet been qualified; preserve the original sandbox
until the user has checked the restored files and histories.

### Qualification record, 2026-10-03

- Typecheck, Wrangler dry-run, seven Python failure tests, fourteen lifecycle
  harness checks, 25 preview security checks, and the grant regression suite pass.
- Disposable `daytona-medium` runs verified interrupted npm installation recovery,
  repeat setup without reinstall/restart, unchanged global OpenCode binary and
  version, preserved user configuration, mode-0600 credentials, and stop/wake plus
  archive/wake without reinstall. The full lifecycle run took 216 seconds.
- A real Chromium visit verified the custom light-green body background,
  seeded project, and BayLeaf GLM model after the startup overlay disappeared.
  `browser-qualification.png` records this UI with the **workspace** project.
  The application was
  reached through a temporary signed Daytona origin, not the new Worker routes.
- After the browser visit, cgroup memory was about 2.20 GiB, with a 2.35 GiB
  peak and no OOM events. This includes installation caches and is not a claim
  about anonymous working-set requirements or sustained agent workloads.
- The rendered dashboard-control component was exercised at a 390px viewport
  with synthetic responses: action header, setup progress, ready link, expiry,
  and absence of an expired-status request loop or horizontal overflow.
- All created qualification sandboxes were deleted and deletion was verified.
  User sandboxes and git history were unchanged during qualification.
- The local supervisor terminated the managed application at a shortened deadline,
  in the historical six-hour work-period implementation (removed by the 24-hour-link simplification),
  followed by provider idle sleep under an accelerated one-minute auto-stop grace.
  The final 132.6-second run included the updated workspace label and verified deletion.

Still unqualified: end-to-end production setup for this controller, the full
15-minute production idle grace, sustained representative agent work, and managed-history
export/recovery. The spike's earlier browser/gateway checks are separate evidence.

### Production rollout, 2026-10-03

Applied D1 migration `0013_browser_preview_owner.sql`, then deployed the Worker
and its new Durable Object binding with `BROWSER_SANDBOX_ENABLED=true`.
Version: `ff5c3c1a-110a-4ed8-91e2-f85a65f803a4`.
Live smoke checks: owner status returned HTTP 200 and idle lifecycle metadata;
anonymous status and start returned 401; OpenAPI contains the lifecycle routes;
the existing recommended-model endpoint remained healthy. Status inspection did
not install tools or begin browser setup on the owner's running sandbox.

Production follow-ups: version `6f29c17f-dcc1-41b9-9ad9-9f0de284aa6e`
suppressed stale setup errors when the backing sandbox has been deleted.
Version `2f0a441f-18ac-49c9-ac66-8b8c788f4864` creates the workspace directory
before application startup. The original live qualification fixture created it
itself and therefore masked a browser-first startup failure on fresh snapshots;
that fixture was corrected and the Python configuration test now checks creation.
After the fix, the deployed controller retried the owner's installation and
reached `ready` with an owner preview in about 16 seconds, without reinstalling.

Version `f61bec1d-3e0a-44b2-a30b-4e723fe9da72` fixes restart false conflicts:
the port probe now uses `SO_REUSEADDR`, matching Node, so TCP TIME_WAIT sockets
do not block startup. Reproduced on an unused port in the live Linux sandbox:
the old probe failed with errno 98 and the new probe succeeded. Retry now waits
for a living runtime instead of terminating it on a transient health failure;
explicit restart and credential/release changes still replace it. Dashboard
status responses are sequence-checked so stale failures cannot replace newer
readiness. Ten installer tests, fourteen lifecycle checks, typecheck, and a
browser delayed-response test passed. Deployment did not restart the active app;
the corrected installer is transferred on the next setup/restart operation.

```sh
npx tsc --noEmit
npm run test:sandbox-plugin
npm run test:sandbox-browser
npm run test:previews
npm run test:grants
npx wrangler deploy --dry-run
```

The local harness uses real workerd, D1 SQL, and Durable Object storage with a
synthetic Daytona service. It advances recorded alarm steps explicitly. It
tests authorization, passive status, concurrency, archived startup, credential
rotation, interrupted setup, expiry, provider outages, and missing-machine
creation. Python failure-injection tests cover locks, atomic state, cancellation,
installation rollback/retry, config preservation, stale readiness, and PID reuse.
These do not establish live service latency, provider billing, or actual idle sleep.

Live qualification is conducted on explicitly authorized disposable sandboxes,
with deletion verified independently. The first run found the default Daytona
image currently allocates **1 GiB**, and verified `requires_2_gib` fails before
installation. The approved resource policy uses `daytona-medium` for newly
created browser sandboxes and requires operator-assisted upgrades for existing
sandboxes below 2 GiB. The controller reports these before transferring a key.
The live API rejects resource overrides on snapshot creation and returns 404
for the documented `/sandbox/{id}/resize` route. `daytona-medium` is an available
2-CPU, 4-GiB, 8-GiB-disk container snapshot used for qualification and new
browser-created sandboxes. Do not assume
existing smaller sandboxes can be resized, or replace them automatically.

Before rollout: qualify clean installation, conflicting/custom installations,
interruption, stopped/archived wake, UI file/project headers, owner/non-owner
login, sustained streaming, key rotation, and browser-only expiry to sleep.
Verify the pinned assembly under representative agent work plus a subprocess.
Confirm backup/export instructions against actual managed histories. Review the
retention/privacy documentation and approve the resource policy.

For another environment, apply D1 migration `0013` before deploying code, then
deploy the new DO migration with `BROWSER_SANDBOX_ENABLED=false`. Enable only
with explicit rollout approval and review of the qualification boundaries above.

Rollback: disable the feature and revoke managed `__browser` preview slots.
Preserve user files and the shared machine. Installation removal and whole-sandbox
reset require separate explicit choices and prior export of wanted data.
