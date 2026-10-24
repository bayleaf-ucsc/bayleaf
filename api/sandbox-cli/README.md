# Sandbox `bayleaf` CLI and MCP

Linux BayLeaf sandbox only. Hosted CLI/MCP wiring shipped 2026-10-24 and refreshed
on Adam's existing sandbox only. Other clients receive it at deliberate app setup,
not remote refresh alone. No desktop/laptop installation, login or personal
credential store. See the release qualification below for remaining limits.

## Hosted wiring (2026-10-24)

Deliberate OpenChamber and Nanobot setup now installs the shared executable before
configuration and registers `bayleaf mcp` through absolute installed-source and
Node paths. The approved release below refreshed only Adam's two managed apps,
preserving workspace, credentials, histories, schedules and owner-edit guards.

- OpenCode V2 uses `mcp.servers.sandbox`, `codemode: false`: native tools named
  `sandbox_click`, `sandbox_screenshot`, etc. Proxy/CA child settings are allowlisted;
  no credentials or arbitrary NODE_OPTIONS enter settings. Managed credentials
  remain automatically discovered and literal Daytona placeholders unchanged.
- Nanobot uses `tools.mcpServers.sandbox`, exact raw-name `enabledTools` generated
  from the shared contract catalog. Its exposed names are `mcp_sandbox_click`, etc.
  The old `bayleaf` adapter keeps search/fetch/usage and quarantined inbox-save only.
  `--private-previews` narrows both schema and dispatch: public access and injected
  headers are rejected before HTTP. No Nanobot authority/approval widening.
  Pinned Nanobot 0.3.5 persists native MCP images as local artifacts rather than
  inserting them directly into model context. Its `read_file` loads those artifacts
  as image blocks; the shared orientation teaches this bridge. Screenshots therefore
  persist in Nanobot media storage unless deleted, unlike the shared MCP itself.
- OpenChamber's plugin switches only when deliberate setup supplies
  `BAYLEAF_SHARED_MCP=true`. It keeps native websearch/webfetch, usage, exact-byte
  inbox saves, message deletion and inbox destruction. All overlapping preview
  and inbox registrations disappear. Existing processes without the flag retain
  their old tools during remote package refresh. No desktop/general-OS wiring.
- One shared `bayleaf-sandbox-orientation` replaces managed environment/Inboxes
  recipe skills. OpenChamber retains `bayleaf-scheduling`. Nanobot schedule,
  environment, persistence and privacy knowledge is in the shared orientation.
  Edited managed skills or an occupied owner-authored `sandbox` MCP entry fail
  visibly, never overwritten. No personal skills, memory or schedules are removed.
- **Approval difference:** OpenCode seeds native `sandbox_*` ask rules and specific
  read-only allows. This replaces legacy per-port/private-public resource prompts
  with tool-name and wildcard-resource MCP prompts. Native retained save/delete
  tools preserve their existing scoped permission UX. Nanobot still has no per-call
  approval UI. This difference needs explicit rollout review, not an assertion of
  permission parity. No floor control is added.

Publication procedure: review and publish the two-file `api/sandbox-plugin` change to
`bayleaf-ucsc/opencode-sandbox`, preserving a remotely advertised release ref.
No Nanobot submodule release is required: its existing adapter already provides
the retained four tools, and parent `enabledTools` partitions them. Strict plugin
and Nanobot clean/published builds are unchanged and must pass before an approved
API deployment. Then qualify an explicitly authorized managed setup for each UI,
native image rendering/consent, placeholder substitution and fresh-agent behavior.
No migration or frontend deployment is required for this wiring itself. Existing
clients update only at deliberate setup; source tests are not live UI evidence.

Run `npm run test:shared-mcp` for configuration and actual isolated V2 stdio
registration, native-image and permission checks. The AX scenario is a structural
discovery check (descriptions available without curl instructions), not model-led
unprompted behavior or a live browser rendering qualification.

The historical deferred matrix below records the CLI-only release decision for
closed issue #117. This candidate implements its follow-on integration, not a
reopening of that issue or a claim the migration is already delivered.

