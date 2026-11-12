import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, GrantTransaction, InferenceGrant, UserKeyRow } from '../types';
import { getSession } from '../utils/session';
import { resolveAuth } from '../utils/auth';
import { ensureUserRow, getActiveRow } from '../provision';
import { eligibleStandardModel, standardModelCatalog } from '../standardModels';
import { BaseLayout, renderPage } from '../templates/layout';
import { describeSeconds, hash, issueGrant, maxGrantSeconds, nowSeconds, randomSecret, seal, unseal, validCallback, grantError, grantModelIds, storedGrantModels,
  GRANT_SCOPES, DEFAULT_SCOPES, grantAuthority, grantScopeIds, grantScopes, needsModels, needsInboxes, grantInboxIds,
  storedGrantInboxes, needsSandboxDirs, needsRooms, grantSandboxDirs, storedGrantSandboxDirs, SANDBOX_APPS_ROOT, type GrantScope } from '../grants';
import { GrantRequestSchema, GrantTokenSchema, GrantErrorSchema, ClientDescriptorRequestSchema,
  ClientDescriptorSchema, GrantExchangeSchema, GrantListSchema, GrantModelsSchema, GrantAuthorizeQuerySchema, ApiErrorSchema,
  GrantInboxesSchema } from '../schemas';

/** Protocol narrative owned beside the handlers, rendered in the spec and Scalar. */
export const GRANT_WORKFLOW = `App tokens (formerly temporary inference tokens) each exercise one grant: a set of scopes, valid until expiry, drawing on an owner's existing allowance. Issuing more tokens adds no credit. Scopes and the routes they admit:

- inference.chat: POST /v1/chat/completions
- inference.responses: POST /v1/responses (OpenRouter only)
- inference.decisions: POST /v1/decisions
- usage.read: GET /usage, the grantor's allowances
- identity.read: GET /whoami, reporting credential grant and the grantor's email
- web.search and web.fetch: POST /web/search and /web/fetch, on BayLeaf's shared provider account (there is no per-user web budget)
- inboxes.messages.read: GET /inboxes/{id}, its events and event stream, messages, one message with its text, body, attachments and har, and export, for bound inboxes only
- inboxes.messages.manage: PATCH /inboxes/{id}/messages/{mid} (archive or unarchive) for bound inboxes only; it does not imply read
- sandbox.files.read: GET /sandbox/files/* inside bound sandbox folders only
- sandbox.files.write: PUT /sandbox/files/* inside bound sandbox folders only; it does not imply read
- rooms.read: GET /rooms/limits, /rooms, /rooms/{id} and /rooms/{id}/export, for all the grantor's rooms
- rooms.manage: POST /rooms, PATCH and DELETE /rooms/{id}, and /rooms/{id}/credentials (issue, list, revoke), for all the grantor's rooms; it does not imply read

Any inference.* scope requires models, 1–16 standard-inference models; models without an inference.* scope are rejected. Any inboxes.* scope requires inboxes, 1–16 of the grantor's own active inbox handles, checked at issuance, approval and exchange (403 inbox_not_allowed otherwise); inboxes without an inboxes.* scope are rejected. Inbox content is stored and sender-controlled: a bound token reads everything the inbox has stored or will receive until expiry or revocation, and a live event stream ends when the token is revoked or expires. Any sandbox.files.* scope requires sandbox_dirs, 1–16 folder names (lowercase letters, digits and hyphens, at most 63 characters); sandbox_dirs without a sandbox.files.* scope are rejected. Each name grants /home/daytona/bayleaf-apps/<name>/ and everything below it. The check is lexical on the decoded path: the path must continue past the folder, and empty, . or .. segments, quotes, backslashes and control characters are refused (403 insufficient_scope). Using such a token wakes the grantor's sandbox and creates one if none exists; another app naming the same folder shares it. rooms.* scopes bind no resource: they reach every room the grantor has or creates, and rooms.manage can mint participant links with any room scope; per-room delegation is a room capability link, not an app token. Requesting a rooms.* scope while Rooms is unavailable is 400 invalid_scope. Omitting scopes requests inference.chat only; request inference.responses or inference.decisions explicitly. Every other route refuses app tokens, including Sealed, model discovery, listing, creating, changing or destroying inboxes, deleting messages, inbox credentials, sandbox status, exec, keep-alive, deletion or file listing, account management and renewal. Model fallbacks, routing overrides and provider plugins are unavailable. Tokens work wherever copied within their scope/model/lifetime restriction; they are not origin-bound.

### Direct issuance

Use your ordinary BayLeaf key, or the signed-in dashboard. Get the selectable catalog from GET /grants/models, POST /grants with scopes (omitted means inference.chat only), models when an inference.* scope is requested (a JSON array of 1–16 backend-qualified slugs, without inference type tags), inboxes when an inboxes.* scope is requested (handles from GET /grants/inboxes), sandbox_dirs when a sandbox.files.* scope is requested, and lifetime, then use the returned access_token, scopes, models and base_url. Legacy model singleton shorthand remains accepted, mutually exclusive with models; responses include model, the first entry, only when models is nonempty. List metadata or revoke by identifier; credentials are recoverable only at issuance. The public name is a recognition aid, not a secret. Legacy grants may be unnamed.

### Visitor-funded browser authorization

1. Retain random state and a cryptographically random PKCE verifier in the initiating tab. Compute the base64url SHA-256 challenge without padding.
2. POST /grants/clients with an app label and exact callback URI. The signed descriptor creates no permanent app registry.
3. Navigate the browser, not fetch(), to GET /grants/authorize with the documented query fields. Encode scopes and models as JSON array query values, or use the legacy model singleton instead of models, never both. BayLeaf handles sign-in and explicit consent listing every scope and model; identity.read is shown as disclosing the visitor's email to the app. Apps cannot know visitors' inbox handles, so they request only an inboxes.* scope (an inboxes query parameter is rejected) and the visitor chooses inboxes on the consent page; the exchanged token reports them as inboxes. Sandbox folder names, by contrast, are the app's own namespace: the app names them as a sandbox_dirs JSON array query value, and the consent page shows each exact path. Mere login grants nothing.
4. The exact callback receives code and state, or error=access_denied and state. Verify state before exchange and remove callback parameters from the address bar.
5. POST JSON to /grants/token with the code, original verifier, descriptor and exact callback. The code can be consumed once. Lifetime starts at approval, not exchange. No client secret or refresh token is issued.

Callback host, port, path and query must match exactly. HTTPS and HTTP loopback callbacks are supported; fragments and credentials are rejected. This is a BayLeaf-specific protocol, not a general OAuth server. Authorization transaction expiry and code expiry are independent bounds; start again if either expires.

### Management and recovery

Management accepts a personal account Bearer credential or a BayLeaf browser session. Cookie-authenticated writes must originate on BayLeaf itself. Cross-origin apps use the public descriptor/exchange flow, not cross-origin account cookies. Campus Pass cannot own grants; app tokens cannot inspect or manage grants.

Requests with an expired token return 401 token_expired; invalid/revoked tokens return 401 invalid_token. Both expose WWW-Authenticate through CORS. A wrong model, or a route outside the token's scopes, returns 403 insufficient_scope. Unknown or empty scopes at issuance or authorization return 400 invalid_scope. A disabled grants feature returns 503; inference against a disabled backend also returns 503 and cannot be bypassed by an existing token. During issuance, authorization validation or exchange, an ineligible model or disabled backend instead returns 403 model_not_allowed. Do not parse message text: use error.code. After expiry or revocation, offer explicit authorization again, never silent renewal loops. Revocation prevents new requests, not running completions; rotating the owner's ordinary key invalidates its grants.

Keep tokens out of URLs, logs, public page source and visible DOM. The app's handling/storage of user content is separate from BayLeaf's ZDR inference path. [Workflow orientation and client setup](/llms.txt#app-tokens); [implementation rationale and browser example](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/GRANTS.md).`;

