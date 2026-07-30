/**
 * Tinfoil Admin API Helpers — per-user key lifecycle for the Sealed lane.
 *
 * Deliberately shaped to mirror `openrouter.ts` (createKey / deleteKey / a
 * lookup) so `provision.ts` can treat the two backends uniformly. Three places
 * where Tinfoil's admin plane differs from OpenRouter's, and each one matters:
 *
 * 1. **No management handle.** OpenRouter identifies a key by an opaque `hash`
 *    and never re-reveals the secret after creation, so D1 must store both.
 *    Tinfoil identifies a key by the secret itself (`DELETE /api/keys/{tk_...}`)
 *    and `GET /api/keys` returns every secret in plaintext. One stored column
 *    therefore serves both the inference and management planes.
 *
 * 2. **The admin key is strictly more dangerous.** Because secrets are
 *    re-readable, a leaked `TINFOIL_ADMIN_KEY` exposes every user's inference
 *    credential; a leaked OpenRouter provisioning key does not. Keep this
 *    credential out of any path that does not need to mint, and prefer a
 *    separate Worker for billing reconciliation so the request path cannot
 *    enumerate keys.
 *
 * 3. **No provider-side model scoping.** `scope: {"models": [...]}` on create
 *    returns 200 and silently stores `scope: null` (verified 2026-07-29), so a
 *    per-user key cannot be restricted to a model subset. BayLeaf therefore
 *    enforces its own per-user request-rate guardrail.
 *
 * There is no `listKeys` here on purpose. Enumerating keys is a reconciler
 * concern, not an inference-path one, and exporting it from a module the
 * request path imports would make "the Worker cannot enumerate user
 * credentials" untrue by accident.
 */

import type { Bindings, TinfoilKeyCreated } from './types';
import { TINFOIL_ADMIN_API } from './constants';

/**
 * Characters Tinfoil rejects in a key name.
 *
 * Verified by probe 2026-07-29: the admin API answers
 * `400 {"error":"API key name must not contain special characters"}` for names
 * containing any of `@ : + ( ) , / '`, while alphanumerics, space, `-`, `_`, and
 * `.` are accepted.
 *
 * This matters because `KEY_NAME_TEMPLATE` embeds an email address, and `@` is
 * on the reject list — so the canonical BayLeaf key name is *not* a legal
 * Tinfoil key name. The constraint is Tinfoil's, so it is absorbed here rather
 * than distorting the shared naming in `provision.ts`, which still computes one
 * canonical name for every backend.
 */
const TINFOIL_NAME_DISALLOWED = /[^A-Za-z0-9 ._-]+/g;

/**
 * Make a BayLeaf key name acceptable to Tinfoil.
 *
 * `"BayLeaf API for alice@ucsc.edu"` becomes `"BayLeaf API for alice_ucsc.edu"`.
 *
 * Note this is lossy, so it is *not* the mechanism by which spend is attributed
 * back to a user. `user_keys.tinfoil_key_name` stores the sanitized name
 * verbatim, and that stored value is the join column for the billing report,
 * which means attribution never has to invert this function.
 *
 * The residual risk is a collision: two distinct emails could sanitize to the
 * same name and the billing report, which aggregates by name, would merge their
 * spend. With `ALLOWED_EMAIL_DOMAIN` restricting sign-up to one domain and CruzIDs
 * being alphanumeric, no two real addresses collide. Revisit this if BayLeaf ever
 * accepts multiple email domains.
 */
export function sanitizeTinfoilKeyName(name: string): string {
  return name.replace(TINFOIL_NAME_DISALLOWED, '_');
}

/**
 * Mint a Tinfoil inference key.
 *
 * `name` is supplied by the caller rather than derived here so that
 * `provision.ts` remains the single place that decides how a user's keys are
 * named across providers. The name is load-bearing beyond display: the
 * out-of-band billing report indexes spend by key *name*, so it is the join
 * column back to a user. It is sanitized on the way out (see above) and the
 * sanitized form is what gets returned for storage.
 *
 * Returns null on any failure. Callers decide whether that is fatal.
 */
export async function createTinfoilKey(
  name: string,
  metadata: Record<string, string>,
  env: Bindings,
): Promise<TinfoilKeyCreated | null> {
  const safeName = sanitizeTinfoilKeyName(name);

  const response = await fetch(`${TINFOIL_ADMIN_API}/keys`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.TINFOIL_ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: safeName,
      // The unsanitized email lives here, so the exact identity survives even
      // though the name is lossy.
      metadata,
    }),
  });


  // Deliberately not logging the response body: unlike OpenRouter's create
  // response, Tinfoil's echoes the secret, and this module is imported by the
  // request path. Log the status only.
  if (!response.ok) {
    console.log('Tinfoil create key failed:', response.status);
    return null;
  }

  const key = await response.json() as TinfoilKeyCreated;
  return key?.key ? key : null;
}

/**
 * Delete a Tinfoil key by its secret.
 *
 * Used on revoke, and by the compare-and-swap in `provision.ts` to clean up the
 * losing side of a concurrent mint. That second use is why this must be
 * reliable: without it, a mint race leaks a billable key.
 */
export async function deleteTinfoilKey(key: string, env: Bindings): Promise<boolean> {
  const response = await fetch(`${TINFOIL_ADMIN_API}/keys/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${env.TINFOIL_ADMIN_KEY}` },
  });

  return response.ok;
}

/*
 * There is deliberately no `getTinfoilKey(key)` liveness check to mirror
 * OpenRouter's `findKeyByHash`. Verified 2026-07-29: `GET /api/keys/{tk_...}`
 * answers 405, so the only ways to read one key's state are enumerating every
 * key via `GET /api/keys` or asking the billing endpoint. Both are reconciler
 * capabilities we specifically do not want reachable from the request path.
 *
 * This is why the Sealed lane trusts the secret stored in D1 and treats an
 * upstream 401 as the signal to re-mint (see `healBackendKey` in
 * `provision.ts`), rather than validating proactively. The absence of a
 * single-key read makes that the only cheap design, not merely the preferred
 * one.
 */
