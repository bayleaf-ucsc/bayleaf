import { renderSandboxPage } from './page';

const ORIGIN = 'https://sandbox.bayleaf.dev';
const SESSION = '__Host-bayleaf-sandbox-session';
const TRANSACTION = '__Host-bayleaf-sandbox-transaction';
const AUTH_HEADERS = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const cookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
function cookies(request) {
  return new Map((request.headers.get('Cookie') || '').split(';').map(part => {
    const at = part.indexOf('=');
    return at < 0 ? ['', ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  }));
}
function redirect(location, values = []) {
  const headers = new Headers({ ...AUTH_HEADERS, Location: location });
  for (const value of values) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}
function continueLogin(location, value) {
  // End the same-origin form submission before navigating to the API broker.
  // Chromium applies form-action to redirect chains, including the external IdP.
  // A fresh document navigation preserves the narrow form-action policy.
  const target = location.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="0;url=${target}"><title>Continue sign-in · BayLeaf Sandboxes</title>
    <p><a href="${target}">Continue to UCSC sign-in</a></p></html>`, { headers: {
      ...AUTH_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': value,
    } });
}
function failure(status, error) {
  return Response.json({ error }, { status, headers: AUTH_HEADERS });
}
function loginFailure(status = 400) {
  return new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Sign-in incomplete · BayLeaf Sandboxes</title><main><h1>Sign-in could not complete</h1>
    <p>The sign-in may have expired, or your account may need attention. Please try again.</p>
    <form method="post" action="/login"><button type="submit">Sign in with UCSC</button></form>
    <p><a href="/">Return to BayLeaf Sandboxes</a></p></main></html>`,
  { status, headers: { ...AUTH_HEADERS, 'Referrer-Policy': 'strict-origin', 'Content-Type': 'text/html; charset=utf-8' } });
}
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

/** Same-origin browser adapter; API-issued sessions stay in host-only cookies.
 * The named binding has no public HTTP counterpart or caller-selected owner.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) return failure(400, 'invalid_host');
    if (request.method === 'OPTIONS') return failure(405, 'method_not_allowed');
    const jar = cookies(request);
    const session = jar.get(SESSION) || '';
    const api = env.MANAGEMENT;
    try {
      // GETs, including authenticated reloads, never wake compute. The initial
      // sign-in POST is the owner's explicit action authorizing a one-shot wake.
      if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
        const current = session ? await api.readSession({ session }) : null;
        const page = await renderSandboxPage(current?.user ?? null);
        if (session && !current) page.headers.append('Set-Cookie', cookie(SESSION, '', 0));
        return request.method === 'HEAD' ? new Response(null, page) : page;
      }
      if (url.pathname === '/login' && request.method === 'GET') return redirect('/');
      if (url.pathname === '/login' && request.method === 'POST') {
        if (request.headers.get('Origin') !== ORIGIN) return failure(403, 'invalid_origin');
        const verifier = random();
        const result = await api.beginLogin({ verifierHash: await hash(verifier) });
        if (!result) return loginFailure(503);
        return continueLogin(result.authorizeUrl, cookie(TRANSACTION, verifier, 600));
      }
      if (url.pathname === '/auth/prove' && request.method === 'GET') {
        const verifier = jar.get(TRANSACTION);
        if (!verifier) return loginFailure();
        const result = await api.proveLogin({ flow: url.searchParams.get('flow'), verifier });
        if (!result) return loginFailure();
        return redirect(result.authorizeUrl);
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        const verifier = jar.get(TRANSACTION);
        if (!verifier) return loginFailure();
        const result = await api.exchangeLogin({ flow: url.searchParams.get('flow'), code: url.searchParams.get('code'), verifier });
        if (!result) return loginFailure();
        // Login is not held hostage by a provider outage. This never creates a
        // machine, installs an app or launches a service. Failures are retryable
        // through deliberate app setup, not an automatic loop on page refresh.
        ctx.waitUntil(api.managed({ session: result.session, operation: 'wake-existing' }).catch(() => undefined));
        return redirect('/', [cookie(TRANSACTION, '', 0), cookie(SESSION, result.session,
          Math.max(0, Math.floor(result.expiresAt - Date.now() / 1000)))]);
      }
      if (url.pathname === '/logout' && request.method === 'POST') {
        if (request.headers.get('Origin') !== ORIGIN) return failure(403, 'invalid_origin');
        if (session && !await api.logout({ session })) return failure(503, 'logout_unavailable');
        return redirect('/', [cookie(SESSION, '', 0), cookie(TRANSACTION, '', 0)]);
      }
      const service = url.pathname.match(/^\/services\/([a-z][a-z0-9-]{0,39})\/(status|start|restart)$/);
      if (service) {
        const [, name, operation] = service;
        if (request.method !== (operation === 'status' ? 'GET' : 'POST')) return failure(405, 'method_not_allowed');
        if (!session) return failure(401, 'login_required');
        if (operation !== 'status' && (request.headers.get('Origin') !== ORIGIN ||
            request.headers.get('X-BayLeaf-Action') !== 'managed-service')) return failure(403, 'invalid_origin');
        const result = await api.managed({ session, service: name, operation });
        // Preserve only the JSON contract, never upstream cookies or redirects.
        return Response.json(result.body, { status: result.status, headers: AUTH_HEADERS });
      }
      return failure(404, 'not_found');
    } catch {
      // No provider payloads, session tokens, or authorization codes in logs.
      return url.pathname.startsWith('/auth/') || url.pathname === '/login'
        ? loginFailure(503) : failure(503, 'service_unavailable');
    }
  },
};
