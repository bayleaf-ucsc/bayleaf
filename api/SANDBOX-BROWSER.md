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
operations and work periods. The existing gateway also has one connection DO
per preview hostname. These are evictable coordinators, not permanently running
VMs. Only a current operation's metadata is retained in lifecycle storage:
owner email, credential fingerprint, sandbox ID, operation ID, phase/step,
timestamps, deadline, content-free failure code, and the wrapped application URL.
It contains no credential, request content, file content, or application logs.

## External contract

All endpoints accept an ordinary personal BayLeaf key. Campus Pass and temporary
inference tokens are excluded. The dashboard uses the existing browser session;
mutations additionally require exact same-origin `Origin` and
`X-BayLeaf-Action: sandbox-browser`. Ownership never comes from request JSON.

| Endpoint | Effect |
| --- | --- |
| `GET /sandbox/browser/status` | Inspect controller metadata and passive control-plane status only |
| `POST /sandbox/browser/start` | Join active setup/work or deliberately begin/resume it |
| `POST /sandbox/browser/continue` | Deliberately renew for up to six hours; create a fresh application generation |
| `POST /sandbox/browser/restart` | Retry setup and restart the managed browser interface within the current deadline |
| `POST /sandbox/browser/stop` | Revoke browser access; stop only managed browser tools and setup tasks |

Start/restart returns 202 while opening. Concurrent requests converge on one
operation. The dashboard polls while setup is opening, not throughout the work
period. Even its status polls never call Toolbox. The deadline display counts
down locally; refresh/focus checks only observe status.

Opening an already-ready work period keeps the URL and deadline. Stopped or
archived machines need a deliberate start action. Sleep loses processes, so
the managed application is relaunched and gets a fresh preview generation.
No OpenChamber Desktop discovery or background reconnect can start or renew work.

The gateway caps the managed preview at the controller deadline and binds it
to a hash of the current owner key. Rotation/revocation denies new gateway
requests; socket sweep/revocation follows the existing preview contract.
Only managed browser previews forward `X-Opencode-Directory` for OpenChamber
workspace selection. This header has no role in gateway authentication.

Expired/unknown preview navigation offers a fixed link to the API dashboard.
Cached application/service-worker pages can still appear on an old origin;
this is not a promise to erase browser storage. Every replacement uses a nonce.

## State and durable orchestration

Machine state, installation state, and work-period state are separate. The DO
persists steps: discover → wake → prepare → inspect → register. Before side
effects it arms an alarm for retry/reconciliation. It does not keep the original
HTTP request open for installation, or rely on `waitUntil` to finish a job.

The operation has a 20-minute setup deadline inside its six-hour work period.
Provider calls are individually bounded. Definitive failures produce a visible
failure code and require an owner retry. An ambiguous create is not automatically
repeated: discovery must find the prior result or report `creation_uncertain`.
Provider lookup failure never means “absent.” Creation still shares Daytona's
label namespace with Lathe; cross-client creation races remain a qualification
concern, not something an owner-scoped BayLeaf lock can solve alone.

Setup status polling ends when ready. The next controller alarm is the work
period deadline. At expiry the controller revokes the browser registration
without contacting Toolbox or stopping the shared sandbox. This avoids extending
inactivity or interrupting independent Chat/API work.

The sandbox supervisor also attempts to terminate its managed process group at
the deadline. Owner-editable files can influence local processes but cannot
authorize network access or extend the edge deadline. Background activity and
new sockets cannot renew the controller's period.

**Compute cutoff qualification remains necessary:** browser-only expiry should
lead to idle sleep after the configured grace period; concurrent independent
Chat/API work may legitimately keep the shared machine active. The implementation
does not claim a daily budget or forcibly stop unrelated work.

## Versioned installer contract

### Sandbox-specific agent skills

`api/sandbox-skills/` is the source of truth for skills intended specifically for
OpenCode/OpenChamber agents in BayLeaf sandboxes. Wrangler's build step runs
`scripts/build-sandbox-skills.py`, creating a content-versioned JSON bundle from
all Markdown/Python files in that directory. The generated `.sandbox-skills.json`
is ignored by git. The controller transfers one bundle; it knows no skill names.
Run that builder before a standalone typecheck on a fresh checkout.

Setup and every managed application launch restore its files to
`~/.local/share/bayleaf/browser/config/opencode/skills/`, the managed XDG global
skill directory. Deleted or edited bundled files regrow; user-added skill files
and directories are preserved. Opening a browser tab onto an already-running
application is not a new process launch and does not trigger restoration.

- `expose-sandbox-ports-technique`: launch/bind a web server, obtain a private
  preview by default, explicitly opt into public access, and revoke a port.
- `bayleaf-sandbox-technique`: account usage, machine/work-period state, persistence,
  and platform self-knowledge grounded in the live API and public BayLeaf sources.

Both include helpers that read the owner key internally, suppress raw exception
and provider-error output, and never take a key as a command argument. These keep
credentials out of the intended tool-traffic path, not out of reach of arbitrary
code running as the sandbox owner. `/usage` reports separate USD and request
allowances without provisioning/healing keys or consuming inference. Disabled
backends are omitted; unknown limits remain null.

Deployed version `24a3b943-f7f7-4d32-a733-6846beba8790`: production restart reached
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
request.json               operation ID, deadline, explicit restart intent
setup.lock / runtime.lock  exclusive kernel file locks
releases/<release>/        pinned npm tools and installation lockfile
current                    atomically switched release symlink
credentials/owner-key      mode 0600; separate authenticated file transfer
config/ data/ cache/       isolated XDG roots for the managed environment
openchamber/               managed application settings and histories
state/operation.json       atomic progress, timestamps, process identity
state/installation.json    completed release manifest
state/runtime.json         supervised process identity and credential fingerprint
state/task.json            currently owned setup subprocess
state/lease.json            local supervisor deadline
state/cancelled.json        explicit cancellation marker
state/setup.log             bounded, content-free phase/error events
```

Operations: `inspect`, `setup --operation <uuid>`, `supervise --operation <uuid>`
(internal), and `stop`. Repeated setup uses an exclusive lock, stages installation
separately, and switches current only after executable checks. Interrupted
staging is rebuilt; old releases and user files are preserved. Failed setup
never destroys the shared sandbox. Process cleanup checks PID, Linux boot ID,
process start ticks, and process-group leadership to avoid killing a reused PID.

Application pins: OpenChamber 2.1.0 and OpenCode 2.0.22. The script retrieves the
current authenticated BayLeaf remote configuration at setup/start and stores
the returned compatibility-format config under its isolated XDG root. A changed
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

## Verification and rollout

### Export before a manual migration

End browser work first so the managed application closes its databases. Using
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
not install tools or start a work period on the owner's running sandbox.

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
