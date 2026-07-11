# BayLeaf API

Cloudflare Worker built with **Hono** + **@hono/zod-openapi**: OIDC auth (provider-agnostic via .well-known discovery; currently CILogon), OpenRouter key provisioning, LLM proxy with system prompt injection, sandboxed code execution (Daytona), web search and page fetching (Tavily), Campus Pass (IP-based auth).

**Architecture**: Multi-file TypeScript under `src/`, D1 for key mappings + cached sandbox IDs. Zod schemas are the single source of truth for request/response validation and OpenAPI spec generation. Bundled by Wrangler.

## Data posture: ZDR + ZOA target

This service is the platform's **zero-operator-access (ZOA) target**, in the
sense of the [AWS Mantle design](https://aws.amazon.com/blogs/machine-learning/exploring-the-zero-operator-access-design-of-mantle/).
Two layered commitments:

- **ZDR (zero data retention)** — the baseline. Prompts and completions are
  streamed through to the upstream provider with **no local caching** and are
  **never written to D1, logs, or any store** (see `RETENTION.md`). Only ZDR
  provider endpoints are reachable, so providers retain only request metadata.
- **ZOA posture** — the API additionally exposes **no operator interface to read
  request content in flight**: Workers Observability is **disabled**
  (`wrangler.jsonc`), there is no request-body logging, and no interactive shell
  into the runtime. The only operator-observable signal is request *metadata*
  (model, token counts, timestamps). An operator therefore has **no standing
  access** to prompt or completion content.

This is a ZOA **posture**, not a hardware-attested ZOA **guarantee** like
Mantle: there is no NitroTPM-style attestation or signed-deploy barrier, so an
operator with deploy rights *could* ship a revision that logs request bodies.
**Treat any change that stores or logs request/response content as a material
break of this posture.** In particular: do not add request-body logging, do not
re-enable Workers Observability for content, do not introduce response caching of
prompt/completion text, and do not inject the user identity anywhere it would be
persisted. Public wording must claim the *posture* ("retains no content, no
standing operator access to content in flight"), not full attested ZOA.

## Commands

```bash
npm run dev      # Local dev
npm run deploy   # Deploy
npx tsc --noEmit # Type check
```

## File Structure

```
src/
  index.ts              Entry point: OpenAPIHono app, cors, route mounting, .doc31() spec, error handler
  types.ts              Bindings, Session, OpenRouterKey, UserKeyRow, AppEnv (Hono generics)
  schemas.ts            Zod schemas — single source of truth for validation + OpenAPI spec
  constants.ts          OIDC discovery helper, OPENROUTER_API, DAYTONA defaults, cookie config
  openrouter.ts         OpenRouter API helpers (findKeyByName, createKey, deleteKey)
  daytona.ts            Daytona sandbox API client (lifecycle, exec, file ops)
  web.ts               Web search and page fetch clients (Tavily Search + Tavily Extract)
  utils/
    auth.ts             resolveAuth(): shared auth for proxy + sandbox routes (Campus Pass, Bayleaf token, raw key)
    ip.ts               IP range parsing, campus pass checks
    session.ts          HMAC session tokens, cookie helpers
    token.ts            sk-bayleaf- token generator
  templates/
    layout.ts           Base HTML layout, errorPage, recommendedModelHint
    landing.ts          Landing page template
    dashboard.ts        Dashboard page template (key card, LLM card, sandbox card + client JS)
  routes/
    auth.ts             authRoutes: /login, /callback, /logout
    dashboard.ts        dashboardRoutes: /, /dashboard (self-heals sandbox ID cache)
    docs.ts             docsRoutes: /docs (Scalar viewer), /docs/SKILL.md
    key.ts              keyRoutes: GET|POST|DELETE /key (OpenAPI-documented)
    proxy.ts            proxyRoutes: POST /responses, POST /chat/completions, /v1/* catch-all
    sandbox.ts          sandboxRoutes: GET / (status), POST /exec, POST /poke, GET|PUT /files/*, DELETE / (OpenAPI-documented)
    web.ts               webRoutes: POST /search, POST /fetch (OpenAPI-documented)
```

## Code Style

**Naming**: Interfaces `PascalCase`, functions `camelCase`, top-level constants `SCREAMING_SNAKE`.

**Patterns**:
- Runtime deps: `hono`, `zod`, `@hono/zod-openapi`. Otherwise only Web APIs and CF Workers globals.
- Route files export `OpenAPIHono<AppEnv>` sub-apps, mounted via `app.route()` in index.ts
- API routes use `createRoute()` + `app.openapi()` for automatic validation and spec generation
- Browser-facing routes (auth, dashboard) use plain `.get()` / `.post()` — hidden from the OpenAPI spec
- Zod schemas live in `src/schemas.ts`; use `.openapi('Name')` to register as named components
- Proxy/auth-guard handlers that return raw `Response` objects use `as any` escape — inherent to the proxy pattern
- Access bindings via `c.env`, use `c.html()`, `c.json()`, `c.redirect()` for responses
- Return `null` on failure, don't throw
- Type assertions for JSON: `await response.json() as { data: T[] }`
- `tsconfig.json` has `strict: true`
- Each file exports only what other files need
- Types live in `src/types.ts`; import with `import type` where possible

## Inference Backends

Chat completions are routed by a `<prefix>:` on the `model` id. **OpenRouter**
(`openrouter:`, or no prefix) is the always-on default. Anything else is an
**alternate backend** declared in the `ALT_BACKENDS` table in `src/constants.ts`
(internal key, wire prefix, `<BACKEND>_ENABLED` env flag, label).

Each alternate backend has a kill-switch env var that must equal the string
`"true"` to enable it; any other value (including unset) **fails closed**. When
disabled, the backend's `/v1/chat/completions` routing is rejected with 503, its
models are dropped from `GET /v1/models`, and its `<prefix>:` entries are
stripped from the OpenCode curated list in `routes/wellknown.ts`. Use
`isBackendEnabled(c.env, key)` / `isVertexEnabled(c.env)` (`src/constants.ts`).

- **`vertex:` — Google Vertex AI. Currently DISABLED** (`VERTEX_ENABLED: "false"`
  in `wrangler.jsonc`). We could not obtain Google's Abuse Monitoring opt-out, so
  we cannot promise ZDR parity with OpenRouter (issue #36). The routing block
  (`routes/proxy.ts`) and GCP JWT minting (`utils/gcp.ts`) remain in place; flip
  the flag to `"true"` to re-enable. Note the GCP service-account secrets must be
  set for it to function.
- **`bedrock:` — Amazon Bedrock (`bedrock-mantle`). Implemented, gated by
  `BEDROCK_ENABLED`** (default `"false"` in `wrangler.jsonc`; flip to `"true"`
  and set the `BEDROCK_BEARER_TOKEN` secret to enable). mantle speaks OpenAI
  Chat Completions and `/models` with a **static bearer token** (no SigV4, no
  JWT minting), so the routing block (`routes/proxy.ts`) is a thin
  prefix-strip + `forwardJson`, much simpler than Vertex's JWT block. mantle
  serves an **open-weight** catalog (Qwen, GLM, Kimi, gpt-oss, DeepSeek,
  Mistral, Gemma, Nemotron), not the frontier Claude/Nova set (issue #41).
  - **Models** are **live-fetched** from mantle's `/models` at `GET /v1/models`
    time and prefixed with `bedrock:` (unlike Vertex's hardcoded
    `VERTEX_MODELS`), since the catalog shifts often. A mantle failure
    contributes zero entries rather than breaking the listing.
  - **Per-key RPD**: Bedrock spend goes to AWS, not OpenRouter, so it is not
    metered by the OR dollar budget. A per-key daily counter (`bedrock_rpd_count`
    / `bedrock_rpd_date`, migration `0004`, limit `BEDROCK_RPD_LIMIT`) mirrors
    Vertex's. Campus Pass users are covered by the unified per-IP counter.
    Surfaced under `data.bayleaf.bedrock` in `GET /v1/auth/key`.
  - **BAA caveat**: the POC token is from a *personal* AWS account with **no
    UCSC BAA coverage**; production must use an enterprise-account key (Track B,
    issue #41).

## Routes

```
/                       Landing       /login         OIDC start      /callback   OIDC callback
/logout                 Clear         /dashboard     User UI         /key        GET|POST|DELETE
/v1/responses           Responses API proxy (system prompt via instructions field)
/v1/chat/completions    Chat completions proxy (system prompt via system message)
/v1/*                   General OpenRouter proxy (models, auth/key, etc.)
/sandbox                GET: sandbox status (keyed only, no side effects)
/sandbox/exec           POST: bash execution (campus-pass: ephemeral, keyed: persistent)
/sandbox/poke           POST: refresh inactivity timer / wake sandbox (keyed only)
/sandbox/files/*        GET: download file, PUT: upload file (keyed only)
/sandbox                DELETE: destroy user's sandbox (keyed or session)
/web/search              POST: web search (Tavily)
/web/fetch               POST: fetch page content from one or more URLs (Tavily Extract)
/recommended-model      Current recommended model slug + display name (JSON, unauthenticated)
/docs                   Interactive API docs (Scalar viewer, loads /docs/openapi.json)
/docs/openapi.json      OpenAPI 3.1 spec (auto-generated from Zod schemas)
/docs/SKILL.md          Agent skill file (public; personalized with email when authenticated)
/docs/gws-oauth-client.json  Google Workspace CLI OAuth config (authenticated or campus)
```

## Don'ts

- Don't use Node.js-specific APIs — only Web APIs and CF Workers globals
- Don't throw — return null/error responses
- Don't hand-code OpenAPI schemas — define Zod schemas in `schemas.ts` and use `createRoute()`
- Don't display API keys in plaintext (no `type="text"` inputs, no visible tokens in the page). Users may screen-share while demoing the system. Always use `type="password"` inputs and "Copy" buttons that write to the clipboard. The key value should never be visible on screen.
