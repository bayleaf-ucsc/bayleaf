/**
 * llms.txt route.
 *
 * Serves https://api.bayleaf.dev/llms.txt: a one-stop site-level reference for
 * humans and LLMs orienting to the BayLeaf API. Follows the loose llmstxt.org
 * convention (H1, blockquote summary, themed sections with link bullets), but
 * inlines per-section detail because BayLeaf's audience is people setting up
 * their first agent, not a separate documentation site.
 *
 * Loaded once during onboarding (or when an agent is being extended with
 * BayLeaf-specific tooling). Not designed to be consumed on every conversation
 * turn: a configured agent calling BayLeaf's OpenAI-compatible /v1/* endpoints
 * doesn't need any BayLeaf-specific context. SKILL.md (now redirected here)
 * was the wrong abstraction for that reason.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { getModelInfo } from '../openrouter';
import type { ModelCost, ModelCostRaw } from '../openrouter';

export const llmsRoutes = new OpenAPIHono<AppEnv>();

llmsRoutes.get('/llms.txt', async (c) => {
  const model = c.env.RECOMMENDED_MODEL;
  const info = await getModelInfo(model);
  const name = info?.name ?? model;
  const cost = info?.cost ?? null;
  const costRaw = info?.costRaw ?? null;
  const gwsEnabled = !!(c.env.GWS_CLIENT_ID && c.env.GWS_CLIENT_SECRET && c.env.GWS_PROJECT_ID);
  const body = buildLlmsTxt({ model, modelName: name, cost, costRaw, gwsEnabled });
  return c.text(body, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

// ── Builder ───────────────────────────────────────────────────────

interface LlmsTxtInput {
  model: string;
  modelName: string;
  cost: ModelCost | null;
  costRaw: ModelCostRaw | null;
  gwsEnabled: boolean;
}

function buildLlmsTxt(input: LlmsTxtInput): string {
  const { model, modelName, cost, costRaw, gwsEnabled } = input;
  const bt = '`';
  const fence = '```';
  const placeholderEmail = 'bslug@ucsc.edu'; // CruzID convention; users replace with their own.

  return `# BayLeaf API

> BayLeaf API (https://api.bayleaf.dev) provides free LLM inference, sandboxed code
> execution, web search, and Google Workspace / Canvas LMS access for the UC Santa Cruz
> campus community. It is an OpenAI-compatible proxy fronting OpenRouter (zero-data-retention
> providers, prefixed ${bt}openrouter:${bt}) and Google Vertex AI (prefixed ${bt}vertex:${bt}).
> Personal API keys (${bt}sk-bayleaf-...${bt}) are issued at https://api.bayleaf.dev/; on the
> UCSC campus network, no key is needed. Conversations are private and never used for training.

This document is intended for a one-time read: by you, when you are setting up a coding
agent against BayLeaf, or by an LLM helping you do so. **Once your agent is configured,
neither you nor it should need to load this file again.** Calls into BayLeaf are just
calls into an OpenAI-compatible endpoint; the agent doesn't need to know it's BayLeaf.

The ${bt}/v1/*${bt} surface is best understood through the OpenAPI spec at
https://api.bayleaf.dev/docs/openapi.json (or the interactive viewer at
https://api.bayleaf.dev/docs).

---

## Quick start: connect a coding agent

If you are deciding which terminal coding agent to start with:

- [**OpenCode**](https://opencode.ai/): friendly defaults, native one-command BayLeaf onboarding (see below). Recommended.
- [**Goose**](https://github.com/block/goose): includes free inference credit on first launch; optional desktop app.
- [**pi**](https://github.com/badlogic/pi-mono): minimal core, strong extension model; bring your own API key.
- [Generic OpenAI-compatible client](#generic): any tool that accepts a base URL and API key (continue.dev, Cline, custom scripts).

You only need to do one of these.

### OpenCode (one command)

OpenCode supports a provider-discovery mechanism via ${bt}.well-known/opencode${bt}, so
BayLeaf-as-a-provider needs zero edits to ${bt}opencode.json${bt}:

${fence}bash
opencode auth login https://api.bayleaf.dev
${fence}

OpenCode prompts for your BayLeaf API key on the terminal (no echo, not written to shell
history). Paste an ${bt}sk-bayleaf-...${bt} token from https://api.bayleaf.dev/, or just
press Enter on the campus network. Then run ${bt}opencode${bt}, pick a BayLeaf model with
${bt}/models${bt}, and you're done.

The recommended model and curated picks update automatically on every OpenCode launch,
served from https://api.bayleaf.dev/.well-known/opencode/config.

**Windows users:** the auth command runs a POSIX shell script. Use
[WSL](https://learn.microsoft.com/en-us/windows/wsl/install), or follow the manual
${bt}opencode.json${bt} setup at https://opencode.ai/docs/providers/#custom-provider with the
fields ${bt}npm: "@ai-sdk/openai-compatible"${bt}, ${bt}options.baseURL: "https://api.bayleaf.dev/v1"${bt},
${bt}options.apiKey: "{env:BAYLEAF_API_KEY}"${bt}.

### Goose

To use BayLeaf with [Goose](https://github.com/block/goose). Requires Goose **1.29+**.

Create ${bt}~/.config/goose/custom_providers/bayleaf.json${bt}:

${fence}json
{
  "name": "bayleaf",
  "engine": "openai",
  "display_name": "BayLeaf API",
  "description": "OpenRouter-proxying LLM inference for UC Santa Cruz. Zero-data-retention.",
  "api_key_env": "BAYLEAF_API_KEY",
  "base_url": "https://api.bayleaf.dev/v1/chat/completions",
  "models": [
    {
      "name": "${model}",
      "context_limit": 128000,
      "max_tokens": 16384${costRaw ? `,
      "input_token_cost": ${costRaw.prompt},
      "output_token_cost": ${costRaw.completion}` : ''}
    }
  ],
  "supports_streaming": true
}
${fence}

Then run ${bt}goose configure${bt}, select **BayLeaf API**, paste your ${bt}sk-bayleaf-...${bt}
key (stored in your system keychain). Or set ${bt}BAYLEAF_API_KEY${bt} in your environment.

Use:

${fence}bash
GOOSE_PROVIDER=bayleaf GOOSE_MODEL=${model} goose session
${fence}

### pi

To use BayLeaf with the [pi coding agent](https://github.com/badlogic/pi-mono)
(${bt}npm install -g @mariozechner/pi-coding-agent${bt}):

Store the API key:

${fence}bash
mkdir -p ~/.tokens && chmod 700 ~/.tokens
echo -n 'sk-bayleaf-...' > ~/.tokens/bayleaf-api
chmod 600 ~/.tokens/bayleaf-api
${fence}

Create or edit ${bt}~/.pi/agent/models.json${bt}:

${fence}json
{
  "providers": {
    "bayleaf": {
      "baseUrl": "https://api.bayleaf.dev/v1",
      "apiKey": "!cat ~/.tokens/bayleaf-api",
      "api": "openai-completions",
      "models": [
        {
          "id": "${model}",
          "name": "${modelName} (BayLeaf)"${cost ? `,
          "cost": { "input": ${cost.input}, "output": ${cost.output}, "cacheRead": ${cost.cacheRead}, "cacheWrite": ${cost.cacheWrite} }` : ''}
        }
      ]
    }
  }
}
${fence}

Run with ${bt}pi --model bayleaf/${model} "Help me refactor this code"${bt}.

### Generic OpenAI-compatible client {#generic}

Any client that accepts a base URL plus API key works:

- **Base URL:** ${bt}https://api.bayleaf.dev/v1${bt}
- **API key:** an ${bt}sk-bayleaf-...${bt} token from https://api.bayleaf.dev/ (or omit on the campus network)
- **Default model:** ${bt}${model}${bt}

---

## API reference

- **OpenAPI 3.1 spec (machine-readable):** https://api.bayleaf.dev/docs/openapi.json
- **Interactive API reference:** https://api.bayleaf.dev/docs
- **Available models:** https://api.bayleaf.dev/v1/models
- **Recommended model (current default):** https://api.bayleaf.dev/recommended-model

### Authentication

All machine-facing endpoints accept ${bt}Authorization: Bearer <key>${bt}.

| Method | When to use |
|--------|-------------|
| **BayLeaf key** (${bt}sk-bayleaf-...${bt}) | Off-campus, or when you need a persistent sandbox and file access. Provision free at https://api.bayleaf.dev/. |
| **Campus Pass** (omit header) | On the UCSC campus network. No key needed. Sandbox access is ephemeral (one-shot). |

Daily spending limit per key: $5 (resets daily). Increased limits are
[available upon request](https://bayleaf.dev/support). All rate limiting is handled by
the upstream provider; the API itself imposes no request-rate limits.

### LLM inference

Chat completions:

${fence}
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-bayleaf-...

{
  "model": "${model}",
  "messages": [
    { "role": "user", "content": "Explain the halting problem in one paragraph." }
  ]
}
${fence}

Supports ${bt}stream: true${bt} for SSE streaming. All standard OpenAI parameters
(${bt}temperature${bt}, ${bt}max_tokens${bt}, ${bt}tools${bt}, etc.) are forwarded. Any other
${bt}/v1/*${bt} path is proxied directly to OpenRouter, including the Responses API
(${bt}POST /v1/responses${bt}) and ${bt}/v1/auth/key${bt} for budget inspection.

### Inspecting your budget

${fence}
GET /v1/auth/key
${fence}

Returns the OpenRouter response augmented with a ${bt}data.bayleaf${bt} block that splits
usage by backend (${bt}openrouter${bt} and ${bt}vertex${bt}). The OR-shaped top-level fields
(${bt}usage${bt}, ${bt}limit${bt}, ${bt}limit_remaining${bt}) report only ${bt}openrouter:${bt}
traffic; for a complete picture across both backends, read ${bt}data.bayleaf${bt}.

---

## Model namespaces

BayLeaf routes requests by a prefix on the ${bt}model${bt} field:

| Prefix | Backend | Notes |
|--------|---------|-------|
| ${bt}openrouter:${bt} | OpenRouter (ZDR providers) | Hundreds of models; per-token pricing varies. |
| ${bt}vertex:${bt} | Google Vertex AI | Gemini family + select MaaS partners (e.g. GLM 5). Requires a BayLeaf API key (no Campus Pass), rate-limited at 100 requests/day per key. |

Examples:

- ${bt}"model": "openrouter:z-ai/glm-5.1"${bt}
- ${bt}"model": "vertex:gemini-3.1-pro"${bt}
- ${bt}"model": "vertex:zai-org/glm-5-maas"${bt}

A bare slug (no prefix) is treated as ${bt}openrouter:${bt} for backwards compatibility,
but new integrations should always include the prefix to match the IDs returned by
${bt}/v1/models${bt}.

Recommended default for general use: ${bt}${model}${bt} (${modelName}).

---

## Capabilities you can wire as agent tools

The following are HTTP endpoints, callable via ${bt}curl${bt} from any agent with shell
access. If your agent supports it, register them as native tools or MCP servers so the
model can call them naturally during conversation. **You only need to do this once
per agent**, not per conversation.

OpenCode tool/MCP docs: https://opencode.ai/docs/custom-tools/, https://opencode.ai/docs/mcp-servers/.
pi extension docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md.
Goose extension docs: https://goose-docs.ai/docs/tutorials/custom-extensions.

### Sandboxed code execution

A persistent Linux environment for running code:

${fence}
POST /sandbox/exec
Content-Type: application/json
Authorization: Bearer sk-bayleaf-...

{
  "command": "python3 -c \\"print(2+2)\\"",
  "workdir": "/home/daytona/workspace"
}
${fence}

Returns ${bt}{ "exitCode": 0, "output": "4\\n" }${bt}. Commands run under
${bt}set -e -o pipefail${bt} with a 120-second timeout. Full Debian-based Linux with
network access. Workdir defaults to ${bt}/home/daytona/workspace${bt} if omitted.

- **Keyed users** get a persistent sandbox surviving across requests.
- **Campus Pass users** get an ephemeral sandbox per-request.

File I/O (keyed users only):

- ${bt}GET /sandbox/files/{path}${bt} returns raw file bytes.
- ${bt}PUT /sandbox/files/{path}${bt} uploads bytes (parent dirs auto-created).
- ${bt}DELETE /sandbox${bt} destroys the sandbox.

### Web search and page fetch

${fence}
POST /web/search
{ "query": "UC Santa Cruz computational media", "max_results": 5 }
${fence}

${fence}
POST /web/fetch
{ "url": "https://example.com/article", "format": "markdown" }
${fence}

Search returns ranked results plus an optional AI-generated ${bt}answer${bt}. Fetch
returns clean extracted content suitable for LLM consumption (${bt}markdown${bt} default,
${bt}text${bt} or ${bt}html${bt} also supported).
${gwsEnabled ? buildGwsSection(placeholderEmail, bt, fence) : ''}${buildCanvasSection(bt, fence)}
---

## Notes

- All inference uses zero-data-retention (ZDR) providers via OpenRouter or Google Vertex AI. Conversations are never used for training, and BayLeaf retains only minimal operational metadata (see https://api.bayleaf.dev/RETENTION.md).
- The ${bt}sk-bayleaf-...${bt} token is yours to manage. Re-running setup commands rotates the stored token; revoking the key from https://api.bayleaf.dev/ invalidates it across all configured agents at once.
- Increased limits are [available upon request](https://bayleaf.dev/support).
- This service is operated by Adam Smith (Computational Media, UCSC). Source on GitHub: https://github.com/bayleaf-ucsc/bayleaf.
`;
}

// ── GWS section (inlined when configured) ─────────────────────────

function buildGwsSection(email: string, bt: string, fence: string): string {
  return `
### Google Workspace CLI (gws)

The [Google Workspace CLI](https://github.com/googleworkspace/cli) gives agents
access to Drive, Gmail, Calendar, Sheets, Docs, Slides, and Tasks on behalf of the
authenticated user. Operations run as ${bt}${email}${bt} (replace with your own UCSC email).

Install:

${fence}bash
npm install -g @googleworkspace/cli
${fence}

Download the OAuth client configuration (BayLeaf distributes a shared GCP project's
client credentials; the security comes from the OAuth browser consent flow, not the
client secret):

${fence}bash
mkdir -p ~/.config/gws
curl -s https://api.bayleaf.dev/docs/gws-client-secret.json \\
  -H "Authorization: Bearer sk-bayleaf-..." \\
  -o ~/.config/gws/client_secret.json
${fence}

On the campus network the ${bt}-H${bt} header can be omitted.

Authenticate (one-time, opens a browser):

${fence}bash
gws auth login --account YOUR_CRUZID@ucsc.edu --full
${fence}

The ${bt}--full${bt} flag requests broad scopes (Drive, Gmail, Calendar, Sheets, Docs,
Slides, Tasks). Credentials store encrypted on disk and refresh automatically.

${bt}gws${bt} can also run as an MCP server: ${bt}gws mcp -s drive,gmail,calendar${bt}.

Common services (each command also self-documents via ${bt}gws <service> --help${bt}):

| Service | Example |
|---------|---------|
| Drive | ${bt}gws drive files list --params '{"q": "...", "pageSize": 10, "fields": "files(id,name)"}'${bt} |
| Gmail | ${bt}gws gmail users messages list --params '{"userId": "me", "maxResults": 5}'${bt} |
| Calendar | ${bt}gws calendar events list --params '{"calendarId": "primary", "maxResults": 5, "singleEvents": true, "orderBy": "startTime", "timeMin": "..."}'${bt} |
| Sheets | ${bt}gws sheets spreadsheets values get --params '{"spreadsheetId": "...", "range": "Sheet1!A1:C10"}'${bt} |
| Docs | ${bt}gws docs documents get --params '{"documentId": "..."}'${bt} |

Troubleshooting:

- **401 auth error:** re-run ${bt}gws auth login --account YOUR_CRUZID@ucsc.edu --full${bt}
- **403 API not enabled:** contact the BayLeaf admin
- **Wrong account's data:** check ${bt}gws auth list${bt} and ${bt}gws auth default${bt}
`;
}

// ── Canvas LMS section ────────────────────────────────────────────

function buildCanvasSection(bt: string, fence: string): string {
  return `
### Canvas LMS

The [canvaslms CLI](https://pypi.org/project/canvaslms/) gives agents read/write
access to Canvas courses, assignments, grades, submissions, announcements, and pages.
Each user authenticates with their own Canvas access token (separate from the BayLeaf
API key).

Install:

${fence}bash
pipx install canvaslms
pipx inject canvaslms cryptography
${fence}

Generate a Canvas access token at **Canvas > Profile > Settings > New Access Token**
(shown only once). Then either log in interactively (stores in keyring):

${fence}bash
canvaslms login
${fence}

…or set environment variables:

${fence}bash
export CANVAS_SERVER=canvas.ucsc.edu
export CANVAS_TOKEN=your_token_here
${fence}

Common commands:

${fence}bash
# List courses (with Canvas IDs)
canvaslms courses -i
canvaslms courses -i "121"                    # filter by regex

# List students (with emails)
canvaslms users -c "COURSE_ID" -s -e

# View / list / grade assignments
canvaslms assignments list -c "COURSE_ID"
canvaslms assignments view -c "COURSE_ID" -a "assignment-regex"
canvaslms submissions list -c "COURSE_ID" -a "assignment-regex" -U
canvaslms grade -c "COURSE_ID" -a "assignment-regex" -u "^student@" -g 7 -m "Comment"

# Post an announcement
canvaslms discussions announce -c "COURSE_ID" -m "Body text" "Title"
${fence}

Notes:

- ${bt}-c${bt} accepts a regex; resolve to a numeric Canvas ID first with ${bt}canvaslms courses -i "pattern"${bt}.
- Output is TSV; pipe through ${bt}cut${bt}, ${bt}awk${bt}, or ${bt}sort${bt}.
- The CLI caches responses (submissions: 5 min, users: 2 days). Use ${bt}--no-cache${bt} after writes.
- For operations the CLI doesn't support, fall back to ${bt}curl${bt} against ${bt}https://canvas.ucsc.edu/api/v1${bt} with ${bt}Authorization: Bearer TOKEN${bt}. API docs: https://canvas.instructure.com/doc/api/.
`;
}
