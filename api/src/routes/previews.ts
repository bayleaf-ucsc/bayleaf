/** Public/private transient preview gateway. See PREVIEWS.md for protocol and limits. */
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Bindings } from '../types';
import { getSession } from '../utils/session';
import { PreviewRegistrationSchema, PreviewRegistrationResponseSchema, PreviewLabelSchema } from '../schemas';
import { upstreamCookies, wrapApplicationCookies } from '../previewCookies';

interface Deployment {
  id: string;
  email_domain: string;
  upstream_suffixes: string[];
  upstream_headers: Record<string, string>;
}
interface Registration {
  hostname: string;
  deployment: string;
  slot: string;
  generation: string;
  upstream_encrypted: string;
  expires_at: number;
  email: string;
  access: 'public' | 'private';
}
interface Flow {
  id: string;
  hostname: string;
  generation: string;
  verifier_hash: string;
  broker_hash: string | null;
  stage: string;
  code_hash: string | null;
  expires_at: number;
}

const PREFIX = '/__preview/';
const TRANSACTION = '__Host-bl-preview-transaction';
const BROKER = '__Host-bl-preview-broker';
const SESSION = '__Host-bl-preview-session';
const RETURN_TO = '__Host-bl-preview-return';
const COOKIE_OPTIONS = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' as const };
const now = () => Math.floor(Date.now() / 1000);
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const hash = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));

function secureHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "frame-ancestors 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'",
  });
}
function failure(status = 403): Response {
  return new Response('Preview unavailable or access denied.', { status, headers: secureHeaders() });
}
function configured(env: Bindings): boolean {
  try {
    const api = new URL(env.PREVIEWS_API_ORIGIN!);
    return env.PREVIEWS_ENABLED === 'true' && api.protocol === 'https:' &&
      api.origin === env.PREVIEWS_API_ORIGIN && !!env.PREVIEWS_DOMAIN &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(env.PREVIEWS_DOMAIN) &&
      !api.hostname.endsWith(`.${env.PREVIEWS_DOMAIN}`) &&
      api.hostname !== env.PREVIEWS_DOMAIN && atob(env.PREVIEWS_SECRET!).length === 32;
  } catch { return false; }
}

async function deployment(c: Context<AppEnv>): Promise<Deployment | null> {
  const expected = c.env.PREVIEWS_INSTALLATION_KEY;
  const authorization = c.req.header('Authorization') ?? '';
  if (!expected || !/^[A-Za-z0-9_-]{32,256}$/.test(expected) ||
      !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)) return null;
  // Compare fixed-size digests using Workers' constant-time primitive. The
  // secret's value never appears in database rows, URLs, errors, or logs.
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(authorization.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  if (!crypto.subtle.timingSafeEqual(actualHash, expectedHash)) return null;
  return { ...apiPolicy(c.env), id: 'lathe' };
}

// Exact HTTPS origin URLs only: no path-based or query-based bearer protocol in
// this POC. Allowed suffixes are operator-controlled shared-hosting domains.
function upstreamAllowed(raw: string, policy: Deployment): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      u.pathname === '/' && !u.search && !u.hash &&
      policy.upstream_suffixes.some(s => /^\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(s) &&
        u.hostname.endsWith(s) && /^[a-z0-9-]+$/.test(u.hostname.slice(0, -s.length)));
  } catch { return false; }
}

async function cryptKey(env: Bindings): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(env.PREVIEWS_SECRET!), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(env: Bindings, url: string, hostname: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(hostname) }, await cryptKey(env), new TextEncoder().encode(url));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(ciphertext)));
}
async function decrypt(env: Bindings, r: Registration): Promise<string> {
  const bytes = Uint8Array.from(atob(r.upstream_encrypted), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12),
    additionalData: new TextEncoder().encode(r.hostname) }, await cryptKey(env), bytes.slice(12)));
}
async function registration(env: Bindings, hostname: string): Promise<Registration | null> {
  const row = await env.DB.prepare('SELECT * FROM preview_registrations WHERE hostname=? AND expires_at>?')
    .bind(hostname, now()).first<Registration>();
  return row && ['public', 'private'].includes(row.access) ? row : null;
}

