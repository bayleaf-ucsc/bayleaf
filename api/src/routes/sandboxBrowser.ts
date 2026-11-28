import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { getSession } from '../utils/session';
import { getAccountRow } from '../sandboxCredentials';
import { browserEnabled } from '../sandboxBrowser';

// Managed-app lifecycle lives on sandbox.bayleaf.dev through the private
// SandboxManagement binding. The service-less start/restart/stop/status routes
// here drove only the retired OpenChamber app, so only access changes remain.
export const sandboxBrowserRoutes = new OpenAPIHono<AppEnv>();
sandboxBrowserRoutes.onError((_error, c) => c.json({ error: 'lifecycle_unavailable' }, 503));
async function handle(c: Context<AppEnv>) {
  c.header('Cache-Control', 'no-store');
  if (!browserEnabled(c.env)) return c.json({ error: 'browser_disabled' }, 503);
  const path = c.req.path.replace(/^\/sandbox\/browser/, '');
  // Access changes are owner-browser actions: no bearer, Campus Pass, or sandbox credential.
  if (c.req.header('Authorization')) return c.json({ error: 'browser_session_required' }, 403);
  const session = await getSession(c);
  if (!session) return c.json({ error: 'login_required' }, 401);
  // Exact Origin + JSON/custom header prevents cross-site form POSTs. No CORS credentials.
  if (c.req.header('Origin') !== new URL(c.req.url).origin ||
      c.req.header('X-BayLeaf-Action') !== 'sandbox-browser') return c.json({ error: 'invalid_origin' }, 403);
  const email = session.email;
  if (!await getAccountRow(email, c.env)) return c.json({ error: 'account_required' }, 403);
  const stub = c.env.SANDBOX_BROWSER.get(c.env.SANDBOX_BROWSER.idFromName(email));
  // Neither caller bodies nor caller-supplied ownership headers cross this boundary.
  return stub.fetch(`https://controller${path}`, { method: 'POST', headers: { 'X-BayLeaf-Owner': email } });
}

sandboxBrowserRoutes.post('/access/revoke', handle as any);
sandboxBrowserRoutes.post('/access/rotate', handle as any);