Local candidate verification: shared CLI/SDK subprocess tests; 34 plugin tests;
31 installer and 9 Nanobot configuration tests; Nanobot package/asset suites;
both TypeScript checks; docs/computer/service-session/credential suites;
33 synthetic browser lifecycle groups, Desktop cleanup and policy smoke passed.
Actual isolated OpenCode 2.1.4 listed all 28 shared tools without overlapping
native registrations, discovered orientation + scheduling, converted native images,
and completed an actual click permission request/reply. Strict plugin build rejects
the edited submodule as expected. Run the optional released-Nanobot image/registry
check with `uv run --script scripts/harness-nanobot-shared-mcp.py`.
Released Nanobot 0.3.5 passed that actual stdio/registry check: 28 exact tool names,
native screenshot converted to an isolated artifact and loaded by `read_file` as
image blocks. No inference, live proxy substitution or UI image rendering involved.

## Examples

```sh
bayleaf tools
bayleaf open_session
bayleaf screenshot --output screen.png
bayleaf click '{"x":200,"y":140}'
printf 'Hello\n' | bayleaf type_text --stdin
bayleaf press '{"key":"Return"}'
bayleaf inbox_limits
bayleaf inbox_create '{"type":"email","preset":"experiment"}'
bayleaf inbox_messages '{"id":"ibx_example","limit":"20"}'
bayleaf inbox_read '{"id":"ibx_example","mid":"msg_example"}'
bayleaf expose 5000
bayleaf expose 5000 --public
bayleaf expose 5000 --stdin  # JSON containing optional upstream_headers, from a trusted pipe
bayleaf unexpose 5000       # port-as-slot, never a URL
bayleaf mcp --groups computer,inboxes,previews
bayleaf mcp --groups computer --allow open_session,screenshot,click
```

All operation output is JSON. Errors are fixed codes on stderr, exit 1; invalid
CLI syntax/input exits 2. Missing credentials fail closed. Screenshot output is a
new, non-clobbering mode-0600 file; MCP returns native image content, not paths or
base64 embedded in text. `--stdin` reads Unicode text for `type_text`, JSON for
other tools. `--json` is an alternative to a single JSON positional argument.
Query fields retain HTTP types, so `limit` is a string. There is no shell/process
invocation inside the CLI. No configurable base URL, redirects, automatic input
retry, session reopening or sandbox/Desktop lifecycle calls.

### Tool inventory (28)

- Computer: `open_session`, `move`, `click`, `drag`, `scroll`, `mouse_down`,
  `mouse_up`, `type_text`, `press`, `hotkey`, `key_down`, `key_up`, `screenshot`,
  `screenshot_compressed`, `display_info`, `windows`.
- Inboxes: `inboxes`, `inbox_limits`, `inbox_get`, `inbox_create`,
  `inbox_lifetime`, `inbox_messages`, `inbox_metadata`, `inbox_read`,
  `inbox_archive`, `inbox_events`.
- Previews: `expose`, `unexpose`.

Each tool has a self-contained description, generated JSON input schema and MCP
read-only/destructive/idempotence/open-world hints. Groups and allowlists are
discovery filters, not credential scope, approval or sandbox isolation. MCP has no
native approval UI. Consequential input, lifetime shortening and public exposure
need caller/user agreement. Public exposure is explicit; private is the default.
Application upstream headers remain supported with API validators, local rejection
of recognizable platform credentials (including Basic encoding), API-side sensitive
credential protection and exact `upstream_headers_applied` acknowledgement. Header
values are never returned. Public visitors can exercise injected app authority.

Inboxes results carry an untrusted-data cue and escaped JSON in a delimited text
block; sender text cannot close that block. CLI uses a structured untrusted flag.
This is a prompt-injection cue, not proof that the model will obey it. Reception
never activates agents. Sender credentials, message deletion, inbox destruction,
SSE, bulk export and attachment/body file saves are not exposed by this initial
curated package. Existing adapters retain their current save/mutation capabilities.
No assertion of complete old-adapter parity or migration is made.

## Shared implementation and delivery

`contracts.ts` imports actual HTTP Zod schemas from `src/schemas.ts`; it curates
names/descriptions and removes the internally managed computer handle from tool
arguments. Full HTTP validation, including mouse coordinate refinements, runs
before transport. JSON schemas are generated from those same validators at runtime,
and tests compare representative contracts to the HTTP definitions. There is no
third hand-copied field catalog or whole-API exposure.

