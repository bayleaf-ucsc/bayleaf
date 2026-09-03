# BayLeaf API

Cloudflare Worker built with **Hono** + **@hono/zod-openapi**: OIDC auth (provider-agnostic via .well-known discovery; currently CILogon), OpenRouter key provisioning, LLM proxy with caller-controlled instructions, sandboxed code execution (Daytona), web search and page fetching (Tavily), Campus Pass (IP-based auth).

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

### The one exception: BayLeaf Sealed

`/sealed/*` (`src/routes/sealed.ts`, issue #55, **enabled in production**) is the
only lane where the above is stronger than a posture. Clients verify a hardware
attestation and encrypt request bodies to the enclave's HPKE key (EHBP, RFC 9180
HPKE at the application layer, independent of TLS). The Worker relays ciphertext.
A body-logging revision would capture ciphertext, so BayLeaf-operator
zero-operator-access becomes structural rather than promised.

The claim to make is narrow and testable, and **is not** "traffic never touches
BayLeaf":

> BayLeaf carries encrypted traffic but does not possess the enclave-bound key
> required to read it. Plaintext requests are rejected rather than downgraded.

Metadata is explicitly **not** covered. BayLeaf still sees caller identity,
timing, byte sizes, request counts, and (non-streaming) token usage. Say both
halves.


## Commands

```bash
npm run dev      # Local dev
npm run deploy   # Deploy
npx tsc --noEmit # Type check
node scripts/harness-provision.mjs   # Key lifecycle integration test (needs wrangler dev; see TESTING.md)
```