export const grantRoutes = new OpenAPIHono<AppEnv>({ defaultHook: (result, c) => {
  if (!result.success) return grantError(c, 'invalid_request', 'Invalid request fields.', 400) as any;
} });
const FLOW_COOKIE = 'bl_grant_flow';
const RETURN_COOKIE = 'bl_grant_return';
const cookieOptions = (c: Context<AppEnv>) => ({ path: '/', httpOnly: true, sameSite: 'Lax' as const,
  secure: new URL(c.req.url).protocol === 'https:', maxAge: 600 });
const json = (schema: any) => ({ 'application/json': { schema } });
const errors = {
  400: { description: 'Invalid fields/scopes/lifetime, expired descriptor/transaction, or code already used/mismatched. For invalid_lifetime, message includes the current administrator maximum.',
    content: { 'application/json': { schema: GrantErrorSchema, examples: {
      lifetime: { value: { error: { code: 'invalid_lifetime', message: 'expires_in must be a positive integer no greater than the configured maximum.' } } },
      code: { value: { error: { code: 'invalid_grant', message: 'Code expired, was already used, or did not match PKCE and callback.' } } },
    } } } },
  401: { description: 'Authentication required. Account authentication may use numeric error.code; grant-flow errors use strings.', content: json(z.union([GrantErrorSchema, ApiErrorSchema])) },
  403: { description: 'Personal account, same-origin browser write, eligible model, or your own active inboxes (inbox_not_allowed) required.',
    content: { 'application/json': { schema: GrantErrorSchema, example: { error: { code: 'model_not_allowed', message: 'Specify eligible models from enabled standard-inference backends.' } } } } },
  503: { description: 'Feature disabled or unavailable.',
    content: { 'application/json': { schema: GrantErrorSchema, example: { error: { code: 'grants_disabled', message: 'Temporary inference access is disabled.' } } } } },
};

grantRoutes.use('*', bodyLimit({ maxSize: 16 * 1024,
  onError: c => grantError(c, 'invalid_request', 'Authorization requests must be at most 16 KiB.', 400),
}));

grantRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // no-referrer can turn a same-origin form POST's Origin into null. Preserve
  // that CSRF signal while withholding referrers from cross-origin callbacks.
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  // form-action 'self' also blocks the legitimate cross-origin 303 callback
  // in some browsers. The fixed form action and Origin/proof checks bind POST.
  c.header('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'");
  if (c.env.GRANTS_ENABLED !== 'true') return grantError(c, 'grants_disabled', 'Temporary inference access is disabled.', 503);
  await next();
});

async function owner(c: Context<AppEnv>): Promise<UserKeyRow | Response> {
  // A supplied credential takes precedence over cookies, including bad keys.
  if (c.req.header('Authorization')) {
    const auth = await resolveAuth(c);
    if (auth instanceof Response) return auth;
    if (auth.userKeyRow?.revoked) return grantError(c, 'personal_account_required',
      'Temporary inference tokens require a current ordinary API key. Sandbox access remains available.', 403);
    return auth.userKeyRow ?? grantError(c, 'personal_account_required', 'Use your personal BayLeaf key, not Campus Pass.', 403);
  }
  const session = await getSession(c);
  if (!session) return grantError(c, 'login_required', 'Sign in to BayLeaf.', 401);
  if (c.req.method !== 'GET' && c.req.header('Origin') !== new URL(c.req.url).origin)
    return grantError(c, 'invalid_origin', 'Submit from the BayLeaf page.', 403);
  const row = c.req.method === 'POST'
    ? await ensureUserRow(session.email, c.env)
    : await getActiveRow(session.email, c.env);
  return row ?? grantError(c, 'account_unavailable', 'Create a token to activate your account first.', 403);
}

/**
 * Scopes and the model set they require, checked at issuance, consent and exchange.
 * models is undefined when the request named none, null when it named them malformed.
 */
async function validateGrant(c: Context<AppEnv>, scopes: GrantScope[] | null, models: string[] | null | undefined,
  lifetime: number): Promise<Response | null> {
  const max = maxGrantSeconds(c.env);
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > max)
    return grantError(c, 'invalid_lifetime', `expires_in must be a positive integer no greater than ${max} seconds.`, 400);
  if (!scopes) return grantError(c, 'invalid_scope', `scopes must be a nonempty array of: ${Object.keys(GRANT_SCOPES).join(', ')}.`, 400);
  if (needsRooms(scopes) && !roomsAvailable(c)) return grantError(c, 'invalid_scope', 'Rooms are unavailable on this deployment.', 400);
  if (!needsModels(scopes)) return models === undefined ? null
    : grantError(c, 'invalid_request', 'models apply only to inference.* scopes.', 400);
  if (models === undefined) return grantError(c, 'invalid_request', 'Specify models (or legacy model) for inference.* scopes.', 400);
  if (!models?.length || !(await Promise.all(models.map(id => eligibleStandardModel(id, c.env)))).every(Boolean))
    return grantError(c, 'model_not_allowed', 'Specify eligible models from enabled standard-inference backends.', 403);
  return null;
}

const roomsAvailable = (c: Context<AppEnv>) => c.env.ROOMS_ENABLED === 'true' && !!c.env.ROOMS;
const inboxesAvailable = (c: Context<AppEnv>) => c.env.INBOXES_ENABLED === 'true' && !!c.env.INBOXES;
type InboxChoice = { id: string; type: string; label: string | null; address?: string; url?: string };

/** The owner's active inboxes, under the same pilot rule as the inbox facade. Empty when
 * Inboxes is off or excludes the owner; null when the inbox service could not answer.
 * Both bind nothing, but only null is worth retrying. */
async function ownerInboxes(c: Context<AppEnv>, row: UserKeyRow | null): Promise<InboxChoice[] | null> {
  const generation = row?.account_generation;
  if (!inboxesAvailable(c) || !generation || (c.env.INBOXES_PILOT_OWNER && generation !== c.env.INBOXES_PILOT_OWNER)) return [];
  try {
    // The RPC reports failure by returning { error }, not only by throwing.
    const result = await c.env.INBOXES!.listInboxes(generation) as { error?: string; inboxes?: (InboxChoice & { state: string })[] };
    if (!result || result.error || !Array.isArray(result.inboxes)) return null;
    return result.inboxes.filter(i => i.state === 'active')
      .map(({ id, type, label, address, url }) => ({ id, type, label, address, url }));
  } catch { return null; }
}

const inboxesUnavailable = (c: Context<AppEnv>) =>
  grantError(c, 'inboxes_unavailable', 'Your inboxes could not be checked right now. Try again shortly.', 503);

/** What an inbox binding lets the app see. Manage does not imply read. */
const inboxEffect = (scopes: GrantScope[]) => scopes.includes('inboxes.messages.read')
  ? 'The app can read everything a chosen inbox has stored or will receive, until the token expires or you revoke it.'
  : 'The app can archive or unarchive messages whose handles it already knows, seeing each one\'s sender and subject (or HTTP method and path), never its body.';

/**
 * Inbox handles an inboxes.* scope binds, checked at issuance, approval and exchange: each
 * must be one of the owner's active inboxes. undefined means the request named none.
 */
