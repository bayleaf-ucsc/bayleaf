# Disposable collaborative Markdown rooms (issue #94)

**Deployed 2026-10-20 Pacific.** CollabMD is the
first managed service with public gateway access. Only its fixed `__collabmd`
slot may use that policy; every other managed slot remains private. Management
always requires the owner, never a room password or application cookie.

## Chosen scope

Adam selected **two hours as guidance**, not an automatic deadline or shutdown.
The existing 24-hour link maximum remains. Sandbox idle sleep can interrupt a
gathering; browser traffic has not been qualified as a reliable keepalive.

Start sharing provisions only `~/workspace/public-collaborative-docs/`. It
preserves existing documents and `.collabmd` collaboration/comment sidecars.
The directory's name is not itself publication. During sharing, anyone with the
link and temporary password can edit the folder. There are no document roles or
guest BayLeaf accounts. End sharing retires the link and stops the managed app,
not the sandbox. Files retain the ordinary sandbox retention policy. Neither
revocation nor expiry recalls copies already downloaded to collaborators' devices.

Agents initially read saved Markdown directly. Disk persistence is debounced,
not a guarantee of the most recent browser keystroke. Coordinate a pause in
human editing before external agent rewrites; overlapping edits are not promised
to merge safely.

### Deliberate capability exposure

| Surface | Decision | Authority / delivery |
| --- | --- | --- |
| Owner Sandboxes dashboard | Expose start, restart, stop, link/password copy | Existing host-only owner session, exact-Origin POSTs and private management binding |
| Hosted OpenChamber/OpenCode | No new lifecycle tools; ordinary filesystem reads | No extra credentials or plugin publication |
| Hosted Nanobot | No new lifecycle tools; ordinary filesystem reads | No extra credentials or adapter publication |
| BayLeaf Chat | Omit room lifecycle tools in this first version | Owner dashboard is the deliberate sharing surface |
| Desktop agents | Omit lifecycle tools; existing authorized file access remains | No new installed capability or credential scope |
| HTTP / agent orientation | Document the folder and coordinated-edit limitation | Existing browser lifecycle endpoint gains OpenChamber stop only; per-app selection remains private RPC |

The operator owns any later agent-tool proposal. Revisit when qualified
collaboration-aware writes or explicit permission-gated lifecycle tools are wanted.

## Runtime and trust boundary

- CollabMD **0.1.55**, exact npm tarball SHA-512 pinned in
  `scripts/collabmd-adapter.py`. Its transitive dependencies are resolved by npm
  during first installation and recorded in the installed lockfile: this is not
  a fully reproducible, repository-locked dependency closure.
- Service-local **Node 26.12.0**, official Linux amd64 archive with pinned
  SHA-256. Other apps' Node installations are unchanged.
- Port **8795**, runtime root `~/.local/share/bayleaf/collabmd`, no owner or
  inference credential uploaded. Room password and cookie-signing material stay
  outside the served folder. A purpose-separated HMAC reconstructs each
  operation's app secret without persisting it in controller metadata.
- Only owner-authenticated ready status returns the room password. The dashboard
  keeps it in its script state for Copy, never visible text, markup or a URL.
  Neither the gateway nor the proxy injects room authentication for visitors.
- Fresh explicit setup after stop uses a new operation, password, cookie secret
  and preview generation. Reopening an already-ready app reuses its room.
- Git, hosted workspace mode, agent-access service and automatic tunnels are
  disabled. No SQLite identity store, Postgres, Redis or renderer sidecar is
  provisioned. PlantUML/Structurizr targets are non-serving loopback endpoints;
  draw.io uses an unavailable same-origin target instead of diagrams.net.
  User-authored Markdown can still embed remote resources or outbound links.
- The configured root cannot be a symlink. Upstream 0.1.55's path sanitizer
  rejects descendant symlinks and traversal. This is an application boundary,
  not an OS sandbox against the owner/agents concurrently changing the filesystem.

### Compatibility changes

The pinned package receives two exact-match, fail-closed source transformations:

1. WebSocket authentication accepts `COLLABMD_PUBLIC_ORIGIN` independently of OIDC.
2. HTTP write-origin protection compares against that same explicit origin.

Both otherwise preserve upstream behavior. Neither trusts a forwarded-host header
nor weakens BayLeaf's generic origin gate. Package changes require requalification;
unrecognized source fails installation rather than applying a fuzzy patch.

Initial setup uses an unadvertised pending origin. The existing bounded
post-registration finalization configures the actual hostname, restarts the app
with the same room credentials and checks readiness before displaying the link.
An interrupted registration resumes the same generation. Generic gateway cookie
wrapping and error sanitization are unchanged.

## Stop lifecycle

The owner controller serializes stop with setup/restart and alarms. It persists
stopped intent, revokes the slot and invalidates live proxy connections first.
Only then does it inspect the recorded machine and attempt local cleanup. A
late installer result cannot re-register a stopped operation. Pending cleanup
blocks a new start for that app, not sibling services.

