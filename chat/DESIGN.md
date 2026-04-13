# BayLeaf Chat — Deployment & Configuration

*Backup and design reference for the Open WebUI deployment at `chat.bayleaf.dev`.*

This directory is a recovery-oriented backup of the BayLeaf Chat service. It
captures the Digital Ocean App Platform deployment configuration, the OWUI
workspace models (with system prompts), custom tools, and filter/action
functions. Combined with the env vars documented below, this should be
sufficient to reconstruct the service from scratch.

> **This repo is public.** Secret values (API keys, OAuth secrets, DB
> credentials) are listed by name but redacted. Actual values live in the DO
> App Platform console and are never committed.

---

## 1. Infrastructure

### Digital Ocean App Platform

| Property | Value |
|----------|-------|
| **App name** | `bayleaf-chat-owui-app` |
| **App ID** | `7d0addd4-85db-4fe3-b931-501ae88d7f7f` |
| **Region** | `sfo` |
| **Image** | `ghcr.io/open-webui/open-webui` (version pinned in app spec) |
| **Instance** | `apps-s-1vcpu-2gb` (1 instance) |
| **HTTP port** | `8080` |

### Domain & Ingress

| Rule | Target |
|------|--------|
| `chat.bayleaf.dev` / | `open-webui` service |
| `bayleaf.dev` | About/landing page (GitHub Pages) |

### Database

Managed PostgreSQL 17 cluster `bayleaf-chat-db`. Connected via
`${bayleaf-chat-db.DATABASE_URL}` at runtime.

### Object Storage

DO Spaces bucket for file uploads and OWUI storage.

| Property | Value |
|----------|-------|
| Bucket | `bayleaf-chat-space` |
| Region | `sfo2` |
| Endpoint | `https://bayleaf-chat-space.sfo2.digitaloceanspaces.com` |

### Environment Variables

All env vars are set with scope `RUN_AND_BUILD_TIME` unless noted.

| Variable | Value | Notes |
|----------|-------|-------|
| `WEBUI_NAME` | `BayLeaf` | Branding |
| `ENABLE_SIGNUP` | `false` | No direct registration |
| `ENABLE_OAUTH_SIGNUP` | `true` | Users sign up via CILogon |
| `ENABLE_LOGIN_FORM` | `false` | No password login |
| `OAUTH_MERGE_ACCOUNTS_BY_EMAIL` | `true` | Merge accounts across auth migrations |
| `OAUTH_UPDATE_NAME_ON_LOGIN` | `true` | Overwrite display name from OIDC claim on each login |
| `OAUTH_UPDATE_PICTURE_ON_LOGIN` | `true` | Overwrite avatar from OIDC claim on each login (no-op for CILogon which sends no picture) |
| `OPENID_PROVIDER_URL` | `https://cilogon.org/.well-known/openid-configuration` | CILogon OIDC |
| `OAUTH_PROVIDER_NAME` | `UCSC` | Login button label |
| `OAUTH_SCOPES` | `openid email profile org.cilogon.userinfo` | Includes affiliation claim |
| `OAUTH_AUTHORIZE_PARAMS` | `{"idphint":"urn:mace:incommon:ucsc.edu"}` | Preselect UCSC IdP (requires v0.8.11+) |
| `OAUTH_CLIENT_ID` | `cilogon:/client_id/...` | CILogon client |
| `OAUTH_CLIENT_SECRET` | `<REDACTED>` | Encrypted in DO |
| `WEBUI_SECRET_KEY` | `<REDACTED>` | Encrypted in DO; must be set explicitly (see below) |
| `CORS_ALLOW_ORIGIN` | `https://chat.bayleaf.dev` | Restrict CORS to production origin |
| `USER_AGENT` | `BayLeaf/1.0 (https://chat.bayleaf.dev)` | Identify outbound HTTP requests |
| `ENABLE_OAUTH_GROUP_MANAGEMENT` | `true` | Sync groups from OAuth claims; see §1a |
| `ENABLE_OAUTH_GROUP_CREATION` | `true` | Auto-create groups from claims |
| `OAUTH_GROUPS_CLAIM` | `affiliation` | CILogon eduPerson affiliation |
| `OAUTH_GROUPS_SEPARATOR` | `;` | CILogon uses semicolons |
| `OAUTH_BLOCKED_GROUPS` | `["legacy:*","course:*"]` | Protect manually-managed groups; see §1a |
| `ENABLE_EVALUATION_ARENA_MODELS` | `false` | |
| `ENABLE_MESSAGE_RATING` | `false` | |
| `ENABLE_COMMUNITY_SHARING` | `false` | |
| `DATABASE_POOL_SIZE` | `5` | |
| `DATABASE_URL` | `${bayleaf-chat-db.DATABASE_URL}` | Scope: `RUN_TIME` only |
| `STORAGE_PROVIDER` | `s3` | |
| `S3_BUCKET_NAME` | `bayleaf-chat-space` | |
| `S3_ENDPOINT_URL` | `https://bayleaf-chat-space.sfo2.digitaloceanspaces.com` | |
| `S3_REGION_NAME` | `sfo2` | |
| `S3_ACCESS_KEY_ID` | `<REDACTED>` | |
| `S3_SECRET_ACCESS_KEY` | `<REDACTED>` | |
| `WEBUI_URL` | `https://chat.bayleaf.dev` | Canonical URL for OAuth callbacks |

