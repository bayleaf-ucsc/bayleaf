import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { getSession } from '../utils/session';
import { resolveAuth } from '../utils/auth';
import { getActiveRow } from '../provision';
import { browserEnabled } from '../sandboxBrowser';
import { BrowserSandboxStatusSchema, BrowserSandboxErrorSchema } from '../schemas';

export const sandboxBrowserRoutes = new OpenAPIHono<AppEnv>();
sandboxBrowserRoutes.onError((_error, c) => c.json({ error: 'lifecycle_unavailable' }, 503));
async function handle(c: Context<AppEnv>) {
  c.header('Cache-Control', 'no-store');
  if (!browserEnabled(c.env)) return c.json({ error: 'browser_disabled' }, 503);
  const path = c.req.path.replace(/^\/sandbox\/browser/, '') || '/status';
  if (!((c.req.method === 'GET' && path === '/status') ||
        (c.req.method === 'POST' && ['/start', '/restart'].includes(path)))) {
    return c.json({ error: 'not_found' }, 404);
  }
  let email: string;
  if (c.req.header('Authorization')) {
    const auth = await resolveAuth(c);
    if (auth instanceof Response) return auth;
    if (auth.isCampusMode || !auth.userEmail) return c.json({ error: 'personal_key_required' }, 403);
    email = auth.userEmail;
  } else {
    const session = await getSession(c);
    if (!session) return c.json({ error: 'login_required' }, 401);
    // Exact Origin + JSON/custom header prevents cross-site form POSTs. No CORS credentials.
    if (c.req.method !== 'GET' && (c.req.header('Origin') !== new URL(c.req.url).origin ||
        c.req.header('X-BayLeaf-Action') !== 'sandbox-browser')) return c.json({ error: 'invalid_origin' }, 403);
    email = session.email;
  }
  if (!await getActiveRow(email, c.env)) return c.json({ error: 'personal_key_required' }, 403);
  const stub = c.env.SANDBOX_BROWSER.get(c.env.SANDBOX_BROWSER.idFromName(email));
  // Neither caller bodies nor caller-supplied ownership headers cross this boundary.
  return stub.fetch(`https://controller${path}`, { method: c.req.method, headers: { 'X-BayLeaf-Owner': email } });
}

const responses = {
  200: { description: 'Current browser setup and link metadata', content: { 'application/json': { schema: BrowserSandboxStatusSchema } } },
  202: { description: 'Setup accepted; poll status without waking compute', content: { 'application/json': { schema: BrowserSandboxStatusSchema } } },
  401: { description: 'Owner authentication required', content: { 'application/json': { schema: BrowserSandboxErrorSchema } } },
  403: { description: 'Personal key or same-origin browser action required', content: { 'application/json': { schema: BrowserSandboxErrorSchema } } },
  503: { description: 'Disabled or unavailable', content: { 'application/json': { schema: BrowserSandboxErrorSchema } } },
};
sandboxBrowserRoutes.openapi(createRoute({ method: 'get', path: '/status', tags: ['Sandbox'],
  operationId: 'browserSandboxStatus', security: [{ Bearer: [] }],
  summary: 'Observe browser setup and link expiry without waking the sandbox', responses }), handle as any);
for (const action of ['start', 'restart'] as const) {
  sandboxBrowserRoutes.openapi(createRoute({ method: 'post', path: `/${action}`, tags: ['Sandbox'],
    operationId: `browserSandbox_${action}`, security: [{ Bearer: [] }],
    summary: `${action}: owner-directed browser setup`,
    description: 'Ordinary owner key only (no Campus Pass or temporary inference token). Browser logins additionally require an exact Origin and X-BayLeaf-Action: sandbox-browser. Start sets up or resumes browser access, reusing an existing ready link. Restart repairs the managed interface. New private links last up to 24 hours; link expiry does not stop applications. Files and the shared sandbox are preserved.',
    responses }), handle as any);
}
