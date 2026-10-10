import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, GrantTransaction, UserKeyRow } from '../types';
import { getSession } from '../utils/session';
import { resolveAuth } from '../utils/auth';
import { ensureUserRow, getActiveRow } from '../provision';
import { standardModelId, eligibleStandardModel, standardModelCatalog } from '../standardModels';
import { BaseLayout, renderPage } from '../templates/layout';
import { hash, issueGrant, maxGrantSeconds, nowSeconds, randomSecret, seal, unseal, validCallback, grantError } from '../grants';
import { GrantRequestSchema, GrantTokenSchema, GrantErrorSchema, ClientDescriptorRequestSchema,
  ClientDescriptorSchema, GrantExchangeSchema, GrantListSchema, GrantModelsSchema } from '../schemas';

export const grantRoutes = new OpenAPIHono<AppEnv>({ defaultHook: (result, c) => {
  if (!result.success) return grantError(c, 'invalid_request', 'Invalid request fields.', 400) as any;
} });
const FLOW_COOKIE = 'bl_grant_flow';
const RETURN_COOKIE = 'bl_grant_return';
const cookieOptions = (c: Context<AppEnv>) => ({ path: '/', httpOnly: true, sameSite: 'Lax' as const,
  secure: new URL(c.req.url).protocol === 'https:', maxAge: 600 });
const json = (schema: any) => ({ 'application/json': { schema } });
const errors = {
  400: { description: 'Invalid request or expired authorization transaction', content: json(GrantErrorSchema) },
  401: { description: 'Authentication required', content: json(GrantErrorSchema) },
  403: { description: 'Permission denied', content: json(GrantErrorSchema) },
  503: { description: 'Feature disabled or unavailable', content: json(GrantErrorSchema) },
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

async function validateGrant(c: Context<AppEnv>, model: string, lifetime: number): Promise<Response | null> {
  const max = maxGrantSeconds(c.env);
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > max)
    return grantError(c, 'invalid_lifetime', `expires_in must be a positive integer no greater than ${max} seconds.`, 400);
  const id = standardModelId(model);
  if (!id || !await eligibleStandardModel(id, c.env))
    return grantError(c, 'model_not_allowed', 'Specify one eligible model from an enabled standard-inference backend.', 403);
  return null;
}

grantRoutes.openapi(createRoute({ method: 'post', path: '/', operationId: 'createTemporaryInferenceToken', tags: ['Grants'],
  summary: 'Create a temporary inference token', description: 'Use your existing allowance with exactly one plaintext model for a positive number of seconds. Excessive lifetimes fail with the current maximum. Tokens cannot mint or renew grants. The returned name is a public recognition aid, also bound into the signed token prefix.',
  security: [{ Bearer: [] }], request: { body: { required: true, content: json(GrantRequestSchema) } },
  responses: { 200: { description: 'Credential shown only at issuance', content: json(GrantTokenSchema) }, ...errors },
}), async c => {
  const row = await owner(c); if (row instanceof Response) return row as any;
  const body = c.req.valid('json') as z.infer<typeof GrantRequestSchema>;
  const rejection = await validateGrant(c, body.model, body.expires_in); if (rejection) return rejection as any;
  const token = await issueGrant(c.env, row, new URL(c.req.url).origin, standardModelId(body.model)!, nowSeconds() + body.expires_in);
  return token ? c.json(token) : grantError(c, 'issuance_unavailable', 'Could not allocate a token name. Try again.', 503) as any;
});

grantRoutes.openapi(createRoute({ method: 'get', path: '/', operationId: 'listInferenceGrants', tags: ['Grants'],
  summary: 'List your active inference grants', security: [{ Bearer: [] }],
  responses: { 200: { description: 'Active grants, never credentials', content: json(GrantListSchema) }, ...errors },
}), async c => {
  const row = await owner(c); if (row instanceof Response) return row as any;
  const results = await c.env.DB.prepare(`SELECT id, name, model, expires_at, created_at, client_name, redirect_uri
    FROM inference_grants WHERE owner_email = ? AND owner_token_hash = ? AND expires_at > ? ORDER BY created_at DESC`)
    .bind(row.email, await hash(row.bayleaf_token), nowSeconds()).all();
  return c.json({ grants: results.results });
});