async function previewSession(request: Request, env: Bindings, r: Registration): Promise<number | null> {
  const cookies = (request.headers.get('Cookie') ?? '').split(';').map(c => c.trim())
    .filter(c => c.startsWith(`${SESSION}=`));
  if (cookies.length !== 1) return null;
  try {
    const payload = await verify(cookies[0].slice(SESSION.length + 1), env.PREVIEWS_SECRET!, 'HS256');
    return payload.aud === new URL(request.url).origin && payload.generation === r.generation &&
      typeof payload.exp === 'number' && payload.exp <= r.expires_at ? payload.exp : null;
  } catch { return null; }
}

async function syncConnections(env: Bindings, hostname: string): Promise<boolean> {
  const stub = env.PREVIEW_CONNECTIONS.get(env.PREVIEW_CONNECTIONS.idFromName(hostname));
  const response = await stub.fetch(`https://${hostname}${PREFIX}internal-sync`, { method: 'POST' });
  return response.ok;
}

async function invalidateRetiredOrigins(env: Bindings, email?: string, slot?: string): Promise<boolean> {
  const query = email === undefined
    ? env.DB.prepare('SELECT hostname FROM preview_invalidations LIMIT 100')
    : env.DB.prepare('SELECT hostname FROM preview_invalidations WHERE email=? AND slot=?').bind(email, slot);
  const rows = await query.all<{ hostname: string }>();
  for (const row of rows.results) {
    if (!await syncConnections(env, row.hostname)) return false;
    await env.DB.prepare('DELETE FROM preview_invalidations WHERE hostname=?').bind(row.hostname).run();
  }
  return true;
}
async function flow(env: Bindings, id: string): Promise<Flow | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  return env.DB.prepare('SELECT * FROM preview_flows WHERE id=? AND expires_at>?')
    .bind(id, now()).first<Flow>();
}

export const previewRoutes = new OpenAPIHono<AppEnv>();
previewRoutes.onError(() => failure(503) as any); // Never log credential-bearing fetch errors.
previewRoutes.use('*', async (c, next) => {
  for (const [key, value] of secureHeaders()) c.header(key, value);
  if (!configured(c.env) || new URL(c.req.url).origin !== c.env.PREVIEWS_API_ORIGIN) return failure(503);
  await next();
});

// Authenticate before parsing/validating registration bodies, including when
// malformed input would otherwise be echoed by schema validation.
previewRoutes.use('/registrations*', async (c, next) => {
  if (!await deployment(c)) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.body('Unauthorized', 401);
  }
  await next();
});
previewRoutes.use('/registrations', bodyLimit({ maxSize: 8192, onError: () => failure(413) }));

const registerRoute = createRoute({
  method: 'post', path: '/registrations', tags: ['Previews'],
  security: [{ PreviewDeployment: [] }],
  request: { body: { required: true, content: { 'application/json': { schema: PreviewRegistrationSchema } } } },
  responses: {
    200: { description: 'Policy-enforced preview registration', content: {
      'application/json': { schema: PreviewRegistrationResponseSchema },
    } },
    403: { description: 'Deployment, owner, destination, or access policy rejected' },
    401: { description: 'Missing or invalid installation credential' },
    409: { description: 'Owner mapping conflict or active-preview limit reached' },
    413: { description: 'Registration exceeds 8 KiB' },
    503: { description: 'Preview service disabled or unavailable' },
  },
});
previewRoutes.openapi(registerRoute, async (c) => {
  const policy = await deployment(c);
  if (!policy) {
    c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
    return c.body('Unauthorized', 401) as any;
  }
  const input = c.req.valid('json');
  const wrapped = await registerPreview(c.env, policy, input);
  return wrapped instanceof Response ? wrapped as any : c.json(wrapped, 200);
});

interface PreviewInput {
  owner: { subject: string; email: string };
  upstream_url: string;
  access: 'public' | 'private';
  tag?: string;
}