**Heads-up on local dev:** `.dev.vars` carries a stale
`OPENROUTER_PROVISIONING_KEY` (OpenRouter answers 401 "Invalid management
key"), so anything that provisions a key fails locally with a 500 until you
override it. See the recipe at the top of `TESTING.md`.

## File Structure

```
src/
  index.ts              Entry point: OpenAPIHono app, cors, route mounting, .doc31() spec, error handler
  types.ts              Bindings, Session, OpenRouterKey, UserKeyRow, AppEnv (Hono generics)
  schemas.ts            Zod schemas — single source of truth for validation + OpenAPI spec
  constants.ts          OIDC discovery helper, OPENROUTER_API, ALT_BACKENDS, DAYTONA defaults, cookie config
  openrouter.ts         OpenRouter API primitives (findKeyByHash, createKey, deleteKey, getModelInfo)
  tinfoil.ts            Tinfoil admin primitives (createTinfoilKey, deleteTinfoilKey, sanitizeTinfoilKeyName)
  provision.ts          Row + per-backend key lifecycle: getActiveRow, provisionToken, ensureUserRow,
                        ensureBackendKey, healBackendKey, resolveOrKeyInfo
  daytona.ts            Daytona sandbox API client (lifecycle, exec, file ops)
  web.ts                Web search and page fetch clients (Tavily Search + Tavily Extract)
  utils/
    auth.ts             resolveAuth(): IDENTITY only — Campus Pass or Bayleaf token. Returns no credential.
    backend.ts          resolveBackendCredential() + sendWithHeal(): per-backend credential + 401 heal-retry
    campusRpd.ts        Per-IP requests-per-day counter for Campus Pass (KV-backed)
    gcp.ts              GCP service-account JWT minting (Vertex backend, currently disabled)
    ip.ts               IP range parsing, campus pass checks
    session.ts          HMAC session tokens, cookie helpers
    token.ts            sk-bayleaf- token generator
  templates/
    layout.tsx          Base HTML layout, renderPage, ErrorPage, recommendedModelHint
    landing.tsx         Landing page template
    dashboard.tsx       Dashboard page template (key card, LLM card, sandbox card + client JS)
  routes/
    auth.tsx            authRoutes: /login, /callback, /logout
    claim.tsx           claimRoutes: RFC 8628-style device flow for handing a key to a terminal
    dashboard.tsx       dashboardRoutes: / (landing), /dashboard (self-heals sandbox ID cache)
    docs.ts             docsRoutes: /docs (Scalar viewer), /docs/openapi.json, /docs/SKILL.md
    key.ts              keyRoutes: POST|DELETE /key (session-gated, hidden from the spec)
    llms.ts             llmsRoutes: /llms.txt and the agent-facing skill prose
    proxy.ts            proxyRoutes: POST /responses, POST /chat/completions, /v1/* catch-all
    sealed.ts           sealedRoutes: BayLeaf Sealed EHBP ciphertext relay (issue #55, enabled; fails closed)
    sandbox.ts          sandboxRoutes: GET / (status), POST /exec, POST /poke, GET|PUT /files/*, DELETE /
    web.ts              webRoutes: POST /search, POST /fetch (OpenAPI-documented)
    wellknown.ts        Standard + opt-in Sealed OpenCode discovery and curated remote configs
migrations/             D1 schema, applied in order (0001 user_keys … 0005 decouple backend keys)
scripts/
  spend-limits.mjs      Operator tool: adjust OR-side daily caps by roster or by current cap
  harness-sealed.py     Sealed lane conformance suite (needs wrangler dev over HTTPS; see TESTING.md)
  harness-sealed-attestation.py  Serves mutated attestation bundles; asserts the client refuses all of them
```

**Key lifecycle lives in one place.** `provision.ts` is the only module that
creates, heals, or re-provisions a user's backend provider keys. The dashboard
render, all three `/key` verbs, and the claim flow's approve step all go
through it. Four near-copies of this logic previously drifted apart; don't
reintroduce a fifth.

**Token issuance and backend keys are decoupled (migration 0005).** The
`sk-bayleaf-` token is the identity record; provider keys are caches minted on
**first use of each backend** via `ensureBackendKey`. So `or_key_secret` and
`tinfoil_key` are nullable and may legitimately be NULL on a valid active row —
never assume they are populated, and never read them directly from a route.

The payoff is that "user never had a key" and "user's key vanished upstream"
became the same code path. Both are `swapBackendKey`, a compare-and-swap
differing only in its expected value (`NULL` to mint, the failed secret to
heal). They were previously `provisionKey`'s revoked-row-reuse branch and
`resolveOrKey`'s self-heal branch, which is precisely what drifted.

Three invariants it protects:

1. **The bayleaf token outlives every backend key.** Healing rewrites provider
   columns in place and never touches `bayleaf_token`. Only revocation mints a
   new token.
2. **One active row per email** (`email` is the primary key).
3. **A mint race never leaks a billable provider key.** Concurrent requests can
   both see an absent key and both mint; the CAS lets one win and the losers
   delete what they created. Verified under load: 8 concurrent first-use
   requests produced 7 `Discarding redundant` cleanups and exactly 1 surviving
   upstream key.

**Credentials are acquired per backend, not by `resolveAuth`.** `resolveAuth`
answers *who is calling*; `utils/backend.ts` answers *which upstream credential
to use*. Keep them separate: of the five route files that call `resolveAuth`,
only `proxy.ts` and `sealed.ts` need an inference credential. Folding
acquisition into `resolveAuth` would mint an OpenRouter key for a user whose
only request was ever a `/sandbox/exec`.

**Liveness is discovered by use, not by checking.** The request path trusts the
stored secret and treats an upstream 401/403 as the heal signal, retrying once
inline (`sendWithHeal`). This is forced for Tinfoil, whose admin API has no
single-key read (`GET /api/keys/{key}` is 405), so a proactive check would mean
enumerating every key in the org on every request. Two routes deliberately do
**not** retry because they stream the client's body and so cannot replay it:
the `/v1/*` catch-all (returns the 401; a later replayable route heals) and the
Sealed relay (heals without retrying, then asks the client to retry, because
Sealed is the only consumer of Tinfoil credentials and would otherwise
dead-end). Only 401/403 heals: re-minting on 429/5xx would churn keys under
load and, since a fresh key resets to the global spend default, hand out budget
as a side effect of provider trouble.

**Spend limits are not mirrored in D1.** OpenRouter is the system of record for
a key's daily cap. `createKey()` stamps the global `SPENDING_LIMIT_DOLLARS` at
creation time; per-user or per-cohort caps are set OR-side with
`scripts/spend-limits.mjs`. This means a heal returns a key to the global
default, which is the accepted cost of having one source of truth rather than
two that disagree. Dashboard revoke/re-provision rotates only the BayLeaf token
and retains backend keys, so it does not reset provider-side spend. Do not add
a D1 limit column.
Tinfoil credentials are minted without a provider-side lifetime token cap.
BayLeaf enforces `SEALED_RPD_LIMIT` against the keyed user's D1 row instead;
Campus Pass uses the shared per-IP `CAMPUS_RPD_LIMIT`.

**Key names are provider-constrained, and Tinfoil's are lossy.** Tinfoil rejects
`@ : + ( ) , / '` in key names (`400 "must not contain special characters"`;
alphanumerics, space, `-`, `_`, `.` are fine), so the canonical
`KEY_NAME_TEMPLATE` value is *not* a legal Tinfoil name.
`sanitizeTinfoilKeyName` maps the rejects to `_`, and `tinfoil_key_name` stores
the name the provider echoed back, so attribution never has to invert the
sanitizer. The exact email survives in the key's `metadata.bayleaf_email`.
Collision risk is nil while `ALLOWED_EMAIL_DOMAIN` restricts sign-up to one
domain; revisit if that ever changes.

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

Independently of backends, OpenRouter access is restricted to verifiably
open-weight models. `GET /v1/models` lists only entries with a truthy
`hugging_face_id` (NOT `!= null`: OR emits `""` for most weightless models, so a
null check fails open). Every OpenRouter inference path additionally requires
that repository URL to resolve. Positive and definite-negative decisions are
cached in `MODEL_STATUS` KV for 24 hours; lookup failures are denied but not
cached. Missing, malformed, or unavailable evidence fails closed with 403.
Tinfoil is outside this check because its current catalog lists only open-weight
models and the Sealed request body, including its model field, is encrypted from
BayLeaf. Unlike plaintext, BayLeaf does not enforce that catalog property itself:
if Tinfoil adds a proprietary model, policy must be revisited before exposing it.

- **`vertex:` — Google Vertex AI. Currently DISABLED** (`VERTEX_ENABLED: "false"`
  in `wrangler.jsonc`). We could not obtain Google's Abuse Monitoring opt-out, so
  we cannot promise ZDR parity with OpenRouter (issue #36). The routing block
  (`routes/proxy.ts`) and GCP JWT minting (`utils/gcp.ts`) remain in place; flip
  the flag to `"true"` to re-enable. Note the GCP service-account secrets must be
  set for it to function.
- **`bedrock:` — Amazon Bedrock (`bedrock-mantle`). Implemented, currently
  DISABLED** (`BEDROCK_ENABLED: "false"` in `wrangler.jsonc`). mantle speaks
  OpenAI Chat Completions and `/models` with a **static bearer token** (no
  SigV4, no JWT minting), so the routing block (`routes/proxy.ts`) is a thin
  prefix-strip + `forwardJson`, much simpler than Vertex's JWT block.
  - **Why paused (2026-07-29, issue #25 follow-up):** mantle's catalog is
    mostly open-weight but not mechanically so. Closed frontier models
    (claude-haiku-4-5, gpt-5.4/5.6, grok-4.3, palmyra-vision) appear in it,
    and mantle exposes **no weights-availability field** to filter on, so the
    open-weight listing policy cannot be enforced the way it is for
    OpenRouter. An earlier claim in this file that mantle "serves an
    open-weight catalog" was wrong.
  - **Retention mechanics (verified against AWS docs):** every mantle model
    carries `data_retention.allowed_modes`. Models accepting `'none'` run
    zero-retention regardless of account config; the closed gpt-5.x entries
    accept only `['default', 'provider_data_share']` and **cannot** run ZDR.
    Setting the AWS account's mantle mode to `'none'`
    (`PUT /v1/data_retention`) makes non-ZDR models report
    `status: "unavailable"` and blocks them server-side, including crafted
    slugs. `fetchBedrockModels` independently filters the listing to
    ZDR-capable models (`'none' in allowed_modes`), which fails closed if
    mantle ever drops the metadata.
  - **Re-enable checklist:** (1) enterprise-account token with UCSC BAA
    (issue #41 Track B; the POC token is a personal AWS account with **no BAA
    coverage**), and in the enterprise setup apply AWS's SCP pattern denying
    `bedrock-mantle:PutAccountDataRetention` and project writes unless the
    mode is `'none'` (condition key `bedrock-mantle:DataRetentionMode`), so
    no operator can ever flip the account to `provider_data_share`; (2) **DONE
    on the POC account 2026-07-29:** account mantle mode set to `'none'`
    (`PUT /v1/data_retention`) after granting the API-key IAM user an identity
    policy allowing `bedrock-mantle:PutAccountDataRetention` (the key ships
    without it; 403 `access_denied` until added). Verified live: gpt-5.4
    reports `status: "unavailable"`, a direct invocation is rejected (HTTP
    400), and gpt-oss-120b still serves under mode `'none'` (HTTP 200). The
    setting is account-scoped, so it must be re-applied on the enterprise
    account, where the item-(1) SCP should make it permanent. Note the mantle
    inference plane is configured separately from the bedrock-runtime control
    plane, and only the mantle plane matters to us; (3) resolve the weights-listing question: the ZDR
    filter still admits closed-weight ZDR-capable models (claude-haiku,
    grok), so re-enabling needs either a mantle weights predicate or an
    accepted maintained list; (4) complete the documentation gate listed beside
    `BEDROCK_ENABLED` in `wrangler.jsonc`: add AWS to `docs/privacy.html` and
    update the status, account-coverage, and data-flow claims in the named
    security, dependency, FERPA, retention, and landing-page documents.
  - **Models** are **live-fetched** from mantle's `/models` at `GET /v1/models`
    time and prefixed with `bedrock:` (unlike Vertex's hardcoded
    `VERTEX_MODELS`), since the catalog shifts often. A mantle failure
    contributes zero entries rather than breaking the listing.
  - **Per-key RPD**: Bedrock spend goes to AWS, not OpenRouter, so it is not
    metered by the OR dollar budget. A per-key daily counter (`bedrock_rpd_count`
    / `bedrock_rpd_date`, migration `0004`, limit `BEDROCK_RPD_LIMIT`) mirrors
    Vertex's. Campus Pass users are covered by the unified per-IP counter.
    Surfaced under `data.bayleaf.bedrock` in `GET /v1/auth/key`.

## BayLeaf Sealed (`/sealed/*`, issue #55)

**Status: enabled in production.** The relay and attestation-mutation harnesses
pass against `api.bayleaf.dev`, including per-user Tinfoil key minting. Keyed
users and Campus Pass are each limited to 100 Sealed requests per day by default.
Tinfoil credentials have no provider-side lifetime token cap.

**Testing the lane requires keyed auth off-campus.** `scripts/harness-sealed.py`
honours `SEALED_AUTH`, defaulting to `campus`. Campus Pass only resolves from a
campus IP, so verifying a deployed instance from elsewhere needs a
`sk-bayleaf-` token: `SEALED_BASE=https://api.bayleaf.dev/sealed
SEALED_AUTH=sk-bayleaf-... ./scripts/harness-sealed.py`. Prefer keyed auth
anyway, since Campus Pass shares an env-held pool key and therefore exercises
*none* of the minting, compare-and-swap, or healing logic. Note that testing
against prod also removes the local-HTTPS cert dance, because the Tinfoil SDK's
https requirement is satisfied natively.

**One observation worth not re-debugging:** immediately after `wrangler deploy`,
Cloudflare serves old and new versions concurrently for tens of seconds, so
`/sealed/*` probes flap between the old behaviour and the new one. A single
surprising status right after a deploy is almost certainly propagation, not a
bug. Confirm with repeated probes before investigating.

Sealed is deliberately **not** an `ALT_BACKENDS` row. It has no `<prefix>:` model
routing and it never forwards plaintext, so it shares no code with
`routes/proxy.ts`. The plaintext proxy parses JSON for schema validation,
attribution, model routing, metering, and replayable credential healing;
`sealed.ts` must never parse the body. These opposite obligations are why Sealed
is a separate route and **must never become a mode flag on the plaintext proxy**.

```
GET      /sealed/health        Kill-switch state + upstream reachability
GET|POST /sealed/attestation   Relay of the signed attestation bundle (BOTH verbs required)
GET      /sealed/models        Tinfoil catalog with bare model IDs
POST     /sealed/v1/*          EHBP ciphertext relay. POST only.
```

### Invariants. Do not relax these without reading why they exist.

1. `SEALED_ENABLED` must equal `"true"`; anything else 503s the whole lane,
   `/sealed/health` included.
2. **`/sealed/v1/*` is POST-only, and this is cryptographic, not stylistic.** A
   bodyless request has no encrypted body, and per the EHBP spec the encrypted
   body is what implicitly authenticates the encapsulated key. Without it an
   intermediary — us — could substitute its own key and read the enclave's
   *reply*. Allowing `GET` here would hand the relay the exact capability the
   lane exists to deny it. The catalog lives at `/sealed/models` for this reason.
3. `Ehbp-Encapsulated-Key` required, strict `^[0-9a-f]{64}$`. Its absence means
   the body is not encrypted; rejecting is what makes "no plaintext fallback"
   operational rather than aspirational.
4. `X-Tinfoil-Enclave-Url` is **untrusted input**, allowlisted to `https` +
   `*.tinfoil.sh`. Without it, our credential-substituting relay is an open
   proxy. The upstream path comes from *our* routing, never from the header.
5. Client-supplied `tk_`/`admin_` credentials are rejected (403); the caller's
   BayLeaf credential is stripped and the server-side key substituted. Headers
   are built by **allowlist**, not copy-and-delete, so nothing leaks by
   forgetting to strip it.
6. The body is never parsed, cloned, buffered, schema-validated, or logged. No
   `c.req.json()`, `.text()`, `.arrayBuffer()`, or `.clone()` on this route.
7. A 2xx upstream response must carry a valid `Ehbp-Response-Nonce` or we return
   502. That header is the fail-closed signal that the reply came back encrypted.
8. No fallback to `/v1/*`, ever. Every failure is an error, never a downgrade.

### Three Workers-specific gotchas, all found the hard way

- **`redirect: 'error'` does not exist in Workers** ("won't be implemented since
  it does not make sense at the edge"), which is what Tinfoil's Go reference
  proxy uses. The no-redirect invariant needs *both* halves of the `NO_REDIRECT`
  idiom: ask for `manual`, then explicitly treat 3xx as failure. Dropping either
  half silently reopens the hole.
- **`Content-Encoding: identity` is load-bearing.** Workers/the CF edge will gzip
  a compressible-looking `Content-Type` when `Accept-Encoding` permits. That
  corrupts EHBP, because a client's EHBP transport parses length-prefixed frames
  *below* its HTTP library's content-decoding layer, so it receives gzip bytes
  and fails. An ordinary buffered client would have decompressed transparently
  and shown nothing wrong, which makes this a nasty one to diagnose. Compressing
  ciphertext is pointless anyway.
- **Streaming usage accounting is unavailable *in the Worker*.** Tinfoil sends usage
  for streamed responses as an HTTP trailer; the Workers `fetch()` API has no
  trailer accessor, and the trailer is dropped rather than passed through to the
  client. Non-streaming reports in a header and works. This constrains
  *in-flight* accounting only — see the cost accounting section, because the
  authoritative numbers are available out-of-band and do include streaming.

### Cost accounting: reconciliation, not request counting

Measured 2026-07-29. The relay's in-flight visibility is poor, but the
out-of-band accounting is excellent, so **spend enforcement should be
dollar-denominated, not request-count based**.

What the Worker sees at request time:

- Non-streaming: `X-Tinfoil-Usage-Metrics: prompt=,completion=,total=,model=`.
  Note `model=` is present *even though EHBP encrypted `model` in the request
  body*, so the relay learns which model ran without decrypting anything.
- Streaming: nothing at all (see the trailer gotcha above).
- Neither carries dollars, only tokens.

What is available out-of-band, and this is the useful part:

```
GET /api/billing/usage?time=<window>     # org admin key
```

One call returns org-wide spend broken down **per key, then per model**, with
`cost` in dollars. Windows: `5m, 15m, 30m, 1h, 24h, today, 7d, 30d, 60d, 90d,
180d, 365d, 3mo, 6mo, 12mo, all`. Measured properties:

- **Includes streaming.** Verified: a streamed request moved `tokens_used` by
  exactly its reported total (3587 -> 3849) and `requests` 24 -> 25.
- **Reconciles fast.** Already correct at the first poll, 6s after the request.
  Not bisected below that.
- **`keys` is indexed by key NAME.** With per-user keys named after the user,
  this response *is* a per-user dollar table with no local join. This is a
  concrete payoff of the decision to allow the email in the key name.
- `POST /api/billing/usage/key?time=<window>` with `{"key":"tk_..."}` gives the
  same for a single key, if per-user granularity is ever needed on demand.

**Tinfoil is the system of record for Sealed spend**, exactly as OpenRouter is
for the proxy lane. D1 caches a recent *reading* for the fast path; it does not
hold a second copy of the *limit*. That distinction keeps the "do not add a D1
limit column" rule above intact.

**Do not also debit from the response header.** Two accounting paths that can
disagree is the failure this file already warns about for spend limits. Use
reconciliation as the accountant and treat the usage header as telemetry (it is
the only place model popularity is observable without decrypting).

**What a rate limit is still for.** Enforcement necessarily lags reconciliation,
so a user can overspend by roughly (requests in flight x worst-case cost per
request). A per-user concurrency cap plus a request rate limit exists to *bound
that window* and to deter abuse. It is not the cost model.

**Suggested split.** Put the reconciler in a **separate Worker** with its own
`TINFOIL_ADMIN_KEY` binding, sharing D1. The inference Worker then holds only
per-user `tk_` values read from D1 and literally cannot mint, enumerate, or read
billing. Cloudflare secrets are per-Worker, so a cron handler in the *same*
Worker does not achieve this — it would leave admin authority reachable from the
request path.

Not yet established: whether `keys` includes revoked/deleted keys (matters for
reconciling a departed user), Admin API rate limits for polling frequency, and
whether reconciliation is faster than 6s.

### Enablement record

The lane is live. Two of the four original gate items were satisfied, and two
were deliberately dropped or deferred. The reasoning matters more than the
checkbox, so it is recorded rather than deleted.

1. **Per-user Tinfoil keys: DONE (migration `0005`).** One Tinfoil key per user
   email, minted on **first use of the lane** and stored in `tinfoil_key`, so
   usage is attributable per user and BayLeaf enforces a per-user RPD limit.
   Campus Pass has no email and so shares `CAMPUS_SEALED_KEY`,
   mirroring `CAMPUS_POOL_KEY`; pool credentials live in env and are therefore
   not healable from the request path.

   Two decisions worth not re-litigating. **The email may appear in the Tinfoil
   key name** (2026-07-29): the line being defended is that *data* is opaque to
   the provider, not that identity or metadata is. If that ever changes, apply
   the same policy to OpenRouter in the same pass rather than treating the lanes
   differently. And **the admin credential is accepted on the inference path**
   (2026-07-29), reversing an earlier "mint at provisioning time only" stance:
   minting at token issuance would let a Tinfoil outage block signup and would
   issue Sealed credentials to users who never touch the lane. The mitigation is
   that `tinfoil.ts` exports no key-enumeration function, so a compromised
   request path can mint and delete but not read other users' credentials.
   Note this makes `TINFOIL_ADMIN_KEY` more dangerous than
   `OPENROUTER_PROVISIONING_KEY`: Tinfoil re-reveals secrets on read, so a leak
   of the admin key exposes every user's inference credential.
2. **Dollar-denominated spend enforcement: STILL OPEN.** The reconciliation loop
   described above, plus a per-user concurrency cap and request rate limit to
   bound the reconciliation-lag overspend window. The RPD guardrail is a
   *component* of this design, not an alternative to it: enforcement necessarily
   lags reconciliation, so something must bound the in-flight window. The lane
   was enabled with `SEALED_RPD_LIMIT` alone, so today exposure is bounded by
   request count rather than by dollars. This is the largest outstanding gap.
3. **`/sealed/policy`: DROPPED as a prerequisite.** The original plan was to
   publish the C1–C6 rubric plus a pinned enclave measurement allowlist. The
   reason it was dropped is that a BayLeaf-served trust policy is circular: the
   guarantee is carried entirely by the client, and Tinfoil's verifier already
   checks SEV-SNP hardware, Sigstore source provenance against a pinned config
   repo, runtime measurement, and HPKE key binding. BayLeaf cannot forge the
   attestation bundle (verified: all five mutation classes are refused
   client-side), and a client that skips verification gets none of the guarantee
   no matter what we publish. Pinning is a client-side obligation we can neither
   enforce nor usefully substitute for. Revisit only when there is a mechanical
   consumer of an accepted-measurement policy; issue #62 is the first plausible
   one.
4. **Tinfoil subprocessor disclosure: DONE and live.** `docs/privacy.html`
   identifies the content and metadata boundaries, and the GitHub Pages revision
   is published at `https://bayleaf.dev/privacy.html`.

## Routes

```
/                       Landing       /login         OIDC start      /callback   OIDC callback
/logout                 Clear         /dashboard     User UI         /key        POST|DELETE
/v1/responses           Responses API proxy (caller instructions forwarded unchanged)
/v1/chat/completions    Chat completions proxy (caller messages forwarded unchanged)
/v1/*                   General OpenRouter proxy (models, auth/key, etc.)
/sandbox                GET: sandbox status (keyed only, no side effects)
/sandbox/exec           POST: bash execution (keyed only, persistent)
/sandbox/poke           POST: refresh inactivity timer / wake sandbox (keyed only)
/sandbox/files/*        GET: download file, PUT: upload file (keyed only)
/sandbox                DELETE: destroy user's sandbox (keyed or session)
/web/search              POST: web search (Tavily)
/web/fetch               POST: fetch page content from one or more URLs (Tavily Extract)
/sealed/health          GET: Sealed kill-switch state + upstream reachability (issue #55)
/sealed/attestation     GET|POST: relay of the signed Tinfoil attestation bundle
/sealed/models          GET: Sealed Tinfoil catalog with bare model IDs
/sealed/v1/*            POST: EHBP ciphertext relay. POST only, no plaintext fallback
/.well-known/opencode                 GET: OpenCode discovery for standard BayLeaf
/.well-known/opencode/config          GET: Authenticated standard OpenCode config
/sealed/.well-known/opencode          GET: OpenCode discovery for opt-in BayLeaf Sealed
/sealed/.well-known/opencode/config   GET: Authenticated Sealed OpenCode config
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
- Don't add body parsing, buffering, logging, or a `GET` handler to
  `routes/sealed.ts`, and don't merge it into `routes/proxy.ts`. Read the
  invariants section above first: several of those look like cleanups and are
  actually the security properties.
