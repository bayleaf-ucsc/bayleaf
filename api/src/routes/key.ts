/**
 * Key Management Route Handlers
 *
 * Issues opaque proxy keys (sk-bayleaf-...) backed by persistent OR keys.
 * The real OR key never reaches the client.
 *
 * These routes back the dashboard UI (provision, view, revoke a personal key
 * after browser login). They are intentionally NOT registered in the OpenAPI
 * spec — agents should not be programming against them. The canonical
 * agent-facing budget endpoint is `/v1/auth/key`, which works with bearer
 * tokens and reports every backend.
 *
 * The OR key lifecycle itself lives in `../provision` — see that module for
 * the self-heal and revoked-row-reuse rules these handlers rely on.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { getSession } from '../utils/session';
import { getActiveRow, resolveOrKey, provisionKey } from '../provision';

export const keyRoutes = new OpenAPIHono<AppEnv>();

/** Session-required middleware for all /key routes */
keyRoutes.use('/key', async (c, next) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  c.set('session', session);
  await next();
});

// ── GET /key — Dashboard key info ─────────────────────────────────

keyRoutes.get('/key', async (c) => {
  const session = c.get('session');
  const row = await getActiveRow(session.email, c.env);
  if (!row) {
    return c.json({ error: { message: 'No key found', code: 404 } }, 404);
  }

  const resolved = await resolveOrKey(row, c.env);
  if (!resolved) {
    return c.json({ error: { message: 'Failed to validate key', code: 500 } }, 500);
  }

  const { orKey } = resolved;
  return c.json({
    exists: true as const,
    key: {
      usage_daily: orKey.usage_daily,
      usage_monthly: orKey.usage_monthly,
      limit: orKey.limit,
      limit_remaining: orKey.limit_remaining,
      created_at: row.created_at,
    },
  }, 200);
});

// ── POST /key — Provision a new key (called by dashboard) ─────────

keyRoutes.post('/key', async (c) => {
  const session = c.get('session');

  if (await getActiveRow(session.email, c.env)) {
    return c.json({ error: { message: 'Key already exists', code: 409 } }, 409);
  }

  const resolved = await provisionKey(session.email, c.env);
  if (!resolved) {
    return c.json({ error: { message: 'Failed to create key', code: 500 } }, 500);
  }

  return c.json({ success: true as const, key: resolved.row.bayleaf_token }, 200);
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
