/**
 * Auth Resolution Utility
 *
 * Shared logic for resolving *identity* across proxy, sandbox, and web routes.
 * Handles Campus Pass and Bayleaf proxy tokens (D1).
 *
 * Raw OpenRouter keys (`sk-or-...`) supplied by the user are NOT accepted:
 * BayLeaf injects system prompts, tags `user` for analytics, and meters
 * traffic. Forwarding a user-supplied OR key bypasses all of that, so
 * we'd just be a worse-UX proxy for openrouter.ai. Keyed users provision
 * a `sk-bayleaf-` token; on-campus users use Campus Pass.
 *
 * **This resolves who is calling, not what credential to call upstream with.**
 * Backend credentials come from `utils/backend.ts`, and the split is load-bearing
 * rather than tidiness: of the five route files that call `resolveAuth`, only
 * `proxy.ts` and `sealed.ts` need an inference credential at all. `sandbox.ts`,
 * `web.ts`, and `wellknown.ts` authenticate users without touching a provider.
 * Since migration 0005 mints provider keys on first use, returning a credential
 * from here would mint an OpenRouter key for a user whose only request was ever
 * a sandbox exec.
 */

import type { Context } from 'hono';
import type { AppEnv, UserKeyRow } from '../types';
import { BAYLEAF_TOKEN_PREFIX } from '../constants';
import { getAuthIP, isCampusPassEligible } from './ip';

export interface AuthResult {
  isCampusMode: boolean;
  userEmail: string | null;
  /**
   * Populated if auth was via a Bayleaf token. Its absence is what marks a
   * caller as unhealable in `utils/backend.ts`: Campus Pass credentials live in
   * env, not in a row we can rewrite.
   */
  userKeyRow?: UserKeyRow;
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

    // Note: no provider credential is read here. `or_key_secret` may legitimately
    // be NULL on a valid, active row — a user who has a token but has not yet
    // used an inference backend. Routes that need one call
    // `resolveBackendCredential`, which mints on demand.
    return {
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
