# Lathe upgrade evidence

Moved verbatim from `chat/DESIGN.md` (only relative link targets adjusted). Dated
evidence for diagnosis: statements such as "current" and "now" describe the time
of writing. Current configuration lives in [`../DESIGN.md`](../DESIGN.md).

## 1.3.3 (2026-10-27)

**Hardening upgrade (2026-10-27):** promoted personally playtested 1.3.3 from
BayLeaf's 1.3.0 (SHA-256
`0fb5de39473418d2c8578a5f1f7660b1272466d5dc17e0d53138457a6787cdad`).
All 837 offline tests passed. Browser clicks now refuse ambiguous or covered
targets before sending input. Background completion notices are sandbox-owned,
claimed by a later tool result in the originating chat, with duration measured
from sandbox launch/completion records. Nothing wakes an idle chat.
Requirements, valve definitions and tool signatures are unchanged. Exact live
source readback, all 14 existing valves, Code Sandbox name/grants and health 200
passed without restart. Full private pre/post resource reconciliation found only
Lathe source/schema changes; the hidden Basic base model was checked separately.
The existing Code Sandbox skill needed no change. Rollback source and valves,
plus full private snapshots: `~/.tokens/bayleaf-lathe-133-20261027/`.
Model-mediated BayLeaf playtesting remains with Adam.

## 1.1.0 (2026-10-21)

**Upgrade (2026-10-21):** promoted Adam's personally used upstream 1.1.0
(SHA-256 `d5fea4351de5cb065a2d1696c729e0358d79740a878ed29a2dcb3a0d0eeb0937`).
All 510 upstream offline tests passed. Production source and complete generated
schema matched; supported existing valves, Code Sandbox name, and grants were
preserved, and health passed without restart. New `onboarding_instructions` and
`handbook_url` valves remain empty. Dependencies are now `httpx`, `pydantic>=2`,
`cachetools`, and `PyYAML`; Lathe no longer requires Pydantic AI or httpx-ws.
Rollback and full private before/after snapshots:
`~/.tokens/bayleaf-lathe-rollout-20261021`.
Full pre/post pulls found only Lathe source/schema changes before the companion
Code Sandbox skill update. The skill's updated guidance was deployed and read
back, preserving its existing live decorative suffixes outside the repo copy.

Python sessions are now owned by a supervisor inside the sandbox, keyed by
deployment, caller, conversation, and sandbox. Worker-local caches no longer
select interpreter identity. Old Daytona interpreter variables are not migrated:
users must rerun setup. Stop/restart or timeout loses Python memory, not saved
workspace files. Session journals and bounded code/output records live under
`/home/daytona/.local/share/lathe/python`; completed records expire on later
submissions after at least 24 hours. Uncertain execution must not be blindly
replayed. This does not establish live multi-worker OWUI qualification.

`delegate`, `handoff`, built-in volume support, and managed application target
shortcuts have been removed. `expose` now only publishes an already-running
`http:<port>` service; optional applications are installed/launched with `bash`.
Adam confirmed production playtesting works. Automated live model-mediated
qualification was not run: the upstream deployment collector still lacks
chat/message filtering and must not use Adam's admin identity.

## 0.32.0 (2026-10-12)