async function validateInboxes(c: Context<AppEnv>, scopes: GrantScope[], inboxes: string[] | null | undefined,
  row: UserKeyRow): Promise<Response | null> {
  if (!needsInboxes(scopes)) return inboxes === undefined ? null
    : grantError(c, 'invalid_request', 'inboxes apply only to inboxes.* scopes.', 400);
  if (inboxes === undefined) return grantError(c, 'invalid_request', 'Specify inboxes for inboxes.* scopes.', 400);
  const choices = await ownerInboxes(c, row);
  if (!choices) return inboxesUnavailable(c);
  const owned = new Set(choices.map(i => i.id));
  if (!inboxes?.length || !inboxes.every(id => owned.has(id)))
    return grantError(c, 'inbox_not_allowed', 'Specify 1–16 of your own active inboxes.', 403);
  return null;
}

/** Folder names a sandbox.files.* scope binds. Pure grammar: there is nothing to own
 * until an app writes, and BayLeaf fixes the root. undefined means the request named none. */
function validateSandboxDirs(c: Context<AppEnv>, scopes: GrantScope[], dirs: string[] | null | undefined): Response | null {
  if (!needsSandboxDirs(scopes)) return dirs === undefined ? null
    : grantError(c, 'invalid_request', 'sandbox_dirs apply only to sandbox.files.* scopes.', 400);
  if (!dirs?.length) return grantError(c, 'invalid_request',
    'sandbox.files.* scopes need sandbox_dirs: 1–16 folder names of lowercase letters, digits and hyphens.', 400);
  return null;
}

/** Authority persisted on a grant or transaction, shaped for the validators. */
function storedAuthority(row: { scopes_json: string | null; models_json: string; inboxes_json: string | null;
  sandbox_dirs_json: string | null }) {
  const scopes = grantScopes(row);
  return { scopes, models: needsModels(scopes) ? storedGrantModels(row) : undefined,
    inboxes: needsInboxes(scopes) ? storedGrantInboxes(row) : undefined,
    sandboxDirs: needsSandboxDirs(scopes) ? storedGrantSandboxDirs(row) : undefined };
}

grantRoutes.openapi(createRoute({ method: 'post', path: '/', operationId: 'createTemporaryInferenceToken', tags: ['Grants'],
  summary: 'Create an app token', description: 'Delegate chosen scopes of your existing allowance for a positive number of seconds. Omitted scopes mean inference.chat only. Any inference.* scope needs 1–16 plaintext models, as backend-qualified models or legacy model singleton shorthand, never both; models without one are rejected. Every model is checked for eligibility. Any inboxes.* scope needs inboxes, 1–16 of your own active inbox handles (see GET /grants/inboxes); inboxes without one are rejected. Any sandbox.files.* scope needs sandbox_dirs, 1–16 folder names under /home/daytona/bayleaf-apps/; sandbox_dirs without one are rejected. Excessive lifetimes fail with the current maximum. Tokens cannot mint or renew grants. The returned name is a public recognition aid, also bound into the signed token prefix.',
  security: [{ Bearer: [] }, { BrowserSession: [] }] as Record<string, string[]>[], request: { body: { required: true, content: json(GrantRequestSchema) } },
  responses: { 200: { description: 'Credential shown only at issuance', content: json(GrantTokenSchema) }, ...errors },
}), async c => {
  const row = await owner(c); if (row instanceof Response) return row as any;
  const body = c.req.valid('json') as z.infer<typeof GrantRequestSchema>;
  const scopes = body.scopes === undefined ? DEFAULT_SCOPES : grantScopeIds(body.scopes);
  const models = body.models !== undefined ? grantModelIds(body.models)
    : body.model !== undefined ? grantModelIds(body.model, true) : undefined;
  const inboxes = body.inboxes !== undefined ? grantInboxIds(body.inboxes) : undefined;
  const sandboxDirs = body.sandbox_dirs !== undefined ? grantSandboxDirs(body.sandbox_dirs) : undefined;
  const rejection = await validateGrant(c, scopes, models, body.expires_in)
    ?? validateSandboxDirs(c, scopes!, sandboxDirs) ?? await validateInboxes(c, scopes!, inboxes, row);
  if (rejection) return rejection as any;
  const token = await issueGrant(c.env, row, new URL(c.req.url).origin,
    { scopes: scopes!, models: models ?? [], inboxes: inboxes ?? [], sandboxDirs: sandboxDirs ?? [] }, nowSeconds() + body.expires_in);
  return token ? c.json(token) : grantError(c, 'issuance_unavailable', 'Could not allocate a token name. Try again.', 503) as any;
});

grantRoutes.openapi(createRoute({ method: 'get', path: '/', operationId: 'listInferenceGrants', tags: ['Grants'],
  summary: 'List your active app tokens (grants)', security: [{ Bearer: [] }, { BrowserSession: [] }],
  responses: { 200: { description: 'Active grants, never credentials', content: json(GrantListSchema) }, ...errors },
}), async c => {
  const row = await owner(c); if (row instanceof Response) return row as any;
  const results = await c.env.DB.prepare(`SELECT id, name, models_json, scopes_json, inboxes_json, sandbox_dirs_json, expires_at, created_at, client_name, redirect_uri
    FROM inference_grants WHERE owner_email = ? AND owner_token_hash = ? AND expires_at > ? ORDER BY created_at DESC`)
    .bind(row.email, await hash(row.bayleaf_token), nowSeconds()).all<InferenceGrant>();
  return c.json({ grants: results.results.map(({ models_json, scopes_json, inboxes_json, sandbox_dirs_json, ...grant }) =>
    ({ ...grant, ...grantAuthority({ scopes: grantScopes({ scopes_json }), models: storedGrantModels({ models_json }),
      inboxes: storedGrantInboxes({ inboxes_json }), sandboxDirs: storedGrantSandboxDirs({ sandbox_dirs_json }) }) })) });
});

