# Hosted adapter completion follow-up (2026-10-21)

**Subsequent approved release:** `hosted-client-release.md` records publication,
parent integration and verified production deployment. Local-only statements below
describe the pre-approval qualification phase.

This supersedes the fixable-source-gap assessment in `hosted-clients.md`.
The original published-pin observations and failed first trial remain historical
evidence. No upstream publication or production adapter-pin deployment occurred.

## Source ownership and reviewable changes

Both main submodule checkouts were clean before work:

- `api/sandbox-plugin`: `c7f5699395928d397531f30781e627a3287bbf44`, independently
  owned by `bayleaf-ucsc/opencode-sandbox`.
- `api/nanobot-sandbox`: `b22f4c6e8bb4f1dc385a9ddc2da3b3550710ea2f`, independently
  owned by `bayleaf-ucsc/nanobot-sandbox`.

Edits are isolated in local clones at
`/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/hosted-client-adapters-ujru0rc2/`.
Neither main submodule checkout nor gitlink was changed during this initial pass.
Reviewed changes: OpenCode four files, 122 insertions/9 deletions; Nanobot four
files, 103 insertions/11 deletions; proposed parent Nanobot enabled-tool allowlist
change, initially tested only in an isolated copy. The adapter changes include
executable code, skill guidance, README and tests. Temporary review patches were
removed after publication: the exact published commits and parent installer diff
in `hosted-client-release.md` are now the canonical review artifacts.

## Agreed exposure and implementation

| Verbs | OpenCode | Nanobot | Delivery |
|---|---|---|---|
| TTL at creation | Expose, native approval resource includes lifetime | Expose, explicit conversational agreement | Both candidate adapters |
| Set/shorten lifetime | New `bayleaf_inbox_lifetime`, native approval | New `inbox_lifetime`, explicit agreement, no native approval UI | Both candidates; parent Nanobot allowlist |
| Expiry readback | Preserve `expires_at`, `cleanup_not_before` | Same | Both candidates |
| Finite arrivals | New `bayleaf_inbox_events` | New `inbox_events` | Both candidates; parent Nanobot allowlist |
| Live SSE | Explicit script/API workflow | Explicit script/API workflow | Skill guidance, bounded duration/cancellation/reconnect, no hidden persistent tool |
| Bulk export/HAR | Direct API/scripts only | Direct API/scripts only | No new adapter tool |

TTL validation rejects both selectors together, invalid presets and seconds
outside 60–2592000 before approval/network. No implicit lifetime default. Shorten
uses the authoritative PATCH endpoint; the server rejects extension. Timed expiry
destroys content, so this consequence is explicit in schemas, descriptions and
skills. Nanobot gains this specifically requested timed-lifecycle action, not
immediate destruction/deletion or credential tools.

Finite events preserve empty-page checkpoints and `more`, validate minimal
reference fields, bound page sizes, and allowlist output. HTTP 410 becomes fixed
resynchronization guidance without upstream body disclosure. Neither tool loops,
polls, invokes inference or starts background work. SSE guidance describes 300-second
connection lifetime, stop reasons, cursor persistence/deduplication, bounded backoff,
deliberate resume after sleep and cancellation. Existing approval/quarantine paths
remain intact.

## Completed measurements

- Candidate OpenCode suite: **30/30** tests passed, including validation before
  approval, deny-before-write, expiry fields, finite empty checkpoints, malformed
  cursors/responses, allowlisting and 410 guidance.
- Candidate Nanobot suite passed, including equivalent new cases and its existing
  protocol, transport, path-containment and download tests.
- Staged parent installer suite: **8/8** tests passed with the proposed allowlist.
- Actual isolated macOS OpenCode v2.1.2 and MCP runtime: ten/eight inbox tools;
  TTL schema present, finite page returned, six OpenCode native permission paths
  rejected/permitted correctly, attachment mode 0600/quarantine protections,
  explicit reload with an existing session and process restart all passed.
- Corrected **published** Nanobot live trial passed: creation, direct-API TTL,
  sender-vs-owner 401 denial, untrusted read, inert response headers, exact-byte
  quarantined download, archive, receipt while the MCP process was off, restart
  retrieval and actual 60-second endpoint denial. Exact inbox destruction was
  acknowledged and private local files/processes removed.

Candidate live attempt was denied at creation. Read-only aggregate inspection
found **10 owner inbox rows: one active, nine destroying**. No candidate inbox was
created and no existing resource was changed. The authoritative per-owner quota
includes destroying rows; do not raise it or force cleanup to make a test pass.
After the Linux run completed, another passive capacity check still found ten
rows, so it did not retry creation.
`hosted-client-live.mjs` now supports `HOSTED_ADAPTER_ROOT` to run candidate-native
TTL/event creation and cursor resume once capacity is available.

