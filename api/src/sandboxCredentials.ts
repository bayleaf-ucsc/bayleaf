/** Independent sandbox authority. D1 holds verifiers; Daytona v2 holds bearers.
 * All issuance/mount/rotation calls are serialized by the owner's controller.
 * No provider inference keys are minted here. Never log provider responses.
 * Legacy v0 rows (non-v2 secret names) never authenticate, rotate or remount.
 */
import type { Bindings, UserKeyRow } from './types';
import { USER_ACTIVITY_COLUMNS } from './userActivity';
import { getV2Sandbox, v2Call, v2SandboxPath } from './daytonaV2';

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
export const v2SecretName = (name: string) => /^BAYLEAF_SANDBOX_[A-F0-9]{32}$/.test(name);

export async function v2CredentialApplied(env: Bindings, sc: SandboxCredential) {
  if (!v2SecretName(sc.secret_name)) return false;
  const r = await v2Call(env, `${v2SandboxPath(sc.sandbox_id)}/secrets`);
  if (!r.ok) { await r.body?.cancel(); throw new Error('sandbox_secret_unavailable'); }
  const { secrets, status } = await r.json() as { secrets?: string[]; status?: string };
  return status === 'applied' && Array.isArray(secrets) && secrets.includes(sc.secret_name);
}
export async function getAccountRow(email: string, env: Bindings) {
  return env.DB.prepare(`SELECT ${USER_ACTIVITY_COLUMNS} FROM user_keys WHERE email=?`).bind(email).first<UserKeyRow>();
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

/** Fail closed on missing/replaced/deleted machines, including external deletion,
 * and on legacy secret names or sandbox IDs. This is a passive control-plane read,
 * never Toolbox or an activity refresh.
 */
export async function authenticateSandboxCredential(env: Bindings, bearer: string): Promise<UserKeyRow | null> {
  if (!/^sk-bayleaf-sandbox-[a-f0-9]{64}$/.test(bearer)) return null;
  const sc = await env.DB.prepare("SELECT * FROM sandbox_credentials WHERE token_hash=? AND state='active'")
    .bind(await credentialHash(bearer)).first<SandboxCredential>();
  if (!sc || !v2SecretName(sc.secret_name)) return null;
  const owner = await getAccountRow(sc.email, env);
  if (!owner || owner.daytona_sandbox_id !== sc.sandbox_id) return null;
  try {
    const m = await getV2Sandbox(sc.sandbox_id, env);
    if (!m || m.state === 'deleting' || m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== sc.email) return null;
    return { ...owner, sandbox_credential_id: sc.id, toolbox_proxy_url: m.toolboxProxyUrl };
  } catch { return null; }
}

/** Called before wake. Never replace an unrelated mount map: unrelated names are preserved. */
export async function ensureSandboxCredential(env: Bindings, email: string, sandboxId: string): Promise<SandboxCredential> {
  const existing = await activeSandboxCredential(env, email, sandboxId);
  if (existing && v2SecretName(existing.secret_name)) return existing;
  // A legacy active row can never authenticate; retire it so setup issues a v2 credential.
  if (existing) await revokeSandboxCredentials(env, sandboxId);
  const m = await getV2Sandbox(sandboxId, env);
  if (!m || m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== email) throw new Error('ownership_mismatch');
  if (!['started', 'stopped', 'paused'].includes(m.state)) throw new Error('sandbox_secret_unavailable');
  // The owner controller serializes setup. A pending row left by an interrupted
  // attempt has no recoverable bearer; retain it only for provider cleanup.
  await env.DB.prepare("UPDATE sandbox_credentials SET state='revoked',updated_at=? WHERE email=? AND sandbox_id=? AND state='pending'")
    .bind(seconds(), email, sandboxId).run();
  const mount = `${v2SandboxPath(sandboxId)}/secrets`;
  const current = await v2Call(env, mount);
  const revision = current.headers.get('ETag');
  if (!current.ok || !revision) { await current.body?.cancel(); throw new Error('sandbox_secret_unavailable'); }
  const { secrets, status } = await current.json() as { secrets: string[]; status?: string };
  if (status === 'pending') throw new Error('sandbox_secret_unavailable');
  if (!Array.isArray(secrets) || secrets.some(s => typeof s !== 'string')) {
    throw new Error('existing_secret_mounts');
  }
  // Preserve every unrelated mount and remove only names already owned by this
  // sandbox's revoked credential rows. The ETag protects concurrent updates.
  const revoked = await env.DB.prepare("SELECT secret_name FROM sandbox_credentials WHERE sandbox_id=? AND state='revoked'")
    .bind(sandboxId).all<{ secret_name: string }>();
  const replaceable = new Set(revoked.results.map(r => r.secret_name).filter(v2SecretName));
  const id = crypto.randomUUID(), bearer = token(), name = `BAYLEAF_SANDBOX_${id.replaceAll('-', '').toUpperCase()}`;
  const secret = `/secrets/${name}`;
  await env.DB.prepare(`INSERT INTO sandbox_credentials(id,email,sandbox_id,token_hash,secret_name,state,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending',?,?)`).bind(id, email, sandboxId, await credentialHash(bearer), name, seconds(), seconds()).run();
  try {
    const created = await v2Call(env, secret, 'PUT', { value: bearer, allowed_domains: ['api.bayleaf.dev'] }, { 'If-None-Match': '*' });
    if (created.status !== 201) { await created.body?.cancel(); throw new Error('secret_unavailable'); }
    const info = await created.json() as { name?: string; allowed_domains?: string[] };
    if (info.name !== name || info.allowed_domains?.length !== 1 || info.allowed_domains[0] !== 'api.bayleaf.dev') {
      throw new Error('secret_unavailable');
    }
    const attached = await v2Call(env, mount, 'PUT',
      { secrets: [...secrets.filter(s => !replaceable.has(s)), name] }, { 'If-Match': revision });
    await attached.body?.cancel();
    if (!attached.ok) throw new Error('secret_attachment_failed');
    const activated = await env.DB.prepare(`UPDATE sandbox_credentials SET state='active',secret_id=?,updated_at=?
      WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM user_keys WHERE email=? AND daytona_sandbox_id=?)`)
      .bind(name, seconds(), id, email, sandboxId).run();
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
  if (!sc.secret_id || !v2SecretName(sc.secret_name)) {
    await revokeSandboxCredentials(env, sc.sandbox_id);
    throw new Error('rotation_failed');
  }
  const bearer = token();
  await env.DB.prepare("UPDATE sandbox_credentials SET token_hash=?,updated_at=? WHERE id=? AND state='active'")
    .bind(await credentialHash(bearer), seconds(), sc.id).run();
  try {
    const r = await v2Call(env, `/secrets/${sc.secret_name}`, 'PUT', { value: bearer, allowed_domains: ['api.bayleaf.dev'] });
    if (!r.ok) throw new Error('secret_unavailable');
    await r.body?.cancel();
  } catch { await revokeSandboxCredentials(env, sc.sandbox_id); throw new Error('rotation_failed'); }
}

async function cleanupV2Credential(env: Bindings, sc: SandboxCredential) {
  const m = await getV2Sandbox(sc.sandbox_id, env);
  if (sc.state === 'active') {
    const owner = await getAccountRow(sc.email, env);
    if (m && m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] === sc.email && owner?.daytona_sandbox_id === sc.sandbox_id) return;
    await revokeSandboxCredentials(env, sc.sandbox_id);
  }
  if (m && m.state !== 'deleting' && m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] === sc.email) {
    const path = `${v2SandboxPath(m.id)}/secrets`;
    const r = await v2Call(env, path);
    const revision = r.headers.get('ETag');
    if (!r.ok || !revision) { await r.body?.cancel(); return; }
    const { secrets, status } = await r.json() as { secrets: string[]; status?: string };
    if (!Array.isArray(secrets) || status === 'pending') return;
    if (secrets.includes(sc.secret_name)) {
      const updated = await v2Call(env, path, 'PUT', { secrets: secrets.filter(s => s !== sc.secret_name) }, { 'If-Match': revision });
      await updated.body?.cancel();
      return; // Detachment is asynchronous; next scheduled pass verifies it.
    }
  }
  const r = await v2Call(env, `/secrets/${sc.secret_name}`, 'DELETE');
  await r.body?.cancel();
  if (r.ok || (r.status === 404 && (sc.secret_id || sc.created_at <= seconds() - 86400))) {
    await env.DB.prepare("DELETE FROM sandbox_credentials WHERE id=? AND state='revoked'").bind(sc.id).run();
  }
}

