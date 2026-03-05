# BayLeaf Chat — Deployment & Configuration

*Backup and design reference for the Open WebUI deployment at `bayleaf.chat`.*

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
| **Image** | `ghcr.io/open-webui/open-webui:v0.8.8` |
| **Instance** | `apps-s-1vcpu-2gb` (1 instance) |
| **HTTP port** | `8080` |

### Domain & Ingress

| Rule | Target |
|------|--------|
| `bayleaf.chat` / | `open-webui` service |
| `bayleaf.chat` /about | 302 redirect → `about.bayleaf.chat` |

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
| `ENABLE_OAUTH_SIGNUP` | `true` | Users sign up via Google |
| `ENABLE_LOGIN_FORM` | `false` | No password login |
| `OPENID_PROVIDER_URL` | `https://accounts.google.com/.well-known/openid-configuration` | Google OIDC |
| `OAUTH_PROVIDER_NAME` | `Google` | Login button label |
| `OAUTH_CLIENT_ID` | `47286725529-bddnlon8kne28k28e4vgnql32ne9f2ig.apps.googleusercontent.com` | Google OAuth |
| `OAUTH_CLIENT_SECRET` | `<REDACTED>` | Encrypted in DO |
| `WEBUI_SECRET_KEY` | `<REDACTED>` | Encrypted in DO |
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

Notable absence: `WEBUI_URL` is **not** currently set (defaults to
`http://localhost:3000`). This should be set to the canonical URL for OAuth
callbacks to work reliably.

### OpenRouter Connection

OWUI is configured (via admin UI, not env vars) with an OpenRouter API
connection that exposes all ZDR-eligible models. The OpenRouter API key is
stored in OWUI's admin settings, not in the app spec.

---

## 2. Workspace Models

BayLeaf exposes curated "workspace models" that wrap OpenRouter base models with
system prompts, capability flags, tool bindings, and access controls. Each model
is defined in `models/<id>/model.json`.

### Public Models (available to all users)

| ID | Name | Base Model | Description |
|----|------|-----------|-------------|
| `basic` | Basic | `openrouter.z-ai/glm-5` | Default model for all users. Campus-aware system prompt, suggestion prompts, no tools bound by default. |
| `help` | Help | `openrouter.z-ai/glm-5` | BayLeaf help desk. Answers questions about the service, processes invite codes via `accept_invites_toolkit`. |

### Group-Restricted Models

| ID | Name | Base Model | Group(s) |
|----|------|-----------|----------|
| `brace-85291` | Brace (CMPM 121 Fall 2025) | `openrouter.deepseek/deepseek-v3.2` | Course-specific |
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
Bound to `accept_invites_toolkit` so it can process invite codes. System prompt
(`Help v1.1`) describes BayLeaf facts and firmly redirects non-help tasks to
Basic.

**Brace** — Course assistant for CMPM 121. No static system prompt — instead,
`brace_filter` dynamically fetches the system prompt from a Canvas wiki page at
runtime. Bound to `brace_submit_action` (Canvas submission button) and
`brace_filter`. Uses `brace_toolkit` (force-injected by the filter).

**Gambit** — Rapid game prototyping assistant (`Gambit v1.5`). Extremely detailed
system prompt (~14K chars) covering prototyping philosophy, HTML artifact
generation, CDN library usage, publishing via gisthost, and cost-consciousness.
Uses `reasoning_effort: low`.

**Procurement** — UC procurement policy assistant. System prompt has a short
behavioral preamble plus ~670K chars of inlined UC policy documents (11 PDFs).
The policy context is split out to `context.md` in this backup.

---

## 3. Tools

Tools are Python classes that OWUI calls on behalf of the LLM. Each tool is in
`tools/<id>/` with `tool.py` (source) and `meta.json` (metadata, specs, access
grants).

### Public Tools (available to all users)

