# Open WebUI upgrade evidence

Moved verbatim from `chat/DESIGN.md` (only relative link targets adjusted). Dated
evidence for diagnosis: statements such as "current" and "now" describe the time
of writing. Current configuration lives in [`../DESIGN.md`](../DESIGN.md). Newer
per-release records are `../image/UPGRADE-*.md`.

## Image choice and native telemetry (as of v0.13.3)

**Image choice.** Use version-specific standard-image tags (currently
`v0.13.5`), not rolling `main` or `slim`. BayLeaf stores uploads in DO Spaces
via OWUI's S3 provider (§1, Object Storage). Before v0.12.0, the slim image
omitted S3 support and refused to start with S3 storage configured. Upstream
v0.12.0 adds S3 support to slim, but BayLeaf retains the standard image;
switching image variants requires separate dependency and upload qualification.

**Native aggregate telemetry (2026-10-20).** The live rung-4 build adds the
qualified source minimization to the v0.13.3 standard image (upgraded 2026-11-10), pinned by
immutable upstream index
`sha256:46b59158e6558eeb980bc828e0f1b30238ad24d82ed84d5e5eda1dab2a082f14`.
The service command is `python /opt/bayleaf-otlp/startup_patch.py`, not the former
echo-and-start wrapper. Exact source/package guards run at build and startup;
the entrypoint prints guarded startup markers and retains the exec handoff to
uvicorn PID 1. Never bypass these guards or enable unpatched native metrics.

Native qualification used deployment `b36b8678-f928-4db2-81e1-a3ebcb35fc34` from
published source `1d56584c4d2b8576413ad615e625addab70e0f7e`. The first build failed unpacking the
pinned upstream image (`unexpected EOF`); one unchanged-source retry succeeded.
One instance, one worker, the original size/pool and retention job were preserved.
Repository-push auto-deploy remains **disabled**, so documentation publication
does not restart Chat. This is not an OWUI upgrade or schema migration.

## v0.13.5

**OWUI v0.13.5 upgrade (2026-11-25):** deployment
`5830cd44-3739-4feb-8f63-9ea4ffb5323d` moved all 296 chats into `chat_message`
rows. The v0.13.4 image cannot boot on the migrated database, so rollback means a
database restore. See [`image/UPGRADE-0.13.5.md`](../image/UPGRADE-0.13.5.md) and, for
the release before it, [`image/UPGRADE-0.13.4.md`](../image/UPGRADE-0.13.4.md).

## v0.13.3

**OWUI v0.13.3 upgrade (2026-11-10):** deployment
`4e42953a-2d5f-4e64-acfa-869693edc362` reached ACTIVE from published source
`12927dced930c71a453ab9e9905bc836a398c44f`. Both builds, all 16 Chromium arrival
cases, a synthetic existing-database upgrade, full five-minute arm64 PG/TLS export
and amd64 boot/inference passed. The telemetry adapter/dependency pins are
unchanged; frontend guards were refreshed. All three migrations completed through
`9f6c2a8d1b43`; image-only rollback is not qualified. Today's managed database
backup was verified. Exact build checkout, source guards, server PID 1,
health/version and authenticated Basic/Help inference passed in production.
The complete app spec, resources, hidden base model, grants and valves remained
byte-identical. Existing global settings were unchanged; new defaults include
90-day renewable session expiry, 50,000-character full-text threshold, disabled
auto tool approval/labels, keyword tool search and no chat-read character limit.
Tool search remains disabled and terminal connections empty. Saved retrieval
values remain 3/3/1000. Served arrival assets match qualified bytes. Adam confirmed
the production experience works and accepted the upgrade; individual browser
sign-in/tool/skill/upload scenarios were not itemized.
See [`image/UPGRADE-0.13.3.md`](../image/UPGRADE-0.13.3.md).

## v0.13.0

**OWUI v0.13.0 upgrade (2026-11-04 Pacific):** deployment
`79af5c90-9217-45ac-ad66-6399a8846ec3` reached ACTIVE from published source
`364ac9e731234b39fa4a15293140f4dd36356ecd`. Both architecture builds, amd64
boot/inference, full five-minute arm64 PostgreSQL/TLS export, all 16 Chromium
arrival cases and a synthetic existing-database upgrade passed. The telemetry
source adapter was adapted to upstream middleware changes without changing the
collection policy. Three migrations completed through `e42c8f710a36`; an
image-only rollback is not qualified. Today's managed PG backup was verified.
Production guards, PID 1, health/version and authenticated Basic/Help inference
passed. The complete app spec stayed unchanged. Full private pre/post pulls
found only the new true `is_active` field on all nine tools; sources, schemas,
valves, models, skills, grants and the hidden underlying model were unchanged.
Config added comments off, notifications on and empty Mistral OCR params.
Adam explicitly accepted the new notification inbox and 1024 tool-call default;
sub-agents remain disabled with their saved finite limits. Served arrival assets
match the qualified bytes. Adam confirmed fresh CILogon sign-in, Sandbox and
web-context tools work and accepted the upgrade. Upload scenarios were not
itemized; the 1024-round limit was deliberately not exercised. See
[`image/UPGRADE-0.13.0.md`](../image/UPGRADE-0.13.0.md).