grantRoutes.openapi(createRoute({ method: 'get', path: '/models', operationId: 'listTemporaryInferenceModels', tags: ['Grants'],
  summary: 'Full model catalog for temporary inference tokens', security: [{ Bearer: [] }],
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
  summary: 'Revoke one of your inference grants', security: [{ Bearer: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { 200: { description: 'Revoked (idempotent)', content: json(z.object({ success: z.literal(true) })) }, ...errors },
}), async c => {
  const row = await owner(c); if (row instanceof Response) return row as any;
  await c.env.DB.prepare('DELETE FROM inference_grants WHERE id = ? AND owner_email = ?').bind(c.req.valid('param').id, row.email).run();
  return c.json({ success: true });
});

grantRoutes.openapi(createRoute({ method: 'post', path: '/clients', operationId: 'describeInferenceClient', tags: ['Grants'],
  summary: 'Obtain an expiring client descriptor without registration', security: [],
  description: 'No database row is created. Navigate the browser to /grants/authorize with client_id, response_type=code, model, expires_in, random state, code_challenge (base64url SHA-256 of a random verifier), and code_challenge_method=S256. After sign-in and explicit consent, the exact callback receives code and state, or error=access_denied and state. Validate state, then exchange via POST /grants/token. HTTPS callbacks and exact HTTP localhost/127.0.0.1/[::1] callbacks are supported.',
  request: { body: { required: true, content: json(ClientDescriptorRequestSchema) } },
  responses: { 200: { description: 'Stateless signed descriptor, valid for ten minutes', content: json(ClientDescriptorSchema) }, ...errors },
}), async c => {
  const body = c.req.valid('json') as z.infer<typeof ClientDescriptorRequestSchema>;
  if (!validCallback(body.redirect_uri)) return grantError(c, 'invalid_redirect_uri', 'Use an exact HTTPS callback or HTTP localhost, 127.0.0.1, or [::1] callback, without credentials or a fragment.', 400) as any;
  const expires_at = nowSeconds() + 600;
  return c.json({ client_id: await seal(c.env, 'client', { ...body, exp: expires_at }), expires_at });
});

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
    const rejection = await validateGrant(c, q.model ?? '', Number(q.expires_in)); if (rejection) return rejection;
    id = crypto.randomUUID();
    const proof = randomSecret();
    await c.env.DB.prepare(`INSERT INTO grant_transactions
      (id, browser_hash, client_id, client_name, redirect_uri, model, lifetime, challenge, state, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, await hash(proof), q.client_id, descriptor.client_name,
        descriptor.redirect_uri, standardModelId(q.model)!, Number(q.expires_in), q.code_challenge, q.state, nowSeconds() + 600).run();
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
  const approval = await seal(c.env, 'consent', { id, email: session.email, exp: tx.expires_at });
  return renderPage(c, <BaseLayout title="Authorize inference"><section class="grant-panel">
    <GrantStyles/>
    <h1>Use your BayLeaf allowance?</h1>
    <p>Signed in as <strong>{session.email}</strong>.</p>
    <p><strong>{tx.client_name}</strong> (a name supplied by the app) requests inference access.</p>
    <p>Destination: <strong>{new URL(tx.redirect_uri).origin}</strong></p>
    <p>Exact callback: <code>{tx.redirect_uri}</code></p>
    <p>Model: <strong>{tx.model}</strong>. Lifetime: <strong>{tx.lifetime} seconds</strong>.</p>
    <p>This uses your existing allowance. The app receives a bearer token usable wherever it is copied, until expiry or revocation. BayLeaf retains no inference content; the app may handle or store what you enter.</p>
    <form method="post" action="/grants/authorize">
      <input type="hidden" name="request" value={id}/><input type="hidden" name="approval" value={approval}/>
      <button name="decision" value="approve" type="submit">Authorize temporary inference access</button>{' '}
      <button name="decision" value="deny" type="submit">Cancel</button>
    </form>
  </section></BaseLayout>);
});

grantRoutes.post('/authorize', async c => {
  if (c.req.header('Origin') !== new URL(c.req.url).origin) return grantError(c, 'invalid_origin', 'Submit from the consent page.', 403);
  const session = await getSession(c);
  if (!session) return grantError(c, 'login_required', 'Sign in again.', 401);
  const body = await c.req.parseBody();
  const tx = await transaction(c, String(body.request ?? ''));
  const approval = await unseal(c.env, 'consent', String(body.approval ?? ''));
  if (!tx || !approval || approval.id !== tx.id || approval.email !== session.email
    || typeof approval.exp !== 'number' || approval.exp <= nowSeconds() || !['approve', 'deny'].includes(String(body.decision)))
    return grantError(c, 'invalid_request', 'Consent expired or did not match this account. Start again.', 400);
  const callback = new URL(tx.redirect_uri);
  callback.searchParams.set('state', tx.state);
  if (body.decision === 'deny') {
    const removed = await c.env.DB.prepare('DELETE FROM grant_transactions WHERE id = ? AND code_hash IS NULL RETURNING id').bind(tx.id).first();
    if (!removed) return grantError(c, 'invalid_request', 'Already answered.', 400);
    callback.searchParams.set('error', 'access_denied');
  } else {
    const rejection = await validateGrant(c, tx.model, tx.lifetime); if (rejection) return rejection;
    const row = await ensureUserRow(session.email, c.env);
    if (!row) return grantError(c, 'account_unavailable', 'Could not prepare your account.', 503);
    const code = randomSecret();
    const updated = await c.env.DB.prepare(`UPDATE grant_transactions SET code_hash = ?, owner_email = ?,
      owner_token_hash = ?, grant_expires_at = ?, expires_at = MIN(expires_at, ?)
      WHERE id = ? AND code_hash IS NULL AND expires_at > ? RETURNING id`).bind(await hash(code), row.email,
        await hash(row.bayleaf_token), nowSeconds() + tx.lifetime, nowSeconds() + 120, tx.id, nowSeconds()).first();
    if (!updated) return grantError(c, 'invalid_request', 'Authorization already answered or expired.', 400);
    callback.searchParams.set('code', code);
  }
  deleteCookie(c, FLOW_COOKIE, { path: '/' });
  return c.redirect(callback.href, 303);
});

grantRoutes.openapi(createRoute({ method: 'post', path: '/token', operationId: 'exchangeInferenceCode', tags: ['Grants'],
  summary: 'Exchange a single-use authorization code using PKCE', security: [],
  request: { body: { required: true, content: json(GrantExchangeSchema) } },
  responses: { 200: { description: 'Temporary inference token with a public memorable name', content: json(GrantTokenSchema) }, ...errors },
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
  const qualifiedModel = standardModelId(tx.model);
  if (!qualifiedModel || !await eligibleStandardModel(qualifiedModel, c.env))
    return grantError(c, 'model_not_allowed', 'The model is no longer eligible on an enabled standard-inference backend.', 403) as any;
  const token = await issueGrant(c.env, row, new URL(c.req.url).origin, qualifiedModel, tx.grant_expires_at!, tx.client_name, tx.redirect_uri);
  return token ? c.json(token) : grantError(c, 'issuance_unavailable', 'Could not allocate a token name. Authorize again.', 503) as any;
});

// Preserve bookmarks while consolidating the controls into the main dashboard.
grantRoutes.get('/manage', c => c.redirect('/dashboard#temporary-inference-tokens', 303));

function GrantStyles() {
  return <style>{`
    .grant-panel { overflow-wrap: anywhere; }
    .grant-panel label { display: block; margin-top: 1rem; font-weight: 600; }
    .grant-panel input:not([type=hidden]) { display: block; width: 100%; padding: .65rem; font: inherit; border: 1px solid #767676; border-radius: 4px; }
    .grant-panel button { padding: .65rem 1rem; margin: .75rem .5rem .75rem 0; font: inherit; cursor: pointer; border: 1px solid #003c6c; border-radius: 4px; background: #003c6c; color: white; }
    .grant-panel li { margin-bottom: 1rem; }
  `}</style>;
}