**Refactor upgrade (2026-10-12):** promoted the unchanged personally used 0.32.0
build (SHA-256 `d7d26ad8151fa0a85e76fadc583585060a001863c4059c59f750f4ea907c45b3`).
All 494 upstream offline tests and six isolated BayLeaf OWUI checks passed:
complete source/schema, bash, write/read, interpreter, view, and delegate.
The additional first-time-agent scenario timed out; that broader workflow is
not qualified by this run. Production readback matched the personal source and
complete schema; all valves, the Code Sandbox name, and grants were preserved.
Health returned 200, with no restart. Full private before/after pulls found only
the Lathe source/schema changes; the hidden Basic base model was checked separately.
Snapshots are under `~/.tokens/bayleaf-lathe-refactor-20261012-193329`.
Adam confirmed production playtesting works. A foreground diagnostic rerun
exposed an upstream deployment-harness isolation bug: the suite used Adam's
admin identity, and its Socket.IO collector accepted unrelated chats' events.
An in-memory request-ID filter eliminated that false delegation failure; all
six core checks passed again. The first-time scenario still timed out after
240 seconds without a tool-status event, so its cause remains undiagnosed.
Further live qualification should use a dedicated synthetic account, not Adam's
admin session. The separate Docker monitor already uses a synthetic identity.
Upstream repair and regression-test proposal:
[Lathe #107](https://github.com/rndmcnlly/lathe/issues/107).

No tools, parameter contracts, dependencies, valves, or preview protocol were
added. Search now returns bounded concrete paths/hits, text previews are bounded,
and completed bash logs/exit evidence are retained for 24 hours (or until sandbox
stop/restart). Delegate references have an aggregate 50-KiB limit and fail rather
than silently clip. Interpreter identity is separated from evictable chat notices;
it remains local to one loaded toolkit instance, not durable across OWUI reloads
or workers. Failure reporting and workspace readiness checks were hardened.

## 0.31.2 reconciliation (2026-10-11)

**Production reconciliation (2026-10-11):** pulled Adam's subsequent 0.31.2
deployment back into the repository, byte-identical to upstream `74b42c2`.
The first-call snapshot now includes discovered skill names, descriptions, and
paths using the same catalog builder as explicit `onboard()`; full skill bodies
still require `read(path)`. Dependencies and tool schema are unchanged. The full
private pull is under `~/.tokens/bayleaf-prod-pull-20261011-120432`; unrelated
Brace3 metadata-format differences were left untouched.

## 0.31.1 (2026-10-11)

**Earlier upgrade (2026-10-11):** deployed unchanged upstream 0.31.1, commit `9642168`
(SHA-256 `00d56dc8125891ba0d30b5c71cb1a7abdb5171c60b4208e2e6b512c385ab1567`).
This adds agent-facing skill-discovery paths to onboarding and the workspace
snapshot, with no mechanical, dependency, valve, or tool-signature changes.
Adam explicitly waived personal-instance testing and long-term soak for the
hackathon rollout. All 323 upstream unit tests passed. Production source readback
matched upstream; valves, tool name, grants, and generated schema were unchanged.
Health returned 200; no restart was needed. Full private before/after pulls
found only the expected Lathe source/version changes, apart from rotating metadata.
Rollback and reconciliation snapshots are under
`~/.tokens/bayleaf-lathe-rollout-20261011`. Human model-mediated playtesting
remains separate.

## 0.31.0 (2026-10-08)

**Previous upgrade (2026-10-08):** the deployed and vendored source was upstream 0.31.0,
commit `4cd5663`, byte-identical to the personal Chat deployment (SHA-256
`816b84af2c2e24d6f6024d49f55a8ef9d1faf23057a425da4a77a7d746e8e29c`).
All 347 upstream offline tests passed. After refreshing the expired admin token,
BayLeaf source and complete generated schema were verified, all valves and tool
grants/name were preserved, and the Code Sandbox skill content and grants/active
state were read back. Health returned 200; no app restart was needed. Six isolated
OWUI core checks passed (source/schema, bash, write/read, interpreter, view,
delegate); the additional first-time-agent check failed because Basic skipped
the overview manual. Private before/after backups are under
`~/.tokens/bayleaf-lathe-upgrade-20261008`. Full reconciliation found only the
Lathe source/schema and Code Sandbox skill changes. The new
`expose(..., upstream_headers={...})` parameter configures fixed application
headers independently of public/private policy. Nonempty headers require exact
boolean `upstream_headers_applied: true` from BayLeaf's registration endpoint:
missing acknowledgement fails closed with no direct fallback in either mode.
API support was deployed separately in issue #86. Values remain in Chat tool arguments,
and applications can reflect them.

Production Basic → loaded Lathe `expose` → BayLeaf API → Daytona qualification
verified public HTTP injection of fixed Basic credentials and a custom header,
including replacement of browser spoof values. Private header-bearing exposure
returned a wrapped URL and denied unauthenticated requests with HTTP 401.
The focused headerless regression passed: public HTTP 200 served the fixture
with no injected Authorization or custom header, preserving gateway filtering.
The fixture used a separately tracked `/tmp/lathe-smoke-*` directory and port
8943 in the coordinated API test sandbox; existing applications were untouched.
Two harness assumptions needed correction: private denial can be 401 rather than
a redirect, and BayLeaf filters unconfigured custom browser headers. Each run
revoked its exact leases, verified preview 404s, and removed only its fixture.
All six previews from the three production-smoke runs were revoked and returned
404. Final read-only cleanup verification found no `/tmp/lathe-smoke-*`
directories and no listener on 8943. Sandbox
`6dc25038-2a83-4061-a4a7-5ebbc845d14e` was preserved by coordination decision:
work of unestablished provenance had appeared outside this fixture. The final
read-only check no longer found `workspace/headercheck.py`; this session did not
remove it or change port 8765. No claim of whole-sandbox teardown is made.
The isolated suite cleaned up its separate staging toolkit and sandbox.
Human workload playtesting remains separate.

## 0.30.7 (2026-09-30)

**Upgrade evidence (2026-09-30).** Lathe 0.30.7 was promoted from the personal
instance after Adam confirmed sufficient use; it matched upstream byte-for-byte.
All 276 offline tests passed and upstream's isolated live monitor was green.
BayLeaf's staging suite passed all six core scenarios on retry after an initial
delegation timeout. Model-mediated preview attempts failed at tool selection or
call budget, not an observed preview service failure. Direct upstream-tool calls
against a disposable real sandbox verified the 1-CPU / 2-GiB / 3-GiB creation
shape and Linux cgroup limit, project-rooted private/public static previews,
anonymous private-access denial, and managed public IDE refusal. The initial
direct private check omitted the trusted OWUI user ID and correctly failed
closed; the corrected identity fixture passed. Test preview registrations were
revoked and sandbox deletion verified. Production source, all valves, grants,
and display name were read back after deployment; `/health` returned 200.
The Code Sandbox skill was updated. Secret-bearing rollback snapshots and full
before/after backups remain private under
`~/.tokens/bayleaf-lathe-upgrade-20260930-132308`. No existing user sandbox was
resized or destroyed. Human post-upgrade workload testing remains pending.

## 0.30.5 (2026-09-24)

**Upgrade evidence (2026-09-24).** Version 0.30.5 was deployed from the source
running on `chat.adamsmith.as`, byte-identical to upstream `main`. The personal
install was from the same day; Adam explicitly waived the usual soak gate. This
version raises the Open WebUI floor to 0.11.0 (BayLeaf runs 0.11.3) and changes
sandbox lifecycle, command cleanup, delegation, and file searches; its admin
valves, dependencies, and tool names/parameters are unchanged. Upstream Python
CI and CodeQL passed. The isolated live monitor passed source/schema, bash,
write/read, and interpreter checks; its view check failed when the model called
`lathe("overview")` instead of `view`. BayLeaf production source matched the
candidate byte-for-byte after deployment; grants, active state, and valves
were preserved, and `/health` returned 200. Rollback snapshots are private
under `~/.tokens/bayleaf-lathe-rollout-20260924`. A model-mediated BayLeaf
playtest passed: Basic selected Code Sandbox, called Lathe `bash`, and returned
the expected `lathe-0305-ok` output.

## 0.29.6 (2026-09-20)

**Upgrade evidence (2026-09-20).** Version 0.29.6 and BayLeaf's integrated v2
wrapper contract were deployed together. Upstream's 118 offline tests, the
25-check workerd/D1 preview suite, TypeScript checks, isolated private and public
OWUI exposure tests, and production-tool private/public smokes passed. The
production public URL served the tracked fixture without login; private returned
only an owner-authenticated CruzID URL; neither exposed the Daytona hostname.
SSH refusal still passed. The full isolated seven-scenario run passed its first
six checks, then its final model-mediated expose timed out; the same path passed
separately before and after that nondeterministic timeout. Rollback snapshots are
private under `~/.tokens/bayleaf-lathe-rollout-20260920`.

## 0.28.0 (2026-09-18)

**Upgrade evidence (2026-09-18).** Version 0.28.0 was explicitly approved for
rollout despite a short soak because it closes the unwrapped bearer-token SSH
path. Upstream unit tests passed 722/722. Production source matched upstream
byte-for-byte, access grants and valves were preserved, `/health` returned 200,
and the protected-expose smoke test returned an owner-authenticated URL with no
upstream hostname. The same production smoke confirmed that `expose("ssh")` is
refused without returning access material. Rollback snapshots are private under
`~/.tokens/bayleaf-lathe-rollout-20260918`.

## Wrapper rollout (2026-09-17)

**Upgrade evidence (2026-09-17).** Full OWUI regression passed 7/7 scenarios:
source/schema, bash, write/read, interpreter, view, delegate, and protected expose.
A separate smoke test invoked production `lathe` and received a protected CruzID
URL. Original grants and existing valves were preserved. Rollback source/valves
and full before/after snapshots are private under
`~/.tokens/bayleaf-lathe-rollout-20260917`. The service restart completed as
deployment `a25ae1e8-7d81-481b-aa09-e6f57c595b1b`; the OWUI image remains v0.11.3.
OWUI installs requirements when code changes. This restart was a precaution
against cached imports across the dependency major-version change, not evidence
that missing-dependency installation requires restarting. Personal proxy
dogfooding was deferred; the coordinated rollout was explicitly approved.

## Gateway sizing and retired project-rooted services

The gateway supports WebSockets, service workers on fresh nonce origins, and
server-managed application cookies. JavaScript-managed original cookie names
are not supported. Browser caches can outlive the server-side grant. The
current 1-GiB sandbox OOM-killed code-server during qualification; a disposable
4-GiB test confirmed core IDE and terminal operation. This did not change
BayLeaf's default sandbox size at that time. On 2026-09-30, Adam approved
2-GiB RAM for new Chat sandboxes after his expected workload hit the 1-GiB
limit; existing sandboxes remain unchanged. The off-ramp policy still applies.

**Historical project-rooted services (Lathe 0.30.7, removed in 1.0).** These
managed target shortcuts no longer work in 1.1.0; install and launch services
with `bash`, then publish `http:<port>`. The former behavior was:
`dufs:/home/daytona/workspace/project`
serves a selected directory; `code-server:/home/daytona/workspace/project`
opens the IDE there. Bare names use the whole workspace. Named service roots
must exist inside the workspace after symlink resolution. Each dufs/code-server
instance uses a fixed port and refuses a mismatched existing root rather than
replacing the running service. Managed dufs enables upload, delete, search,
folder ZIP downloads, and file hashes without permitting symlinks outside its
served root. Older running dufs processes using `--allow-all` must be stopped
before re-exposure; do not stop users' services automatically. Code-server's
opening folder is not filesystem confinement, and both managed code-server and
ttyd require private access. Python static-site serving can still follow symlinks
inside the served directory. These controls do not confine a model-controlled
shell or an arbitrary `http:<port>` service.
