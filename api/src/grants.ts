/** Temporary inference authority. Only metadata is persisted; inference uses
 * the owner's existing backend limits and the standard lane's provider policy. */
import type { Context } from 'hono';
import type { AppEnv, Bindings, InferenceGrant, UserKeyRow } from './types';
import { standardModelId } from './standardModels';
import { ALT_BACKENDS, isBackendEnabled } from './constants';

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

export function grantError(c: Context<AppEnv>, code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 503) {
  if (status === 401) c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
  return c.json({ error: { code, message } }, status);
}

export async function issueGrant(env: Bindings, row: UserKeyRow, apiOrigin: string, model: string, expiresAt: number,
  clientName: string | null = null, redirectUri: string | null = null) {
  const ownerHash = await hash(row.bayleaf_token);
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = crypto.randomUUID();
    const name = memorableName();
    // Database uniqueness makes this safe under concurrent issuance. Expired
    // rows awaiting cleanup also reserve their names, without a history table.
    const inserted = await env.DB.prepare(`INSERT INTO inference_grants
      (id, name, owner_email, owner_token_hash, model, expires_at, created_at, client_name, redirect_uri)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`)
      .bind(id, name, row.email, ownerHash, model, expiresAt, nowSeconds(), clientName, redirectUri).first();
    if (!inserted) continue;
    const token = GRANT_PREFIX + name + '.' + await seal(env, 'access', { id, name, exp: expiresAt });
    return { grant_id: id, name, key: token, access_token: token, token_type: 'Bearer' as const,
      model, expires_at: expiresAt, expires_in: Math.max(0, expiresAt - nowSeconds()),
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

/** Global gate: no alternate route, cookie fallback, or Campus Pass upgrade. */
export async function guardGrant(c: Context<AppEnv>, token: string): Promise<Response | null> {
  if (c.env.GRANTS_ENABLED !== 'true') return grantError(c, 'grants_disabled', 'Temporary inference access is disabled.', 503);
  const parts = token.slice(GRANT_PREFIX.length).split('.');
  const name = parts.length === 3 ? parts.shift()! : null;
  const payload = await unseal(c.env, 'access', parts.join('.'));
  if (!payload || typeof payload.id !== 'string' || typeof payload.exp !== 'number')
    return grantError(c, 'invalid_token', 'Invalid inference token.', 401);
  if ((payload.name ?? null) !== name)
    return grantError(c, 'invalid_token', 'Token name does not match its signed permission.', 401);
  // Signed expiry remains distinguishable even after its database row is deleted.
  if (payload.exp <= nowSeconds()) return grantError(c, 'token_expired', 'Authorize again to continue.', 401);
  const grant = await c.env.DB.prepare('SELECT * FROM inference_grants WHERE id = ?').bind(payload.id).first<InferenceGrant>();
  const owner = grant && await c.env.DB.prepare('SELECT * FROM user_keys WHERE email = ? AND revoked = 0')
    .bind(grant.owner_email).first<UserKeyRow>();
  if (!grant || grant.name !== name || grant.expires_at !== payload.exp || !owner || await hash(owner.bayleaf_token) !== grant.owner_token_hash)
    return grantError(c, 'invalid_token', 'Inference access was revoked. Authorize again.', 401);
  if (c.req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(c.req.path))
    return grantError(c, 'insufficient_scope', 'This token permits only plaintext inference with its specified model.', 403);
  c.set('inferenceGrant', grant);
  c.set('grantOwner', owner);
  return null;
}

/** Called on the validated body immediately before inference routing. */
export function enforceGrantModel(c: Context<AppEnv>, body: Record<string, unknown>): Response | null {
  const grant = c.get('inferenceGrant');
  if (!grant) return null;
  const model = typeof body.model === 'string' ? standardModelId(body.model) : null;
  // Older OpenRouter grants stored bare slugs. Canonicalize on read so they
  // retain exactly their existing authority during the transition.
  if (!model || model !== standardModelId(grant.model))
    return grantError(c, 'insufficient_scope', `This token permits only ${grant.model}.`, 403);
  const backend = ALT_BACKENDS.find(b => model.startsWith(b.prefix));
  if (backend && !isBackendEnabled(c.env, backend.key))
    return grantError(c, 'backend_disabled', `${backend.label} is disabled.`, 503);
  if (backend && c.req.path === '/v1/responses')
    return grantError(c, 'insufficient_scope', 'This backend supports /v1/chat/completions, not /v1/responses.', 403);
  // OpenRouter fallback/routing extensions must not override the single model.
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