**`WEBUI_SECRET_KEY` gotcha.** OWUI's Docker entrypoint (`start.sh`) checks
for this env var *in the shell* before Python starts. If the var is missing or
empty, OWUI generates a random key and writes it to `.webui_secret_key` inside
the container. On ephemeral container platforms like DO App Platform, this file
doesn't survive redeploys — so every deploy gets a new key, silently
invalidating all JWTs and any invite codes signed with the old key. Always set
`WEBUI_SECRET_KEY` explicitly as a `type: SECRET` env var in the app spec.

### OpenRouter Connection

OWUI is configured (via admin UI, not env vars) with an OpenRouter API
connection that exposes all ZDR-eligible models. The OpenRouter API key is
stored in OWUI's admin settings, not in the app spec.

### 1a. Group Management & Naming Convention

BayLeaf uses OWUI's OAuth group sync to automatically assign users to groups
based on CILogon's `affiliation` claim. When a user logs in, CILogon returns
semicolon-separated eduPerson values like
`Faculty@ucsc.edu;Employee@ucsc.edu;Member@ucsc.edu`. OWUI parses these into
individual group names, creates groups that don't exist yet, and reconciles
membership — adding the user to groups in the claim and removing them from
groups not in the claim.

**The clobbering problem.** OAuth group sync is a full reconcile: it removes
users from any group not present in the current claim. Without protection,
manually-managed groups (invite-code groups, course groups, research groups)
would be stripped from users on their next login.

**Solution: namespaced groups with `OAUTH_BLOCKED_GROUPS`.** Blocked groups are
immune to OAuth sync in both directions — they are never added to or removed
from during the login reconciliation. OWUI's `is_in_blocked_groups()` supports
exact matches, shell-style wildcards (`*`, `?`), and regex patterns.

**Naming convention:**

| Prefix | Purpose | Examples |
|--------|---------|---------|
| `legacy:` | Pre-existing manually-managed groups | `legacy:amsmith-group`, `legacy:https://canvas.ucsc.edu/courses/89028` |
| `course:` | Per-course access; suffix is Canvas course ID | `course:92591` |
| `access:` | Special access tiers (future) | `access:beta-testers`, `access:elevated-rate` |
| `admin:` | Operational groups (future) | `admin:operators` |
| *(no prefix, `@ucsc.edu` suffix)* | OAuth-managed affiliation | `Faculty@ucsc.edu`, `Student@ucsc.edu`, `Member@ucsc.edu` |

The current blocked pattern is `["legacy:*", "course:*"]`. As new prefixes are introduced,
add them: `["legacy:*", "course:*", "access:*", "admin:*"]`.

**Key details:**

- **Invite codes are UUID-based.** The `help_toolkit` (formerly
  `accept_invites_toolkit`) encodes the group UUID (not name) into invite JWTs.
  Renaming a group does not invalidate outstanding invite codes.
- **Model access grants use UUIDs.** Renaming a group does not affect which
  users can see which models — `access_grants` reference group IDs, not names.
- **User grants are unaffected.** OAuth group sync only touches group
  membership. Direct user grants on models (via `access_grants` with
  `principal_type: "user"`) are a separate system entirely.
- **OAuth group creation is enabled.** If a user logs in with an affiliation
  value that doesn't match any existing group, OWUI auto-creates it. This means
  new affiliation groups (e.g. `Affiliate@ucsc.edu`) appear automatically.

### 1b. Pre-Provisioning Students via Placeholder Accounts

Students can't be granted access to a course-specific model (e.g. Brace) until
they have OWUI accounts — but most students haven't logged in yet at the start of
term. The solution is to create **placeholder accounts** before term begins, add
them to the course group, and let the OIDC merge mechanism handle the rest when
students first log in.

**How it works:**