`entry.ts` is the dedicated executable entry (including symlink launches);
`main.ts` exports import-safe CLI/MCP helpers. `client.ts` handles credentials, fixed-origin bounded HTTPS, session custody,
redaction and images. `main.ts` serves both CLI and MCP. The maintained official
`@modelcontextprotocol/sdk` is pinned and locked rather than growing another
hand-written stdio protocol. Undici supplies explicit HTTPS-proxy support across
supported Node versions. Its TLS validation remains enabled and Node respects
`NODE_EXTRA_CA_CERTS`. No arbitrary NODE_OPTIONS or credentials go in MCP settings.

The package is private, parent-owned source under `api/`, not a third independently
published repository. `npm run build:sandbox-cli` installs locked build inputs
without lifecycle scripts and esbuild emits a self-contained ~1.2 MB executable
and ignored `.sandbox-cli-assets.json`. No runtime npm install is needed in guests.
Wrangler runs this build **in addition to**, not instead of, the unchanged strict
published-submodule guards. The CLI-only build requires no submodule edits; hosted
migration also uses the separately published OpenCode plugin registration switch.

The controller transfers `cli-assets.json` beside the existing installer on the
next deliberate managed app setup. After app configuration, the installer uses a
shared file lock, verifies asset hashes and refuses to overwrite owner-edited CLI
source. It writes `~/.local/share/bayleaf/cli/bayleaf.mjs` (0700) and symlinks
`/usr/local/bin/bayleaf` when writable, otherwise `bayleaf` beside the existing
PATH-resolved Node executable, only when its directory is same-UID, writable and
not group/world-writable. That normal PATH location is intended for terminals,
OpenChamber children and Nanobot, not just a launcher-specific PATH. Occupied paths
or lack of write permission fail with `cli_path_conflict`/`cli_path_unavailable`,
not sudo, an implicit lifecycle operation or a false successful install.
Adam's live Linux image qualified the Node-directory fallback; other images and
app-only setups remain qualification gates. No PATH or shell-profile edits occur.
Desktop's Toolbox-managed activation does not run this installer.

### Credential and handle custody

Use `BAYLEAF_API_KEY` when present. MCP children without it read the existing
managed `credentials/owner-key` from fixed BayLeaf service locations, in order
browser, nanobot, ttyd, jupyter, code-server, dufs, collabmd. No new credential
copy is persisted. Files must be regular, same-UID, mode 0600 or stricter, bounded
and not final-component symlinks. An invalid present environment/file fails closed.
Literal `dtn_secret_` placeholders are preserved for Daytona HTTPS substitution.
The API remains authoritative for owner binding, scope and credential lifecycle.

Computer handles live at `~/.local/state/bayleaf/computer/session.json`, separately
from harness-specific XDG roots. The directory is 0700, the file 0600, same-UID,
non-symlink, atomically replaced and bound to a SHA-256 credential fingerprint.
Only the signed observation handle, expiry and fingerprint persist. The API binds
the handle to owner/account generation, sandbox and boot/Xvfb process generation.
Expiry/credential changes reject locally; generation changes reject at the API's
next screenshot. Any computer HTTP, transport or image failure discards the local
handle, without automatic reopen/retry. Explicit `open_session` can replace it.
Multiple processes share this handle; one process's failure can invalidate another
process's observation session. This is conservative coordination, **not** floor
control or an atomic snapshot. Existing API future floor-control comments remain.
No screenshots or typed/inbox content are retained except explicit output files
and transient MCP results (a harness may retain those in its history).

## Historical CLI-only exposure decisions (#117, superseded for hosted wiring)

| Surface | Decision, boundary and owner/gate |
|---|---|
| Sandbox CLI/MCP | Installer support deployed; all 28 tools listed on Adam's existing sandbox, with bounded read-only qualification below. API authority unchanged. Other machines install on next deliberate app setup. |
| Hosted OpenChamber/OpenCode | Keep native plugin, search/fetch permission UX and all existing skills/tools unchanged. Do not register overlapping MCP Inbox/expose tools. Full migration needs plugin maintainer to disable migrated native registrations/recipe skills while retaining search/fetch and other functionality, publish approved submodule revision, then qualify V2 image/approval behavior. |
| Hosted Nanobot | Keep existing stdio adapter and parent enabledTools unchanged. Full migration needs parent config to partition old search/fetch/usage from new computer/Inboxes/previews without duplicate registrations, preserve old inbox-save functionality or agree its replacement, and explicitly approve public/header support versus today's private-only surface. Its independently published adapter may need skill/registration edits before a full replacement. |
| Shared sandbox orientation | ONE new short `SKILL.md` packaged, not yet registered. Replace old environment/specialized recipe guidance only alongside working harness migration; keep scheduling/lifecycle knowledge discoverable. No duplicate recipe skills added. |
| Chat | Defer, Chat maintainer/Adam owns authority, grants, screenshot-history and consent decisions. No tools/config changed. |
| Desktop OpenCode/OpenChamber, Standard/Sealed | Omit CLI installation: sandbox-only decision. Existing desktop onboarding/skills unchanged. |
| HTTP docs/llms | HTTP contracts unchanged; existing deployed orientation remains accurate. This guide records the sandbox-only CLI, not migrated harness availability. |