/** Shared registration path: issuer authority differs, canonical ownership does not. */
async function registerPreview(env: Bindings, policy: Deployment, input: PreviewInput, stableSlot?: string) {
  if (!configured(env)) return failure(503);
  const email = input.owner.email.toLowerCase();
  // The campus email namespace already supplies the public username. Preserve
  // it exactly rather than inventing aliases by stripping punctuation or hashing.
  const slug = email.split('@')[0];
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) ||
      slug.length + 1 + input.access.length + 1 + 24 > 63) return failure();
  if (email.split('@')[1] !== policy.email_domain || !upstreamAllowed(input.upstream_url, policy)) return failure();
  // Registration retention is independent of sandbox or upstream-token lifetime.
  // An unavailable upstream does not delete the mapping.
  const expiry = now() + 24 * 3600;
  await env.DB.prepare('INSERT OR IGNORE INTO preview_owners (email,slug) VALUES (?,?)').bind(email, slug).run();
  const owner = await env.DB.prepare('SELECT email,slug FROM preview_owners WHERE email=?')
    .bind(email).first<{ email: string; slug: string }>();
  if (!owner || owner.slug !== slug) return failure(409);
  if (policy.id !== '__api') {
    await env.DB.prepare('INSERT OR IGNORE INTO preview_identities (deployment,subject,email) VALUES (?,?,?)')
      .bind(policy.id, input.owner.subject, email).run();
    const identity = await env.DB.prepare('SELECT email FROM preview_identities WHERE deployment=? AND subject=?')
      .bind(policy.id, input.owner.subject).first<{ email: string }>();
    if (identity?.email !== email) return failure(409);
  }
  // Keep ownership and access policy legible when a URL leaves its initiating
  // conversation: this explains group-access denial and makes public exposure
  // visible. The 96-bit nonce still supplies fresh-origin isolation for service
  // workers and browser state; none of the hostname text is an access credential.
  const hostname = `${owner.slug}-${input.access}-${random().slice(0, 24)}.${env.PREVIEWS_DOMAIN}`;
  // Lathe v2 intentionally supplies no stable slot. Its previews are independent
  // leases; BayLeaf's keyed API keeps port-based replacement via stableSlot.
  const slot = stableSlot ?? `lathe-${random()}`;
  const encrypted = await encrypt(env, new URL(input.upstream_url).origin, hostname);
  const result = await env.DB.prepare(`INSERT INTO preview_registrations
    (hostname,email,deployment,slot,generation,upstream_encrypted,expires_at,access)
    SELECT ?,?,?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM preview_registrations WHERE email=? AND expires_at>?) < 16
      OR EXISTS (SELECT 1 FROM preview_registrations WHERE email=? AND slot=? AND expires_at>?)
    ON CONFLICT(email,slot) DO UPDATE SET hostname=excluded.hostname, generation=excluded.generation,
      upstream_encrypted=excluded.upstream_encrypted, expires_at=excluded.expires_at,
      deployment=excluded.deployment, access=excluded.access
    WHERE email=excluded.email
    RETURNING hostname`).bind(hostname, email, policy.id, slot, random(), encrypted, expiry, input.access,
      email, now(), email, slot, now()).first();
  if (!result) return failure(409);
  if (!await invalidateRetiredOrigins(env, email, slot)) return failure(503);
  return { url: `https://${hostname}/`, expires_at: new Date(expiry * 1000).toISOString() };
}

function apiPolicy(env: Bindings): Deployment {
  return { id: '__api', email_domain: env.ALLOWED_EMAIL_DOMAIN,
    upstream_suffixes: (env.PREVIEWS_UPSTREAM_SUFFIXES ?? '').split(',').map(s => s.trim()),
    upstream_headers: { 'X-Daytona-Skip-Preview-Warning': 'true' } };
}

export async function registerUserPreview(env: Bindings, email: string, slot: string, url: string) {
  return registerPreview(env, apiPolicy(env), {
    owner: { subject: email, email }, upstream_url: url, access: 'private',
  }, slot);
}

export function previewsEnabled(env: Bindings): boolean { return configured(env); }

export async function revokeUserPreview(env: Bindings, email: string, slot: string): Promise<boolean> {
  await env.DB.prepare('DELETE FROM preview_registrations WHERE email=? AND slot=?')
    .bind(email.toLowerCase(), slot).run();
  // Repeat invalidation on idempotent retries, even when the D1 delete already
  // succeeded but the preceding connection-manager call failed.
  return invalidateRetiredOrigins(env, email.toLowerCase(), slot);
}

