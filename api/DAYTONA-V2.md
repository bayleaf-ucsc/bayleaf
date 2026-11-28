# Daytona v2 migration audit

Scope: [BayLeaf #172](https://github.com/bayleaf-ucsc/bayleaf/issues/172).
Upstream candidate: Lathe 2.0.0, `6ea95e3273b53015391fcdb3aabd7a8cdd0b607c`.
Provider reference: [Daytona v0 import](https://www.daytona.com/docs/migrate-from-v0)
and [Linux lifecycle](https://www.daytona.com/docs/linux-sandboxes).
The v2 integration is staged in the checkout. Deployed behavior is documented in
[SANDBOX-BROWSER.md](SANDBOX-BROWSER.md), [PREVIEWS.md](PREVIEWS.md), and
[RETENTION.md](RETENTION.md).

## Source audit

| Entry point | Authority and current behavior | v2 work |
| --- | --- | --- |
| Chat Lathe (`chat/tools/lathe/`, `chat/DESIGN.md`) | OWUI supplies the user's email and subject; the toolkit uses an operator-held Daytona project credential. Looks up the exact `chat.bayleaf.dev` label. Lathe uses the email OWUI supplies verbatim. BayLeaf disables automatic creation. `destroy()` is a separate human-confirmed call that deletes directly through Daytona. | Adopt upstream byte-for-byte, with the v2 endpoint and no static Toolbox URL. Verify that the staging OWUI identity supplies the canonical email found in D1; do not assume Lathe normalizes it. Keep auto-create disabled and point missing owners to BayLeaf provisioning. Prefer API/dashboard-owned deletion so credential revocation and deletion verification run together; check whether OWUI can remove `destroy` from both the callable schema and the dispatcher, or pursue an upstream valve. |
| API `/sandbox` and dashboard (`src/routes/sandbox.ts`, `src/routes/dashboard.tsx`, `src/templates/dashboard.tsx`, `src/daytona.ts`) | Ordinary owner key authorizes exec, poke, and expose; the API dashboard uses the owner's browser session. Exec, poke, and file requests can provision or wake through the shared resolver, including app tokens admitted to their bound file paths. Expose requires a running machine. Status and dashboard reads are passive. Delete accepts owner key or session. D1 caches the Daytona ID. Provider calls use the Worker project key. | Replace v0 CRUD and process calls, preserve public HTTP contracts, and show pause/restart truthfully. V2 search uses `/sandboxes/search`; verify exact ownership on authoritative ID reads, finish pagination, and fail closed on ambiguity or provider errors. Use an idempotent create shared by both BayLeaf provisioning paths. Old IDs or an unavailable search must never trigger a blank replacement. |
| Managed browser apps (`src/routes/sandboxBrowser.ts`, `src/sandboxBrowser.ts`, `src/serviceSessions.ts`, `sandbox/`) | Sandboxes uses account-bound management sessions over private Worker RPC. The owner Durable Object queues setup, wake and app operations; it currently duplicates API discovery, create, resume, process and upload transport. Explicit setup can provision; Desktop requires an existing machine. Passive status must not wake it. | Share the provider client with the API. Drive queued/booting, pausing/paused and stopping/stopped through legal transitions. Rebind stored app operations and issue new managed links for the new ID; distinguish setup/restart from a pause/resume that can keep the app alive. |
| Computer-use API and managed Desktop (`src/routes/computer.ts`, `src/computerUse.ts`, `src/sandboxBrowser.ts`, `src/serviceDefs.ts`) | Owner authority and sandbox-bound generation checks guard API sessions. Tool traffic uses the Worker project key. Browser Desktop currently assumes the v0 noVNC service; computer generation uses a constant v0 execute probe. | Port to the v2 Computer Use contracts, verify that status/screenshot/input do not wake compute, and qualify a noVNC bridge that listens on the sandbox interface while leaving RFB local. Verify real reconnect and generation behavior after pause and full restart. |
| Credential custody (`src/sandboxCredentials.ts`, `scripts/browser-setup.py`) | D1 holds an owner- and sandbox-ID-bound verifier; Daytona v0 substitutes a host-scoped secret for the placeholder sent by managed apps. Separate from the project key, ordinary owner key, app tokens and management sessions. Cleanup uses the v0 secret API. | V2 imports omit secret mounts. V2 uses project-scoped secrets named as the injected environment variable, so the v0 pattern (distinct per-sandbox secret attached as `BAYLEAF_API_KEY`) cannot be copied unchanged. Preserve distinct per-sandbox authority and `api.bayleaf.dev`-only substitution, and adapt managed bootstrap to the selected variable or placeholder. Test old readback, rotation and revocation as well as clean setup. Verify that any Daytona credential accessible to guest root is scoped to the fixture; no project key may enter the guest. Track the old secret outbox independently through rollback. |
| Preview gateway (`src/routes/previews.ts`, `wrangler.jsonc`, `PREVIEWS.md`) | Lathe registers with the installation credential and an OWUI owner assertion. The API owner-key path and managed app path mint their own signed Daytona destinations; private browser access uses the BayLeaf login/handoff, independent of app auth. Encrypted registration stores each upstream capability. | Use v2 signed-preview creation (`POST /sandboxes/{id}/ports/{port}/signed-preview-urls`). Qualify the exact live regional suffix and browser forwarding before adding it to the allowlist. Bind app listeners to the sandbox interface; most existing managed services already do. Daytona documents authenticated preview-triggered wake, including signed URLs: test via BayLeaf after pause and decide how public BayLeaf links should affect activity. Keep app/WebSocket access fail-closed and do not expose raw VNC. |
| Inactivity, cleanup and monitoring (`src/sandboxReaper.ts`, `src/userRetention.ts`, `src/index.ts`, `chat/probe/`, `telemetry/daytona/`) | Daily reaper scans complete v0 inventory, checks `lastActivityAt` and stable stopped/archived state, refreshes metadata before deleting, and clears D1 only after verifying absence. The fixed passive probe owner is exempt. Credential/preview cleanup runs separately; account retention observes sandbox dependencies. The status probe calls BayLeaf, while Daytona telemetry ingests provider metrics rather than making sandbox calls. | Keep 30 days of inactivity and the probe exemption. Use v2 lifecycle activity and paused/stopped metadata, run dry-run first, and reconcile imported activity with the source so import/testing does not silently renew retention. Verify deletion and compare by exact ID. Qualify metric continuity separately; Daytona does not migrate webhook registrations. |
| Indirect clients and qualification | Pouch, the sandbox CLI, hosted plugin and Sandboxes UI use BayLeaf HTTP/RPC. Direct v0 qualification callers include `scripts/preview-apps.py`, `preview-ops.py`, `probe-daytona-*.py` in the same directory, and `inbox/qualification/hosted-client-daytona.py`. The probe and CLI do not need Daytona credentials. | Keep downstream API paths; update lifecycle prose/status presentation. Migrate actively used provider qualification scripts and preserve historical evidence as such. Extend provider fixtures in `test-sandbox-policy`, `test-sandbox-reaper`, `test-sandbox-upload`, `test-grant-sandbox-files`, `test-computer`, `harness-sandbox-browser`, `harness-sandbox-credentials`, and `harness-previews`; run docs and frontend checks. Convert staging/rollout scripts and the Chat Code Sandbox skill alongside the tool. |

## Staging and cutover

1. Qualify a synthetic v0 archive import and an independently externally
   provisioned v2 sandbox. Use a separate label and staging user. Exercise actual
   Lathe discovery with auto-create off; inspect exact owner association and
   harmless process/filesystem/interpreter persistence. Then exercise the same
   workspace through a staging API and OWUI identity, including private HTTP,
   private VNC/WebSocket, a signed-in non-owner, and verified cleanup.
2. Use a persistent v2 image registered in BayLeaf's project and region. Review
   and pin image inputs before production. The upstream reference adds
   Chromium, AT-SPI and a noVNC bridge, uses an ordinary `daytona` user with
   passwordless sudo, and downloads Node, uv and noVNC during build. Imported
   filesystems do not inherit that image; qualify installing the bridge and
   missing runtime dependencies separately. Budget smaller **new** workspaces
   at **1 vCPU reserved, bursting to 2 vCPUs, 2 GiB RAM reserved and capped,
   and a 10 GiB disk cap** (`cpu: 0.5`, `cores_max: 1`, `memory_mib: 2048`,
   `memory_max_mib: 2048`, `disk_max_mib: 10240`). Daytona counts two vCPUs per
   core. The existing controller requires 2 GiB for OpenChamber, OpenCode Web
   and code-server; the installer also checks actual memory. Qualify cold
   setup, a real project workload, and reconnect after pause on this exact
   shape before rollout. Do not resize imports by default.
3. Stage the Worker and Chat together. BayLeaf provisions; Chat only discovers
   and wakes. Configure a one-hour idle pause and qualify a 24-hour run cap,
   which is independent of activity. Apply that lifecycle explicitly to imports:
   Daytona maps the old auto-stop to **stop**, not pause. Leave provider
   auto-deletion off. User jobs freeze while paused; external connections may
   need retry/reconnect.
4. Reinventory at cutover, quiesce v0 starts and writes, and confirm each
   backup reflects the last use. Import by verified source ID, without `force`.
   Keep a private mapping of source ID, destination ID, owner, source activity
   and credential/link state. Confirm exact labels and expected file data,
   reissue owned credentials and links, then compare-and-swap the D1 mapping.
   Keep production writes closed until both API and Chat resolve the same
   destination. The v0 reaper must not delete retained rollback copies during
   the review window. Keep the passive monitor passive throughout.
5. Before opening writes, rollback can restore the old mapping, API and Chat
   source/valves with the original workspaces intact. Once users write to v2,
   switching IDs back alone loses access to those writes; freeze and reconcile
   changed work from v2 first. Publish a user notice covering files, processes,
   secrets and replaced links. Review the pilot and rollback with Adam before
   changing the shared deployment. Handle retirement of old copies separately.

### Operator controls

- The checked-in Worker configuration still selects v0. An isolated Worker
  selects `DAYTONA_API_VERSION=2`, sets a non-production deployment label,
  points at a separately provisioned D1 database with migration `0024`
  applied, and sets `DAYTONA_V2_IMAGE`/`DAYTONA_V2_REGION` before enabling
  `DAYTONA_V2_CREATE_ENABLED`. Use a staging Chat identity and separate
  installation credential against its preview gateway.
- Before any Worker build for rollout, publish the sandbox plugin's dual
  `dtn_secret_`/`dtns_` support separately and verify real Git-package loading
  at the resulting SHA. The strict pin build refuses a dirty submodule.
  Rebuild the parent CLI assets and plugin pin from the reviewed checkout.
- The pinned Lathe reference image was built in BayLeaf's default project in
  Ashburn: `lathe-us-east-ash-1-20261127-5d26f651`. It is the candidate named in
  `wrangler.jsonc`. Rebuilds require `write:images` and `read:images`.
  Keep deploy, image build, and Chat credentials separate. Give the Chat key
  `read:sandboxes` and `write:sandboxes` but **no** `delete:sandboxes`; the
  byte-exact tool still lists `destroy`, but Daytona rejects it. The API owns
  the user-confirmed deletion path.
- The staged preview allowlist admits `.ash-1.daytonaproxy03.net` only in v2
  mode. The cutover tool refuses to generate bindings for imports outside
  qualified regions. Pass `--qualified-region` for each region only after
  its gateway is configured and tested. The Worker reaper is dry-run in v2
  even if the v0 setting is `delete`, until
  `DAYTONA_V2_REAPER_DELETE=true` is explicitly set after review.
- Use [`scripts/prepare-daytona-v2-cutover.py`](scripts/prepare-daytona-v2-cutover.py)
  for read-only owner/ID/import preflight. Once users have been notified and
  v0 mutations have been quiesced, `--prepare --state-dir <new-private-dir>`
  starts or reuses imports and applies lifecycle settings. Inspect the
  private warnings and verify each imported cohort's filesystem and launcher.
  Put the destinations back to sleep, then use `--finalize --state-dir
  <private-dir>` to capture their final activity clocks and generate the
  guarded handoff. These commands never write D1 or delete sources. Keep
  both generations closed to user writes during binding and deployment.
  Apply migration `0024`, install `handoff/install-guard.sql`, and run the
  one-statement `handoff/cutover.sql`. Require `verified=1` from
  `handoff/verify.sql` immediately before reopening traffic. Rehearse the
  guarded `rollback.sql` and `verify-rollback.sql` in local D1 with the
  same schema before production. Keep the guard until rollback is no
  longer needed, then remove it with `remove-guard.sql`.
- Set `SANDBOX_MIGRATION_READONLY=true` before changing owner bindings. It
  gates BayLeaf sandbox routes, new preview forwarding, owner controller
  operations, dashboard sandbox cache healing, and sandbox cleanup. It does
  not stop existing direct Daytona URLs, WebSockets already bridged, or
  separately hosted Chat dispatch. Pause Lathe tool dispatch in OWUI, drain or
  retire live connections/direct links, and verify v0 machines remain
  archived before copying. The passive sandbox probe also sees 503 during
  this maintenance window. Leave inference and unrelated BayLeaf facets live.
- Back up Chat using `python3 chat/scripts/lathe-rollout.py backup
  --snapshot-dir <private-dir>`. With `LATHE_DAYTONA_V2_KEY` loaded, run
  `preflight` against the same directory before pausing. If the operator
  has explicitly accepted Daytona's reported v0 sync on the separate
  credential, include `--allow-v0-key-sync` on both `preflight` and `promote`.
  The same-project and exact read/write sandbox scope checks still apply.
  Use `pause` with the same directory and
  drain in-flight calls. Once the API mapping, selected version and gateway
  have been verified, `promote --snapshot-dir <private-dir> --api-v2-ready`
  reads `LATHE_DAYTONA_V2_KEY`, installs the pinned tool and skill, and
  verifies the inactive configuration. Re-enable dispatch explicitly only
  after readback and the cutover check. Refresh `chat/tools/lathe/meta.json`
  from the live OWUI schema after promotion; the checked-in metadata before
  cutover is the v0 production snapshot.
- Browser links bound to v0 credentials fail closed when D1 binds the v2
  destination. Deliberate app setup attaches a new host-scoped secret and
  generates a new private link. Stop/archive on v0 and full stop/start on v2
  lose processes; pause/resume on v2 preserves them and reuses an unexpired
  managed link. Verify both browser reconnection and provider wake behavior.
  Keep legacy source machines and credential rows through rollback review.
  In a separate approved step, retire the original workspaces, set
  `DAYTONA_V2_RETIRE_V0_CREDENTIALS=true` to drain their credential outbox,
  and then remove the v0 transport.

### Run isolated launcher qualification

Build the local CLI artifact with `node scripts/build-sandbox-cli.mjs` from
`api/`. With the BayLeaf Daytona project key and candidate image in the
environment, run `node scripts/qualify-daytona-v2-launcher.mjs --live`. Add
`--cold-openchamber` to exercise the actual package installers on a fresh
workspace before the Desktop tests. The harness uses real Daytona and the
local API/D1/DO/preview code with synthetic identities.
Managed Desktop does not require inference. OpenChamber and OpenCode Web
still need a staging BayLeaf owner and a routable, authorized BayLeaf API to
verify their bootstrap and real inference. Use the approved ZDR lane.

A remote staging pilot requires its own Worker and preview-domain routes,
Wildcard DNS and TLS, D1/DO storage, preview wrapping and signing secrets, and
an approved OIDC callback with separate owner and non-owner sessions. Start
from an isolated configuration without production D1, service bindings,
telemetry or scheduled deletion. The Sandboxes frontend service binding,
browser broker origin, installer integration URL, and plugin API origin
currently target production. An alternate Worker hostname by itself cannot
exercise authenticated agent bootstrap end to end. Agree on a staging
deployment and identity plan before registering an OIDC callback or changing
shared routing.

## Read-only inventory and initial evidence

On 2026-11-27, Daytona returned 24 v0 workspaces with the exact production label,
24 distinct owners, all archived with completed backups, and all importable.
No imports or v2 sandboxes were present in the default project at preflight. No
non-exempt source was past the 30-day cutoff. The existing project credential
authenticated to v2; `GET /sandboxes` returned 410 directing callers to
`GET /sandboxes/search`. Lathe's offline suite completed successfully.

Production D1 contained 24 cached IDs, all exact matches for the current
Daytona owner and ID. Of these, 22 have an active sandbox credential bound to
that owner and ID. There were no active preview leases at the time of the query.
BayLeaf Chat's live valves confirm v0 control plane and a static Toolbox
override, with `auto_create_sandbox=false`. The personal-instance exercise in
the issue is operator-reported; the personal admin credential did not return a
valve read in this audit.

The v0 fleet is one base cohort: all 24 are private `daytona-medium`
containers, with `daytona` as the configured user and 2 vCPU, 4 GiB RAM,
and 8 GiB disk. Individual files and installed packages may differ.
The strict follow-up freshness check refused the fleet: all 24 reported
`last_backup_at` before `lastActivityAt`, for most by roughly the 24-hour
archive interval. `importable` proves Daytona will copy an archive, not
that the backup timestamp covers the owner's last write. Require a verified
backup-provenance rule or a fresh archive under maintenance before binding.
A disposable first archive reproduced the ordering, with recorded activity
2.397 seconds after its backup timestamp. Daytona returned a transient 502
during the fixture's second archive, so that run did not establish which
canary was imported. The first fixture was verified deleted; the retry uses
bounded backoff for transient metadata reads, without replaying writes.
The retry remained in `archiving` for the full 15-minute deadline on its
first cycle. The source fixture was verified deleted; no v2 import was
attempted. The successful single-cycle canary imports still establish that
archived files can carry over. They do not resolve the production timestamp
gap or justify bypassing the freshness guard.
A later single-cycle fixture verified the final canary byte-for-byte on both
the imported v2 sandbox and the restored v0 source, even though the source
activity timestamp was 3.536 seconds later than the backup. Both fixture
sandboxes were deleted. This confirms that the ordering alone is insufficient
to classify an archive as stale; it does not verify the fleet's archives.
Daytona's [historical v0 archive implementation](https://github.com/daytonaio/daytona/blob/v0.190.0/apps/api/src/sandbox/managers/sandbox-actions/sandbox-archive.action.ts#L88-L146)
can reuse a completed backup before destroying the runner copy, and
[state changes advance activity](https://github.com/daytonaio/daytona/blob/v0.190.0/apps/api/src/sandbox/repositories/sandbox.repository.ts#L96-L122).
That explains how an intact archive could show this timestamp ordering. The
tag does not identify the deployed hosted implementation or attest any of
the 24 backups. The documented migration API does not expose a backup digest
or backup selection. Resolve this with Daytona evidence for the exact
archives, or agree on a maintenance procedure that compares each restored
source with its v2 copy before rebinding. A comparison can establish what
both systems restore for the agreed paths; it cannot recover a write missing
from the original archive.
The synthetic import of that image retained the `daytona` home, writable
workspace, Node 24/npm, Python 3.14, Chromium, sudo, and websockify. It had
noVNC under `/usr/share/novnc`, which the managed Desktop launcher accepts.
Lathe's own `expose(target="vnc")` expects `/opt/novnc`; qualify a compatibility
alias on imported workspaces before promising that Chat shortcut. If the
distribution assets exist and `/opt/novnc` is absent, use
`sudo -n ln -sT -- /usr/share/novnc /opt/novnc` on the inspected v2 copy
before capture of its final activity baseline. Inspect an existing path rather
than replacing it. The synthetic import accepted the alias and verified the
expected asset was readable without overwriting provider or user files.

A disposable persistent v2 sandbox booted in Ashburn at 0.25 reserved cores,
1 GiB reserved RAM, and a 10 GiB disk limit. Daytona defaulted the limits to
16 cores and 32 GiB RAM, so reservation alone does not cap the shape. The
default image had Python but did not use the `daytona` account. A direct
signed HTTP preview returned 200, with suffix `.ash-1.daytonaproxy03.net`,
which the current BayLeaf configuration rejects. No BayLeaf proxy behavior
is established by the direct preview. The existing Worker key lacks
`write:images`. The Chat credential was confirmed to be for the same project
and used to build the candidate without expanding the Worker key.
The small disposable sandbox's deletion was verified.

A second fresh fixture accepted explicit ceilings of 1 core and 2 GiB RAM
with the same 0.25-core and 1-GiB reservations. The actual upstream Lathe tool,
with auto-create disabled and separate synthetic owner/other identities,
found only the externally provisioned fixture, ran shell commands, wrote and
read files, and resumed it with files and live Python interpreter state
intact. Deletion was verified. This called Lathe directly; OWUI dispatch and
the real BayLeaf gateway were not involved.

Credential creation and ETag-guarded attachment accepted a uniquely named,
host-scoped v2 secret. On retry, Daytona reported the attachment `applied`
and the guest saw a `dtns_` placeholder without its value being printed.
The agreed shape booted with 0.5/1 Daytona cores, 2048/2048 MiB RAM, and
10240 MiB disk cap. This used a disposable default image. Authenticated
substitution through the actual launcher remains a staging check.

The initial v0 import fixture reached `archived` before its `backupState`
field was populated. The retry with
[`scripts/qualify-daytona-v2-import.py`](scripts/qualify-daytona-v2-import.py)
used the migration inventory's authoritative `importable` signal. It imported
the archive and verified exact owner label, canary bytes, and one-hour pause
policy. Both fixture deletions were verified. The exact-shape default-image
fixture also passed native Desktop start, screenshot, and stop; this did not
exercise the managed noVNC bridge or gateway.

Local checks passed: API type checking, the v2 wire-contract harness, 39
preview gateway checks, 34 browser lifecycle checks, computer-use, sandbox
credentials, retention, installer, sandbox CLI, and plugin tests. The existing
full-app harnesses use synthetic providers. The fast preview helper harness
has a separate loader failure; the full gateway harness passed.

The real v2 launcher harness passed on the named image and agreed shape:
API provisioning, command and file I/O, native Desktop generation, private
noVNC HTTP and RFB WebSocket, signed-in non-owner denial, and reuse of the
same private link and owner session after pause/resume. Fixture cleanup was
verified. Live RFB exposed a Workers compatibility change: newer dates
deliver binary frames as `Blob`. The gateway now selects `arraybuffer` on
both sockets before accepting them.

A separate pair of disposable v2 workspaces verified host-scoped substitution:
as guest root, the synthetic `dtns_` placeholder authenticated to its
allowlisted endpoint (HTTP 200) and did not authenticate to a second origin
(HTTP 401). The guest-root process did not inherit a project key or a
`DAYTONA_SANDBOX_TOKEN`. This is an environment/egress check, not an exhaustive
guest isolation audit or a test of authenticated BayLeaf app bootstrap.
In a separate lifecycle probe, Daytona returned authoritative `deleted`
metadata; replaying a previously used create key after deletion created a new
ID, with unchanged and then changed resource arguments. No production
workspace was involved.

An isolated container running the same pinned upstream OWUI version as
BayLeaf Chat loaded the exact Lathe source and expected tool schemas. The
test verified distinct setup-admin and ordinary owner identities, exercised
the missing-workspace error with a real model on BayLeaf's standard ZDR
lane, and confirmed that Daytona had created nothing. After externally
provisioning one workspace, native model dispatch wrote a canary which an
independent Toolbox read verified. One owner/ID match remained, and the
fixture and container were removed. This does not exercise production
CILogon, the restricted Chat project key, or a Chat-registered private preview.

At the agreed profile, OpenChamber plus its managed OpenCode, standalone
OpenCode Web, and code-server passed cold install and binary version checks.
The launcher now locates the OpenChamber installer in the current `build/`
package layout as well as the older layout. These package checks do not
qualify authenticated managed-agent bootstrap or an inference workload.

Independent review added a recovery path when an app was stopped while the
machine was paused, an explicit boot-generation check before reusing old
launch links, retryable pending credential setup, and file-backed execution
for large scripts. Open now performs the v2 server-side check before
navigating, while status and Stop stay passive. Local lifecycle, UI, and
credential harnesses cover these paths.
