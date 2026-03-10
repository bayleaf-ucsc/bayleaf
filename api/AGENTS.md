# BayLeaf API

Cloudflare Worker built with **Hono**: OIDC auth (UCSC Google), OpenRouter key provisioning, LLM proxy with system prompt injection, sandboxed code execution (Daytona), Campus Pass (IP-based auth).

**Architecture**: Multi-file TypeScript under `src/`, D1 for key mappings + cached sandbox IDs. Hono handles routing, CORS, and response helpers. Bundled by Wrangler.

## Commands

```bash
npm run dev      # Local dev
npm run deploy   # Deploy
npx tsc --noEmit # Type check
```

## File Structure

```
src/
  index.ts              Entry point: Hono app, cors middleware, route mounting, error handler
  types.ts              Bindings, Session, OpenRouterKey, UserKeyRow, AppEnv (Hono generics)
  constants.ts          GOOGLE_OIDC, OPENROUTER_API, DAYTONA defaults, cookie config
  openrouter.ts         OpenRouter API helpers (findKeyByName, createKey, deleteKey)
  daytona.ts            Daytona sandbox API client (lifecycle, exec, file ops)
  utils/
    auth.ts             resolveAuth(): shared auth for proxy + sandbox routes (Campus Pass, Bayleaf token, raw key)
    ip.ts               IP range parsing, campus pass checks
    session.ts          HMAC session tokens, cookie helpers
  templates/
    layout.ts           Base HTML layout, errorPage, recommendedModelHint
    landing.ts          Landing page template
    dashboard.ts        Dashboard page template (key card, LLM card, sandbox card + client JS)
  routes/
    auth.ts             authRoutes: /login, /callback, /logout
    dashboard.ts        dashboardRoutes: /, /dashboard (self-heals sandbox ID cache)
    docs.ts             docsRoutes: /docs (Scalar viewer), /docs/openapi.json, /docs/SKILL.md, /docs/recommended-model
    key.ts              keyRoutes: GET|POST|DELETE /key
    proxy.ts            proxyRoutes: POST /responses, /v1/* catch-all
    sandbox.ts          sandboxRoutes: POST /exec, GET|PUT /files/*, DELETE /
```

## Code Style

**Naming**: Interfaces `PascalCase`, functions `camelCase`, top-level constants `SCREAMING_SNAKE`.

**Patterns**:
- Hono is the only runtime dependency; otherwise only Web APIs and CF Workers globals
- Route files export `Hono<AppEnv>` sub-apps, mounted via `app.route()` in index.ts
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
/v1/*                   Chat/general proxy (system prompt via system message)
/sandbox/exec           POST: bash execution (campus-pass: ephemeral, keyed: persistent)
/sandbox/files/*        GET: download file, PUT: upload file (keyed only)
/sandbox                DELETE: destroy user's sandbox (keyed or session)
/recommended-model      Current recommended model slug + display name (JSON, unauthenticated)
/docs                   Interactive API docs (Scalar viewer, loads /docs/openapi.json)
/docs/openapi.json      OpenAPI 3.1 spec (dynamic, embeds current recommended model)
/docs/SKILL.md          Agent skill file for coding assistants and tool frameworks
```

## Don'ts

- Don't add runtime dependencies (beyond hono)
- Don't use Node.js-specific APIs
- Don't throw - return null/error responses
- Don't display API keys in plaintext (no `type="text"` inputs, no visible tokens in the page). Users may screen-share while demoing the system. Always use `type="password"` inputs and "Copy" buttons that write to the clipboard. The key value should never be visible on screen.