grantRoutes.openapi(createRoute({ method: 'get', path: '/inboxes', operationId: 'listAppTokenInboxes', tags: ['Grants'],
  summary: 'Your inboxes that app tokens can be bound to', security: [{ Bearer: [] }, { BrowserSession: [] }],
  description: 'Active inboxes owned by the caller, for choosing an inboxes.* binding. Empty when Inboxes is unavailable. Issuance checks ownership again.',
  responses: { 200: { description: 'Bindable inboxes', content: json(GrantInboxesSchema) }, ...errors },
}), async c => {
  const row = await owner(c); if (row instanceof Response) return row as any;
  const inboxes = await ownerInboxes(c, row);
  return inboxes ? c.json({ inboxes }) : inboxesUnavailable(c) as any;
});

grantRoutes.openapi(createRoute({ method: 'get', path: '/models', operationId: 'listTemporaryInferenceModels', tags: ['Grants'],
  summary: 'Full model catalog for app tokens', security: [{ Bearer: [] }, { BrowserSession: [] }],
  description: 'Backend-qualified models from every enabled standard-inference backend, plus backend availability. Disabled backends are identified but are not selectable. Issuance performs the backend eligibility check again. Sealed is separate.',
  responses: { 200: { description: 'Standard-inference catalog and backend status', content: json(GrantModelsSchema) }, ...errors },
}), async c => {
  // Read-only browser discovery must also work before the user's first token.
  if (c.req.header('Authorization')) {
    const row = await owner(c); if (row instanceof Response) return row as any;
  } else if (!await getSession(c)) return grantError(c, 'login_required', 'Sign in to BayLeaf.', 401) as any;
  return c.json(await standardModelCatalog(c.env));
});

grantRoutes.openapi(createRoute({ method: 'delete', path: '/{id}', operationId: 'revokeInferenceGrant', tags: ['Grants'],
  summary: 'Revoke one of your app tokens (grants)', security: [{ Bearer: [] }, { BrowserSession: [] }] as Record<string, string[]>[],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { 200: { description: 'Revoked (idempotent)', content: json(z.object({ success: z.literal(true) })) }, ...errors },
}), async c => {
  const row = await owner(c); if (row instanceof Response) return row as any;
  await c.env.DB.prepare('DELETE FROM inference_grants WHERE id = ? AND owner_email = ?').bind(c.req.valid('param').id, row.email).run();
  return c.json({ success: true });
});

grantRoutes.openapi(createRoute({ method: 'post', path: '/clients', operationId: 'describeInferenceClient', tags: ['Grants'],
  summary: 'Obtain an expiring client descriptor without registration', security: [],
  description: 'No database row is created. Navigate the browser to /grants/authorize with client_id, response_type=code, optional scopes (JSON array; omitted means inference.chat only), models (JSON array) or legacy model singleton when an inference.* scope is requested (never inboxes: the visitor chooses those at consent), sandbox_dirs (JSON array of folder names) when a sandbox.files.* scope is requested, expires_in, random state, code_challenge (base64url SHA-256 of a random verifier), and code_challenge_method=S256. After sign-in and explicit consent, the exact callback receives code and state, or error=access_denied and state. Validate state, then exchange via POST /grants/token. HTTPS callbacks and exact HTTP localhost/127.0.0.1/[::1] callbacks are supported.',
  request: { body: { required: true, content: json(ClientDescriptorRequestSchema) } },
  responses: { 200: { description: 'Stateless signed descriptor, valid for ten minutes', content: json(ClientDescriptorSchema) }, ...errors },
}), async c => {
  const body = c.req.valid('json') as z.infer<typeof ClientDescriptorRequestSchema>;
  if (!validCallback(body.redirect_uri)) return grantError(c, 'invalid_redirect_uri', 'Use an exact HTTPS callback or HTTP localhost, 127.0.0.1, or [::1] callback, without credentials or a fragment.', 400) as any;
  const expires_at = nowSeconds() + 600;
  return c.json({ client_id: await seal(c.env, 'client', { ...body, exp: expires_at }), expires_at });
});