No submodule publication is required to build/install the CLI alone. Complete
OpenCode migration does require an approved plugin release; do not weaken its clean
published-pin guard. Nanobot can partition MCP servers in parent config, but a full
single-skill/functional replacement needs coordinated adapter/skill work and may
require its release. These are explicit deferred integration gates, not completed
capability delivery. Existing/running/sleeping clients have not been changed.

## Tests and deployment steps

From `api/`: `npm ci --prefix sandbox-cli --ignore-scripts`,
`npm run test:sandbox-cli`, `npx tsc --noEmit -p sandbox-cli/tsconfig.json`,
`npx tsc --noEmit`, and the existing computer/docs/service-session/sandbox-browser/
sandbox-credential suites. New tests use synthetic credentials and HTTP fixtures,
temporary private files, in-memory MCP and a genuine SDK stdio subprocess. They
cover initialization/list/call, native images, schema drift, invalid arguments,
handle reuse/expiry/credential rejection/discard, no lifecycle calls/retries,
credential fallback/permissions/redaction, invalid image/JSON/HTTP/redirect errors,
untrusted framing, stdin/file output and port/header/default-access contracts.
Synthetic installer tests cover normal-PATH installation, idempotence and refusal
to overwrite edited CLI source. No live credential or provider traffic is used.

Local results (2026-10-24): new CLI/MCP suite, both TypeScript checks, `test:docs`,
`test:computer`, `test:service-sessions`, `test:sandbox-credentials`, and full
`test:sandbox-browser` passed (29 installer tests and 33 synthetic lifecycle groups).
`git diff --check` passed. Tests regenerated explicitly marked Nanobot fixture
assets; they are not deployable provenance evidence. Deployment must run the strict
published asset build again. No submodule working tree changed.

Before any deployment: review this diff and deferred migrations with Adam; verify
the exact Linux image can install the PATH link and supply supported Node/proxy/CA
settings; qualify real screenshots/computer generation failures through Daytona.
Then, only with approval, build verified published adapter assets and deploy API.
Use an explicitly approved isolated managed app setup, never restart a user's work
to refresh the CLI. Verify installed PATH from terminal and each agent process,
credential substitution/rotation/revocation, actual image rendering, tool duplication
and ordinary-user consent/discovery. Commit/push and submodule releases are separate
approval gates. The approved CLI-only rollout below supersedes the original
no-deployment state, not the deferred migration gates.

## Historical CLI-only installation qualification (2026-10-24)

- API deployed successfully (checked exit 0):
  `45da40b7-f80f-46b8-a7ff-e62aa426e77d`. No migration or frontend deployment.
  Strict build verified published plugin `96851ba3c0ee1130c484af761e25b1cc080883f4`
  and Nanobot `6863a08e671eb7697a28b6582ac8e3bf1b17346d`, not fixture assets.
- CLI 0.1.0 installed through the same hash-verified installer helper and managed
  source guard, in Adam's already-running, exact-owner-label sandbox only.
  Source: `~/.local/share/bayleaf/cli/bayleaf.mjs`, mode 0700, with managed SHA-256
  manifest. Installed source matches the deployed build:
  `94b8f436a0a09dff71fe9eedd53dbed48b5b61d1aca5bc507fff888715d4f63f`.
  Executable: `/usr/local/share/nvm/current/bin/bayleaf` symlink.
  `/usr/local/bin` was root-owned 0755 and unwritable; no sudo or permission changes.