1. Pull the Canvas roster: `canvaslms users -c COURSE_ID -s -e`
2. For each student email, create a placeholder:
   `owui-cli users add <email> <name>` (exits 2 if already exists — safe to re-run)
3. Look up the user ID and add to the course group:
   `owui-cli groups add-user <group-id> <user-id>`
4. Student logs in via CILogon for the first time → OWUI finds the placeholder
   by email (`OAUTH_MERGE_ACCOUNTS_BY_EMAIL=true`), stamps the OIDC `sub` onto
   it, and updates the display name from the OIDC claim
   (`OAUTH_UPDATE_NAME_ON_LOGIN=true`). The account is now permanently linked.
5. The course model (e.g. `brace3-92591`) is already in the group — Brace just
   appears in the student's model list with no action required from them.

**Tooling:** See [`owui-cli`](https://github.com/rndmcnlly/owui-cli) (`users add`,
`users find`, `users show`, `groups add-user`) and `canvaslms` for roster export.
A provisioning script for a given course should pull the roster programmatically
rather than transcribing emails by hand to avoid transcription errors.

**TAs and guests:** Add non-student enrollments (TAs, guests) the same way —
`canvaslms users -c COURSE_ID -a -e` lists TAs. Add them to the group manually
if not on the Canvas roster.

**Re-running is safe:** `owui-cli users add` exits with code 2 if the account
already exists (either a prior placeholder or a student who logged in early).
`owui-cli groups add-user` is idempotent for existing members. A provisioning
script can be re-run mid-term to catch late adds from the registrar.

**Caveats:**
- Placeholder passwords are set to the string `placeholder-no-login`. Direct
  password login is disabled (`ENABLE_LOGIN_FORM=false`) so this is never
  usable, but it is not a real secret.
- `OAUTH_UPDATE_EMAIL_ON_LOGIN` is intentionally **not** set. If CILogon were
  ever to assert a different email than the placeholder (e.g. a preferred email
  alias), leaving this off prevents the stored email from drifting and breaking
  future lookups.
- CILogon does not send a `picture` claim, so `OAUTH_UPDATE_PICTURE_ON_LOGIN`
  is a no-op in practice but is set for correctness if the IdP ever changes.

---

## 2. Workspace Models

BayLeaf exposes curated "workspace models" that wrap OpenRouter base models with
system prompts, capability flags, tool bindings, and access controls. Each model
is defined in `models/<id>/model.json`.

### Public Models (available to all users)

| ID | Name | Base Model | Description |
|----|------|-----------|-------------|
| `basic` | Basic | `openrouter.z-ai/glm-5` | Default model for all users. Campus-aware system prompt (`Basic v1.1`), six suggestion prompts, no tools bound by default. System prompt mentions BayLeaf API access at `api.bayleaf.dev`. |
| `help` | Help | `openrouter.z-ai/glm-5` | BayLeaf help desk. Answers questions about the service, processes invite codes via `accept_invites_toolkit`. |

### Group-Restricted Models

| ID | Name | Base Model | Group(s) |
|----|------|-----------|----------|
| `brace-85291` | Brace (CMPM 121 Fall 2025) | `openrouter.deepseek/deepseek-v3.2` | Course-specific (Brace v2) |
| `brace3-92591` | Brace (CMPM 120 Spring 2026) | `openrouter.deepseek/deepseek-v3.2` | Course-specific |
| `everett-program` | Everett Program Chat | `openrouter.z-ai/glm-5` | Program-specific |
| `gambit` | Gambit (GLM-5) | `openrouter.z-ai/glm-5` | 2 groups |
| `procurement` | Procurement | `openrouter.z-ai/glm-5` | Staff group |

### Model Configuration Details

**Basic** — The default landing model. System prompt (`Basic v1.1`) orients the
model as a campus assistant, encourages concise replies, warns about turn-depth
limits, and suggests users start fresh conversations rather than extending long
ones. Uses `function_calling: native` with OpenRouter provider sort by
throughput. Vision is disabled; file upload and code interpreter are enabled.
Six suggestion prompts guide new users.

**Help** — Minimal capabilities (no vision, no file upload, no code interpreter).
Uses `help_filter` to force-inject `help_toolkit` (stealth pattern, see §3a),
giving users tools to list their groups, see available models, and process invite
codes. System prompt (`Help v1.1`) describes BayLeaf facts and firmly redirects
non-help tasks to Basic.