previewRoutes.openapi(createRoute({
  method: 'delete', path: '/registrations/{label}', tags: ['Previews'],
  summary: 'Revoke a registration last written by this installation',
  security: [{ PreviewDeployment: [] }], request: { params: PreviewLabelSchema },
  responses: { 204: { description: 'Revoked, or no matching installation-owned registration' },
    401: { description: 'Missing or invalid installation credential' },
    403: { description: 'Installation rejected' }, 503: { description: 'Preview service unavailable' } },
}), async (c) => {
  const policy = await deployment(c);
  const { label } = c.req.valid('param');
  if (!policy) return failure() as any;
  const hostname = `${label}.${c.env.PREVIEWS_DOMAIN}`;
  await c.env.DB.prepare('DELETE FROM preview_registrations WHERE hostname=? AND deployment=?')
    .bind(hostname, policy.id).run();
  if (!await syncConnections(c.env, hostname)) return failure(503) as any;
  await c.env.DB.prepare('DELETE FROM preview_invalidations WHERE hostname=?').bind(hostname).run();
  return c.body(null, 204);
});

previewRoutes.get('/authorize', async (c) => {
  const f = await flow(c.env, c.req.query('flow') ?? '');
  if (!f) return failure();
  const r = await registration(c.env, f.hostname);
  if (!r || r.generation !== f.generation) return failure();
  if (f.stage === 'started') {
    const broker = random();
    const updated = await c.env.DB.prepare(`UPDATE preview_flows SET broker_hash=?,stage='bound'
      WHERE id=? AND stage='started' RETURNING id`).bind(await hash(broker), f.id).first();
    if (!updated) return failure();
    setCookie(c, BROKER, broker, { ...COOKIE_OPTIONS, maxAge: 300 });
    return c.redirect(`https://${r.hostname}${PREFIX}prove?flow=${f.id}`, 302);
  }
  if (f.stage !== 'proved' || await hash(getCookie(c, BROKER) ?? '') !== f.broker_hash) return failure();
  const session = await getSession(c);
  if (!session) {
    setCookie(c, RETURN_TO, f.id, { ...COOKIE_OPTIONS, maxAge: 300 });
    return c.redirect('/login', 302);
  }
  if (session.email.toLowerCase() !== r.email) return failure();
  const code = random();
  const issued = await c.env.DB.prepare(`UPDATE preview_flows SET stage='issued',code_hash=?,expires_at=?
    WHERE id=? AND stage='proved' AND expires_at>? RETURNING id`)
    .bind(await hash(code), Math.min(f.expires_at, now() + 60), f.id, now()).first();
  if (!issued) return failure();
  deleteCookie(c, BROKER, COOKIE_OPTIONS);
  return c.redirect(`https://${r.hostname}${PREFIX}callback?flow=${f.id}&code=${code}`, 302);
});

export function consumePreviewReturnTo(c: Context<AppEnv>): string | null {
  const id = getCookie(c, RETURN_TO);
  if (!id) return null;
  deleteCookie(c, RETURN_TO, COOKIE_OPTIONS);
  return /^[a-f0-9]{64}$/.test(id) ? `/previews/authorize?flow=${id}` : null;
}

