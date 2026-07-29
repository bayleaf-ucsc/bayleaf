/**
 * Key Management Route Handlers
 *
 * Issues opaque proxy keys (sk-bayleaf-...) backed by persistent OR keys.
 * The real OR key never reaches the client.
 *
 * These two routes back the dashboard's "Create API Key" and "Revoke" buttons
 * and nothing else. They are intentionally NOT registered in the OpenAPI spec —
 * agents should not be programming against them. The canonical agent-facing
 * budget endpoint is `/v1/auth/key`, which works with bearer tokens and reports
 * every backend; the dashboard reads usage server-side in routes/dashboard.tsx.
 * (A `GET /key` used to exist as a third way to read usage. It had no caller and
 * was strictly worse than `/v1/auth/key`, so it's gone.)
 *
 * The OR key lifecycle itself lives in `../provision` — see that module for
 * the self-heal and revoked-row-reuse rules these handlers rely on.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { getSession } from '../utils/session';
import { getActiveRow, provisionToken } from '../provision';

export const keyRoutes = new OpenAPIHono<AppEnv>();

/** Session-required middleware for all /key routes */
keyRoutes.use('/key', async (c, next) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  c.set('session', session);
  await next();
});

// ── POST /key — Provision a new key (called by dashboard) ─────────

keyRoutes.post('/key', async (c) => {
  const session = c.get('session');

  if (await getActiveRow(session.email, c.env)) {
    return c.json({ error: { message: 'Key already exists', code: 409 } }, 409);
  }

  const row = await provisionToken(session.email, c.env);
  if (!row) {
    return c.json({ error: { message: 'Failed to create key', code: 500 } }, 500);
  }

  return c.json({ success: true as const, key: row.bayleaf_token }, 200);
});

// ── DELETE /key — Revoke a key (called by dashboard) ──────────────

keyRoutes.delete('/key', async (c) => {
  const session = c.get('session');

  if (!(await getActiveRow(session.email, c.env))) {
    return c.json({ error: { message: 'No key found', code: 404 } }, 404);
  }

  await c.env.DB.prepare(
    'UPDATE user_keys SET revoked = 1 WHERE email = ?',
  ).bind(session.email).run();

  return c.json({ success: true as const }, 200);
});