### Disposable Linux host: completed and cleaned

`hosted-client-daytona.py --live` created **one** independent `daytona-medium`
machine with a 20-minute wall budget and automatic-stop/deletion backstops, using
the repository's Daytona account credential in operator process memory. No
BayLeaf owner/inference key was uploaded and no existing machine/session was
accessed. Public prices observed were $0.0504/vCPU-hour, $0.0162/GiB-hour and
$0.000108/GiB-hour storage; the bounded medium run budget was under $0.10.

The guest reported Python 3.14.6, Linux x86_64 and initial Node 25.9.0. Installed
Node 22, current OpenChamber npm package and OpenCode through OpenChamber's own
installer, yielding **OpenCode v2.1.2**; Nanobot 0.3.5 installed successfully in a
separate venv. No independent OpenCode version pin was introduced.

The real Linux OpenCode service and stdio MCP runtime then passed all candidate
checks: ten/eight inbox tools, TTL schema, finite checkpoint, six native approval
paths, exact HTML attachment mode 0600, unsafe-path/overwrite rejection, existing
test-session use after explicit reload, and process restart. This closes the
previous macOS-only uncertainty around the descriptor-relative download helper.

Stopped the exact disposable VM through Daytona. Two passive control-plane GETs
three seconds apart both reported stopped. Deliberate start restored a persistent
marker; the complete Linux runtime suite passed again. The finalizer deleted
only that owned VM and verified **GET 404**. Each inner run also removed its
temporary runtime/session/credential/download files.

Limits: the remote archive preceded the final local additional type guards for
event IDs/cursors; the final source passed the full local suites afterward.
OpenChamber's installer and OpenCode were exercised, **not browser approval UI**.
Nanobot's package installation and its real MCP process were exercised, **not
gateway/LLM tool registration**. This was a staging VM outside the production
owner controller, not the Sandboxes dashboard's managed install/relink flow.
The server used synthetic HTTP fixtures: live receipt arrival while the host
was asleep and finite-event resume against production remain unqualified due
to the owner-row quota. Explicit reload is not automatic ten-minute refresh.

The public managed-service endpoints select the authenticated owner's existing
controller/machine; they do not expose a test-sandbox-ID override. Exercising
that production path with the existing operator key would target the user's
stopped real workspace. It was intentionally not used. A separate synthetic
owner/controller fixture or approved isolated staging deployment is needed to
qualify that exact managed path without modifying the user's sessions.

## Release dependency and plan (requires review before publication)

1. Review the two source patches, especially Nanobot's explicit shortening action
   without native approval. Apply to the independent adapter repositories without
   overwriting concurrent work, then separately approve their coherent commits/pushes.
2. Include the small parent installer allowlist patch. Its omission would hide both
   new Nanobot tools even after publishing the package. Run the existing installer
   suite and verify actual installed `enabledTools` plus skill files.
3. Build authentic parent assets from the clean published commits. Preserve current
   production pins until this deliberate release; no fixture assets or unpublished
   local source may silently become deployed pins.
4. Stage/deploy the approved API update preserving the operator pilot and existing
   production settings. Verify active version, authenticated OpenCode pin and
   embedded Nanobot provenance. Parent commit/push remains a separate decision.
5. Qualify running-client delivery and deliberate sleeping-client resume. OpenCode
   needs the correct process feature flag as well as refreshed packages; Nanobot
   needs managed setup to update both assets and enabled-tool config. Already loaded
   conversation skill text may remain stale.

GLM AX must follow working functionality. This session exposes no subagent tool;
the parent can launch its explicitly authorized `opencode-go/glm-5.3-flash` runner
with the bounded published/candidate inventory and a natural receiving task.
Do not call this deterministic runtime harness a GLM behavioral result.

## Remaining release gates

- Explicit review/publication approval for both independent adapter commits and
  the parent allowlist/pin integration. The patches match the tested clones and
  apply against the stated base HEADs; both main adapter checkouts remain clean.
- Candidate-native TTL/events against production once normal cleanup frees an
  owner slot. Published basic live operations passed; this newer trial did not.
- Actual managed Nanobot gateway enabled-tool registration, OpenChamber browser
  permission presentation, automatic running-client refresh and managed relink.
  Core Linux V2/MCP tests are stronger than source checks but not those app gates.
- Real receipt while the disposable host sleeps, followed by finite-event cursor
  reconciliation. Host sleep/resume and process-off live delivery were separately
  measured, not combined into a fabricated end-to-end claim.
- Bounded GLM AX via the parent's available subagent machinery.