/** Host dispatch is before all API routes, wildcard CORS, and error logging. */
export async function handlePreviewHost(c: Context<AppEnv>): Promise<Response> {
  try {
    if (!configured(c.env)) return failure(503);
    const u = new URL(c.req.url);
    if (u.protocol !== 'https:' || u.port) return failure();
    const r = await registration(c.env, u.hostname);
    if (!r) return failure(404);
    const origin = c.req.header('Origin');
    const site = c.req.header('Sec-Fetch-Site');
    const navigation = c.req.method === 'GET' && c.req.header('Sec-Fetch-Mode') === 'navigate' &&
      c.req.header('Sec-Fetch-Dest') === 'document';
    if ((origin && origin !== u.origin) ||
        (site && !['none', 'same-origin'].includes(site) && !navigation) ||
        (!['GET', 'HEAD'].includes(c.req.method) && origin !== u.origin)) return failure();
    const upgrade = c.req.header('Upgrade');
    if (upgrade && (upgrade.toLowerCase() !== 'websocket' || origin !== u.origin || c.req.method !== 'GET')) return failure();
    const serviceWorker = !!c.req.header('Service-Worker') || c.req.header('Sec-Fetch-Dest') === 'serviceworker';
    // Legacy stable registrations cannot acquire persistent interceptors.
    if (serviceWorker && !/-[a-f0-9]{24}$/.test(u.hostname.split('.')[0])) return failure();

    // Encoded aliases of the reserved namespace must never reach applications.
    const decodedPath = decodeURIComponent(u.pathname).replace(/\\/g, '/');
    if (decodedPath.startsWith('/__preview') && !u.pathname.startsWith(PREFIX)) return failure(404);

    if (u.pathname.startsWith(PREFIX)) {
      if (r.access === 'public') return failure(404);
      if (c.req.method !== 'GET' || upgrade || serviceWorker) return failure();
      for (const [key, value] of secureHeaders()) c.header(key, value);
      if (u.pathname === `${PREFIX}start`) {
        const id = random();
        const verifier = random();
        // Bound pending state per hostname as well as its lifetime.
        const inserted = await c.env.DB.prepare(`INSERT INTO preview_flows
          (id,hostname,generation,verifier_hash,stage,expires_at)
          SELECT ?,?,?,?,'started',? WHERE
          (SELECT COUNT(*) FROM preview_flows WHERE hostname=? AND expires_at>?) < 64 RETURNING id`)
          .bind(id, r.hostname, r.generation, await hash(verifier), Math.min(now() + 300, r.expires_at), r.hostname, now()).first();
        if (!inserted) return failure(429);
        setCookie(c, TRANSACTION, verifier, { ...COOKIE_OPTIONS, maxAge: 300 });
        return c.redirect(`${c.env.PREVIEWS_API_ORIGIN}/previews/authorize?flow=${id}`, 302);
      }
      const f = await flow(c.env, u.searchParams.get('flow') ?? '');
      if (!f || f.hostname !== r.hostname || f.generation !== r.generation ||
          await hash(getCookie(c, TRANSACTION) ?? '') !== f.verifier_hash) return failure();
      if (u.pathname === `${PREFIX}prove`) {
        const proved = await c.env.DB.prepare(`UPDATE preview_flows SET stage='proved'
          WHERE id=? AND stage='bound' AND expires_at>? RETURNING id`).bind(f.id, now()).first();
        if (!proved) return failure();
        return c.redirect(`${c.env.PREVIEWS_API_ORIGIN}/previews/authorize?flow=${f.id}`, 302);
      }
      if (u.pathname === `${PREFIX}callback`) {
        const consumed = await c.env.DB.prepare(`DELETE FROM preview_flows
          WHERE id=? AND hostname=? AND generation=? AND verifier_hash=? AND code_hash=?
          AND stage='issued' AND expires_at>? RETURNING id`).bind(f.id, r.hostname, r.generation,
            f.verifier_hash, await hash(u.searchParams.get('code') ?? ''), now()).first();
        if (!consumed) return failure();
        // A multi-hour interactive session must not require periodic re-login.
        // Registration replacement/revocation still invalidates this generation.
        const exp = r.expires_at;
        const token = await sign({ aud: u.origin, generation: r.generation, exp }, c.env.PREVIEWS_SECRET!);
        setCookie(c, SESSION, token, { ...COOKIE_OPTIONS, maxAge: exp - now() });
        for (const part of (c.req.header('Cookie') ?? '').split(';')) {
          const name = part.split('=')[0].trim();
          if (name.startsWith('__Host-bl-app-') && !name.startsWith(`__Host-bl-app-${r.generation}-`) &&
              /^[A-Za-z0-9_-]+$/.test(name)) deleteCookie(c, name, COOKIE_OPTIONS);
        }
        deleteCookie(c, TRANSACTION, COOKIE_OPTIONS);
        return c.redirect('/', 302);
      }
      return failure(404);
    }

    const authenticated = r.access === 'private' ? await previewSession(c.req.raw, c.env, r) : r.expires_at;
    if (r.access === 'private' && !authenticated) {
      if (navigation && !upgrade) return new Response(null, { status: 302,
        headers: new Headers([...secureHeaders(), ['Location', `${PREFIX}start`]]) });
      return failure(401);
    }
    // Modern browser Fetch Metadata or an exact Origin is required. A browser
    // omitting both cannot silently bypass sibling-origin request checks.
    if (r.access === 'private' && !site && origin !== u.origin) return failure();
    if (upgrade) {
      const stub = c.env.PREVIEW_CONNECTIONS.get(c.env.PREVIEW_CONNECTIONS.idFromName(u.hostname));
      return await stub.fetch(c.req.raw);
    }
    return await forward(c, r);
  } catch { return failure(502); }
}