Stop is idempotent. Responses distinguish `access_revoked` and
`cleanup_pending`; alarms retry partial failures. GET remains passive. A sleeping,
archived or missing machine needs no Toolbox call or wake to complete cleanup.
Expiry still revokes access only, and does not acquire these stop semantics.

Local cancellation and spawn share a short lifecycle lock. Installer subprocesses
and runtime leaders use PID + boot ID + process-start identity, not port numbers.
Stop cancels the local request, signals verified process groups, and verifies
setup/runtime locks have been released. A mismatched port occupant is never killed.

**App-specific limits:** CollabMD is a single Node process; SIGTERM asks it to
flush rooms, with its own five-second forced-exit fallback. A completed signal
sequence alone is not a proof that every edit was durable. Other apps stop their
managed process group: detached agent jobs, terminal jobs, extension services or
independently launched kernels may survive. Jupyter is asked to shut down its
kernels, but the current cleanup result does not certify every detached kernel.
The shared sandbox and sibling managed apps are never stopped by this operation.

## Local evidence (2026-10-20)

- 32 synthetic workerd/D1/DO lifecycle checks, including CollabMD policy,
  password omission from durable metadata, no owner-credential upload, no injected
  guest auth, active socket closure, sibling survival, fresh generations,
  stop-during-setup, partial cleanup retry and sleeping-machine behavior.
- 35 synthetic gateway security checks pass, including application cookies,
  error sanitization, origin gates, revocation and expiry.
- Adapter/installer tests, service-session RPC/HTTP adapter tests, policy/SSR
  checks and TypeScript checks pass. These are not Linux process qualification.
- Real npm package, **localhost on macOS / Node 26.12.0**: two independent Yjs
  protocol clients co-edit; anonymous HTTP/WS, wrong password, wrong Origin,
  traversal and outside-root symlinks are denied. Opening preserves CRLF bytes;
  saved edits are readable on disk; SIGTERM flushes a final edit; a fresh room
  rejects the old password and cookie and reopens the persisted room. Largest
  frame across these tiny fixture runs was 124 bytes. Two document sockets are
  **not** a browser-tab connection count.
  Run `python3 scripts/qualify-collabmd-local.py /path/to/node_modules/collabmd`
  with a separately installed 0.1.55 package and Node 26.

## Live qualification and rollout

### Live qualification: 2026-10-20 Pacific

Adam authorized using `amsmith@ucsc.edu`'s own sandbox, including destruction if
needed. Its exact label/ID binding was verified before mutation. The existing
2-vCPU / 4-GiB / 8-GiB machine was restored from archive, not destroyed or
replaced. The canonical installer downloaded and verified its pinned Node and
CollabMD packages and reached readiness on Linux.

No Worker deployment was necessary: two **installation-scoped public previews**
exercised the real BayLeaf/Daytona HTTP/WS transport. This does **not** qualify
the new managed-slot policy or owner-controller/dashboard integration in
production. No inference keys were installed and no inference was performed.

Two independent clean Rodney/Chrome profiles, without BayLeaf accounts, passed:

- Native password challenge and usable wrong-password error through sanitized
  gateway responses; old password rejected after a fresh room generation.
- Bidirectional browser co-editing and corresponding saved Markdown on disk.
- Authenticated app-cookie round trips; browser fetches with credentials omitted
  and wrong-password requests returned 401. Traversal, outside-root file symlinks
  and directory symlinks returned 404 without disclosing fixture content.
- Three concurrent WebSockets per tab in this one-document workload: lobby,
  workspace and document. A 972,036-byte Markdown fixture produced a 972,066-byte
  initial-sync frame without exceeding the gateway's 4-MiB limit. This is not a
  participant-capacity guarantee. Native browser memory measurements were too
  coarsely rounded to use; server RSS samples were approximately 136–165 MiB.
- Revocation closed both tabs' existing sockets and denied reconnects. A fresh
  URL/password was required; previous preview URLs stayed revoked. Cached editor
  text remained visible locally, as expected, rather than being remotely erased.
- Document and comment-sidecar recovery across app restart. Opening a CRLF
  fixture preserved its bytes. A coordinated external append, with browser
  typing paused, propagated to the browser and remained on disk.
- Linux process checks: owned group termination, sibling survival, stale/reused
  PID rejection, no arbitrary-port killing, and task/setup cancellation during
  an injected slow installation.

#### Accepted upstream limitation: silent Markdown persistence failure

A synthetic `readonly-qualification/blocked.md` file and its containing folder
were made unwritable to the app. Browser B accepted and rendered an edit while
the Markdown file retained its old text. The browser still showed ordinary live
collaboration, with **no visible save-failure warning** in its text or screenshot.
This is a persistence-feedback failure, not a gateway authentication failure.
The pinned upstream room's scheduled-persist catch logs the failure server-side;
the managed app deliberately has no content-bearing server log surface.