**Brace (v2, `brace-85291`)** — Course assistant for CMPM 121 Fall 2025. No
static system prompt — `brace_filter` fetches the system prompt from a Canvas
wiki page at the hardcoded slug `braces-system-prompt` at runtime. Bound to
`brace_submit_action` (Canvas submission button) and `brace_filter`. Uses
`brace_toolkit` (force-injected by the filter). Falls back to a generic prompt
if the Canvas page is unreachable. (The original Brace v1 architecture lives at
[rndmcnlly/brace](https://github.com/rndmcnlly/brace).)

**Brace (v3, `brace3-92591`)** — Course assistant for CMPM 120 Spring 2026.
Successor to Brace v2 with a cleaner design. No `brace_submit_action`. Uses
`brace3_filter` + `brace3_canvas_toolkit` (see §3). Key differences from v2:
system prompt is looked up by **page title** ("Brace3 System Prompt") rather
than a hardcoded slug — raises cleanly if the page is missing instead of
falling back silently; body is converted from HTML to markdown via
`markdownify`. Vision and `file_context` enabled.

**Gambit** — Rapid game prototyping assistant (`Gambit v1.5`). Extremely detailed
system prompt (~14K chars) covering prototyping philosophy, HTML artifact
generation, CDN library usage, publishing via gisthost, and cost-consciousness.
Uses `reasoning_effort: low`.

**Procurement** — UC procurement policy assistant. System prompt contains a
behavioral preamble and a lookup table of file IDs for 11 UC policy documents.
Retrieval is agentic: the model calls `read_document` via the `whole_document_retrieval`
toolkit to fetch full document text on demand, rather than having policy text inlined.
Documents live in the "Procurement" knowledge base (`8c7d7e27-6871-4871-a6b3-c197cf418072`).
`context.md` in this backup is the original source used to populate the KB; it is no
longer part of the system prompt.

---

## 3. Tools

Tools are Python classes that OWUI calls on behalf of the LLM. Each tool is in
`tools/<id>/` with `tool.py` (source) and `meta.json` (metadata, specs, access
grants).

### Public Tools (available to all users)

| ID | Name | Description |
|----|------|-------------|
| `lathe` | Code Sandbox | Coding agent tools backed by per-user Daytona sandbox VMs (see below) |
| `tavily_web_search` | Web Search | Tavily API search (valve: API key) |
| `jina_reader_toolkit` | Web Page Content | Jina Reader API for fetching web pages as markdown (valve: API key) |
| `deepinfra_key_generator_toolkit` | DeepInfra Key Generator | Generates scoped, time-limited DeepInfra API keys (valve: API key, token name, model list) |
| `random_choice_toolkit` | Random Choice | Uniform random selection from a list — for varied regenerations |
| `youtube_toolkit` | YouTube | Stub — tells users to run a local `uv` command to fetch transcripts |
| `campus_directory_toolkit` | Campus Directory | Scrapes UCSC campus directory with CSRF handling |
| `datetime_converter_toolkit` | Datetime Converter | ISO date → localized string via pytz |
| `whole_document_retrieval_toolkit` | Whole Document Retrieval | Agentic KB retrieval — list and read full documents by file ID, bypassing vector/embedding search. Access-controlled via `__user__` and `__model_knowledge__`. |

### Code Sandbox (Lathe)

The most substantial toolkit on the deployment. Source:
[rndmcnlly/lathe](https://github.com/rndmcnlly/lathe). Available to all users
but **not bound to any model by default** — users enable it per-chat via the
tool picker in the chat composer.

**What it does.** Gives any OWUI model a coding-agent tool surface — `bash`,
`read`, `write`, `edit`, `attach`, `ingest`, `onboard`, `ssh`, `preview`,
`destroy` — executing against per-user sandbox VMs
([Daytona](https://www.daytona.io/)) with transparent lifecycle management. Each
user gets a single persistent sandbox identified by email; the sandbox is
created lazily on first tool call and survives across conversations.

**Tools exposed to the model:**

| Tool | Purpose |
|------|---------|
| `bash(command, workdir)` | Execute shell commands (2-min timeout, output truncated to last 2000 lines / 50 KB) |
| `read(path, offset, limit)` | Read file with line numbers |
| `write(path, content)` | Write/create file (parent dirs created automatically) |
| `edit(path, old_string, new_string, replace_all)` | Exact string replacement |
| `attach(path)` | Show file to user inline (syntax-highlighted text, images, binary download card) without consuming model context |
| `ingest(prompt)` | Pull a file or pasted text from the user into the sandbox via browser modal |
| `onboard(path)` | Load project context (AGENTS.md + skill catalog) for agentic workflows |
| `ssh(expires_in_minutes)` | Generate a time-limited SSH command for interactive shell access |
| `preview(port)` | Generate a signed URL for a service running in the sandbox |
| `destroy(confirm, wipe_volume)` | Permanently delete the sandbox (safety guard: requires `confirm=true`) |

**Sandbox lifecycle.** Sandboxes idle-stop after 15 min, archive after 60 min
past stop. The first tool call in a conversation transparently creates, starts,
or unarchives the sandbox as needed. `/home/daytona/volume` is S3/FUSE-backed
persistent storage that survives even sandbox destruction.

**UserValves.** Users can configure `env_vars` (a JSON object of environment
variables like `{"GITHUB_TOKEN":"ghp_..."}`) that are injected into every
`bash` command without exposing values to the model.

**Admin valves** (configured in OWUI admin panel, never committed):

- `daytona_api_key` — Daytona API key
- `daytona_api_url` — Control plane URL (default: `https://app.daytona.io/api`)
- `daytona_proxy_url` — Toolbox proxy URL
- `deployment_label` — Label key for sandbox tagging (e.g. `chat.bayleaf.dev`)
- `auto_stop_minutes` — Idle timeout (default: 15)
- `auto_archive_minutes` — Archive delay after stop (default: 60)
- `sandbox_language` — Default runtime (default: `python`)

### Restricted Tools (Stealth Toolkits)

| ID | Name | Access | Injected by | Description |
|----|------|--------|-------------|-------------|
| `help_toolkit` | Help | No grants (stealth) | `help_filter` | Group membership listing, model access listing, invite code acceptance/creation. Valve: `INVITE_SIGNING_KEY` (optional, falls back to `WEBUI_SECRET_KEY`). |
| `brace3_canvas_toolkit` | Brace3 Canvas | No grants (stealth) | `brace3_filter` | Canvas LMS read access + date localization for Brace v3. Token snarfed from the filter at call time; no separate valve needed. |
| `brace_toolkit` | Brace | No grants (stealth) | `brace_filter` | Canvas API, GitHub API, Google Drive used by Brace v2 (valve: multiple keys). |

### Other Restricted Tools

| ID | Name | Access | Description |
|----|------|--------|-------------|
| `gws_toolkit` | Google Workspace | Admin only (no grants) | Per-user OAuth2 access to Google Drive (see below) |
| `mark_time_toolkit` | Mark Time | Admin only (no grants) | Stopwatch/timer with per-chat LRU cache (user valve: timezone) |

### 3a. Stealth Toolkit Pattern

Several toolkits are not directly visible to users. Instead, a paired filter
force-injects the toolkit into the request at runtime. This gives the admin full
control over which models get which tools, without users being able to
accidentally enable or disable them via the chat composer's tool picker.

**How it works:**

1. **Create the toolkit** normally (`tools deploy`), but **do not grant any
   access** (`access_grants: []`). With no grants, the toolkit is invisible in
   the user-facing tool picker.

2. **Create a paired filter** whose `inlet` method appends the toolkit ID to
   `body["tool_ids"]`:

   ```python
   class Filter:
       def inlet(self, body, __user__, __metadata__):
           body.setdefault("tool_ids", []).append("my_toolkit")
           return body
   ```

3. **Attach the filter to the model** (via `params.filter_ids` on the model
   config). The filter runs before tool dispatch, so the toolkit is available
   to the model even though the user never selected it.

**Current instances:**

| Filter | Toolkit | Model(s) |
|--------|---------|----------|
| `help_filter` | `help_toolkit` | `help` |
| `brace3_filter` | `brace3_canvas_toolkit` | `brace3-*` |
| `brace_filter` | `brace_toolkit` | `brace-*` |

**When to use this pattern:**

- The toolkit should always be available on a specific model, not user-selectable.
- The toolkit exposes internal APIs (groups, models, access grants) that should
  not be casually browsable from arbitrary models.
- The filter needs to do additional setup (e.g. fetch a system prompt, derive
  context from the model ID) alongside the toolkit injection.

### Google Workspace (GWS Toolkit)

Per-user OAuth2 integration with Google Drive. Source:
[rndmcnlly/gws-toolkit](https://github.com/rndmcnlly/gws-toolkit). Users
connect their own Google account via an in-chat OAuth flow; tokens are stored
per-user and revocable. Currently **admin-only** — not yet granted to the
general user population.

**Tools exposed to the model:**

| Tool | Purpose |
|------|---------|
| `connect_google_workspace` | Initiate OAuth flow to link the user's Google account |
| `disconnect_google_workspace` | Revoke tokens and unlink |
| `search_drive(query)` | Search the user's Google Drive by text query |
| `list_drive_folder(folder_id)` | List files in a Drive folder (default: root) |
| `read_drive_file(file_id)` | Read a file — exports Docs as markdown, Sheets as CSV, Slides as text |

**Design.** The toolkit self-registers an OAuth callback route on the OWUI
FastAPI app at startup. Token refresh is handled transparently. Read-only
scope only (`drive.readonly`). The OAuth client credentials are configured
via admin valves — the toolkit itself contains no secrets.

**Admin valves** (configured in OWUI admin panel, never committed):

- `google_client_id` — Google OAuth client ID
- `google_client_secret` — Google OAuth client secret
- `base_url` — OWUI base URL for the OAuth callback (e.g. `https://chat.bayleaf.dev`)

### Tool Valves (credentials configured in admin UI)

Several tools require API keys configured as "valves" in the OWUI admin panel.
These are **never** committed to this repo:

- `lathe` — `daytona_api_key`, `daytona_api_url`, `daytona_proxy_url`, `deployment_label`, `auto_stop_minutes`, `auto_archive_minutes`, `sandbox_language`
- `gws_toolkit` — `google_client_id`, `google_client_secret`, `base_url`
- `tavily_web_search` — `tavily_api_key`
- `jina_reader_toolkit` — `JINA_API_KEY`
- `deepinfra_key_generator_toolkit` — `API_KEY`, `API_TOKEN_NAME`, `MODELS`, `EXPIRES_DELTA`
- `help_toolkit` — `INVITE_SIGNING_KEY` (optional; falls back to `WEBUI_SECRET_KEY` if empty)
- `brace_toolkit` — `GITHUB_API_TOKEN`, `CANVAS_ACCESS_TOKEN`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON`
- `brace3_filter` — `CANVAS_ACCESS_TOKEN` (used by both `brace3_filter` and `brace3_canvas_toolkit`; the toolkit snarfs it from the filter instance)

---

## 4. Functions (Filters & Actions)

Functions are Python classes that intercept or augment the request/response
pipeline. Each is in `functions/<id>/` with `function.py` and `meta.json`.

| ID | Type | Global | Active | Description |
|----|------|--------|--------|-------------|
| `rate_limit_filter` | filter | yes | **yes** | Per-user rate limiting (10/min, 50/hr, 100/3hr sliding window) |
| `depth_limit_filter` | filter | yes | no | Halves max response tokens with each turn (disabled) |
| `help_filter` | filter | no | yes | Injects `help_toolkit` into the Help model (stealth pattern, see §3a). No valves. |
| `brace_submit_action` | action | no | yes | Button to submit conversation HTML to Canvas assignment (Brace v2 only) |
| `brace_filter` | filter | no | yes | Injects `brace_toolkit` and fetches system prompt from Canvas wiki page at hardcoded slug (Brace v2) |
| `brace3_filter` | filter | no | yes | Injects `brace3_canvas_toolkit` and fetches system prompt from Canvas page by title "Brace3 System Prompt" (Brace v3). Derives course ID from model ID (`brace3-NNN`). Raises on missing page. Valve: `CANVAS_ACCESS_TOKEN`. |

### Rate Limit Filter

The only globally active filter. Applies to all models and all users (including
admins). Default thresholds:

- 10 requests per minute
- 50 requests per hour
- 100 requests per 3-hour sliding window

### Depth Limit Filter

Currently **disabled**. When active, it divides an `initial_token_budget`
(default 16384) by the number of user turns, making responses progressively
shorter in long conversations.

---

## 5. Skills

Skills are markdown documents surfaced to the LLM as context (Workspace →
Skills). Access is controlled by `access_grants` — the same mechanism as
models and tools. BayLeaf uses skills to inject role-specific behavioral
guidance and platform feature hints, scoped to the OAuth groups that
correspond to each campus affiliation.

Manage via `owui-cli skills` or the admin API at `/api/v1/skills/`.

| ID | Active | Access | Description |
|----|--------|--------|-------------|
| `web-search` | yes | all users (`user:*`) | Describes the Tavily web search and Jina Reader integrations and how to enable them. |
| `code-sandbox` | yes | 1 group | Points to the Lathe coding agent toolkit and Daytona sandboxes; tells users to enable the Code Sandbox toolkit. |
| `canvas-api` | yes | 1 group | Guides agents using the Canvas LMS API via the Code Sandbox toolkit's `CANVAS_ACCESS_TOKEN` env var; includes `canvaslms` CLI usage, REST API pointer, data hygiene rules, and escalation to a desktop agent for complex tasks. |
| `bayleaf-for-students` | yes | 1 group (`Student@ucsc.edu`) | Instructs the agent to prioritize learning, build writing literacy, and points to the learning-opportunities skill package. |
| `bayleaf-for-employees` | yes | 1 group (`Employee@ucsc.edu`) | Placeholder — acknowledges employee role, no special instructions yet. |
| `bayleaf-for-faculty` | yes | 0 grants (owner-only) | Suggests AI integration paths for research and teaching; mentions Canvas LMS and BayLeaf as a campus-scoped alternative to commercial tools. |

### Role-scoped skills and OAuth groups

The `bayleaf-for-*` skills implement a lightweight skill system: each skill is
granted `read` access to the OAuth-managed group that corresponds to the
relevant `eduPerson` affiliation (e.g. `Student@ucsc.edu`,
`Employee@ucsc.edu`). When a user with that affiliation opens a conversation,
the OWUI skill engine surfaces the matching skill(s) as additional context for
the model. This gives the model role-aware behavioral guidance without
requiring separate models per role.

`bayleaf-for-faculty` currently has no grants (owner-only) — it is visible
only to admins while its content is being refined.

---

## 6. Recovery Procedure

To reconstruct BayLeaf Chat from this backup:

1. **Create DO App Platform app** with a single service using the OWUI Docker
   image at the version noted above. Attach a managed PG 17 database and
   configure S3 storage via DO Spaces. Set all env vars from the table in §1.

2. **Configure OpenRouter** in the OWUI admin panel (Admin → Settings →
   Connections) with a ZDR-eligible OpenRouter API key.

3. **Import models** — The model JSON files in `models/` match the OWUI import
   format. Use the admin API `POST /api/v1/models/import` or recreate them
   manually in the Workspace → Models UI. For procurement, the system prompt is
   complete as-is in `model.json`; re-populate the KB from `context.md` (see step 3a).

   3a. **Repopulate Procurement KB** — Split `models/procurement/context.md` into
   individual policy files and upload each to a new knowledge base, then attach it to
   the model and update the file IDs in the system prompt table. The
   `whole_document_retrieval` toolkit must also be deployed (see step 4).

4. **Import tools** — For each tool in `tools/`, create a new tool in the admin
   UI (Workspace → Tools), paste the source from `tool.py`, and configure the
   access grants and valves per `meta.json`.

   Note: `brace3_canvas_toolkit` has no `meta.json` — it is admin-only with no
   grants. Its Canvas token comes from the `brace3_filter` valve at runtime;
   no valve configuration is needed on the toolkit itself.

5. **Import functions** — Same process via Workspace → Functions. Set
   `is_global` and `is_active` flags per `meta.json`. Configure function
   valves (Canvas tokens etc.) in the admin panel.

   For `brace3_filter`: set `CANVAS_ACCESS_TOKEN` in the filter's valve. This
   same token is used by `brace3_canvas_toolkit` at call time (snarfed via
   `app.state.FUNCTIONS`). Attach to any model with ID matching `brace3-NNN`
   where `NNN` is the Canvas course ID.

6. **Configure model bindings** — Attach tools, filters, and actions to models
   per the `toolIds`, `filterIds`, and `actionIds` in each `model.json`.

7. **Set access grants** — Configure group-based access for restricted models
   and tools. Group UUIDs will differ in a new deployment; map by group name.

---

## 7. Synchronization Workflow

This directory is the source of truth for model system prompts, tool source
code, and function source code. Changes flow in two directions.

### CLI tool: `owui-cli`

[`owui-cli`](https://github.com/rndmcnlly/owui-cli) is a purpose-built CLI
for the OWUI admin API. Install via `uvx owui-cli`.

```bash
export OWUI_URL=https://chat.bayleaf.dev  # target instance
export OWUI_TOKEN=<bearer-token>          # admin JWT
owui-cli tools list                      # list all tools
owui-cli tools pull <id>                 # dump tool source to stdout
owui-cli tools deploy <source.py> [id]   # push tool source to live
owui-cli functions pull <id>             # dump function source to stdout
owui-cli functions deploy <source.py>    # push function source to live
owui-cli --json models show <id>         # full model JSON
owui-cli models update <model.json>      # push model config to live
owui-cli users find <query>              # search users
owui-cli groups add-user <id> <user-id>  # add user to group
owui-cli schema                          # explore the full OWUI API surface
```

Run `owui-cli` with no arguments for the full command listing.

### Bearer token

`owui-cli` reads `OWUI_URL` and `OWUI_TOKEN` from the environment. Tokens
are JWTs that expire; refresh by copying a fresh token from
`localStorage.getItem("token")` in the browser console.

### Pull (single item)

```bash
owui-cli tools pull lathe > chat/tools/lathe/tool.py
owui-cli functions pull rate_limit_filter > chat/functions/rate_limit_filter/function.py
owui-cli --json models show basic > chat/models/basic/model.json
```

Then `git diff chat/` to review changes.

### Pull (full backup)

```bash
owui-cli tools pull-all chat/tools/
owui-cli functions pull-all chat/functions/
owui-cli skills pull-all chat/skills/
owui-cli models pull-all chat/models/
```

Each `pull-all` command writes `<dir>/<id>/source + <dir>/<id>/meta.json`.
Models pull-all filters to workspace models only (those with a
`base_model_id`), discovers all models dynamically, and extracts base64
data-URI profile images into separate files. Then `git diff chat/` to review.

The legacy `_backup.py` script still exists for one feature `owui-cli`
doesn't handle: splitting the procurement model's ~670K-char policy context
from the system prompt into a separate `context.md` file. This is too
app-specific for the CLI.

### Push (apply repo changes to live instance)

```bash
owui-cli tools deploy chat/tools/lathe/tool.py lathe
owui-cli functions deploy chat/functions/rate_limit_filter/function.py rate_limit_filter
owui-cli models update chat/models/basic/model.json
```

Alternatively, edit items manually in the OWUI admin UI (Admin Panel →
Workspace → Models / Tools / Functions).

### Upstream API source (for reference)

The authoritative route definitions live in the Open WebUI repo:

- [`backend/open_webui/routers/models.py`](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/routers/models.py)
- [`backend/open_webui/routers/tools.py`](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/routers/tools.py)
- [`backend/open_webui/routers/functions.py`](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/routers/functions.py)

`owui-cli schema` and `owui-cli schema <resource>` can also be used to
explore the API surface directly.

---

## 8. Directory Structure

```
chat/
├── DESIGN.md               # This file
├── _backup.py              # Script used to pull this data from the OWUI API
├── models/
│   ├── basic/
│   │   ├── model.json      # Params, meta, system prompt, capabilities
│   │   └── profile.png     # Model avatar
│   ├── help/
│   │   ├── model.json
│   │   └── profile.png
│   ├── brace-85291/        # Brace v2 — CMPM 121 Fall 2025
│   │   ├── model.json
│   │   └── profile.png
│   ├── brace3-92591/       # Brace v3 — CMPM 120 Spring 2026
│   │   └── model.json
│   ├── everett-program/
│   │   └── model.json
│   ├── gambit/
│   │   ├── model.json
│   │   └── profile.webp
│   └── procurement/
│       ├── model.json      # Behavioral preamble only
│       ├── context.md      # Inlined UC policy documents (~670K chars)
│       └── profile.png
├── tools/
│   ├── lathe/
│   │   ├── tool.py          # Code Sandbox — coding agent tools (Daytona sandboxes)
│   │   └── meta.json
│   ├── accept_invites_toolkit/  # Legacy — superseded by help_toolkit
│   │   ├── tool.py
│   │   └── meta.json
│   ├── help_toolkit/            # Stealth — injected by help_filter
│   │   └── tool.py
│   ├── tavily_web_search/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── jina_reader_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── deepinfra_key_generator_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── random_choice_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── gws_toolkit/
│   │   ├── tool.py          # Google Workspace — per-user OAuth2 Drive access
│   │   └── meta.json
│   ├── brace_toolkit/       # Brace v2 — Canvas + GitHub + Drive
│   │   ├── tool.py
│   │   └── meta.json
│   ├── brace3_canvas_toolkit/  # Brace v3 — Canvas read-only, force-injected by brace3_filter
│   │   └── tool.py          # No meta.json — admin-only, no grants
│   ├── youtube_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── campus_directory_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── datetime_converter_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── mark_time_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   └── whole_document_retrieval_toolkit/
│       └── tool.py          # No meta.json
└── functions/
    ├── rate_limit_filter/
    │   ├── function.py
    │   └── meta.json
    ├── depth_limit_filter/
    │   ├── function.py
    │   └── meta.json
    ├── brace_submit_action/ # Brace v2 only
    │   ├── function.py
    │   └── meta.json
    ├── brace_filter/        # Brace v2 — hardcoded slug, fallback on error
    │   ├── function.py
    │   └── meta.json
    ├── help_filter/         # Stealth toolkit injector for Help model
    │   └── function.py
    └── brace3_filter/       # Brace v3 — title lookup, markdownify, raises on missing page
        └── function.py      # No meta.json
```