/** Hourly, bounded cleanup. Pending rows older than setup's deadline cannot authorize.
 * Keeps an outbox row until deletion succeeds, including ambiguous secret creation.
 * Legacy v0 rows have no provider outbox left to drain (their Daytona v0 secrets
 * were verified absent at retirement), so they are revoked and dropped locally.
 */
export async function cleanupSandboxCredentials(env: Bindings) {
  await env.DB.prepare("UPDATE sandbox_credentials SET state='revoked' WHERE state='pending' AND created_at<?")
    .bind(seconds() - 1200).run();
  const rows = await env.DB.prepare('SELECT * FROM sandbox_credentials ORDER BY updated_at LIMIT 100').all<SandboxCredential>();
  for (const sc of rows.results) {
    try {
      if (sc.state === 'pending') continue;
      if (!v2SecretName(sc.secret_name)) {
        await env.DB.prepare("UPDATE sandbox_credentials SET state='revoked',updated_at=? WHERE id=?").bind(seconds(), sc.id).run();
        await env.DB.prepare("DELETE FROM sandbox_credentials WHERE id=? AND state='revoked'").bind(sc.id).run();
        continue;
      }
      await cleanupV2Credential(env, sc);
    } catch { /* Durable outbox retries; no content or credential logging. */ }
    finally {
      // A failing provider deletion must not starve later owners in a bounded sweep.
      await env.DB.prepare('UPDATE sandbox_credentials SET updated_at=? WHERE id=?').bind(seconds(), sc.id).run();
    }
  }
}
