/**
 * User key lifecycle — the one place a user's OpenRouter key is looked up,
 * self-healed, or provisioned.
 *
 * Four call sites used to carry their own near-copy of this logic (the
 * dashboard render, GET /key, POST /key, and the claim flow's approve step),
 * and they had drifted: each independently re-derived the "reuse a revoked
 * row's OR key only if it's still alive upstream" nuance, and they disagreed
 * about what to do when re-creation failed. Consolidating them here keeps the
 * D1 row and the upstream OR key in agreement no matter which door the user
 * came through.
 *
 * Two invariants this module exists to protect:
 *
 * 1. **The bayleaf token outlives the OR key.** Self-healing replaces
 *    `or_key_hash`/`or_key_secret` in place and never touches
 *    `bayleaf_token`, so a user's `sk-bayleaf-...` keeps working across an
 *    upstream key loss without them noticing. Only revocation mints a new
 *    token.
 * 2. **One active row per email.** `user_keys.email` is the primary key, so
 *    "provision" is an INSERT for a first-time user and an UPDATE that clears
 *    `revoked` for a returning one.
 *
 * Spend limits are deliberately *not* modeled here. OpenRouter is the system
 * of record for a key's daily cap; `createKey()` stamps the global default
 * from `SPENDING_LIMIT_DOLLARS` at creation time and operators adjust
 * individual keys OR-side (see `scripts/spend-limits.mjs`). A self-heal
 * therefore returns a key to the global default, which is the honest
 * consequence of keeping limits in one place rather than mirroring them.
 */

import type { Bindings, OpenRouterKey, UserKeyRow } from './types';
import { getKeyName, findKeyByHash, createKey } from './openrouter';
import { generateBayleafToken } from './utils/token';

/** A D1 row paired with its live upstream OpenRouter key. */
export interface ResolvedKey {
  row: UserKeyRow;
  orKey: OpenRouterKey;
}

/** The user's active (non-revoked) mapping row, or null if they have none. */
export async function getActiveRow(email: string, env: Bindings): Promise<UserKeyRow | null> {
  return env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 0',
  ).bind(email).first<UserKeyRow>();
}

/**
 * Confirm the row's OpenRouter key is still alive, re-creating it in place if
 * it isn't. The user's bayleaf token is preserved either way.
 *
 * Returns null only when the upstream key is gone *and* re-creation failed —
 * callers decide whether that's fatal (GET /key) or merely means "render the
 * page without usage numbers" (the dashboard).
 */
export async function resolveOrKey(row: UserKeyRow, env: Bindings): Promise<ResolvedKey | null> {
  const orKey = await findKeyByHash(row.or_key_hash, env);
  if (orKey && !orKey.disabled) return { row, orKey };

  console.log(`Self-healing OR key for ${row.email}: hash ${row.or_key_hash} is gone or disabled`);
  const newOrKey = await createKey(getKeyName(row.email, env.KEY_NAME_TEMPLATE), env);
  if (!newOrKey?.key) return null;

  await env.DB.prepare(
    'UPDATE user_keys SET or_key_hash = ?, or_key_secret = ? WHERE email = ?',
  ).bind(newOrKey.hash, newOrKey.key, row.email).run();

  return {
    row: { ...row, or_key_hash: newOrKey.hash, or_key_secret: newOrKey.key },
    orKey: newOrKey,
  };
}

/**
 * Provision a fresh key for a user with no active row, minting a new bayleaf
 * token. If they have a revoked row whose OpenRouter key is still alive
 * upstream, that key is reused rather than leaking an orphan that would keep
 * counting against the account.
 *
 * Precondition: the caller has already established there is no active row.
 * Returns null if a usable OpenRouter key could not be obtained.
 */
export async function provisionKey(email: string, env: Bindings): Promise<ResolvedKey | null> {
  const revoked = await env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 1',
  ).bind(email).first<UserKeyRow>();

  let orKey: OpenRouterKey | null = null;
  let orKeySecret: string | null = null;

  if (revoked) {
    const alive = await findKeyByHash(revoked.or_key_hash, env);
    if (alive && !alive.disabled) {
      orKey = alive;
      orKeySecret = revoked.or_key_secret;
    }
  }

  if (!orKey) {
    const created = await createKey(getKeyName(email, env.KEY_NAME_TEMPLATE), env);
    if (!created?.key) return null;
    orKey = created;
    orKeySecret = created.key;
  }

  const bayleafToken = generateBayleafToken();

  if (revoked) {
    await env.DB.prepare(
      "UPDATE user_keys SET bayleaf_token = ?, or_key_hash = ?, or_key_secret = ?, revoked = 0, created_at = datetime('now') WHERE email = ?",
    ).bind(bayleafToken, orKey.hash, orKeySecret, email).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO user_keys (email, bayleaf_token, or_key_hash, or_key_secret) VALUES (?, ?, ?, ?)',
    ).bind(email, bayleafToken, orKey.hash, orKeySecret).run();
  }

  // Re-read rather than synthesizing the row, so callers see the column
  // defaults (sandbox id, per-backend RPD counters) exactly as D1 stored them.
  const row = await getActiveRow(email, env);
  return row ? { row, orKey } : null;
}

/**
 * Resolve the user's key, provisioning one if they don't have it yet.
 * The "I don't care how, just give me a working key" entry point.
 */
export async function ensureUserKey(email: string, env: Bindings): Promise<ResolvedKey | null> {
  const row = await getActiveRow(email, env);
  return row ? resolveOrKey(row, env) : provisionKey(email, env);
}
