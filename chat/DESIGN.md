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

All resources live in the **`BayLeaf / UCSC`** DigitalOcean team
(slug: `bayleaf-ucsc`), under the `adam@adamsmith.as` account with
`amsmith@ucsc.edu` invited as a second owner. See
`politics/ACCOUNTS.md §2` for the account/team migration history and
handover plan.

Use `doctl --context bayleaf` to target this team from the CLI; the
default context points at the personal `Just Adam` team.

### Digital Ocean App Platform

| Property | Value |
|----------|-------|
| **App name** | `bayleaf-chat-owui-app` |
| **App ID** | `f1a1e758-62e9-4e99-90cb-212cab12958d` |
| **Default ingress** | `bayleaf-chat-owui-app-6uicw.ondigitalocean.app` |
| **Region** | `sfo` |
| **Image** | `ghcr.io/open-webui/open-webui` (version pinned in app spec) |
| **Instance** | `apps-s-1vcpu-2gb` (1 instance) |
| **HTTP port** | `8080` |

### Domain & Ingress

| Rule | Target |
|------|--------|
| `chat.bayleaf.dev` / | `open-webui` service |
| `bayleaf.dev` | About/landing page (GitHub Pages) |

**DNS setup.** `chat.bayleaf.dev` is served by DigitalOcean App Platform's
shared edge (which itself runs on Cloudflare infrastructure). In the
Cloudflare zone for `bayleaf.dev`, `chat` is configured as two A records
pointing at DO's published **static ingress IPs**: `172.66.0.96` and
`162.159.140.98` (plus optional AAAA records `2606:4700:7::60` and
`2a06:98c1:58::60`). These IPs are documented and stable per DO policy
(see <https://docs.digitalocean.com/products/app-platform/how-to/add-ip-address/>).
Both records are "DNS only" (grey cloud); we do NOT proxy through the
user-owned Cloudflare layer, because DO's edge is already Cloudflare-based
and a second layer would add latency without value. The TLS cert on
`chat.bayleaf.dev` is issued by Google Trust Services via DO's edge, not
Let's Encrypt.

A CNAME pointing at the default ingress hostname would also work and
reads more self-documenting, but the A-record approach is the
DO-documented default and avoids binding the DNS record to this specific
app's random slug (which would change if the app is ever rebuilt).

### Database

Managed PostgreSQL 17 cluster `bayleaf-chat-db`.

| Property | Value |
|----------|-------|
| **Cluster ID** | `ea8c7549-e761-44e1-a9c3-e45e478a5202` |
| **Engine** | PostgreSQL 17 |
| **Region** | `sfo2` |
| **Size** | `db-s-1vcpu-1gb` (10 GB storage, 25 max connections) |
| **Connection** | `${bayleaf-chat-db.DATABASE_URL}` at runtime (spec binding) |

### Object Storage

DO Spaces bucket for file uploads and OWUI storage.

| Property | Value |
|----------|-------|
| Bucket | `bayleaf-ucsc-storage` |
| Region | `sfo2` |
| Endpoint | `https://sfo2.digitaloceanspaces.com` (path-style; see §6a) |
| Access key | Scoped (Read/Write/Delete on this bucket only), not account-wide full access |

Objects are stored flat at the bucket root (no key prefix). Uploaded via OWUI
yield keys of the form `<uuid>_<original-filename>`.

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
| `OAUTH_BLOCKED_GROUPS` | `["legacy:*","course:*","hold:*"]` | Protect manually-managed groups; see §1a |
| `ENABLE_EVALUATION_ARENA_MODELS` | `false` | |
| `ENABLE_MESSAGE_RATING` | `false` | |
| `ENABLE_COMMUNITY_SHARING` | `false` | |
| `DATABASE_POOL_SIZE` | `10` | Headroom above OWUI's default of 5; see §1c. |
| `DATABASE_URL` | `${bayleaf-chat-db.DATABASE_URL}` | Scope: `RUN_TIME` only |
| `STORAGE_PROVIDER` | `s3` | |
| `S3_BUCKET_NAME` | `bayleaf-ucsc-storage` | |
| `S3_ENDPOINT_URL` | `https://sfo2.digitaloceanspaces.com` | Region endpoint (path-style); do **not** use the virtual-hosted `<bucket>.sfo2.digitaloceanspaces.com` form — see §6a |
| `S3_REGION_NAME` | `sfo2` | |
| `S3_ACCESS_KEY_ID` | `<REDACTED>` | Encrypted in DO (was plaintext in the pre-migration app; hardened to SECRET during 2026-04 migration) |
| `S3_SECRET_ACCESS_KEY` | `<REDACTED>` | Encrypted in DO (same as above) |
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
| `hold:` | Users on administrative hold | `hold:graduation-pending` |
| *(no prefix, `@ucsc.edu` suffix)* | OAuth-managed affiliation | `Faculty@ucsc.edu`, `Student@ucsc.edu`, `Member@ucsc.edu` |

The current blocked pattern is `["legacy:*", "course:*", "hold:*"]`. As new prefixes are introduced,
add them: `["legacy:*", "course:*", "hold:*", "access:*", "admin:*"]`.

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

### 1c. Scaling Posture (Single Worker, Single Replica)

BayLeaf Chat runs as **1 instance × 1 uvicorn worker**. The instance is
`apps-s-1vcpu-2gb`; `UVICORN_WORKERS` is unset, which means OWUI's `start.sh`
defaults to `--workers 1`. `DATABASE_POOL_SIZE=10` (above OWUI's default of
`5`) provides headroom for the warm-up burst after process restarts without
approaching the managed PG cluster's `max_connections=25` cap.

This is intentional. Going to multiple workers (or multiple replicas) is **not
a single-flag change** on this stack: it requires every shared-state
subsystem to use external coordination, per Open WebUI's own guidance:

- [Open WebUI: Multi-Replica, High Availability & Concurrency Troubleshooting](https://docs.openwebui.com/troubleshooting/multi-replica/)

The gaps today, mapped to that doc's checklist:

| Requirement | Current state | Notes |
|---|---|---|
| Shared `WEBUI_SECRET_KEY` | ✓ set explicitly as a SECRET env var | §1 already documents the gotcha |
| External database (PostgreSQL) | ✓ managed PG 17 | `bayleaf-chat-db` |
| Redis for WebSockets / config sync | ✗ not configured | streaming events and config-change broadcast would diverge across workers |
| Shared file storage | ✓ DO Spaces (S3) | uploads land in the bucket regardless of worker |
| External vector DB | ✗ default ChromaDB (SQLite-backed) | known to **crash workers** during RAG ingestion under multi-worker; affects the `procurement` model's KB |
| Toolkit ephemeral state | ✗ `gws_toolkit` uses per-worker `app.state` | tracked at [rndmcnlly/gws-toolkit#7](https://github.com/rndmcnlly/gws-toolkit/issues/7) |

The architectural cliff is the database connection cap: with 1 instance × 1
worker × pool 10 = 10 connections out of 25 max. Going to 2 workers
(20 conn) is still within budget; a second instance would force either a DB
upgrade or a connection pooler.

**Capacity sizing for "campus, not the world"**: even at full UCSC adoption
(~95 concurrent active sessions estimated, ~5–15 in-flight requests at peak),
a single worker with the pool bump should cope. The argument for going
multi-worker is **availability** (cold-start tail mitigation, deploy-window
coverage) rather than **throughput**. Until the readiness gaps above are
closed, the cost of going multi-worker (broken RAG, broken Google integration)
exceeds the benefit.

Tracked as a longer-term, incremental readiness effort at
[bayleaf-ucsc/bayleaf#35](https://github.com/bayleaf-ucsc/bayleaf/issues/35).

---

## 2. Workspace Models

BayLeaf exposes curated "workspace models" that wrap OpenRouter base models with
system prompts, capability flags, tool bindings, and access controls. Each model
is defined in `models/<id>/model.json`.

### Public Models (available to all users)

| ID | Name | Base Model | Description |
|----|------|-----------|-------------|
| `basic` | Basic | `openrouter.z-ai/glm-5.2` | Default model for all users. Campus-aware system prompt (`Basic v1.2`), builtin tools enabled, skills for Google Workspace, Canvas, web search, and code sandbox. |
| `help` | Help | `openrouter.z-ai/glm-5.2` | BayLeaf help desk. Lists user groups and available models, inspects model configurations, processes invite codes. Binds `help_toolkit` and `web_context_toolkit` directly via the model's `toolIds`. System prompt (`Help v1.5`). |

### Group-Restricted Models

*None currently active.* Course and program models have been deactivated as their
terms ended. See the Inactive table below for preserved configurations.

### Inactive (Archived) Models

These models remain on the live instance but are deactivated (`is_active: false`).
Their configurations are preserved in `models/` for reference.

| ID | Name | Base Model | Notes |
|----|------|-----------|-------|
| `deep-research` | Deep Research | `openrouter.z-ai/glm-5.2` | Interactive research agent. Retired now that Basic has a skill system for web search. |
| `brace3-92591` | Brace (CMPM 120 Spring 2026) | `openrouter.z-ai/glm-5.1` | Course-specific. Spring 2026 term ended. |
| `everett-program` | Everett Program Chat | `openrouter.z-ai/glm-5.1` | Program-specific. |
| `procurement` | Procurement | `openrouter.z-ai/glm-5.2` | Staff group. |
| `brace-85291` | Brace (CMPM 121 Fall 2025) | `openrouter.deepseek/deepseek-v3.2` | Brace v2, superseded by `brace3-92591`. |
| `gambit` | Gambit | `openrouter.z-ai/glm-5` | Rapid game prototyping assistant (`Gambit v1.6`). |

### Model Configuration Details

**Basic** — The default landing model. System prompt (`Basic v1.2`) orients the
model as a sub-trillion-parameter open-weight campus assistant, encourages
concise replies, warns about turn-depth limits, and suggests users start fresh
conversations rather than extending long ones. Uses `function_calling: native`.
Builtin tools enabled (time, memory, chats, notes, knowledge, channels). Skills
bound: `google-workspace`, `bayleaf-for-students`, `bayleaf-for-faculty`,
`bayleaf-for-employees`, `canvas-api`, `web-search`, `code-sandbox`. Vision
disabled; file upload enabled.

**Deep Research** *(inactive)* — Interactive research agent (`Deep Research v1.1`).
Bound to `web_context_toolkit` (Tavily search + Tavily Extract). System prompt
instructs the model to narrate its intent before each tool call and summarize
results, so users can follow the research path. Retired now that Basic's skill
system covers web search. Vision disabled; file context and all builtin tools
enabled.

**Help** — Minimal capabilities (no vision, no file upload, no code interpreter).
Binds `help_toolkit` and `web_context_toolkit` directly via the model's
`toolIds` (no filter; the stealth injection via `help_filter` was retired in
June 2026 in favor of plain model-bound tools), giving users tools to list
their groups, see available models, inspect model configurations, process
invite codes, and search the web for self-discovery (including consulting
BayLeaf's own source on GitHub). System prompt
(`Help v1.5`) describes BayLeaf facts and firmly redirects non-help tasks to
Basic.

**Brace (v3, `brace3-92591`)** *(inactive)* — Course assistant for CMPM 120
Spring 2026. Successor to Brace v2 with a cleaner design. No
`brace_submit_action`. Uses `brace3_filter` + `brace3_canvas_toolkit` (see §3).
The system prompt is no longer stored in the model JSON; it is looked up at
runtime by **page title** ("Brace3 System Prompt") from Canvas — raises
cleanly if the page is missing instead of falling back silently; body is
converted from HTML to markdown via `markdownify`. Vision and `file_context`
enabled.

**Everett Program Chat** *(inactive)* — Placeholder chatbot for the Everett
Program with the Web Context toolkit (`web_context_toolkit`).

**Procurement** *(inactive)* — UC procurement policy assistant. System prompt
contains a behavioral preamble and a lookup table of file IDs for 11 UC policy
documents. Retrieval is agentic: the model calls `read_document` via the
`whole_document_retrieval` toolkit to fetch full document text on demand,
rather than having policy text inlined. Documents live in the "Procurement"
knowledge base (`8c7d7e27-6871-4871-a6b3-c197cf418072`). `context.md` in this
backup is the original source used to populate the KB; it is no longer part of
the system prompt.

**Brace (v2, `brace-85291`)** *(inactive)* — Course assistant for CMPM 121 Fall
2025. No static system prompt — `brace_filter` fetches the system prompt from a
Canvas wiki page at the hardcoded slug `braces-system-prompt` at runtime. Bound
to `brace_submit_action` (Canvas submission button) and `brace_filter`. Uses
`brace_toolkit` (force-injected by the filter). Falls back to a generic prompt
if the Canvas page is unreachable. (The original Brace v1 architecture lives at
[rndmcnlly/brace](https://github.com/rndmcnlly/brace).)

**Gambit** *(inactive)* — Rapid game prototyping assistant (`Gambit v1.6`).
Extremely detailed system prompt (~14K chars) covering prototyping philosophy,
HTML artifact generation, CDN library usage, publishing via gisthost, and
cost-consciousness.

---

## 3. Tools

Tools are Python classes that OWUI calls on behalf of the LLM. Each tool is in
`tools/<id>/` with `tool.py` (source) and `meta.json` (metadata, specs, access
grants).

### Public Tools (available to all users)

| ID | Name | Description |
|----|------|-------------|
| `lathe` | Code Sandbox | Coding agent tools backed by per-user Daytona sandbox VMs (see below) |
| `web_context_toolkit` | Web Context | Tavily-backed web search and page-content extraction in one toolkit (valve: API key) |
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
- `auto_delete_minutes` — Minutes after archive before permanent deletion (-1 = never)
- `sandbox_language` — Default runtime (default: `python`)
- `foreground_timeout_seconds` — Seconds to wait for bash/delegate before auto-backgrounding (default: 30)
- `auto_create_sandbox` — Automatically create a sandbox when none exists for the user (default: `true`; disable for deployments where sandboxes are provisioned externally)
- `sandbox_missing_message` — Custom message returned to the agent when no sandbox exists and auto-create is off (empty falls back to a generic message)
- `sandbox_create_overrides` — JSON object of extra Daytona create args merged into the request, e.g. `{"cpu":2,"memory":4,"snapshot":"my-snapshot"}`. Cannot override `name`, `labels`, or `volumes` (managed by lathe).

### Restricted Tools (Stealth Toolkits)

| ID | Name | Access | Injected by | Description |
|----|------|--------|-------------|-------------|
| `brace3_canvas_toolkit` | Brace3 Canvas | No grants (stealth) | `brace3_filter` | Canvas LMS read access + date localization for Brace v3. Token snarfed from the filter at call time; no separate valve needed. |
| `brace_toolkit` | Brace | No grants (stealth) | `brace_filter` | Canvas API, GitHub API, Google Drive used by Brace v2 (valve: multiple keys). |

### Other Restricted Tools

| ID | Name | Access | Description |
|----|------|--------|-------------|
| `help_toolkit` | Help | No grants (model-bound via `toolIds` on `help`) | Group membership listing, model access listing, invite code acceptance/creation. Valve: `INVITE_SIGNING_KEY` (optional, falls back to `WEBUI_SECRET_KEY`). |
| `gws_toolkit` | Google Workspace | All users (`user:*`) | Per-user, per-chat OAuth2 access to Google Workspace APIs (see below) |
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
| `brace3_filter` | `brace3_canvas_toolkit` | `brace3-*` |
| `brace_filter` | `brace_toolkit` | `brace-*` |

(`help_filter` was a former instance; it was retired in June 2026 because the
Help model needs no filter-time setup — its toolkit is now bound directly via
the model's `toolIds`, which is less magical and equally invisible to the tool
picker when the toolkit has no access grants.)

**When to use this pattern:**

- The toolkit should always be available on a specific model, not user-selectable.
- The toolkit exposes internal APIs (groups, models, access grants) that should
  not be casually browsable from arbitrary models.
- The filter needs to do additional setup (e.g. fetch a system prompt, derive
  context from the model ID) alongside the toolkit injection.

### Google Workspace (GWS Toolkit)

Per-user, per-chat OAuth2 integration with Google Workspace APIs. Source:
[rndmcnlly/gws-toolkit](https://github.com/rndmcnlly/gws-toolkit). Users
connect their own Google account via an in-chat OAuth flow. Tokens are
**ephemeral** (in-process memory, no DB persistence) and scoped to a single
chat; every chat starts unauthorized and users consent to exactly the
capabilities they need. Available to all users.

**Tools exposed to the model:**

| Tool | Purpose |
|------|---------|
| `gws_authorize(capabilities)` | Request authorization for capabilities in the current chat, or inspect current status |
| `gws_action(action, params)` | Execute a Google Workspace action, gated by admin capabilities and per-chat authorization |

**Actions** (22 across 4 services, dispatched via `gws_action`):

| Action | Capability | Description |
|--------|-----------|-------------|
| `drive.files.search` | `drive.readonly` | Full-text search across Drive |
| `drive.files.get` | `drive.readonly` | Read a file (exports Docs as markdown, Sheets as CSV, Slides as text) |
| `drive.files.list` | `drive.readonly` | List folder contents |
| `gmail.messages.search` | `gmail.readonly` | Search messages using Gmail syntax |
| `gmail.messages.get` | `gmail.readonly` | Read a message (decodes MIME body) |
| `gmail.threads.list` | `gmail.readonly` | Search threads |
| `gmail.threads.get` | `gmail.readonly` | Read all messages in a thread |
| `gmail.drafts.create` | `gmail.compose` | Create a draft (does NOT send) |
| `gmail.drafts.list` | `gmail.readonly` | List drafts |
| `gmail.drafts.get` | `gmail.readonly` | Read a specific draft |
| `calendar.calendars.list` | `calendar.readonly` | List available calendars |
| `calendar.events.list` | `calendar.readonly` | List/search events (defaults to upcoming) |
| `calendar.events.get` | `calendar.readonly` | Full event details |
| `calendar.freebusy.query` | `calendar.readonly` | Check free/busy status |
| `calendar.events.create` | `calendar.events` | Create an event |
| `calendar.events.patch` | `calendar.events` | Update specific fields of an event |
| `calendar.events.delete` | `calendar.events` | Delete an event |
| `sheets.spreadsheets.get` | `spreadsheets.readonly` | Spreadsheet metadata |
| `sheets.values.get` | `spreadsheets.readonly` | Read a cell range |
| `sheets.values.batchGet` | `spreadsheets.readonly` | Read multiple cell ranges |
| `sheets.values.update` | `spreadsheets` | Write values to a cell range |
| `sheets.values.append` | `spreadsheets` | Append rows to a detected table |

**Design.** The toolkit self-registers an OAuth callback route on the OWUI
FastAPI app at startup. Authorization uses OWUI event emitters (`__event_call__`)
to show a confirmation modal with the OAuth link; the user right-clicks to open
it in a new tab, completes Google consent, then confirms back in the chat.
Tokens live in-process keyed by `(user_id, chat_id)` and are lost on server
restart — this is by design. The `enabled_capabilities` valve sets an admin
ceiling; users can only authorize up to the admin-allowed maximum. The
`gws_authorize` response includes current UTC time so the LLM can ground
time-relative API parameters.

**Capabilities** (mirror Google OAuth scope suffixes):

| Capability | Description |
|-----------|-------------|
| `drive.readonly` | Search, read, list Drive files |
| `drive` | Full Drive access |
| `gmail.readonly` | Read Gmail messages and drafts |
| `gmail.compose` | Create and manage email drafts |
| `calendar.readonly` | View calendar events |
| `calendar.events` | Create, edit, and delete events |
| `spreadsheets.readonly` | Read Sheets data |
| `spreadsheets` | Read and write Sheets |
| `tasks.readonly` | View Google Tasks |
| `tasks` | Manage Google Tasks |
| `documents.readonly` | Read Docs content |
| `documents` | Read and write Docs |
| `presentations.readonly` | Read Slides content |
| `presentations` | Read and write Slides |

Drive, Gmail, Calendar, and Sheets have action handlers. Tasks, Docs, and
Slides are scope-ready in the capability registry but have no handlers yet.

**Admin valves** (configured in OWUI admin panel, never committed):

- `google_client_id` — Google OAuth client ID
- `google_client_secret` — Google OAuth client secret
- `base_url` — OWUI base URL for the OAuth callback (e.g. `https://chat.bayleaf.dev`)
- `enabled_capabilities` — Comma-separated capability ceiling (default: `drive.readonly`)

### Tool Valves (credentials configured in admin UI)

Several tools require API keys configured as "valves" in the OWUI admin panel.
These are **never** committed to this repo:

- `lathe` — `daytona_api_key`, `daytona_api_url`, `daytona_proxy_url`, `deployment_label`, `auto_stop_minutes`, `auto_archive_minutes`, `auto_delete_minutes`, `persistent_volume`, `sandbox_language`, `foreground_timeout_seconds`, `auto_create_sandbox`, `sandbox_missing_message`, `sandbox_create_overrides`
- `gws_toolkit` — `google_client_id`, `google_client_secret`, `base_url`, `enabled_capabilities`
- `web_context_toolkit` — `tavily_api_key`, `search_depth`, `include_answer`, `max_results`, `extract_depth`
- `deepinfra_key_generator_toolkit` — `API_KEY`, `API_TOKEN_NAME`, `MODELS`, `EXPIRES_DELTA`
- `help_toolkit` — `INVITE_SIGNING_KEY` (optional; falls back to `WEBUI_SECRET_KEY` if empty)
- `brace_toolkit` — `GITHUB_API_TOKEN`, `CANVAS_ACCESS_TOKEN`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON`
- `brace3_filter` — `CANVAS_ACCESS_TOKEN` (used by both `brace3_filter` and `brace3_canvas_toolkit`; the toolkit snarfs it from the filter instance)

**Non-secret, non-default valve values** (safe to record as recovery backup):

- `lathe`: `deployment_label` = `chat.bayleaf.dev`, `auto_delete_minutes` = `129600` (90 days), `persistent_volume` = `false`

---

## 4. Functions (Filters & Actions)

Functions are Python classes that intercept or augment the request/response
pipeline. Each is in `functions/<id>/` with `function.py` and `meta.json`.

| ID | Type | Global | Active | Description |
|----|------|--------|--------|-------------|
| `rate_limit_filter` | filter | yes | **yes** | Per-user rate limiting (10/min, 50/hr, 100/3hr sliding window) |
| `depth_limit_filter` | filter | yes | no | Halves max response tokens with each turn (disabled) |
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
| `web-search` | yes | all users (`user:*`) | Describes the Web Context toolkit (Tavily-backed search and page extraction) and how to enable it. |
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

## 6a. Post-mortem: S3 migration/retrieval incident (2026-05-02)

In the first-ever recovery exercise of BayLeaf Chat's storage layer, two
independent bugs were found and fixed in the same session. Documented here so
the next operator (or agent) can recognise the failure modes quickly.

### Symptoms

- All file attachments in chats returned HTTP 400 `{"detail": "[ERROR: Error
  getting file content]"}` from `GET /api/v1/files/{id}/content`.
- One post-migration file retrieved 200 early in the debugging session but 404
  later — a red herring that turned out to be the OWUI local cache warming
  from upload-time bytes, then getting wiped on redeploy.

### Bug 1: `S3_ENDPOINT_URL` virtual-hosted style

The app spec had `S3_ENDPOINT_URL=https://bayleaf-ucsc-storage.sfo2.digitaloceanspaces.com`,
i.e. the bucket name in the *hostname*. Combined with `S3_BUCKET_NAME=bayleaf-ucsc-storage`
and boto3's default path-style addressing, every request path was
`https://bayleaf-ucsc-storage.sfo2.digitaloceanspaces.com/bayleaf-ucsc-storage/<key>` —
DigitalOcean saw the bucket in the hostname AND as the first path segment, so
uploads landed at key `bayleaf-ucsc-storage/<real-key>` and retrievals looked
up the same doubly-prefixed key. Upstream OWUI `_extract_s3_key` stripped the
first path segment, making the key round-trip correctly in principle, but the
physical storage layout was inconsistent with what the rest of the system
assumed.

Fix: endpoint URL changed to `https://sfo2.digitaloceanspaces.com` (region
endpoint, path-style). Verified with a boto3 repro that constructed both URL
forms and HEAD'd the same key against both.

### Bug 2: Migration left DB paths unrewritten

The 2026-04-29 bucket rename from `bayleaf-chat-space` → `bayleaf-ucsc-storage`
copied 273 objects server-side (preserving them under a `bayleaf-chat-space/`
key prefix inside the new bucket) but did not update the `file.path` column in
the managed PostgreSQL database. 224 DB rows continued to point at
`s3://bayleaf-chat-space/...`.

Fix: collapsed all 274 objects (273 migrated + 1 post-migration stray) to the
bucket root via server-side `copy_object`, then rewrote all 225 file-table rows
to the flat form `s3://bayleaf-ucsc-storage/<uuid>_<filename>`, then deleted
the prefixed sources. Idempotent, transactional on the DB side, verified
end-to-end with upload/retrieve/delete smoke test.

### Bugs interacted to obscure each other

Either bug alone would have been easy to isolate. Together, they produced
confusing signals:

- The one post-migration file "worked" earlier in the session (local cache,
  see above) but "didn't work" later, making it unclear whether bug 2 was
  active or resolved.
- Rewriting a single DB row's path as a canary didn't fix retrieval, because
  bug 1 would have caused a 404 regardless.
- The canary evidence suggested the path rewrite theory was wrong; only
  constructing the actual request URLs against DO Spaces (outside boto3)
  revealed bug 1.

The diagnostic path that worked: tail the running container's logs during a
failed retrieval, see the raw `(404) when calling the HeadObject operation`
from boto3, inspect the deployed `provider.py` source to confirm
`_extract_s3_key` behavior, then independently construct path-style vs.
virtual-hosted-style requests to see which DigitalOcean responds to.

### Orphan file cleanup as follow-on

During reconciliation, 49 objects in the bucket had no matching `file` row
(true S3-level orphans from pre-migration deleted chats) and 112 `file` rows
had no surviving chat/KB reference (true DB-level orphans). Both classes were
cleaned up during this session's post-migration pass, and an automated orphan
sweep (§5 of `RETENTION.md`) now runs daily to keep the bucket and DB in sync
going forward.

### Prevention

For any future bucket migration:

1. **Migrations must update DB references in the same transactional scope as
   object copies**, or at minimum in the same runbook step. Decoupling the two
   is how bug 2 happened.
2. **Storage config should be validated against physical layout** after any
   change. A simple smoke test (upload a file, retrieve it, check the object
   key in the bucket matches the DB path) catches bug 1 immediately.
3. **`S3_ENDPOINT_URL` for DigitalOcean Spaces should always be the region
   endpoint** (`https://<region>.digitaloceanspaces.com`), never a
   bucket-hostname endpoint. Bucket goes in the `S3_BUCKET_NAME` env var; the
   endpoint stays generic. DO's documentation shows both forms and does not
   warn that using both together causes double-prefixing.

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
│   ├── deep-research/        # Inactive — retired in favor of Basic's skill system
│   │   └── model.json
│   ├── help/
│   │   ├── model.json
│   │   └── profile.png
│   ├── brace3-92591/       # Inactive — Brace v3 (CMPM 120 Spring 2026)
│   │   ├── model.json
│   │   └── profile.webp
│   ├── everett-program/   # Inactive
│   │   └── model.json
│   ├── procurement/        # Inactive
│   │   ├── model.json      # Behavioral preamble only
│   │   ├── context.md      # Inlined UC policy documents (~670K chars)
│   │   └── profile.png
│   ├── brace-85291/        # Inactive — Brace v2 (CMPM 121 Fall 2025)
│   │   ├── model.json
│   │   └── profile.png
│   └── gambit/             # Inactive — rapid prototyping assistant
│       ├── model.json
│       └── profile.webp
├── tools/
│   ├── lathe/
│   │   ├── tool.py          # Code Sandbox — coding agent tools (Daytona sandboxes)
│   │   └── meta.json
│   ├── help_toolkit/            # Bound to Help model via toolIds (no grants)
│   │   └── tool.py
│   ├── web_context_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── deepinfra_key_generator_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── random_choice_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── gws_toolkit/
│   │   ├── tool.py          # Google Workspace — per-user, per-chat OAuth2 (Drive, Gmail, Calendar, Sheets)
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
    └── brace3_filter/       # Brace v3 — title lookup, markdownify, raises on missing page
        └── function.py      # No meta.json
```
