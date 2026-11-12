/** Temporary inference authority. Only metadata is persisted; inference uses
 * the owner's existing backend limits and the standard lane's provider policy. */
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { COMPOSED_HANDLER } from 'hono/utils/constants';
import type { AppEnv, Bindings, InferenceGrant, UserKeyRow } from './types';
import { standardModelId } from './standardModels';
import { ALT_BACKENDS, isBackendEnabled } from './constants';
import { USER_ACTIVITY_COLUMNS } from './userActivity';

export const GRANT_PREFIX = 'sk-bayleaf-grant-';
export const nowSeconds = () => Math.floor(Date.now() / 1000);
const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
export const randomSecret = () => b64(crypto.getRandomValues(new Uint8Array(32)));
export async function hash(value: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function signingKey(env: Bindings) {
  // Domain separation: these envelopes can never be accepted as login JWTs.
  return crypto.subtle.importKey('raw', encoder.encode(env.OIDC_CLIENT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function seal(env: Bindings, purpose: string, payload: Record<string, unknown>) {
  const data = b64(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(`bayleaf-grants:v1:${purpose}:${data}`));
  return `${data}.${b64(new Uint8Array(signature))}`;
}
export async function unseal(env: Bindings, purpose: string, value: string): Promise<Record<string, unknown> | null> {
  try {
    if (value.length > 8192) return null;
    const parts = value.split('.');
    if (parts.length !== 2 || !parts.every(s => /^[A-Za-z0-9_-]+$/.test(s))) return null;
    if (!await crypto.subtle.verify('HMAC', await signingKey(env), unb64(parts[1]), encoder.encode(`bayleaf-grants:v1:${purpose}:${parts[0]}`))) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch { return null; }
}

/** Preserve exact callback spelling; reject URL parser normalization surprises. */
export function validCallback(value: string): boolean {
  try {
    if (value.length > 2048 || /[\s\\]/.test(value)) return false;
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.href !== value) return false;
    if (['code', 'state', 'error'].some(k => url.searchParams.has(k))) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export function maxGrantSeconds(env: Bindings): number {
  const value = Number(env.GRANTS_MAX_SECONDS ?? 3600);
  return Number.isSafeInteger(value) && value > 0 ? value : 3600;
}

/** Human lifetime in its largest whole unit, "about" when it rounds down. */
export function describeSeconds(seconds: number): string {
  const units: [number, string][] = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  const [size, name] = units.find(([size]) => seconds >= size) ?? units[3];
  const n = Math.floor(seconds / size);
  return `${seconds % size ? 'about ' : ''}${n} ${name}${n === 1 ? '' : 's'}`;
}

export function grantError(c: Context<AppEnv>, code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 503) {
  if (status === 401) c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
  return c.json({ error: { code, message } }, status);
}

/** Canonical ordered model set. Arrays require backend prefixes; only legacy
 * singleton shorthand accepts bare OpenRouter IDs. No inference type tags. */
export function grantModelIds(value: unknown, legacy = false): string[] | null {
  const values = legacy ? [value] : value;
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) return null;
  const ids: string[] = [];
  for (const entry of values) {
    if (typeof entry !== 'string' || entry.length > 200) return null;
    const id = standardModelId(entry);
    if (!id || (!legacy && id !== entry)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Persisted authority is exclusively a qualified model set, failing closed. */
export function storedGrantModels(row: { models_json: string }): string[] {
  try { return grantModelIds(JSON.parse(row.models_json)) ?? []; } catch { return []; }
}

/** Everything a grant may do: scopes plus the resources they are bound to. */
export interface GrantAuthority { scopes: GrantScope[]; models: string[]; inboxes: string[]; sandboxDirs: string[] }

/** Issuance/list response fields describing authority. `model` stays a legacy alias. */
export function grantAuthority({ scopes, models, inboxes, sandboxDirs }: GrantAuthority) {
  return { scopes, models, ...(models.length ? { model: models[0] } : {}), inboxes, sandbox_dirs: sandboxDirs };
}

export async function issueGrant(env: Bindings, row: UserKeyRow, apiOrigin: string, authority: GrantAuthority,
  expiresAt: number, clientName: string | null = null, redirectUri: string | null = null) {
  const ownerHash = await hash(row.bayleaf_token);
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = crypto.randomUUID();
    const name = memorableName();
    // Database uniqueness makes this safe under concurrent issuance. Expired
    // rows awaiting cleanup also reserve their names, without a history table.
    const inserted = await env.DB.prepare(`INSERT INTO inference_grants
      (id, name, owner_email, owner_token_hash, models_json, scopes_json, inboxes_json, sandbox_dirs_json, expires_at, created_at,
        client_name, redirect_uri)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`)
      .bind(id, name, row.email, ownerHash, JSON.stringify(authority.models), JSON.stringify(authority.scopes),
        authority.inboxes.length ? JSON.stringify(authority.inboxes) : null,
        authority.sandboxDirs.length ? JSON.stringify(authority.sandboxDirs) : null, expiresAt, nowSeconds(),
        clientName, redirectUri).first();
    if (!inserted) continue;
    const token = GRANT_PREFIX + name + '.' + await seal(env, 'access', { id, name, exp: expiresAt });
    return { grant_id: id, name, key: token, access_token: token, token_type: 'Bearer' as const,
      ...grantAuthority(authority), expires_at: expiresAt, expires_in: Math.max(0, expiresAt - nowSeconds()),
      base_url: `${apiOrigin}/v1` };
  }
  return null;
}

// 16 × 16 × 32^4 combinations (28 recognition bits). Security comes from HMAC,
// not these words. No user-controlled labels or permanent naming history.
const ADJECTIVES = ['brisk', 'calm', 'clever', 'cosmic', 'curious', 'daring', 'gentle', 'jolly',
  'lively', 'mellow', 'nimble', 'quiet', 'snarky', 'sunny', 'witty', 'zippy'];
const ANIMALS = ['aardvark', 'badger', 'capybara', 'dolphin', 'falcon', 'gecko', 'heron', 'ibis',
  'koala', 'lemur', 'marmot', 'newt', 'otter', 'panda', 'raven', 'wombat'];
function memorableName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  // Use a 32-character alphabet for unbiased low-five-bit indexing.
  const suffixAlphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  return `${ADJECTIVES[bytes[0] & 15]}-${ANIMALS[bytes[1] & 15]}-${Array.from(bytes.slice(2), b => suffixAlphabet[b & 31]).join('')}`;
}

/** App-token scopes (SCOPES.md), in canonical order, with consent-page wording. */
export const GRANT_SCOPES = {
  'inference.chat': 'Chat with the models listed below, using your allowance',
  'inference.responses': 'Use the Responses API with those models (OpenRouter models only)',
  'inference.decisions': 'Ask those models typed questions (choice, yes/no, score)',
  'usage.read': 'See your remaining inference allowances',
  'identity.read': 'Learn your BayLeaf account email address',
  'web.search': 'Search the web through BayLeaf',
  'web.fetch': 'Fetch web pages through BayLeaf',
  'inboxes.messages.read': 'Read messages in the inboxes chosen below',
  'inboxes.messages.manage': 'Archive or unarchive messages in those inboxes',
  'sandbox.files.read': 'Read files in the sandbox folders listed below',
  'sandbox.files.write': 'Create or overwrite files in those sandbox folders',
  'rooms.read': 'See all your rooms, their participant labels and usage, and export their content',
  'rooms.manage': 'Create, change and delete any of your rooms, and issue or revoke their participant links (which can read and export the rooms)',
} as const;
export type GrantScope = keyof typeof GRANT_SCOPES;
const ALL_SCOPES = Object.keys(GRANT_SCOPES) as GrantScope[];
/** Narrow default for issuance requests that omit scopes. Rows issued before scopes
 * existed were backfilled with all three inference.* scopes by migration 0020. */
export const DEFAULT_SCOPES: GrantScope[] = ['inference.chat'];
export const needsModels = (scopes: GrantScope[]) => scopes.some(s => s.startsWith('inference.'));
export const needsInboxes = (scopes: GrantScope[]) => scopes.some(s => s.startsWith('inboxes.'));
export const needsSandboxDirs = (scopes: GrantScope[]) => scopes.some(s => s.startsWith('sandbox.files.'));
/** Rooms scopes bind no resource: they reach every room of the grantor (SCOPES.md). */
export const needsRooms = (scopes: GrantScope[]) => scopes.some(s => s.startsWith('rooms.'));

/** Folder names, never paths: BayLeaf fixes the root, so an app cannot ask for ~ or /. */
export const SANDBOX_APPS_ROOT = '/home/daytona/bayleaf-apps/';
export function grantSandboxDirs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null;
  if (!value.every(d => typeof d === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(d))) return null;
  return [...new Set(value as string[])];
}
export function storedGrantSandboxDirs(row: { sandbox_dirs_json: string | null }): string[] {
  try { return grantSandboxDirs(JSON.parse(row.sandbox_dirs_json ?? 'null')) ?? []; } catch { return []; }
}

/**
 * Whether a sandbox file path lies inside one of the bound folders. Lexical only (SCOPES.md):
 * the prefix keeps its trailing slash so `journal-old` never matches `journal`, at least one
 * segment must follow, and no segment may be empty, `.` or `..`. Quotes and control
 * characters are refused too, matching what uploadFile can pass safely.
 */
export function insideSandboxDirs(path: string, dirs: string[]): boolean {
  if (/['\\\x00-\x1f\x7f]/.test(path)) return false;
  const dir = dirs.find(d => path.startsWith(SANDBOX_APPS_ROOT + d + '/'));
  if (!dir) return false;
  const rest = path.slice((SANDBOX_APPS_ROOT + dir + '/').length).split('/');
  return rest.every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/** Canonical inbox binding: 1–16 distinct handles. Ownership is checked against the
 * inbox Worker at issuance, consent and exchange, not here. */
export function grantInboxIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null;
  if (!value.every(id => typeof id === 'string' && /^ibx_[a-z0-9]{1,60}$/i.test(id))) return null;
  return [...new Set(value as string[])];
}

/** Persisted inbox binding; NULL or malformed binds nothing, which fails closed. */
export function storedGrantInboxes(row: { inboxes_json: string | null }): string[] {
  try { return grantInboxIds(JSON.parse(row.inboxes_json ?? 'null')) ?? []; } catch { return []; }
}
const SCOPE_TAG = Symbol('bayleaf.grantScope');

/** Canonical scope set: known names only, deduplicated, in GRANT_SCOPES order. */
export function grantScopeIds(value: unknown): GrantScope[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > ALL_SCOPES.length * 2) return null;
  if (!value.every(s => typeof s === 'string' && (ALL_SCOPES as string[]).includes(s))) return null;
  return ALL_SCOPES.filter(s => value.includes(s));
}

/** Persisted scopes, failing closed on malformed or missing (NULL) rows. */
export function grantScopes(row: { scopes_json: string | null }): GrantScope[] {
  try { return grantScopeIds(JSON.parse(row.scopes_json ?? 'null')) ?? []; } catch { return []; }
}

/**
 * Route middleware declaring which scope admits app tokens to this route. A no-op at
 * request time: the global gate reads the tag from Hono's matched routes before any
 * handler runs, so a route without this middleware denies every app token.
 */
export function requireScope(scope: GrantScope): MiddlewareHandler<AppEnv> {
  return Object.assign(async (_c: Context<AppEnv>, next: () => Promise<void>) => { await next(); }, { [SCOPE_TAG]: scope });
}

/**
 * The scope declared by the route that will respond. Hono matches every pattern that fits
 * (GET /inboxes/limits also fits GET /inboxes/:id), so only the first method-specific
 * route counts: `use()` middleware registers as ALL, and an earlier method-specific route
 * answers before later ones run. Several scopes on that route fail closed.
 */
function declaredScope(c: Context<AppEnv>): GrantScope | null {
  const routes = matchedRoutes(c);
  const target = routes.find(r => r.method !== 'ALL');
  if (!target) return null;
  const scopes = new Set<GrantScope>();
  for (const { handler } of routes.filter(r => r.method === target.method && r.path === target.path)) {
    // Sub-apps with their own onError are mounted wrapped; the declared function sits beneath.
    const original = (handler as any)[COMPOSED_HANDLER] ?? handler;
    if (original[SCOPE_TAG]) scopes.add(original[SCOPE_TAG]);
  }
  return scopes.size === 1 ? [...scopes][0] : null;
}

type GrantFailure = { code: string; message: string; status: 401 | 403 | 503 };

/** Every grant check, writing nothing to the response, so a live stream can revalidate. */
export async function checkGrant(c: Context<AppEnv>, token: string):
  Promise<{ grant: InferenceGrant; owner: UserKeyRow } | GrantFailure> {
  if (c.env.GRANTS_ENABLED !== 'true') return { code: 'grants_disabled', message: 'Temporary inference access is disabled.', status: 503 };
  const parts = token.slice(GRANT_PREFIX.length).split('.');
  const name = parts.length === 3 ? parts.shift()! : null;
  const payload = await unseal(c.env, 'access', parts.join('.'));
  if (!payload || typeof payload.id !== 'string' || typeof payload.exp !== 'number')
    return { code: 'invalid_token', message: 'Invalid inference token.', status: 401 };
  if ((payload.name ?? null) !== name)
    return { code: 'invalid_token', message: 'Token name does not match its signed permission.', status: 401 };
  // Signed expiry remains distinguishable even after its database row is deleted.
  if (payload.exp <= nowSeconds()) return { code: 'token_expired', message: 'Authorize again to continue.', status: 401 };
  const grant = await c.env.DB.prepare('SELECT * FROM inference_grants WHERE id = ?').bind(payload.id).first<InferenceGrant>();
  const owner = grant && await c.env.DB.prepare(`SELECT ${USER_ACTIVITY_COLUMNS} FROM user_keys WHERE email = ? AND revoked = 0`)
    .bind(grant.owner_email).first<UserKeyRow>();
  if (!grant || grant.name !== name || grant.expires_at !== payload.exp || !owner || await hash(owner.bayleaf_token) !== grant.owner_token_hash)
    return { code: 'invalid_token', message: 'Inference access was revoked. Authorize again.', status: 401 };
  const scope = declaredScope(c);
  if (!scope || !grantScopes(grant).includes(scope))
    return { code: 'insufficient_scope', message: 'This app token does not permit this operation.', status: 403 };
  return { grant, owner };
}

/** Global gate: no alternate route, cookie fallback, or Campus Pass upgrade. */
export async function guardGrant(c: Context<AppEnv>, token: string): Promise<Response | null> {
  const result = await checkGrant(c, token);
  if ('code' in result) return grantError(c, result.code, result.message, result.status);
  c.set('inferenceGrant', result.grant);
  c.set('grantOwner', result.owner);
  return null;
}

/** Called on the validated body immediately before inference routing. */
export function enforceGrantModel(c: Context<AppEnv>, body: Record<string, unknown>): Response | null {
  const grant = c.get('inferenceGrant');
  if (!grant) return null;
  const model = typeof body.model === 'string' ? standardModelId(body.model) : null;
  if (!model || !storedGrantModels(grant).includes(model))
    return grantError(c, 'insufficient_scope', 'This model is not authorized by the token.', 403);
  const backend = ALT_BACKENDS.find(b => model.startsWith(b.prefix));
  if (backend && !isBackendEnabled(c.env, backend.key))
    return grantError(c, 'backend_disabled', `${backend.label} is disabled.`, 503);
  if (backend && c.req.path === '/v1/responses')
    return grantError(c, 'insufficient_scope', 'This backend supports /v1/chat/completions, not /v1/responses.', 403);
  // OpenRouter fallback/routing extensions must not override the chosen model.
  if (['models', 'route', 'plugins'].some(key => key in body))
    return grantError(c, 'insufficient_scope', 'Model fallbacks, routing overrides, and provider plugins are unavailable with temporary inference tokens.', 403);
  return null;
}

export async function cleanupGrants(env: Bindings) {
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM inference_grants WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM grant_transactions WHERE expires_at <= ?').bind(now),
  ]);
}
