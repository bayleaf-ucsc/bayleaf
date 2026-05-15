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
 * tokens and reports both backends.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv, UserKeyRow } from '../types';
import { getSession } from '../utils/session';
import { generateBayleafToken } from '../utils/token';
import { getKeyName, findKeyByName, findKeyByHash, createKey } from '../openrouter';

export const keyRoutes = new OpenAPIHono<AppEnv>();

/** Session-required middleware for all /key routes */
keyRoutes.use('/key', async (c, next) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  c.set('session', session);
  await next();
});

/**
 * Ensure the user has a valid OR key, provisioning or self-healing as needed.
 * Returns the validated D1 row, or null on failure.
 */
async function ensureOrKey(
  email: string,
  row: UserKeyRow | null,
  env: AppEnv['Bindings'],
): Promise<{ row: UserKeyRow; orKey: import('../types').OpenRouterKey } | null> {
  const keyName = getKeyName(email, env.KEY_NAME_TEMPLATE);

  if (row) {
    const orKey = await findKeyByHash(row.or_key_hash, env);
    if (orKey && !orKey.disabled) {
      return { row, orKey };
    }

    console.log(`Self-healing OR key for ${email}: old hash ${row.or_key_hash} is gone`);
    const newOrKey = await createKey(keyName, env);
    if (!newOrKey?.key) return null;

    await env.DB.prepare(
      'UPDATE user_keys SET or_key_hash = ?, or_key_secret = ? WHERE email = ?',
    ).bind(newOrKey.hash, newOrKey.key, email).run();

    const updatedRow: UserKeyRow = {
      ...row,
      or_key_hash: newOrKey.hash,
      or_key_secret: newOrKey.key,
    };
    return { row: updatedRow, orKey: newOrKey };
  }

  // No D1 row — check for a pre-existing OR key (migration case)
  const existingOrKey = await findKeyByName(keyName, env);
  if (existingOrKey) {
    // Can't adopt without the raw secret — skip and let caller provision fresh
  }

  return null;
}

// ── GET /key — Dashboard key info ─────────────────────────────────

keyRoutes.get('/key', async (c) => {
  const session = c.get('session');
  const row = await c.env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 0',
  ).bind(session.email).first<UserKeyRow>();

  if (!row) {
    return c.json({ error: { message: 'No key found', code: 404 } }, 404);
  }

  const result = await ensureOrKey(session.email, row, c.env);
  if (!result) {
    return c.json({ error: { message: 'Failed to validate key', code: 500 } }, 500);
  }

  const { orKey } = result;
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
  const keyName = getKeyName(session.email, c.env.KEY_NAME_TEMPLATE);

  const existing = await c.env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 0',
  ).bind(session.email).first<UserKeyRow>();

  if (existing) {
    return c.json({ error: { message: 'Key already exists', code: 409 } }, 409);
  }

  const revoked = await c.env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 1',
  ).bind(session.email).first<UserKeyRow>();

  let orKeyHash: string;
  let orKeySecret: string;

  if (revoked) {
    const orKey = await findKeyByHash(revoked.or_key_hash, c.env);
    if (orKey && !orKey.disabled) {
      orKeyHash = revoked.or_key_hash;
      orKeySecret = revoked.or_key_secret;
    } else {
      const newOrKey = await createKey(keyName, c.env);
      if (!newOrKey?.key) {
        return c.json({ error: { message: 'Failed to create key', code: 500 } }, 500);
      }
      orKeyHash = newOrKey.hash;
      orKeySecret = newOrKey.key;
    }
  } else {
    const existingOrKey = await findKeyByName(keyName, c.env);
    if (existingOrKey) {
      // Can't adopt without the raw secret — provision fresh
    }

    const newOrKey = await createKey(keyName, c.env);
    if (!newOrKey?.key) {
      return c.json({ error: { message: 'Failed to create key', code: 500 } }, 500);
    }
    orKeyHash = newOrKey.hash;
    orKeySecret = newOrKey.key;
  }

  const bayleafToken = generateBayleafToken();

  if (revoked) {
    await c.env.DB.prepare(
      'UPDATE user_keys SET bayleaf_token = ?, or_key_hash = ?, or_key_secret = ?, revoked = 0, created_at = datetime(\'now\') WHERE email = ?',
    ).bind(bayleafToken, orKeyHash, orKeySecret, session.email).run();
  } else {
    await c.env.DB.prepare(
      'INSERT INTO user_keys (email, bayleaf_token, or_key_hash, or_key_secret) VALUES (?, ?, ?, ?)',
    ).bind(session.email, bayleafToken, orKeyHash, orKeySecret).run();
  }

  return c.json({ success: true as const, key: bayleafToken }, 200);
});

// ── DELETE /key — Revoke a key (called by dashboard) ──────────────

keyRoutes.delete('/key', async (c) => {
  const session = c.get('session');
  const existing = await c.env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 0',
  ).bind(session.email).first<UserKeyRow>();

  if (!existing) {
    return c.json({ error: { message: 'No key found', code: 404 } }, 404);
  }

  await c.env.DB.prepare(
    'UPDATE user_keys SET revoked = 1 WHERE email = ?',
  ).bind(session.email).run();

  return c.json({ success: true as const }, 200);
});