async function upstreamRequest(request: Request, env: Bindings, r: Registration) {
  const base = await decrypt(env, r);
  const policy = ['__api', 'lathe'].includes(r.deployment) ? apiPolicy(env) : null;
  if (!policy || !upstreamAllowed(base, policy)) return null;
  const incoming = new URL(request.url);
  const target = new URL(base);
  // Assign components, never resolve an untrusted path such as //evil.example.
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers();
  for (const key of ['Accept', 'Accept-Language', 'Content-Type', 'Range', 'If-Range',
    'Origin', 'User-Agent', 'X-Requested-With', 'X-CSRF-Token', 'X-XSRF-Token', 'Service-Worker']) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set('X-Forwarded-Host', incoming.host);
  headers.set('X-Forwarded-Proto', 'https');
  const cookies = upstreamCookies(request.headers.get('Cookie') ?? '', r.generation, incoming.pathname);
  if (cookies) headers.set('Cookie', cookies);
  for (const [key, value] of Object.entries(policy.upstream_headers)) headers.set(key, value);
  return { target, headers, incoming };
}

async function forward(c: Context<AppEnv>, r: Registration): Promise<Response> {
  const prepared = await upstreamRequest(c.req.raw, c.env, r);
  if (!prepared) return failure();
  const { target, headers, incoming } = prepared;
  const upstream = await fetch(target, { method: c.req.method, headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    redirect: 'manual', signal: AbortSignal.timeout(Math.min(300_000, Math.max(1, (r.expires_at - now()) * 1000))),
  });
  const responseHeaders = secureHeaders();
  // Root-scoped workers (including code-server's) are confined to this unique
  // origin. Scope is never broadened across an origin boundary by this header.
  const workerScope = upstream.headers.get('Service-Worker-Allowed');
  if ((c.req.header('Service-Worker') || c.req.header('Sec-Fetch-Dest') === 'serviceworker') &&
      workerScope?.startsWith('/') && !workerScope.startsWith('//') && !workerScope.includes('\\') &&
      !workerScope.includes(target.hostname)) responseHeaders.set('Service-Worker-Allowed', workerScope);
  wrapApplicationCookies(upstream.headers, responseHeaders, r.generation, incoming.pathname, r.expires_at, target.hostname);
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('Location');
    await upstream.body?.cancel();
    if (!location) return failure(502);
    const redirect = new URL(location, target);
    if (![target.origin, incoming.origin].includes(redirect.origin) || redirect.username || redirect.password ||
        decodeURIComponent(redirect.pathname).replace(/\\/g, '/').startsWith('/__preview') || redirect.pathname.includes(target.hostname) ||
        redirect.search.includes(target.hostname) || redirect.hash.includes(target.hostname)) return failure(502);
    redirect.host = incoming.host;
    responseHeaders.set('Location', redirect.href);
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return failure(502);
  }
  for (const key of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Encoding', 'Content-Disposition']) {
    const value = upstream.headers.get(key);
    if (value && !value.includes(target.hostname)) responseHeaders.set(key, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

interface Connection {
  downstream: WebSocket;
  upstream: WebSocket;
  generation: string;
  expiresAt: number;
}

/** One Durable Object per preview hostname owns live socket lifetimes. Only
 * metadata is persisted. Frames are relayed in memory and never logged/stored.
 * Outbound WebSockets keep this object active; no background sandbox keepalive.
 */
export class PreviewConnections {
  private sockets = new Set<Connection>();
  constructor(private state: DurableObjectState, private env: Bindings) {}

  async fetch(request: Request): Promise<Response> {
    try {
      // Serialize connection establishment and invalidation, so replacement
      // cannot finish while an old-generation handshake is still being added.
      return await this.state.blockConcurrencyWhile(async () => {
        const u = new URL(request.url);
        if (!this.state.id.equals(this.env.PREVIEW_CONNECTIONS.idFromName(u.hostname))) return failure();
        if (request.method === 'POST' && u.pathname === `${PREFIX}internal-sync`) {
          await this.sweep(u.hostname);
          return new Response(null, { status: 204 });
        }
        const r = await registration(this.env, u.hostname);
        if (!configured(this.env) || !r || request.method !== 'GET' ||
            request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
            request.headers.get('Origin') !== u.origin) return failure();
        const sessionExpiry = r.access === 'private'
          ? await previewSession(request, this.env, r)
          : r.expires_at;
        if (!sessionExpiry) return failure();
        if (this.sockets.size >= 16) return failure(429);
        const prepared = await upstreamRequest(request, this.env, r);
        if (!prepared) return failure();
        prepared.headers.set('Upgrade', 'websocket');
        const offered = request.headers.get('Sec-WebSocket-Protocol');
        if (offered) prepared.headers.set('Sec-WebSocket-Protocol', offered);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        let upstreamResponse: Response;
        try {
          upstreamResponse = await fetch(prepared.target, { headers: prepared.headers,
            redirect: 'manual', signal: controller.signal });
        } finally {
          // The deadline bounds establishment, not the lifetime of the socket.
          clearTimeout(timeout);
        }
        const upstream = upstreamResponse.webSocket;
        if (upstreamResponse.status !== 101 || !upstream) {
          await upstreamResponse.body?.cancel();
          return failure(502);
        }
        upstream.accept();
        const current = await registration(this.env, u.hostname);
        if (!current || current.generation !== r.generation) {
          upstream.close(1008, 'Preview registration changed');
          return failure();
        }
        const protocol = upstreamResponse.headers.get('Sec-WebSocket-Protocol');
        if (protocol && (!offered?.split(',').map(p => p.trim()).includes(protocol) || protocol.includes(prepared.target.hostname))) {
          upstream.close(1008, 'Invalid upstream protocol');
          return failure(502);
        }
        const pair = new WebSocketPair();
        pair[1].accept();
        const connection = { downstream: pair[1], upstream, generation: r.generation, expiresAt: Math.min(r.expires_at, sessionExpiry) };
        this.sockets.add(connection);
        const relay = (destination: WebSocket, event: MessageEvent) => {
          if (!this.sockets.has(connection)) return;
          if (now() >= connection.expiresAt) { this.close(connection); return; }
          const size = typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : event.data.byteLength;
          if (size > 4 * 1024 * 1024) { this.close(connection, 1009); return; }
          try { destination.send(event.data); } catch { this.close(connection); }
        };
        pair[1].addEventListener('message', event => relay(upstream, event));
        upstream.addEventListener('message', event => relay(pair[1], event));
        for (const socket of [pair[1], upstream]) {
          socket.addEventListener('close', () => this.close(connection, 1000));
          socket.addEventListener('error', () => this.close(connection));
        }
        await this.state.storage.put('hostname', u.hostname);
        await this.arm();
        const responseHeaders = new Headers();
        if (protocol) responseHeaders.set('Sec-WebSocket-Protocol', protocol);
        wrapApplicationCookies(upstreamResponse.headers, responseHeaders, r.generation, u.pathname, r.expires_at, prepared.target.hostname);
        return new Response(null, { status: 101, webSocket: pair[0], headers: responseHeaders });
      });
    } catch { return failure(502); }
  }

  private close(connection: Connection, code = 1008): void {
    if (!this.sockets.delete(connection)) return;
    for (const socket of [connection.downstream, connection.upstream]) {
      try { socket.close(code, code === 1000 ? 'Connection closed' : 'Preview access ended'); } catch { /* Already closed. */ }
    }
  }

  private async arm(): Promise<void> {
    if (!this.sockets.size) {
      await this.state.storage.deleteAll();
      await this.state.storage.deleteAlarm();
      return;
    }
    const next = Math.min(Date.now() + 30_000, ...[...this.sockets].map(c => c.expiresAt * 1000));
    await this.state.storage.setAlarm(Math.max(Date.now() + 1, next));
  }

  private async sweep(hostname: string): Promise<void> {
    const current = configured(this.env) ? await registration(this.env, hostname) : null;
    for (const socket of this.sockets) {
      if (!current || socket.generation !== current.generation || now() >= socket.expiresAt) this.close(socket);
    }
    await this.arm();
  }

  async alarm(): Promise<void> {
    const hostname = await this.state.storage.get<string>('hostname');
    if (!hostname) return;
    try { await this.sweep(hostname); }
    catch {
      // Fail closed if authorization storage becomes unavailable.
      for (const socket of this.sockets) this.close(socket);
      await this.arm();
    }
  }
}

export async function cleanupPreviews(env: Bindings): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM preview_flows WHERE expires_at<=?').bind(now()),
    env.DB.prepare('DELETE FROM preview_registrations WHERE expires_at<=?').bind(now()),
  ]);
  await invalidateRetiredOrigins(env);
}