- Debian Linux UID 1001, Node v25.9.0. Login-shell help and 28-tool discovery pass.
  Existing Terminal process PATH also resolves the CLI, with HTTPS proxy and
  `NODE_EXTRA_CA_CERTS` present. No running OpenChamber/Nanobot process was found
  for direct environment qualification; neither app was started or restarted.
- Without `BAYLEAF_API_KEY`, the existing private browser `credentials/owner-key`
  (same UID, 0600) supplied a literal Daytona secret placeholder. Read-only
  `inbox_limits` succeeded through proxy substitution (1127 ms), with no new
  credential copy. TLS verification remained enabled.
- Real sandbox stdio JSON-RPC client initialized MCP 0.1.0 and listed 28 tools.
  No MCP registration/configuration or existing adapter replacement occurred.
- Desktop was already active. Explicit `open_session` and one screenshot passed:
  161933 bytes, 707 ms, new 0600 private scratch file, deleted immediately.
  No screenshot contents were exported; no GUI input or Desktop lifecycle calls.
  All qualification scratch was removed; a post-deployment `inbox_limits` also passed.
  Shared handle created at `~/.local/state/bayleaf/computer/session.json` (0600,
  directory 0700). It expires normally; no automatic reopen.
- Live qualification caught silent symlink entrypoint failure. Dedicated executable
  entry and symlink regression fixed it before deployment. Normal-PATH fallback
  has owned-directory and unsafe-permission regression coverage.
- Both TypeScript checks, CLI/MCP, computer, docs, service-session,
  sandbox-credential and sandbox-browser suites passed (30 installer tests,
  33 synthetic lifecycle groups). No live key rotation/revocation, generation
  disruption, image rendering by an agent, consent/duplicate-tool migration,
  unprompted discovery, other-owner live traffic or inference tests performed.
  No exposures or inboxes created. All changes remain uncommitted.

To try it, open the existing sandbox Desktop's Terminal application yourself
(or use an already-open Terminal). No managed app setup/restart is needed:

```sh
bayleaf --help
bayleaf tools
bayleaf inbox_limits
bayleaf open_session
bayleaf screenshot --output "$HOME/bayleaf-trial.png"  # new private file; delete after use
bayleaf mcp --groups computer,inboxes,previews  # stdio server, not an interactive shell
```

Computer commands require an already-active Desktop. During that earlier trial,
agent tools/skills remained unchanged; hosted wiring now ships as described above.

## Approved hosted release qualification (2026-10-24)

- Published plugin `1061c6e6c7d724d23b56565752f4fbcdc6142315` to its existing
  `origin/main`, with no protection/ruleset requiring a PR and no divergence.
  Tag `sandbox-before-shared-mcp-2026-10-24` preserves the previous deployed
  `96851ba` as a remotely advertised rollback ref. Nanobot remains published
  `6863a08e671eb7697a28b6582ac8e3bf1b17346d`; no Nanobot submodule edits/release.
- Strict published asset builds and API deployment succeeded with checked exit 0.
  Initial integration version: `bdd430e3-2f3b-445b-a479-1c4aedd44011`.
  Final API version after public orientation updates:
  `35491220-6e0b-48a1-ac08-34d8fe833749` (exit 0). Live `/llms.txt` readback
  confirms hosted delivery, deliberate setup and desktop/laptop exclusions.
  Public orientation was updated only after installed-client qualification.
  No migration or frontend deployment; parent changes remain uncommitted/unpushed.
- Exact owner label `chat.bayleaf.dev=amsmith@ucsc.edu` verified on the existing
  started 4-GiB machine before Toolbox commands. No creation, deletion, resizing,
  Desktop activation or unrelated app restart. Local personal-key files were
  stale (403); the existing private managed placeholder worked without export.
  No fabricated auth/session records or credential/config authority changes.
- OpenChamber repair used the supported owner-authenticated
  `POST /sandbox/browser/restart` from inside the sandbox. Controller and installer
  reached ready. At the real `/home/daytona/workspace` location, OpenCode 2.1.4
  reports the exact published plugin active, shared MCP connected, one orientation
  plus `bayleaf-scheduling`, and no old environment/Inboxes recipe skills.
  Actual generated-config stdio discovery lists all 28 shared tools. The isolated
  real V2 harness separately verifies retained native extras and duplicate removal;
  no claim of a full active-process tool enumeration through the HTTP API.