| ID | Name | Description |
|----|------|-------------|
| `accept_invites_toolkit` | Accept Invites | JWT-based invite code system for joining groups |
| `tavily_web_search` | Web Search | Tavily API search (valve: API key) |
| `jina_reader_toolkit` | Web Page Content | Jina Reader API for fetching web pages as markdown (valve: API key) |
| `deepinfra_key_generator_toolkit` | DeepInfra Key Generator | Generates scoped, time-limited DeepInfra API keys (valve: API key, token name, model list) |
| `random_choice_toolkit` | Random Choice | Uniform random selection from a list — for varied regenerations |
| `youtube_toolkit` | YouTube | Stub — tells users to run a local `uv` command to fetch transcripts |
| `campus_directory_toolkit` | Campus Directory | Scrapes UCSC campus directory with CSRF handling |
| `datetime_converter_toolkit` | Datetime Converter | ISO date → localized string via pytz |

### Restricted Tools

| ID | Name | Access | Description |
|----|------|--------|-------------|
| `brace_toolkit` | Brace's toolkit | Admin only (no grants) | Canvas API, GitHub API, Google Drive (valve: multiple keys) |
| `mark_time_toolkit` | Mark Time | Admin only (no grants) | Stopwatch/timer with per-chat LRU cache (user valve: timezone) |

### Tool Valves (credentials configured in admin UI)

Several tools require API keys configured as "valves" in the OWUI admin panel.
These are **never** committed to this repo:

- `tavily_web_search` — `tavily_api_key`
- `jina_reader_toolkit` — `JINA_API_KEY`
- `deepinfra_key_generator_toolkit` — `API_KEY`, `API_TOKEN_NAME`, `MODELS`, `EXPIRES_DELTA`
- `brace_toolkit` — `GITHUB_API_TOKEN`, `CANVAS_ACCESS_TOKEN`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_JSON`

---

## 4. Functions (Filters & Actions)

Functions are Python classes that intercept or augment the request/response
pipeline. Each is in `functions/<id>/` with `function.py` and `meta.json`.

| ID | Type | Global | Active | Description |
|----|------|--------|--------|-------------|
| `rate_limit_filter` | filter | yes | **yes** | Per-user rate limiting (10/min, 50/hr, 100/3hr sliding window) |
| `depth_limit_filter` | filter | yes | no | Halves max response tokens with each turn (disabled) |
| `brace_submit_action` | action | no | yes | Button to submit conversation HTML to Canvas assignment |
| `brace_filter` | filter | no | yes | Injects Brace's toolkit and fetches system prompt from Canvas wiki |

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

## 5. Recovery Procedure

To reconstruct BayLeaf Chat from this backup:

1. **Create DO App Platform app** with a single service using the OWUI Docker
   image at the version noted above. Attach a managed PG 17 database and
   configure S3 storage via DO Spaces. Set all env vars from the table in §1.

2. **Configure OpenRouter** in the OWUI admin panel (Admin → Settings →
   Connections) with a ZDR-eligible OpenRouter API key.

3. **Import models** — The model JSON files in `models/` match the OWUI import
   format. Use the admin API `POST /api/v1/models/import` or recreate them
   manually in the Workspace → Models UI. For procurement, paste the content of
   `context.md` back into the system prompt after the behavioral preamble.

4. **Import tools** — For each tool in `tools/`, create a new tool in the admin
   UI (Workspace → Tools), paste the source from `tool.py`, and configure the
   access grants and valves per `meta.json`.

5. **Import functions** — Same process via Workspace → Functions. Set
   `is_global` and `is_active` flags per `meta.json`. Configure function
   valves (Canvas tokens etc.) in the admin panel.

6. **Configure model bindings** — Attach tools, filters, and actions to models
   per the `toolIds`, `filterIds`, and `actionIds` in each `model.json`.

7. **Set access grants** — Configure group-based access for restricted models
   and tools. Group UUIDs will differ in a new deployment; map by group name.

---

## 6. Directory Structure

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
│   ├── brace-85291/
│   │   ├── model.json
│   │   └── profile.png
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
│   ├── accept_invites_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
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
│   ├── brace_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── youtube_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── campus_directory_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   ├── datetime_converter_toolkit/
│   │   ├── tool.py
│   │   └── meta.json
│   └── mark_time_toolkit/
│       ├── tool.py
│       └── meta.json
└── functions/
    ├── rate_limit_filter/
    │   ├── function.py
    │   └── meta.json
    ├── depth_limit_filter/
    │   ├── function.py
    │   └── meta.json
    ├── brace_submit_action/
    │   ├── function.py
    │   └── meta.json
    └── brace_filter/
        ├── function.py
        └── meta.json
```
