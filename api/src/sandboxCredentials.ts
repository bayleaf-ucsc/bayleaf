/** Independent sandbox authority. D1 holds verifiers; Daytona holds bearers.
 * All issuance/mount/rotation calls are serialized by the owner's controller.
 * No provider inference keys are minted here. Never log provider responses.
 */
import type { Bindings, UserKeyRow } from './types';
import { DAYTONA_DEFAULT_API_URL } from './constants';

export const SANDBOX_TOKEN_PREFIX = 'sk-bayleaf-sandbox-';
const seconds = () => Math.floor(Date.now() / 1000);
export const credentialHash = async (value: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const token = () => SANDBOX_TOKEN_PREFIX + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export interface SandboxCredential {
  id: string; email: string; sandbox_id: string; token_hash: string; secret_name: string;
  secret_id: string | null; placeholder: string | null; state: 'pending' | 'active' | 'revoked';
  created_at: number; updated_at: number;
}
interface Secret { id: string; name: string; placeholder: string; hosts: string[] }
interface Machine { id: string; state: string; labels?: Record<string, string>; env?: Record<string, string> }
async function call(env: Bindings, path: string, method = 'GET', body?: unknown) {
  return fetch((env.DAYTONA_API_URL || DAYTONA_DEFAULT_API_URL).replace(/\/+$/, '') + path, {
    method, headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
}
export async function getAccountRow(email: string, env: Bindings) {
  return env.DB.prepare('SELECT * FROM user_keys WHERE email=?').bind(email).first<UserKeyRow>();
}
export async function activeSandboxCredential(env: Bindings, email: string, sandboxId: string) {
  return env.DB.prepare("SELECT * FROM sandbox_credentials WHERE email=? AND sandbox_id=? AND state='active'")
    .bind(email, sandboxId).first<SandboxCredential>();
}

/** SQL predicate for atomic account writes, rechecking the actual caller's authority. */
export function callerAuthority(row: UserKeyRow): { sql: string; values: string[] } {
  if (row.sandbox_credential_id) return {
    sql: `email=? AND EXISTS (SELECT 1 FROM sandbox_credentials sc WHERE sc.id=? AND sc.email=user_keys.email
      AND sc.sandbox_id=user_keys.daytona_sandbox_id AND sc.state='active')`,
    values: [row.email, row.sandbox_credential_id],
  };
  return { sql: 'email=? AND bayleaf_token=? AND revoked=0', values: [row.email, row.bayleaf_token] };
}

/** Fail closed on missing/replaced/deleted machines, including external deletion.
 * This is a passive control-plane read, never Toolbox or an activity refresh.
 */
export async function authenticateSandboxCredential(env: Bindings, bearer: string): Promise<UserKeyRow | null> {
  if (!/^sk-bayleaf-sandbox-[a-f0-9]{64}$/.test(bearer)) return null;
  const sc = await env.DB.prepare("SELECT * FROM sandbox_credentials WHERE token_hash=? AND state='active'")
    .bind(await credentialHash(bearer)).first<SandboxCredential>();
  if (!sc) return null;
  const owner = await getAccountRow(sc.email, env);
  if (!owner || owner.daytona_sandbox_id !== sc.sandbox_id) return null;
  try {
    const r = await call(env, `/sandbox/${encodeURIComponent(sc.sandbox_id)}`);
    if (!r.ok) { await r.body?.cancel(); return null; }
    const m = await r.json() as Machine;
    if (m.id !== sc.sandbox_id || m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== sc.email ||
        ['destroyed', 'deleted'].includes(m.state)) return null;
    return { ...owner, sandbox_credential_id: sc.id };
  } catch { return null; }
}

// Exact-name discovery recovers an ambiguous create without ever reading values.
async function findSecret(env: Bindings, name: string): Promise<Secret | null> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const r = await call(env, `/secret/paginated?name=${encodeURIComponent(name)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!r.ok) throw new Error('secret_unavailable');
    const data = await r.json() as { items: Secret[]; nextCursor?: string | null };
    if (!Array.isArray(data.items)) throw new Error('secret_unavailable');
    const found = data.items.find(s => s.name === name);
    if (found) return found;
    if (!data.nextCursor) return null;
    if (seen.has(data.nextCursor)) break;
    cursor = data.nextCursor; seen.add(cursor);
  }
  throw new Error('secret_unavailable');
}

/** Called before wake. First attachment to an existing running machine is refused.
 * Never replace an unrelated mount map: unknown placeholders require operator review.
 */
export async function ensureSandboxCredential(env: Bindings, email: string, sandboxId: string): Promise<SandboxCredential> {
  const existing = await activeSandboxCredential(env, email, sandboxId);
  if (existing) return existing;
  const r = await call(env, `/sandbox/${encodeURIComponent(sandboxId)}`);
  if (!r.ok) throw new Error('sandbox_unavailable');
  const m = await r.json() as Machine;
  if (m.id !== sandboxId || m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== email) throw new Error('ownership_mismatch');
  const alreadyProxied = /^dtn_secret_[A-Za-z0-9_-]+$/.test(m.env?.BAYLEAF_API_KEY ?? '');
  if (!['stopped','archived'].includes(m.state) && !(m.state === 'started' && alreadyProxied)) throw new Error('credential_migration_requires_stop');
  if (Object.entries(m.env ?? {}).some(([key, value]) => key !== 'BAYLEAF_API_KEY' && value.startsWith('dtn_secret_'))) throw new Error('existing_secret_mounts');
  // A prior crash has no retained bearer. Revoke it and clean up before retry.
  await env.DB.prepare("UPDATE sandbox_credentials SET state='revoked',updated_at=? WHERE email=? AND sandbox_id=? AND state='pending'")
    .bind(seconds(), email, sandboxId).run();
  const id = crypto.randomUUID(), bearer = token(), name = `bayleaf-sandbox-${id}`;
  await env.DB.prepare(`INSERT INTO sandbox_credentials(id,email,sandbox_id,token_hash,secret_name,state,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending',?,?)`).bind(id, email, sandboxId, await credentialHash(bearer), name, seconds(), seconds()).run();
  try {
    const created = await call(env, '/secret', 'POST', { name, value: bearer, hosts: ['api.bayleaf.dev'] });
    if (!created.ok) throw new Error('secret_unavailable');
    const secret = await created.json() as Secret;
    if (!secret.id || secret.name !== name || !/^dtn_secret_[A-Za-z0-9_-]+$/.test(secret.placeholder) ||
        secret.hosts?.length !== 1 || secret.hosts[0] !== 'api.bayleaf.dev') throw new Error('secret_unavailable');
    await env.DB.prepare("UPDATE sandbox_credentials SET secret_id=?,placeholder=? WHERE id=? AND state='pending'")
      .bind(secret.id, secret.placeholder, id).run();
    const mounted = await call(env, `/sandbox/${encodeURIComponent(sandboxId)}/secrets`, 'PUT',
      { secrets: [{ BAYLEAF_API_KEY: name }] });
    if (!mounted.ok) throw new Error('secret_attachment_failed');
    await mounted.body?.cancel();
    const activated = await env.DB.prepare(`UPDATE sandbox_credentials SET state='active',updated_at=? WHERE id=? AND state='pending'
      AND EXISTS (SELECT 1 FROM user_keys WHERE email=? AND daytona_sandbox_id=?)`).bind(seconds(), id, email, sandboxId).run();
    if (activated.meta.changes !== 1) throw new Error('credential_revoked');
    return (await activeSandboxCredential(env, email, sandboxId))!;
  } catch {
    await env.DB.prepare("UPDATE sandbox_credentials SET state='revoked',updated_at=? WHERE id=?").bind(seconds(), id).run();
    throw new Error('sandbox_credential_setup_failed');
  }
}

/** Revocation is local and immediate; provider deletion is retried by the outbox. */
export async function revokeSandboxCredentials(env: Bindings, sandboxId: string) {
  await env.DB.prepare("UPDATE sandbox_credentials SET state='revoked',updated_at=? WHERE sandbox_id=? AND state!='revoked'")
    .bind(seconds(), sandboxId).run();
}

/** Rotate in the owner DO. A failed/ambiguous rotation revokes access, never revives an old token. */
export async function rotateSandboxCredential(env: Bindings, sc: SandboxCredential) {
  if (!sc.secret_id) throw new Error('secret_unavailable');
  const bearer = token();
  await env.DB.prepare("UPDATE sandbox_credentials SET token_hash=?,updated_at=? WHERE id=? AND state='active'")
    .bind(await credentialHash(bearer), seconds(), sc.id).run();
  try {
    const r = await call(env, `/secret/${encodeURIComponent(sc.secret_id)}`, 'PATCH', { value: bearer, hosts: ['api.bayleaf.dev'] });
    if (!r.ok) throw new Error('secret_unavailable');
    await r.body?.cancel();
  } catch { await revokeSandboxCredentials(env, sc.sandbox_id); throw new Error('rotation_failed'); }
}

/** Hourly, bounded cleanup. Pending rows older than setup's deadline cannot authorize.
 * Keeps an outbox row until deletion succeeds, including ambiguous secret creation.
 */
export async function cleanupSandboxCredentials(env: Bindings) {
  await env.DB.prepare("UPDATE sandbox_credentials SET state='revoked' WHERE state='pending' AND created_at<?")
    .bind(seconds() - 1200).run();
  const rows = await env.DB.prepare('SELECT * FROM sandbox_credentials ORDER BY updated_at LIMIT 100').all<SandboxCredential>();
  for (const sc of rows.results) {
    try {
      if (sc.state === 'pending') continue;
      if (sc.state === 'active') {
        const owner = await getAccountRow(sc.email, env);
        const r = await call(env, `/sandbox/${encodeURIComponent(sc.sandbox_id)}`);
        let gone = r.status === 404 || owner?.daytona_sandbox_id !== sc.sandbox_id;
        if (r.ok) {
          const m = await r.json() as Machine;
          gone ||= ['destroyed','deleted'].includes(m.state) || m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== sc.email;
        } else await r.body?.cancel();
        if (!gone) { await env.DB.prepare('UPDATE sandbox_credentials SET updated_at=? WHERE id=?').bind(seconds(), sc.id).run(); continue; }
        await revokeSandboxCredentials(env, sc.sandbox_id);
      }
      const id = sc.secret_id ?? (await findSecret(env, sc.secret_name))?.id;
      // A timed-out create may become visible after an early metadata read.
      // Keep its exact-name tombstone for a day before accepting absence.
      if (!id && !sc.secret_id && sc.created_at > seconds() - 86400) continue;
      if (id) {
        const r = await call(env, `/secret/${encodeURIComponent(id)}`, 'DELETE');
        if (!r.ok && r.status !== 404) { await r.body?.cancel(); continue; }
        await r.body?.cancel();
      }
      await env.DB.prepare("DELETE FROM sandbox_credentials WHERE id=? AND state='revoked'").bind(sc.id).run();
    } catch { /* Durable outbox retries; no content or credential logging. */ }
    finally {
      // A failing provider deletion must not starve later owners in a bounded sweep.
      await env.DB.prepare('UPDATE sandbox_credentials SET updated_at=? WHERE id=?').bind(seconds(), sc.id).run();
    }
  }
}