## v0.12.4

**OWUI v0.12.4 upgrade (2026-10-27):** deployment
`c63a7deb-02c0-4261-880c-8a0eb8d0b2bd` reached ACTIVE from published source
`09aeebff5d2ffef6fc835607472f3e9158be9df0`. Both architecture builds, full arm64
PostgreSQL/TLS metrics export, amd64 boot/inference and all 16 real Chromium
arrival cases passed. No migration source changes; guarded telemetry dependencies
and minimized adapter bytes are unchanged. The image now uses Python 3.12 / Debian
13. Guarded startup, PID 1, health/version and authenticated Basic/Help responses
passed in production. The complete app spec and resource definitions stayed
unchanged. New config defaults are an empty LDAP fallback domain, lazy skills off
and empty UI visibility settings. Lathe 1.3.3 source/valves survived unchanged.
See [`image/UPGRADE-0.12.4.md`](../image/UPGRADE-0.12.4.md) for qualification and rollback;
Adam confirmed the production experience works after deployment; individual
browser/tool/upload scenarios were not itemized.

## Native telemetry production gate (2026-10-20)

The bounded five-minute on/off production gate passed: CPU changed −1.534
percentage points; loopback health/version p95 changed +2.50%, with no HTTP errors
or observed pool/cancellation errors; one metrics connection; warmed callback
probes 7.934–11.427 ms. RSS peak on was approximately 1.64 GB (off approximately
1.82 GB), not a long-term memory/capacity guarantee for this 2-GB instance. These
sequential windows are not matched campus-user load or full user-request p95.
Live private collector readback verified all five metric names, approved
dimensions, the observed source batch bound and **90-day active expiry**. No
gauge values were retained in qualification evidence. See
[`native-production.md`](../../telemetry/qualification/native-production.md).
The 120-points/minute retry budget still has the documented lost-ack headroom
limitation. Five-minute paging reduces freshness; the active-user gauge still
counts the previous three minutes, not five-minute unique users. Collector
freshness matters because dedicated exporter errors are suppressed.

## Signed-out root arrivals (2026-10-20)

**Signed-out root arrivals (2026-10-20).** Current deployment
`a5319b41-56ca-452d-a74e-bee904458baf` is ACTIVE from published source
`13a3a67b6642e49429ac22483121df9e389057ab`, preserving the native configuration
above. `BAYLEAF_CHAT_ARRIVALS_ENABLED=true` independently installs a guarded
first-party static loader/module. One initial public-root document may send one
identity-free arrival only after ordinary session resolution renders the sign-in
card; existing token markers, direct auth entries and private deep links are
excluded. The client sends only schema version, destination `chat` and null
referrer, with no credentials/referrer. The collector stores schema 2/policy 3
records with approved coarse network classification and 90-day expiry. Actual
anonymous HTTP → HTTPS → auth browser delivery, stored readback, served asset
hashes and native-export continuity passed; signed-in non-collection has isolated
local browser proof, not a new live authenticated test. See
[`chat-arrivals.md`](../../telemetry/qualification/chat-arrivals.md). Set this one
switch to `false` to disable arrivals without changing native metrics. Do not add
`FRONTEND_BUILD_DIR` or `STATIC_DIR` overrides; the pinned asset installer refuses
them. Recovery must preserve this explicit switch as well as the native settings.

## v0.12.3 and the reconnect incident (2026-10-18)

