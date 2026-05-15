/**
 * Auth Resolution Utility
 *
 * Shared logic for resolving API auth across proxy routes.
 * Handles Campus Pass, Bayleaf proxy tokens (D1), and raw sk-or- passthrough.
 */

import type { Context } from 'hono';
import type { AppEnv, UserKeyRow } from '../types';
import { BAYLEAF_TOKEN_PREFIX } from '../constants';
import { isCampusPassEligible } from './ip';

export interface AuthResult {
  authorization: string;     // "Bearer sk-or-..."
  isCampusMode: boolean;
  userEmail: string | null;
  userKeyRow?: UserKeyRow; // populated if auth via Bayleaf token
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

  // If no key, empty key, or "campus" token, check for campus access
  if (!providedKey || providedKey === '' || providedKey.toLowerCase() === 'campus') {
    if (isCampusPassEligible(c.req.raw, c.env)) {
      return {
        authorization: `Bearer ${c.env.CAMPUS_POOL_KEY}`,
        isCampusMode: true,
        userEmail: null,
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
      };
  }

  // Raw sk-or- key passes through as-is (backwards compat)
  return {
    authorization: authHeader!,
    isCampusMode: false,
    userEmail: null,
  };
}
