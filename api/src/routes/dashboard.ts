/**
 * Dashboard Route Handlers
 * Browser-facing HTML routes — hidden from OpenAPI docs.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv, UserKeyRow, OpenRouterKey } from '../types';
import { getSession } from '../utils/session';
import { isCampusPassEligible } from '../utils/ip';
import { getKeyName, findKeyByHash, createKey } from '../openrouter';
import { findSandboxByLabel, getSandboxInfo, type SandboxInfo } from '../daytona';
import { landingPage } from '../templates/landing';
import { dashboardPage } from '../templates/dashboard';

export const dashboardRoutes = new OpenAPIHono<AppEnv>();

/** GET / - Landing page (redirects to dashboard if logged in) */
dashboardRoutes.get('/', async (c) => {
  const session = await getSession(c);
  if (session) return c.redirect('/dashboard');
  return c.html(landingPage(isCampusPassEligible(c.req.raw, c.env), c.env.RECOMMENDED_MODEL));
});

/** GET /dashboard - Main user interface */
dashboardRoutes.get('/dashboard', async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect('/login');

  // Look up the user's proxy key mapping in D1
  const row = await c.env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 0',
  ).bind(session.email).first<UserKeyRow>();

  let orKey: OpenRouterKey | null = null;

  if (row) {
    // Validate the OR key is still alive
    orKey = await findKeyByHash(row.or_key_hash, c.env);

    if (!orKey || orKey.disabled) {
      // Self-heal: provision a new OR key, keep the same bayleaf token
      const keyName = getKeyName(session.email, c.env.KEY_NAME_TEMPLATE);
      const newOrKey = await createKey(keyName, c.env);
      if (newOrKey?.key) {
        await c.env.DB.prepare(
          'UPDATE user_keys SET or_key_hash = ?, or_key_secret = ? WHERE email = ?',
        ).bind(newOrKey.hash, newOrKey.key, session.email).run();
        orKey = newOrKey;
      }
    }
  }

  // Fetch sandbox status (non-blocking — don't fail the page if this errors).
  let sandboxInfo: SandboxInfo | null = null;
  if (row && c.env.DAYTONA_API_KEY) {
    try {
      if (row.daytona_sandbox_id) {
        try {
          sandboxInfo = await getSandboxInfo(row.daytona_sandbox_id, c.env);
        } catch {
          sandboxInfo = await findSandboxByLabel(session.email, c.env);
          await c.env.DB.prepare(
            'UPDATE user_keys SET daytona_sandbox_id = ? WHERE email = ? AND revoked = 0',
          ).bind(sandboxInfo?.id ?? null, session.email).run();
        }
      } else {
        sandboxInfo = await findSandboxByLabel(session.email, c.env);
        if (sandboxInfo) {
          await c.env.DB.prepare(
            'UPDATE user_keys SET daytona_sandbox_id = ? WHERE email = ? AND revoked = 0',
          ).bind(sandboxInfo.id, session.email).run();
        }
      }
    } catch (e) {
      console.error('Failed to fetch sandbox status:', e);
    }
  }

  return c.html(dashboardPage(session, row, orKey, c.env.RECOMMENDED_MODEL, sandboxInfo));
});
