# BayLeaf API

Cloudflare Worker built with **Hono** + **@hono/zod-openapi**: OIDC auth (UCSC Google), OpenRouter key provisioning, LLM proxy with system prompt injection, sandboxed code execution (Daytona), Campus Pass (IP-based auth).

**Architecture**: Multi-file TypeScript under `src/`, D1 for key mappings + cached sandbox IDs. Zod schemas are the single source of truth for request/response validation and OpenAPI spec generation. Bundled by Wrangler.

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
  constants.ts          GOOGLE_OIDC, OPENROUTER_API, DAYTONA defaults, cookie config
  openrouter.ts         OpenRouter API helpers (findKeyByName, createKey, deleteKey)
  daytona.ts            Daytona sandbox API client (lifecycle, exec, file ops)
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
    sandbox.ts          sandboxRoutes: POST /exec, GET|PUT /files/*, DELETE / (OpenAPI-documented)
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

## Routes

```
/                       Landing       /login         OIDC start      /callback   OIDC callback
/logout                 Clear         /dashboard     User UI         /key        GET|POST|DELETE
/v1/responses           Responses API proxy (system prompt via instructions field)
/v1/chat/completions    Chat completions proxy (system prompt via system message)
/v1/*                   General OpenRouter proxy (models, auth/key, etc.)
/sandbox/exec           POST: bash execution (campus-pass: ephemeral, keyed: persistent)
/sandbox/files/*        GET: download file, PUT: upload file (keyed only)
/sandbox                DELETE: destroy user's sandbox (keyed or session)
/recommended-model      Current recommended model slug + display name (JSON, unauthenticated)
/docs                   Interactive API docs (Scalar viewer, loads /docs/openapi.json)
/docs/openapi.json      OpenAPI 3.1 spec (auto-generated from Zod schemas)
/docs/SKILL.md          Agent skill file for coding assistants and tool frameworks
```

## Don'ts

- Don't use Node.js-specific APIs — only Web APIs and CF Workers globals
- Don't throw — return null/error responses
- Don't hand-code OpenAPI schemas — define Zod schemas in `schemas.ts` and use `createRoute()`
- Don't display API keys in plaintext (no `type="text"` inputs, no visible tokens in the page). Users may screen-share while demoing the system. Always use `type="password"` inputs and "Copy" buttons that write to the clipboard. The key value should never be visible on screen.
