/**
 * Backend credential acquisition for the request path.
 *
 * `resolveAuth` establishes *who* is calling; this establishes *which upstream
 * credential* to call with. They are deliberately separate, because most routes
 * need only the former: `/sandbox/*`, `/web/*`, and `/.well-known/*` all
 * authenticate users without touching an inference provider. Folding credential
 * acquisition into `resolveAuth` would mint an OpenRouter key for a user whose
 * only ever request was a sandbox exec, which is exactly what migration 0005
 * decoupled.
 *
 * Two auth modes resolve differently:
 *
 * - **Keyed users** get a per-user key from D1, minted on first use of that
 *   backend (`ensureBackendKey`). Healable, because the credential lives in a
 *   row we can rewrite.
 * - **Campus Pass** users have no email and therefore no row, so they share a
 *   pool credential from the environment. **Not healable**: an env var cannot be
 *   rewritten from the request path, so a dead pool key is an operator problem,
 *   not something the Worker can repair. `sendWithHeal` reflects that by
 *   returning the upstream error unchanged when there is no row.
 */

import type { AuthResult } from './auth';
import type { Bindings, UserKeyRow } from '../types';
import { type BackendKind, ensureBackendKey, healBackendKey } from '../provision';

/** A credential plus what is needed to replace it if the provider rejects it. */
export interface BackendCredentialHandle {
  secret: string;
  kind: BackendKind;
  /** The row to rewrite when healing; null for Campus Pass (env-held pool key). */
  row: UserKeyRow | null;
}

/** Which binding holds the shared Campus Pass credential for each backend. */
const CAMPUS_POOL_BINDING: Record<BackendKind, 'CAMPUS_POOL_KEY' | 'CAMPUS_SEALED_KEY'> = {
  openrouter: 'CAMPUS_POOL_KEY',
  tinfoil: 'CAMPUS_SEALED_KEY',
};

/**
 * Get the upstream credential this caller should use for a given backend,
 * minting a per-user key if they have none yet.
 *
 * Returns null when no credential could be obtained: an unconfigured campus
 * pool key, a keyed caller with no row, or a failed mint. Callers should treat
 * that as a 503 rather than falling back to another credential — silently
 * substituting a shared key for a per-user one would break the per-user
 * attribution the whole scheme exists to provide.
 */
export async function resolveBackendCredential(
  auth: AuthResult,
  kind: BackendKind,
  env: Bindings,
): Promise<BackendCredentialHandle | null> {
  if (auth.isCampusMode) {
    const secret = env[CAMPUS_POOL_BINDING[kind]];
    return secret ? { secret, kind, row: null } : null;
  }

  if (!auth.userKeyRow) return null;

  const cred = await ensureBackendKey(auth.userKeyRow, kind, env);
  return cred ? { secret: cred.secret, kind, row: cred.row } : null;
}

/**
 * Perform an upstream call, healing the credential once if it is rejected.
 *
 * The inference path trusts the credential stored in D1 rather than validating
 * it first — for Tinfoil a liveness check is not even possible without
 * enumerating the whole org's keys, and for OpenRouter it would add a
 * round-trip to every request. The cost of that choice is that a stale
 * credential is discovered by *using* it, so one inline retry converts what
 * would be a user-visible 401 into a transparent recovery.
 *
 * `send` must be replayable. That is a real constraint, not a formality: a
 * caller that has already consumed the client's request body cannot re-send it,
 * which is why the `/v1/*` streaming passthrough does not use this helper.
 *
 * Only 401/403 triggers a heal. A 429 or 5xx says nothing about credential
 * validity, and re-minting on those would churn keys under load — and, since a
 * fresh key resets to the global spend default, would hand out budget as a
 * side effect of provider trouble.
 */
export async function sendWithHeal(
  handle: BackendCredentialHandle,
  env: Bindings,
  send: (secret: string) => Promise<Response>,
): Promise<Response> {
  const res = await send(handle.secret);
  if (res.status !== 401 && res.status !== 403) return res;

  // Campus Pass: pool key lives in env, so there is nothing to rewrite.
  if (!handle.row) return res;

  const healed = await healBackendKey(handle.row, handle.kind, handle.secret, env);
  if (!healed) return res;

  return send(healed.secret);
}