// Registry-only: describe public browser initiation without validating/replacing
// the handler's cookie-bound internal ?request= continuation.
grantRoutes.openAPIRegistry.registerPath(createRoute({
  method: 'get', path: '/authorize', operationId: 'authorizeInferenceClient', tags: ['Grants'],
  summary: 'Navigate a browser to authorize an app token', security: [],
  description: 'Browser navigation, not a JSON fetch. Use the descriptor/PKCE workflow in the Grants introduction. ' +
    'Initial navigation redirects to a cookie-bound continuation, then login if needed, and an explicit HTML consent page. ' +
    'The consent form is BayLeaf-owned, not an app API; with an inboxes.* scope the visitor chooses which inboxes to bind there, and an inboxes query parameter is rejected. After consent the exact callback receives code+state, or error=access_denied+state. ' +
    'Verify state before JSON exchange. The internal request query parameter is not an integration entrypoint.',
  request: { query: GrantAuthorizeQuerySchema },
  responses: { 200: { description: 'HTML consent page after sign-in; never an app token',
    content: { 'text/html': { schema: z.string() } } },
    303: { description: 'Cookie-bound continuation, login navigation, or consent callback; let the browser follow',
      headers: z.object({ Location: z.string().describe('Navigation destination, not a JSON response.') }) }, ...errors },
}));

export function consumeGrantReturnTo(c: Context<AppEnv>): string | null {
  const id = getCookie(c, RETURN_COOKIE);
  deleteCookie(c, RETURN_COOKIE, { path: '/' });
  return id && /^[a-f0-9-]{36}$/.test(id) ? `/grants/authorize?request=${id}` : null;
}

async function transaction(c: Context<AppEnv>, id: string): Promise<GrantTransaction | null> {
  const proof = getCookie(c, FLOW_COOKIE);
  if (!proof) return null;
  return c.env.DB.prepare('SELECT * FROM grant_transactions WHERE id = ? AND browser_hash = ? AND expires_at > ? AND code_hash IS NULL')
    .bind(id, await hash(proof), nowSeconds()).first<GrantTransaction>();
}

