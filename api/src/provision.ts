/**
 * User key lifecycle — the one place a user's row and their per-backend
 * provider keys are created, healed, or looked up.
 *
 * Four call sites used to carry their own near-copy of this logic (the
 * dashboard render, GET /key, POST /key, and the claim flow's approve step),
 * and they had drifted: each independently re-derived the "reuse a revoked
 * row's OR key only if it's still alive upstream" nuance, and they disagreed
 * about what to do when re-creation failed. Consolidating them here keeps the
 * D1 row and the upstream provider keys in agreement no matter which door the
 * user came through.
 *
 * ## The token/backend-key split (migration 0005)
 *
 * Originally a user's OpenRouter key was minted in the same operation as their
 * `sk-bayleaf-` token, so `or_key_secret` could be NOT NULL. That coupling did
 * not generalize to a second backend: minting a Tinfoil key at token time would
 * make a Tinfoil outage block OpenRouter provisioning for new users, and would
 * mint a Sealed credential for every user whether or not they ever touch the
 * lane.
 *
 * So the two are now separate. **Token issuance creates the identity record;
 * backend keys are caches minted on first use of that backend.** The payoff is
 * that "this user never had a key" and "this user's key vanished upstream"
 * collapse into a single code path — `swapBackendKey` below — rather than being
 * `provisionKey`'s revoked-row-reuse branch and `resolveOrKey`'s self-heal
 * branch, which is what previously drifted.
 *
 * Three invariants this module exists to protect:
 *
 * 1. **The bayleaf token outlives every backend key.** Healing replaces the
 *    provider columns in place and never touches `bayleaf_token`, so a user's
 *    `sk-bayleaf-...` keeps working across an upstream key loss without them
 *    noticing. Only revocation mints a new token.
 * 2. **One active row per email.** `user_keys.email` is the primary key, so
 *    "provision" is an INSERT for a first-time user and an UPDATE that clears
 *    `revoked` for a returning one.
 * 3. **A mint race never leaks a billable provider key.** Concurrent requests
 *    can both observe an absent key and both mint; the compare-and-swap in
 *    `swapBackendKey` lets exactly one win and makes the loser delete what it
 *    just created. Without that cleanup the orphan would keep counting against
 *    the account, which is the hazard the old revoked-row-reuse branch existed
 *    to avoid in a narrower case.
 *
 * Spend limits are deliberately *not* modeled here. The provider is the system
 * of record for a key's cap; `createKey()` stamps the global default from
 * `SPENDING_LIMIT_DOLLARS` at creation time and operators adjust individual keys
 * provider-side (see `scripts/spend-limits.mjs`). A heal therefore returns a key
 * to the global default, which is the honest consequence of keeping limits in
 * one place rather than mirroring them.
 */

import type { Bindings, OpenRouterKey, UserKeyRow } from './types';
import { getKeyName, findKeyByHash, createKey, deleteKey } from './openrouter';
import { createTinfoilKey, deleteTinfoilKey } from './tinfoil';
import { generateBayleafToken } from './utils/token';

/** Which upstream provider a credential belongs to. */
export type BackendKind = 'openrouter' | 'tinfoil';

/** A usable provider credential plus the row it was read from or written to. */
export interface BackendCredential {
  /** The bearer value to send upstream. */
  secret: string;
  row: UserKeyRow;
}

/** A D1 row paired with its live upstream OpenRouter key (dashboard display). */
export interface ResolvedKey {
  row: UserKeyRow;
  orKey: OpenRouterKey;
}

/**
 * Per-backend description of how a credential is stored and minted.
 *
 * This table exists so the CAS below is written once. Adding a third backend
 * that needs per-user credentials should mean adding a row here, not another
 * copy of the swap logic — the drift this module was consolidated to prevent.
 *
 * `columns` returns the D1 SET fragment and its bindings, because the two
 * backends store a different *number* of things: OpenRouter needs an opaque
 * management handle alongside the secret, Tinfoil needs the key name (its
 * billing report indexes spend by name) and has no handle at all.
 */
interface BackendSpec {
  /** Column holding the bearer secret; also the CAS predicate target. */
  secretColumn: 'or_key_secret' | 'tinfoil_key';
  /** Mint upstream. Returns the secret plus any companion columns to store. */
  mint(name: string, email: string, env: Bindings): Promise<{
    secret: string;
    extra: Record<string, string | number>;
  } | null>;
  /** Destroy upstream, used to clean up the loser of a mint race. */
  destroy(secret: string, row: UserKeyRow, env: Bindings): Promise<boolean>;
}