**Resolved incident and upgrade (2026-10-18).** Promoted v0.12.3 after Adam confirmed at
least a day of issue-free personal-service use. Only the image tag changed;
the startup harness and environment were preserved. This addresses the v0.12.0
socket reconnect/authentication storm documented in upstream
[issue #32338](https://github.com/open-webui/open-webui/issues/32338) and fixed
by [PR #32341](https://github.com/open-webui/open-webui/pull/32341), released in
v0.12.1. Before the upgrade, the main Python thread sustained 88–93% CPU,
authentication-related queries dominated approximately 168 SQL calls/second,
and application requests hit database-pool timeouts despite a healthy `/health`.
A restart alone immediately reproduced the load. The database showed no
long-running queries or blocked locks. Enabled `pg_stat_statements` in the
application database without a restart; DO had already loaded its collector.
Normalized query counters, not raw parameters or chat content, identified the
authentication amplification.

Both new migrations completed (`b8f2c6d91a04` → `c92da83b017f` →
`0bd252b206fb`); the harness preceded server PID 1, health passed, and
`/api/version` reported `0.12.3`. Initial 15-second samples fell to 1.3–1.9%
CPU with one 26.3% interval, and 1.7–9.7 SQL calls/second. Startup logs showed
no session errors or pool timeouts. Four subsequent 20-second samples measured
19.8%, 9.1%, 2.0%, and 11.7% CPU, with 9.1 then approximately 2 SQL calls/second;
all eight observed application database connections were idle. Adam confirmed
normal-browser sign-in was working after recovery. Existing browser tabs must
reload to receive the frontend fix. Today's managed database backup was verified. The expired
admin JWT and unresponsive UI prevented a fresh pre-upgrade resource pull;
recovery proceeded using the managed backup and preserved app spec rather than
blocking on the failed service. After token renewal, authenticated Basic and Help
inference returned the expected smoke-test response (1.0 and 7.9 seconds).
Full private pulls captured 9 tools, 6 functions, 8 skills and 4 workspace
models. Tool/function sources and tool schemas matched the repository after
normalizing schema order. Model differences were new null voice defaults;
known Brace3 metadata drift remained outside this upgrade. The live Code Sandbox
skill had three added decorative characters, left untouched pending confirmation.
The hidden base model remained active, hidden and wildcard-user readable.
Adam accepted incident closure after recovery and authenticated inference
verification. Full Basic/Help browser/tool/upload acceptance is a deferred
follow-up, not a completed check. Monitoring and capacity design are separate
post-incident work.
The private specs are under the session's temporary
`bayleaf-upgrade-20261018` directory. Image-only rollback is not qualified
across the new migration revision. No diagnostic hook, pool increase, or
additional worker was deployed.

## v0.12.0 (2026-10-12)

**Upgrade evidence (2026-10-12).** Promoted v0.12.0 after Adam confirmed personal
service soak. Deployment `737f9787-eb3e-4d6c-b26d-3041322d1fd7` reached ACTIVE;
all six Alembic migrations completed, the startup harness preceded server PID 1,
health passed, and `/api/version` reported `0.12.0`. Authenticated admin Basic
and Help inference returned the expected smoke-test response. Full private
before/after pulls (9 tools, 6 functions, 8 skills, 4 workspace models) differed
only by newly assigned version-history IDs; content, sources, images and grants
were unchanged. The hidden base model remained active with wildcard-user read.
Environment settings were unchanged and all names were documented here.
Snapshots and the previous deployment spec are under
`~/.tokens/bayleaf-owui-upgrade-20261012`; today's managed database backup was
verified, with no laptop database access opened. Adam confirmed that the browser
experience feels good after the upgrade; fresh CILogon sign-in was not separately
verified. Reverting the
image alone is not a verified rollback across the new migration revision.

## Global admin settings snapshot (2026-11-04, amended 2026-11-25)

Read back from the live persistent config and admin API after operator edits.
These are observed current values, not a before/after diff: earlier resource
backups did not capture global admin settings. No production settings were
changed during this backup.

- Workspace Tools/Functions: creation and import are admin-only (default user
  permissions leave `workspace.tools` and functions off; confirmed by the
  operator 2026-11-21). This is load-bearing:
  tool valves hold the Daytona key, Google client secret and instructor
  Canvas/GitHub tokens, and arbitrary user Python would reach them.
- Automations: `automations.enable=false`; default user permission
  `user.permissions.features.automations=false`. This is OWUI user automation,
  not the separate DigitalOcean retention-cleanup job.
- Comments: `comments.enable=false`; new notification inbox:
  `notifications.enable=true`. Adam accepted the default-on inbox on upgrade.
  Tool-call rounds now use upstream's 1024 default. Sub-agents remain disabled
  with saved limits of 20 concurrent, 20 async, 30 iterations and 30,000 output
  characters. The upgrade added empty `rag.mistral_ocr_params={}`.
- Context compaction: `chat.context_compaction.enable=true`, token threshold
  `80000`, token cap `80000`, retention percentage `40`. The compaction model
  and prompt-template overrides are both empty strings.
- Default chat model: `ui.default_models="basic"`; default pinned models: null.
  Default and external task models are both `openrouter.z-ai/glm-5.3-flash`;
  task-model params are `{}`.
- Global default model params: `{"custom_params": {}}`.
- Global default model capabilities: file context, vision, file upload, image
  generation, code interpreter, citations, status updates, usage and builtin
  tools enabled; web search, terminal and memory disabled. Default builtin-tool
  overrides disable memory, notes, channels and chats.

**Changes on 2026-11-25 (v0.13.5):**

- Default builtin-tool overrides also disable `users` (directory lookup) and
  `tools` (`create_tool`). A missing category means on, and a model with its own
  `builtinTools` does not inherit these: set both there too. Every OWUI upgrade
  must check for new categories.
- `skills.lazy_loading.enable=true`: attached skills appear by name and description
  until the model loads one. When off, OWUI preloads the bodies and records them as
  hidden tool calls that the model mistakes for its own.
- Default `terminal` capability is on, deliberately; no shared machines are
  configured. `video_generation.enable=false`; the default model capability is
  true but hidden in the UI while that switch is off.

These global defaults are distinct from saved workspace-model definitions and
do not establish which capabilities a particular model actually exposes. The
full resource pull found no new prompt, parameter, capability or binding changes
in Basic, Help, Basic Canary or Brace. The hidden shared base model was verified
active, hidden and wildcard-user readable. Full config exports can contain
credentials and stay private; only these reviewed settings belong in the repo.

## Superseded telemetry rollback instruction

For source shutdown set all four OTel enable flags to literal `false`, retaining
the guarded entrypoint. Full rollback restores the protected pre-change upstream
image/spec and prior wrapper **with native export disabled**, preserving all
unrelated settings.
