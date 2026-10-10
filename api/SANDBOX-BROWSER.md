# Browser sandbox lifecycle

**Pending issue #90 revision:** local code now uses independent, Daytona-held
sandbox credentials and sandbox-bound managed links. See
[`SANDBOX-CREDENTIALS.md`](SANDBOX-CREDENTIALS.md) for migration and qualification.
Historical deployment records below describe ordinary-key delegation. ✨

Issue [#81](https://github.com/bayleaf-ucsc/bayleaf/issues/81).
**Deployed and enabled on 2026-10-03 with explicit owner approval.**
The earlier amsmith-only spike is recorded in `SANDBOX-BROWSER-SPIKE.md`.

## Ownership and packet flow

The dedicated [BayLeaf Sandboxes dashboard](https://sandbox.bayleaf.dev) is the
management surface for hosted applications. The API dashboard retains low-level
machine status, keep-alive and deletion. No personalized hostname is needed.
Passive visits never create or wake a sandbox; completed explicit Sandboxes
sign-in starts one best-effort wake of existing compute, separate from app setup.
See [`../sandbox/README.md`](../sandbox/README.md) for the authentication boundary
and coordinated rollout. The dashboard move was deployed on 2026-10-08.

```text
Browser → Sandboxes dashboard → private API management binding
                            → owner-scoped SandboxBrowser Durable Object
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
inference tokens are excluded. The API endpoints retain their existing API browser
session support; mutations require exact same-origin `Origin` and
`X-BayLeaf-Action: sandbox-browser`. The Sandboxes dashboard uses its separate
host-only session and `X-BayLeaf-Action: managed-service` on same-origin service
POSTs. Its private binding resolves owner identity server-side and calls the same
controller. Ownership never comes from request JSON.

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
archived machines need a deliberate start action or a completed Sandboxes login
to begin waking compute. Login wake retires stale ready-app metadata but does not
restore applications. Sleep loses processes, so
the managed application is relaunched and gets a fresh preview generation.
No OpenChamber Desktop discovery or background reconnect can start compute or renew links.

The gateway caps the managed preview at the controller deadline and binds it
to a hash of the current owner key. Rotation/revocation denies new gateway
requests; socket sweep/revocation follows the existing preview contract.
Only managed browser previews forward `X-Opencode-Directory` for OpenChamber
workspace selection. This header has no role in gateway authentication.

Expired/unknown preview navigation offers a fixed link to BayLeaf Sandboxes.
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

### Managed services: local addition, not deployed

The shared controller now supports code-server and dufs alongside OpenChamber. The editor's port
is 8791, its state root is `~/.local/share/bayleaf/code-server`, and its private
preview slot is `__code-server`. All managed slots retain deployment `__browser` for
owner-key authorization, using the existing migration 0013 column. Only the
legacy OpenChamber slot may frame public previews or forward `X-Opencode-Directory`.
Public keyed exposure rejects all managed ports. No new migration is required.

The installer defaults to OpenChamber; `--service code-server` selects named
editor adapters. OpenChamber's state root and legacy `operation` DO key remain
unchanged. The editor uses `operation/code-server`; dufs uses `operation/dufs`. Only OpenChamber receives
the inference credential or runs Node/OpenCode prerequisites and BayLeaf bootstrap.
OpenChamber and code-server have an explicit 2-GiB minimum, rather than a universal service floor.
New sandboxes have the 4-GiB baseline; code-server previously OOM-killed on 1 GiB.
Extensions and simultaneous apps can increase memory pressure, so this minimum
does not promise capacity for a particular workload.

code-server installation reuses Lathe's verified GitHub release semantics:
canonical coder/code-server release ID, exact Linux amd64 asset URL and SHA-256
digest, bounded download, path-checked extraction, file lock, staged executable
check and atomic installation. Unsupported architectures fail explicitly. The
layout release is versioned; a completed installation is reused rather than
silently upgraded on every launch. Settings and extensions have service-local roots.
Workspace trust keeps its upstream default. `--auth none` is intentional behind
private Daytona transport and the owner-authenticated gateway. Telemetry and
automatic update checks are disabled; no editor inference key is transferred.
The Python adapter checks `/healthz` for `status: alive` and a living recorded
runtime; the controller validates the uniform service/operation/port/ready result.
Status GET never performs that health probe, so ready means the last setup passed.

dufs uses port 8790, root `~/.local/share/bayleaf/dufs`, slot `__dufs`, and named
install/start/readiness adapters (`/__dufs__/health`, `status: OK`). It serves only
`~/workspace`: browsing, upload, download, text editing, deletion, search, archive
download and hashes. Outside-root symlinks remain disabled. There is no editor
memory floor; installation requires 128 MiB free disk. The same verified archive
helper handles sigoden/dufs's flat musl archive using an asset-name callback and
app-specific executable path. No controller or gateway dufs branch was needed.
Non-inference children strip inherited platform/provider inference credentials;
dufs also strips `DUFS_*` overrides. Shared workspace files are not an isolation
boundary. Archive extraction bounds compressed/expanded bytes and entry count,
checks the final symlink graph, and rejects writes through links. Supervisors
hold an exited leader unreaped through identity-verified process-group cleanup.

One setup opens at a time per owner; another service's request gets an explicit
`409 service_busy` and must be retried. The single alarm centrally schedules setup,
independent link deadlines, and pending invalidation retries. Only due records
advance; setup deadlines take precedence over backoff. Retiring one
service cannot cancel the other's alarm. An owner-wide creation-uncertainty marker
survives cross-service attempts. Daytona's [SDK error contract](https://www.daytona.io/docs/typescript-sdk/errors/)
identifies 401/403 as authentication/permission rejection: those clear creation
intent and allow corrected retries. The current create OpenAPI documents no other
failure contract, so 400, 5xx and transport loss remain ambiguous. Discovery clears
the marker after finding a machine;
if an ambiguous creation never appears, operator investigation is required before
clearing it. Login or setup wake retires all stale ready records before restoring
compute, since wake does not restore processes.

The gateway's previously remaining six-hour cap is corrected to 24 hours. The
controller adopts the registration's returned expiry, and old links retain their
stored deadlines. Passive status also checks the stored preview deadline, so a
historical shorter or revoked registration cannot masquerade as a ready link;
deliberate start relinks it. code-server and dufs have no invented countdown baseline. Their UI shows
steps and elapsed time; the measured OpenChamber meter remains optional.

Deployment and live evidence remain pending. See `../sandbox/README.md` for API-first
rollout and qualification gates, and `PREVIEWS.md` for proxy/browser evidence.

### Shell (ttyd)

Deployed 2026-10-09: API `9f3ffc16-b694-47b5-b54d-a6071e82424f`, then
Sandboxes `a847518f-85c5-4e32-8a09-9f58a7b1cafb`. Live qualification found the
correct Shell (ttyd) card in Adam's authenticated dashboard. Initial passive
status reads returned `invalid_operation`. Operator inspection confirmed both
versions active at 100%, the correct production management binding, ttyd in the
downloaded API bundle, and the embedded installer identical to the checkout
(SHA-256 `66d457cd564dd3fd9ab15ba1d96fbe407b72d461a9de99ac55c449c465a46e6d`).
Status subsequently recognized ttyd as idle on the started machine, consistent
with stale rollout execution rather than a missing registry/allowlist entry.
No code fix or redeployment was needed. Adam's authenticated dashboard then
launched ttyd alone; Linux installation and authenticated readiness completed in
16 seconds on the existing started sandbox. OpenChamber, Nanobot, code-server
and JupyterLab retained their available dashboard links; none was restarted.
Anonymous management status, app `/token`, and WS upgrade each returned 401.
Opening the owner-private app proceeded through CILogon to the CruzID Gold
password form. Adam must complete that login before live browser `printf`/`pwd`
and authenticated WebSocket qualification. Direct native-auth denial remains
locally qualified, not separately probed against the production upstream.

`ttyd` uses port 8794, root `~/.local/share/bayleaf/ttyd`, and private slot
`__ttyd`. It reuses the shared supervisor and app-secret delivery, with no
inference-key transfer, plugin publication, controller branch or migration.
The verified-archive installer accepts a direct-binary downloader for this app:
upstream [1.7.7](https://github.com/tsl0922/ttyd/releases/tag/1.7.7), Linux x86_64,
1,362,040 bytes, SHA-256
`8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55`.
This release has no GitHub API asset digest; the pin comes from its published
`SHA256SUMS`. Downloads are bounded to 2 MiB and checked before execution.
No runtime compiler, container or additional daemon is installed.

The fixed launcher runs `/bin/bash` as the ordinary sandbox user, with explicit
`--writable` and `--cwd /home/daytona/workspace`; URL arguments are disabled.
Each WebSocket gets a new shell. Disconnect sends SIGHUP to the child; reconnect
starts afresh. There is no tmux or promise that terminal sessions survive browser
closure, app restart, or machine sleep. Detached jobs remain the user's concern.

Native Basic authentication protects HTTP and WS. The private gateway injects
`Authorization: Basic …` from its encrypted registration after owner/origin checks.
ttyd's authenticated `/token` returns that app-only credential encoded for its
WS handshake; it is intentionally visible to the owner, not a BayLeaf API key.
The local ttyd process argv also contains this app credential; programs running
as the same user already share the credential file and workspace. Logging is
restricted to errors and the supervisor discards application stdout/stderr.

Upstream [HTTP auth](https://github.com/tsl0922/ttyd/blob/1.7.7/src/http.c) and
[WS auth/origins](https://github.com/tsl0922/ttyd/blob/1.7.7/src/protocol.c) were
inspected: `--auth-header` trusts any nonempty header, so it is not used.
`--check-origin` compares browser Origin to Host, ignoring X-Forwarded-Host;
Daytona changes Host, so enabling it would reject legitimate proxy WebSockets.
Its default remains off; the mandatory owner-private gateway enforces origins
on HTTP and WS. Direct access without Basic auth is denied, but possession of
the app credential authenticates directly without an origin restriction.

Local evidence (2026-10-09): real release download checksum/ELF architecture,
four adapter tests, 26 shared installer tests, 29 workerd lifecycle checks,
dashboard/policy tests and TypeScript passed. `harness-ttyd-local.py` exercised
real ttyd 1.7.7 in isolated HOME: HTTP, WS printf, cwd, normal-user identity,
direct unauthenticated denial, owner/origin fixture gates and shell exit on
disconnect. This ran a native macOS Homebrew build, not the Linux release binary;
Linux installation/readiness subsequently passed in the rollout above; live
authenticated browser terminal behavior remains blocked on fresh CruzID login.
On an isolated Linux amd64 host, run `uv run scripts/harness-ttyd-local.py` to
include the verified installer. Deploy API before Sandboxes, then explicitly
launch only Shell (ttyd) and qualify owner/non-owner HTTP+WS and sibling apps.

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

Port 3100 is reserved for OpenChamber; 8791 for code-server; 8790 for dufs. The local
managed-service revision changes restart behavior for both: only the recorded
runtime process group is terminated after PID/start-time/boot-ID verification.
An unrelated listener is left alone and produces `port_in_use`. Earlier deployments
reclaimed any same-user listener on 3100; that behavior is no longer used by setup.
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
## Nanobot POC (deployed for owner evaluation)

See [NANOBOT-POC.md](NANOBOT-POC.md) for the fourth service's implementation,
private application authentication, finalization/renewal contract, canonical MCP
adapter, credential scope, tests and live gates. Its app secret never enters DO
metadata or dashboard output; private preview registration uses the existing
encrypted header envelope. No new migration or infrastructure secret.

Nanobot's adapter/guide live in the independent `api/nanobot-sandbox` submodule,
published as `bayleaf-ucsc/nanobot-sandbox` with explicit approval on 2026-10-09.
The Worker embeds source at its own verified published
SHA; it does not install this package from Git at sandbox runtime. Wrangler runs
the OpenCode pin builder and the separate strict Nanobot asset builder. Explicit
`--fixture` builds support isolated tests while publication is pending. See the
Nanobot POC's approval-required init/submodule/release sequence. OpenCode's
unchanged plugin does not need republishing for this work.

Code-server's next deliberate setup seeds missing
`user-data/User/settings.json` with `chat.disableAIFeatures: true` and
`workbench.secondarySideBar.defaultVisibility: "hidden"`. Existing JSONC is
preserved byte-for-byte. These are user-overridable defaults, not a policy or a
primary-sidebar visibility change. Source/browser qualification covered
code-server 4.141.0 / VS Code 1.141.0; no extension was installed for this change.