const BACKENDS: Record<BackendKind, BackendSpec> = {
  openrouter: {
    secretColumn: 'or_key_secret',
    async mint(name, _email, env) {
      const created = await createKey(name, env);
      if (!created?.key) return null;
      return { secret: created.key, extra: { or_key_hash: created.hash } };
    },
    // Deletion is by OpenRouter's opaque handle, not by the secret, so this
    // reads the hash from the row rather than deriving it from the credential.
    async destroy(_secret, row, env) {
      return row.or_key_hash ? deleteKey(row.or_key_hash, env) : false;
    },
  },
  tinfoil: {
    secretColumn: 'tinfoil_key',
    async mint(name, email, env) {
      // The email is recorded in both the name and the metadata. The name is
      // what the billing report indexes by, so it is the functional join
      // column; the metadata is the durable record if the name template ever
      // changes. Decided 2026-07-29: identity at the provider is deliberately
      // not concealed. What the Sealed lane defends is the opacity of message
      // *content*, not of who is talking.
      const created = await createTinfoilKey(name, { bayleaf_email: email, lane: 'sealed' }, env);
      if (!created?.key) return null;
      // Store the name the provider actually recorded, not the one we asked for.
      // Tinfoil rejects `@` in key names, so `createTinfoilKey` sanitizes on the
      // way out; storing the echoed value keeps `tinfoil_key_name` a valid join
      // key for the billing report instead of a name that exists only here.
      return {
        secret: created.key,
        extra: { tinfoil_key_name: created.name, tinfoil_unlimited: 1 },
      };
    },
    // Tinfoil has no management handle: the secret is the identifier.
    async destroy(secret, _row, env) {
      return deleteTinfoilKey(secret, env);
    },
  },
};

/** The user's active (non-revoked) mapping row, or null if they have none. */
export async function getActiveRow(email: string, env: Bindings): Promise<UserKeyRow | null> {
  return env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 0',
  ).bind(email).first<UserKeyRow>();
}

/**
 * Mint a backend credential and install it, but only if the stored credential
 * is still `expected`. The single primitive behind both first-time provisioning
 * and post-401 healing.
 *
 * `expected === null` means "install only if absent" (first use of this
 * backend). `expected === '<secret>'` means "replace only if the stored value is
 * still the one that just failed upstream" (heal). Both cases have the same
 * race: another in-flight request for the same user may get there first.
 *
 * The compare-and-swap makes that safe. We mint *before* the conditional UPDATE
 * because there is no way to reserve a provider key, so losing the race is
 * possible and must be paid for: the loser deletes the key it created and
 * adopts the winner's. That wastes one mint under contention, which is the
 * accepted cost of never leaking a billable orphan.
 *
 * Returns null when minting failed, or when the row was revoked mid-flight.
 */
async function swapBackendKey(
  row: UserKeyRow,
  kind: BackendKind,
  expected: string | null,
  env: Bindings,
): Promise<BackendCredential | null> {
  const spec = BACKENDS[kind];
  const name = getKeyName(row.email, env.KEY_NAME_TEMPLATE);

  const minted = await spec.mint(name, row.email, env);
  if (!minted) return null;

  // Build the SET clause from the secret plus whatever companion columns this
  // backend carries, so the two providers share one write path.
  const sets = { [spec.secretColumn]: minted.secret, ...minted.extra };
  const assignments = Object.keys(sets).map((col) => `${col} = ?`).join(', ');
  const predicate = expected === null
    ? `${spec.secretColumn} IS NULL`
    : `${spec.secretColumn} = ?`;

  const result = await env.DB.prepare(
    `UPDATE user_keys SET ${assignments}
       WHERE email = ? AND revoked = 0 AND ${predicate}`,
  ).bind(
    ...Object.values(sets),
    row.email,
    ...(expected === null ? [] : [expected]),
  ).run();

  if (result.meta.changes === 1) {
    return { secret: minted.secret, row: { ...row, ...sets } as UserKeyRow };
  }

  // Lost the race, or the row was revoked while we were minting. Either way the
  // key we just created is unreferenced, so destroy it before adopting whatever
  // is actually stored now.
  console.log(`Discarding redundant ${kind} key for ${row.email} (lost mint race or row revoked)`);
  await spec.destroy(minted.secret, row, env);

  const fresh = await getActiveRow(row.email, env);
  const winner = fresh?.[spec.secretColumn] ?? null;
  return fresh && winner ? { secret: winner, row: fresh } : null;
}