Permissions were restored before ending the run. Graceful app shutdown then
persisted the previously blocked edit; independent filesystem reads confirmed
the recovery, both co-edits, the external append, the comment and CRLF fidelity.
This recovery is not a substitute for notifying participants at the time of a
failed save, and must not be presented as a general durability guarantee.

The representative two-hour soak was initially paused after this finding.
Adam explicitly chose to continue qualification without fixing upstream's
persistence feedback. Retain this as a known limitation, not a BayLeaf proxy bug
or a claimed passing failed-save UI test. A two-hour soak was then launched and
cancelled at Adam's direction: **duration qualification is intentionally skipped,
not passed**. Production rollout remains separately gated.

One credential-less non-browser public WebSocket probe received 502 rather than
an authentication-specific rejection. It did not upgrade or disclose content;
raw Python HTTP probes were also denied earlier by the edge with 403. Browser
401 tests above reached the application. Preserve this distinction rather than
calling the raw-client responses application-authentication evidence.

Cleanup confirmed both public previews return 404, the owned CollabMD process is
stopped, both test Chrome instances are closed, and the owner's machine is
stopped, **not destroyed**. Synthetic documents and the installed app remain for
inspection under the ordinary sandbox policy. No other user's sandbox changed.

Reproduction helpers: `scripts/qualify-collabmd-live.py`,
`scripts/qualify-collabmd-browsers.py`, and `scripts/qualify-collabmd-watch.py`.
Live operations require `--live`; private state is kept outside the repository.

### Approved production deployment

Adam explicitly approved deployment, commit and push after accepting the upstream
save-feedback limitation and cancelling the soak. The worktree was reconciled
with current `main`, preserving the newer diagnostics and telemetry changes.

- API Worker: `55fb7e68-4993-44d5-babf-dced8fa11b77`.
- Sandboxes Worker: `ef4fdc08-7070-42ea-8d49-423a6fb09b8c`.
- Prior rollback versions: API `8cfdc34a-071b-4039-ae1e-ab8033510984`,
  Sandboxes `f80f038d-4807-4c33-99d2-8a6a6e0a5589`.
- No D1 migration, plugin publication or provider/retention-policy change.
  Production builds verified the existing published OpenCode/Nanobot pins, not
  fixture assets. Wrangler explicitly loads the new Python adapter as text and
  the API configuration now pins the BayLeaf account.

The actual `amsmith@ucsc.edu` UCSC session completed dashboard Start sharing →
ready → End sharing. D1 readback confirmed `deployment=__browser`,
`slot=__collabmd`, public access and a bound sandbox credential. Two independent
guest browser profiles entered this **managed** room without BayLeaf accounts,
co-edited and saved distinct markers. Their app-cookie round trips, anonymous
401s, wrong-password 401s and traversal/symlink denials passed again. End sharing
closed both profiles' sockets, made the URL return 404 and stopped the owned
process; saved guest edits remained. Test browser profiles were then closed.
A subsequent managed start generated a different URL, password and operation.
After stopping owner compute, the dashboard still offered End sharing; using it
revoked that new URL while control-plane readback remained `stopped`, without
waking the sandbox. This also leaves the owner's machine stopped, not destroyed.

Reconciled checks pass: 32 lifecycle groups, 36 gateway security groups, 28 shared
installer tests, seven CollabMD adapter/stop tests, service-session and dashboard
adapter tests, four diagnostic tests, docs and TypeScript. Executing the actual
dashboard script with a synthetic DOM additionally verifies End sharing remains
available for sleeping, expired or failed operations, rather than requiring a
wake just to retire access.

### Remaining qualification boundaries

- Keep the accepted upstream save-failure limitation explicit; do not claim
  failed-save UI qualification passed. No BayLeaf-specific fix is planned.
- Exhaustive live generic-stop behavior on existing managed apps and their
  child/job semantics, beyond the shared controller/installer tests.
- Expired app-session UI, not only incorrect passwords or new room generations.
- Source fidelity beyond the CRLF fixture and additional external-edit cases.
- Actual document/presence/workspace sockets per tab, frame sizes near limits,
  and small-machine CPU/memory beyond the measured two-tab fixture. The
  representative two-hour idle/sleep session is waived for this iteration by
  operator direction; do not claim reliable two-hour keepalive behavior.
  BayLeaf's 16-socket / 4-MiB frame caps are unchanged. Initial document sync is
  configured to 2 MiB, but that is not a general promise all frames fit.
- Desktop/mobile live dashboard checks and privacy wording review before rollout.
  The synthetic dashboard was opened in the browser, including a 390-pixel mobile
  room with wrapping controls and a visible sharing-boundary warning. This does
  not qualify production sign-in, password copy or the CollabMD browser client.
- Account/sandbox-credential revocation through the managed real chain, beyond
  the synthetic active-credential gates. No issue-closing action is implied by
  this rollout; skipped or unperformed checks remain explicitly unqualified.