grantRoutes.get('/authorize', async c => {
  let id = c.req.query('request');
  if (!id) {
    const q = c.req.query();
    const descriptor = await unseal(c.env, 'client', q.client_id ?? '');
    if (!descriptor || typeof descriptor.exp !== 'number' || descriptor.exp <= nowSeconds()
      || typeof descriptor.redirect_uri !== 'string' || typeof descriptor.client_name !== 'string'
      || !validCallback(descriptor.redirect_uri) || q.response_type !== 'code' || q.code_challenge_method !== 'S256'
      || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '') || !q.state || q.state.length > 256)
      return grantError(c, 'invalid_request', 'Invalid descriptor, state, or S256 PKCE authorization request.', 400);
    if (q.model !== undefined && q.models !== undefined)
      return grantError(c, 'invalid_request', 'Specify models or model, not both.', 400);
    let scopes: GrantScope[] | null = DEFAULT_SCOPES;
    if (q.scopes !== undefined) {
      try { scopes = grantScopeIds(JSON.parse(q.scopes)); } catch { scopes = null; }
    }
    let models: string[] | null | undefined;
    if (q.models !== undefined) {
      try { models = grantModelIds(JSON.parse(q.models)); } catch { models = null; }
      if (!models) return grantError(c, 'invalid_request', 'models must be a JSON array of 1–16 backend-qualified model slugs.', 400);
    } else if (q.model !== undefined) models = grantModelIds(q.model, true);
    const rejection = await validateGrant(c, scopes, models, Number(q.expires_in)); if (rejection) return rejection;
    // Apps cannot know a visitor's inbox handles: the visitor chooses them at consent.
    if (q.inboxes !== undefined)
      return grantError(c, 'invalid_request', 'Visitors choose inboxes on the consent page; omit inboxes.', 400);
    if (needsInboxes(scopes!) && !inboxesAvailable(c))
      return grantError(c, 'inbox_not_allowed', 'Inboxes are unavailable on this deployment.', 403);
    // Unlike inbox handles, folder names are the app's own namespace: it names them here.
    let sandboxDirs: string[] | null | undefined;
    if (q.sandbox_dirs !== undefined) {
      try { sandboxDirs = grantSandboxDirs(JSON.parse(q.sandbox_dirs)); } catch { sandboxDirs = null; }
    }
    const dirRejection = validateSandboxDirs(c, scopes!, sandboxDirs); if (dirRejection) return dirRejection;
    id = crypto.randomUUID();
    const proof = randomSecret();
    await c.env.DB.prepare(`INSERT INTO grant_transactions
      (id, browser_hash, client_id, client_name, redirect_uri, models_json, scopes_json, sandbox_dirs_json, lifetime, challenge, state, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, await hash(proof), q.client_id, descriptor.client_name,
        descriptor.redirect_uri, JSON.stringify(models ?? []), JSON.stringify(scopes), sandboxDirs ? JSON.stringify(sandboxDirs) : null,
        Number(q.expires_in), q.code_challenge, q.state, nowSeconds() + 600).run();
    setCookie(c, FLOW_COOKIE, proof, cookieOptions(c));
    return c.redirect(`/grants/authorize?request=${id}`, 303);
  }
  const tx = await transaction(c, id);
  if (!tx) return grantError(c, 'invalid_request', 'Authorization expired or belongs to a different browser. Start again in the app.', 400);
  const session = await getSession(c);
  if (!session) {
    setCookie(c, RETURN_COOKIE, id, cookieOptions(c));
    return c.redirect('/login', 303);
  }
  const { scopes, models, sandboxDirs } = storedAuthority(tx);
  const rejection = await validateGrant(c, scopes, models, tx.lifetime) ?? validateSandboxDirs(c, scopes, sandboxDirs);
  if (rejection) return rejection;
  const choices = needsInboxes(scopes) ? await ownerInboxes(c, await getActiveRow(session.email, c.env)) : undefined;
  const approval = await seal(c.env, 'consent', { id, email: session.email, exp: tx.expires_at });
  return renderPage(c, <BaseLayout title="Authorize app"><section class="grant-panel">
    <GrantStyles/>
    <h1>Give this app an app token?</h1>
    <p>Signed in as <strong>{session.email}</strong>.</p>
    <p><strong>{tx.client_name}</strong> (a name supplied by the app) asks to:</p>
    <ul>{scopes.map(scope => <li><strong>{GRANT_SCOPES[scope]}</strong> <code>{scope}</code></li>)}</ul>
    {scopes.includes('identity.read') && <p>The app will learn that you are <strong>{session.email}</strong>.</p>}
    {models && <><p>Authorized models:</p><ul>{models.map(model => <li><strong>{model}</strong></li>)}</ul></>}
    {sandboxDirs && <><p>Sandbox folders (named by the app; another app using the same name would share it):</p>
      <ul>{sandboxDirs.map(dir => <li><code>{SANDBOX_APPS_ROOT + dir + '/'}</code></li>)}</ul>
      <p>{scopes.includes('sandbox.files.read') ? 'The app can read any file in these folders, whoever wrote it. ' : ''}
        {scopes.includes('sandbox.files.write') ? 'The app can create or overwrite files there; treat them as untrusted if your own agents read them. ' : ''}
        Using the token wakes your BayLeaf Sandbox, and creates one if you have none.</p></>}
    {needsRooms(scopes) && <p>This covers every room you have or create, not one chosen room.
      {scopes.includes('rooms.read') ? ' The app can read and export everything participants stored in them.' : ''}
      {scopes.includes('rooms.manage') ? ' The app can delete rooms and hand out participant links, including links that can write.' : ''}</p>}
    <p>Destination: <strong>{new URL(tx.redirect_uri).origin}</strong></p>
    <p>Exact callback: <code>{tx.redirect_uri}</code></p>
    <p>Lifetime: <strong>{describeSeconds(tx.lifetime)}</strong> from approval, until about <strong>{new Date((nowSeconds() + tx.lifetime) * 1000).toUTCString()}</strong>.</p>
    {tx.lifetime > 86400 && <p>This token lasts longer than a day. Revoke it from your dashboard when the app no longer needs it.</p>}
    <p>{models && 'Inference uses your existing allowance. '}The app receives a bearer token usable wherever it is copied, until expiry or revocation.{models && ' BayLeaf retains no inference content; the app may handle or store what you enter.'}</p>
    <form method="post" action="/grants/authorize">
      <input type="hidden" name="request" value={id}/><input type="hidden" name="approval" value={approval}/>
      {choices !== undefined && <fieldset><legend>Inboxes this app may use</legend>
        {choices === null ? <p>Your inboxes could not be loaded right now. Reload this page to try again.</p>
          : choices.length ? choices.map(inbox => <label class="grant-choice"><input type="checkbox" name="inbox" value={inbox.id}/>{' '}
            <strong>{inbox.label ?? inbox.id}</strong> <code>{inbox.address ?? inbox.url}</code></label>)
          : <p>You have no active inboxes to share. Create one, then start again in the app.</p>}
        <p>{inboxEffect(scopes)} Inbox content is sender-controlled.</p>
      </fieldset>}
      <button name="decision" value="approve" type="submit" disabled={choices === null || choices?.length === 0}>Authorize app token</button>{' '}
      <button name="decision" value="deny" type="submit">Cancel</button>
    </form>
  </section></BaseLayout>);
});

grantRoutes.post('/authorize', async c => {
  if (c.req.header('Origin') !== new URL(c.req.url).origin) return grantError(c, 'invalid_origin', 'Submit from the consent page.', 403);
  const session = await getSession(c);
  if (!session) return grantError(c, 'login_required', 'Sign in again.', 401);
  const body = await c.req.parseBody({ all: true });
  const field = (name: string) => typeof body[name] === 'string' ? body[name] as string : '';
  const tx = await transaction(c, field('request'));
  const approval = await unseal(c.env, 'consent', field('approval'));
  if (!tx || !approval || approval.id !== tx.id || approval.email !== session.email
    || typeof approval.exp !== 'number' || approval.exp <= nowSeconds() || !['approve', 'deny'].includes(field('decision')))
    return grantError(c, 'invalid_request', 'Consent expired or did not match this account. Start again.', 400);
  const callback = new URL(tx.redirect_uri);
  callback.searchParams.set('state', tx.state);
  if (field('decision') === 'deny') {
    const removed = await c.env.DB.prepare('DELETE FROM grant_transactions WHERE id = ? AND code_hash IS NULL RETURNING id').bind(tx.id).first();
    if (!removed) return grantError(c, 'invalid_request', 'Already answered.', 400);
    callback.searchParams.set('error', 'access_denied');
  } else {
    const { scopes, models, sandboxDirs } = storedAuthority(tx);
    const rejection = await validateGrant(c, scopes, models, tx.lifetime) ?? validateSandboxDirs(c, scopes, sandboxDirs);
    if (rejection) return rejection;
    const row = await ensureUserRow(session.email, c.env);
    if (!row) return grantError(c, 'account_unavailable', 'Could not prepare your account.', 503);
    const chosen = [body.inbox ?? []].flat().filter((v): v is string => typeof v === 'string');
    const inboxes = needsInboxes(scopes) ? grantInboxIds(chosen) : undefined;
    const inboxRejection = await validateInboxes(c, scopes, inboxes, row); if (inboxRejection) return inboxRejection;
    const code = randomSecret();
    const updated = await c.env.DB.prepare(`UPDATE grant_transactions SET code_hash = ?, owner_email = ?,
      owner_token_hash = ?, grant_expires_at = ?, expires_at = MIN(expires_at, ?), inboxes_json = ?
      WHERE id = ? AND code_hash IS NULL AND expires_at > ? RETURNING id`).bind(await hash(code), row.email,
        await hash(row.bayleaf_token), nowSeconds() + tx.lifetime, nowSeconds() + 120,
        inboxes ? JSON.stringify(inboxes) : null, tx.id, nowSeconds()).first();
    if (!updated) return grantError(c, 'invalid_request', 'Authorization already answered or expired.', 400);
    callback.searchParams.set('code', code);
  }
  deleteCookie(c, FLOW_COOKIE, { path: '/' });
  return c.redirect(callback.href, 303);
});

grantRoutes.openapi(createRoute({ method: 'post', path: '/token', operationId: 'exchangeInferenceCode', tags: ['Grants'],
  summary: 'Exchange a single-use authorization code using PKCE', security: [],
  description: 'JSON exchange after explicit browser consent. Uses the original verifier, client descriptor and exact callback binding. Single use, no refresh token; lifetime started at approval. No ordinary API key is required in the app.',
  request: { body: { required: true, content: json(GrantExchangeSchema) } },
  responses: { 200: { description: 'App token with a public memorable name', content: json(GrantTokenSchema) }, ...errors },
}), async c => {
  const body = c.req.valid('json') as z.infer<typeof GrantExchangeSchema>;
  // Atomic consume AFTER verifying PKCE and exact descriptor/callback binding.
  const tx = await c.env.DB.prepare(`DELETE FROM grant_transactions WHERE code_hash = ? AND challenge = ?
    AND client_id = ? AND redirect_uri = ? AND expires_at > ? AND grant_expires_at > ? RETURNING *`)
    .bind(await hash(body.code), await hash(body.code_verifier), body.client_id, body.redirect_uri, nowSeconds(), nowSeconds()).first<GrantTransaction>();
  if (!tx?.owner_email) return grantError(c, 'invalid_grant', 'Code expired, was already used, or did not match PKCE and callback.', 400) as any;
  const row = await getActiveRow(tx.owner_email, c.env);
  if (!row || await hash(row.bayleaf_token) !== tx.owner_token_hash)
    return grantError(c, 'invalid_grant', 'Account credential changed. Authorize again.', 400) as any;
  const { scopes, models, inboxes, sandboxDirs } = storedAuthority(tx);
  const rejection = await validateGrant(c, scopes, models, tx.lifetime) ?? validateSandboxDirs(c, scopes, sandboxDirs)
    ?? await validateInboxes(c, scopes, inboxes, row);
  if (rejection) return rejection as any;
  const token = await issueGrant(c.env, row, new URL(c.req.url).origin,
    { scopes, models: models ?? [], inboxes: inboxes ?? [], sandboxDirs: sandboxDirs ?? [] }, tx.grant_expires_at!,
    tx.client_name, tx.redirect_uri);
  return token ? c.json(token) : grantError(c, 'issuance_unavailable', 'Could not allocate a token name. Authorize again.', 503) as any;
});

// Preserve bookmarks while consolidating the controls into the main dashboard.
grantRoutes.get('/manage', c => c.redirect('/dashboard#temporary-inference-tokens', 303));

function GrantStyles() {
  return <style>{`
    .grant-panel { overflow-wrap: anywhere; }
    .grant-panel label { display: block; margin-top: 1rem; font-weight: 600; }
    .grant-panel input:not([type=hidden]):not([type=checkbox]) { display: block; width: 100%; padding: .65rem; font: inherit; border: 1px solid #767676; border-radius: 4px; }
    .grant-panel button { padding: .65rem 1rem; margin: .75rem .5rem .75rem 0; font: inherit; cursor: pointer; border: 1px solid #003c6c; border-radius: 4px; background: #003c6c; color: white; }
    .grant-panel li { margin-bottom: 1rem; }
    .grant-panel label.grant-choice { font-weight: normal; margin-top: .5rem; }
    .grant-panel fieldset { margin: 1rem 0; }
  `}</style>;
}