/**
 * Get the user's credential for a backend, minting one if they have none.
 *
 * Cheap in the common case: a populated column is trusted and returned without
 * any upstream call. The inference path deliberately does **not** verify the
 * credential is still alive first — for Tinfoil that is not even possible
 * without enumerating every key in the org (see `tinfoil.ts`), and for
 * OpenRouter it would add a round-trip to every proxied request. Liveness is
 * discovered by using the key; see `healBackendKey`.
 */
export async function ensureBackendKey(
  row: UserKeyRow,
  kind: BackendKind,
  env: Bindings,
): Promise<BackendCredential | null> {
  const existing = row[BACKENDS[kind].secretColumn];
  if (existing) return { secret: existing, row };
  return swapBackendKey(row, kind, null, env);
}

/**
 * Replace a backend credential that the provider has rejected.
 *
 * Call this only after an actual upstream 401/403 on `failed`, never
 * speculatively. Passing the failed secret as the CAS expectation means two
 * concurrent healers converge on one replacement instead of thrashing, and a
 * request that healed while we were minting is respected rather than clobbered.
 */
export async function healBackendKey(
  row: UserKeyRow,
  kind: BackendKind,
  failed: string,
  env: Bindings,
): Promise<BackendCredential | null> {
  console.log(`Healing ${kind} key for ${row.email}: upstream rejected the stored credential`);
  return swapBackendKey(row, kind, failed, env);
}

/**
 * Create the row and `sk-bayleaf-` token for a user who has no active row.
 *
 * Backend provider keys are **not** minted here; they arrive on first use of
 * each backend via `ensureBackendKey`. That is what keeps a provider outage
 * from blocking signup, and what stops a user who only ever uses the sandbox
 * from being issued inference credentials they never touch.
 *
 * A revoked row is reused (UPDATE clearing `revoked`) rather than inserted, and
 * its stale backend columns are cleared: the old keys were destroyed at
 * revocation, so leaving the columns populated would hand the user a dead
 * credential and defer the repair to a 401 that `healBackendKey` would then
 * have to fix. Clearing them is cheaper and keeps "populated means plausibly
 * live" true.
 *
 * Precondition: the caller has already established there is no active row.
 */
export async function provisionToken(email: string, env: Bindings): Promise<UserKeyRow | null> {
  const bayleafToken = generateBayleafToken();

  const revoked = await env.DB.prepare(
    'SELECT email FROM user_keys WHERE email = ? AND revoked = 1',
  ).bind(email).first<{ email: string }>();

  if (revoked) {
    await env.DB.prepare(
      `UPDATE user_keys
          SET bayleaf_token = ?, revoked = 0, created_at = datetime('now'),
              or_key_hash = NULL, or_key_secret = NULL,
              tinfoil_key = NULL, tinfoil_key_name = NULL
        WHERE email = ?`,
    ).bind(bayleafToken, email).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO user_keys (email, bayleaf_token) VALUES (?, ?)',
    ).bind(email, bayleafToken).run();
  }

  // Re-read rather than synthesizing the row, so callers see the column
  // defaults (sandbox id, per-backend RPD counters) exactly as D1 stored them.
  return getActiveRow(email, env);
}

/**
 * Return the user's row, provisioning a token if they don't have one yet.
 * The "I don't care how, just make sure this user exists" entry point.
 */
export async function ensureUserRow(email: string, env: Bindings): Promise<UserKeyRow | null> {
  return (await getActiveRow(email, env)) ?? provisionToken(email, env);
}

/**
 * Fetch the live OpenRouter key object for display (usage and limit numbers on
 * the dashboard), minting the key first if the user has none.
 *
 * This is the one place that still pays for an upstream read, because the
 * dashboard's whole job here is to show provider-side numbers that only exist
 * upstream. If the key is absent upstream despite being stored, heal and retry
 * once — the same one-inline-retry shape the inference path uses.
 *
 * Returns null when the user has no row, when minting failed, or when the key
 * could not be read after healing. Callers treat that as "render the page
 * without usage numbers", not as a fatal error.
 */
export async function resolveOrKeyInfo(
  row: UserKeyRow,
  env: Bindings,
): Promise<ResolvedKey | null> {
  const cred = await ensureBackendKey(row, 'openrouter', env);
  if (!cred) return null;

  const orKey = cred.row.or_key_hash ? await findKeyByHash(cred.row.or_key_hash, env) : null;
  if (orKey && !orKey.disabled) return { row: cred.row, orKey };

  const healed = await healBackendKey(cred.row, 'openrouter', cred.secret, env);
  if (!healed?.row.or_key_hash) return null;

  const fresh = await findKeyByHash(healed.row.or_key_hash, env);
  return fresh ? { row: healed.row, orKey: fresh } : null;
}
