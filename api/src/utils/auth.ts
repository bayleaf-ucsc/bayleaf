/**
 * Auth Resolution Utility
 *
 * Shared logic for resolving API auth across proxy routes.
 * Handles Campus Pass and Bayleaf proxy tokens (D1).
 *
 * Raw OpenRouter keys (`sk-or-...`) supplied by the user are NOT accepted:
 * BayLeaf injects system prompts, tags `user` for analytics, and meters
 * traffic. Forwarding a user-supplied OR key bypasses all of that, so
 * we'd just be a worse-UX proxy for openrouter.ai. Keyed users provision
 * a `sk-bayleaf-` token; on-campus users use Campus Pass.
 */

import type { Context } from 'hono';
import type { AppEnv, UserKeyRow } from '../types';
import { BAYLEAF_TOKEN_PREFIX } from '../constants';
import { getAuthIP, isCampusPassEligible } from './ip';

export interface AuthResult {
  authorization: string;     // "Bearer sk-or-..." — always a BayLeaf-managed OR key, never user-supplied
  isCampusMode: boolean;
  userEmail: string | null;
  userKeyRow?: UserKeyRow; // populated if auth via Bayleaf token
  clientIp: string | null;  // CF-Connecting-IP (or dev loopback); null if absent. Used for Campus Pass RPD.
}

/**
 * Resolve the auth credentials for a proxied request.
 * Returns an AuthResult on success, or a Response (error) on failure.
 */
export async function resolveAuth(
  c: Context<AppEnv>,
): Promise<AuthResult | Response> {
  const authHeader = c.req.header('Authorization');
  const providedKey = authHeader?.replace(/^Bearer\s+/i, '').trim();
  const clientIp = getAuthIP(c.req.raw, c.env);

  // If no key, empty key, or "campus" token, check for campus access
  if (!providedKey || providedKey === '' || providedKey.toLowerCase() === 'campus') {
    if (isCampusPassEligible(c.req.raw, c.env)) {
      return {
        authorization: `Bearer ${c.env.CAMPUS_POOL_KEY}`,
        isCampusMode: true,
        userEmail: null,
        clientIp,
      };
    }
    return c.json({
      error: {
        message: 'API key required. On-campus users can omit the key or use "campus". Visit https://api.bayleaf.dev/ for a free personal key.',
        code: 401,
      },
    }, 401);
  }

  // Bayleaf proxy token — resolve via D1
  if (providedKey.startsWith(BAYLEAF_TOKEN_PREFIX)) {
    const row = await c.env.DB.prepare(
      'SELECT * FROM user_keys WHERE bayleaf_token = ? AND revoked = 0',
    ).bind(providedKey).first<UserKeyRow>();

    if (!row) {
      return c.json({
        error: {
          message: 'Invalid or revoked API key.',
          code: 401,
        },
      }, 401);
    }

    return {
        authorization: `Bearer ${row.or_key_secret}`,
        isCampusMode: false,
        userEmail: row.email,
        userKeyRow: row,
        clientIp,
      };
  }

  // Anything else (including raw sk-or- keys) is rejected. BayLeaf only
  // accepts its own sk-bayleaf- tokens or Campus Pass; user-supplied OR
  // keys are not a supported path because they bypass system prompt
  // injection, user-field tagging, and budget enforcement.
  return c.json({
    error: {
      message: 'Unsupported API key. Use a BayLeaf-issued key (sk-bayleaf-...) or Campus Pass. Provision a free key at https://api.bayleaf.dev/.',
      code: 401,
    },
  }, 401);
}