- Nanobot refresh used its supported installed setup action with the existing
  owner credential and exact existing operation/preview origin. Only its local
  request deadline/restart flag changed, not edge expiry or auth records. Verified
  installer/CLI/published assets were transferred; existing setup/config/request
  files were privately backed up in `state/shared-mcp-release-backup` first.
  The installer reached ready and its managed process is alive. This is installer
  repair, not a new dashboard login or newly registered managed preview.
  Later managed operations replaced both operation IDs during qualification;
  no attempt was made to overwrite or roll those operations back.
- Real installed Nanobot 0.3.5 loaded the generated config in a separate no-inference
  registry check: exactly 28 `mcp_sandbox_*` tools plus `mcp_bayleaf_search`,
  `mcp_bayleaf_fetch`, `mcp_bayleaf_usage`, `mcp_bayleaf_inbox_save`. No duplicate
  preview/Inboxes registrations. Shared private-only arguments, orientation and
  existing scheduling file remain. Real retained usage and shared inbox-limit
  reads succeed through Daytona substitution. No inboxes/exposures created.
- Installed executable `/usr/local/share/nvm/current/bin/bayleaf` resolves to
  `~/.local/share/bayleaf/cli/bayleaf.mjs`, mode 0700, SHA-256
  `359b61d92bc1a19241914a45f8c508f3d21399a127c5916c4888ee026dd926a8`, matching
  the genuine deployed CLI asset. Both actual configs use absolute Node/source
  paths and contain only allowlisted proxy/CA environment settings, no credentials.
- Open-session observation returned HTTP 409 because Desktop was inactive. The
  failed observation handle was discarded, and a subsequent screenshot correctly
  refused with `session_required`. No screenshot artifact or GUI input was made;
  Desktop was not started for testing. Live image rendering/input remain pending.
  Isolated released Nanobot artifact/read_file and OpenCode native-image tests pass.
- Tests passed: 34 plugin tests; CLI/SDK suite (28 tools); both TypeScript checks;
  actual OpenCode 2.1.4 shared-MCP image/permission/duplicate checks and published
  Git-plugin runtime harness; released Nanobot 0.3.5 image/registry harness;
  Nanobot adapter/assets/setup suites; docs, computer, service-session, credential,
  browser installer (31 tests), Nanobot installer (9 tests), Desktop cleanup,
  sandbox policy and all 33 synthetic browser lifecycle groups; diff check.
- Safe UI checks: OpenChamber `/health` returned 200; Nanobot bootstrap returned
  200 with its existing app-only header and 401 without it. Both current private
  gateways denied anonymous requests with 401. No app auth secrets or URLs exported.
- Remaining evaluation: real browser image rendering, actual GUI input/native
  approval interaction, fresh-model unprompted discovery, existing-conversation
  stale-skill behavior, other images and sleeping-client migration, live credential
  rotation/revocation. No inference spend or floor-control claim. Reload both UI
  tabs and start a fresh conversation to avoid old skill text in history; start
  Desktop deliberately only when a GUI task is desired.

### Release snapshot: deferred screenshot failure

Later diagnostic evidence supersedes the inactive-Desktop observation above:
direct Daytona full and region screenshots return HTTP 500 `DAYTONA_DAEMON`,
`connection is shut down`; BayLeaf maps this to HTTP 410 `session_ended`.
The OpenChamber MCP region request used `{height:400,width:512,x:0,y:0}`.
Xvfb/Desktop are running and `xdpyinfo` succeeds, so a stale session alone is not
the cause. The underlying provider screenshot connection failure is unresolved.
Screenshot/UI qualification and further troubleshooting are deliberately deferred;
this release does not claim live screenshot success. No speculative fix is included.

Final release snapshot deployed API `a9023bd4-cd9f-4794-98ee-1bd33eef3f90`
with checked exit 0 and strict published plugin/Nanobot builds, plus the locked
CLI build. Focused CLI/MCP, real isolated OpenCode, plugin, installer, computer,
docs, service-session, credential and 33 synthetic lifecycle checks passed, as did
both TypeScript checks and the diff check. Live smoke: OpenAPI and Sandboxes root
200, all 16 computer routes present and unauthenticated POSTs denied with 401.
No migrations, frontend deployment, app restart or authenticated sandbox calls
were performed for this final snapshot.
