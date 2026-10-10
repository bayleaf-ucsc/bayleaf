/** Fixed-client management RPC. This entrypoint has no public HTTP API. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Bindings } from './types';
import { ensureUserRow } from './provision';
import { getAccountRow } from './sandboxCredentials';
import { browserEnabled } from './sandboxBrowser';
import { wakeExistingSandbox } from './sandboxWake';
import { serviceDef } from './serviceDefs';

export const SERVICE_ORIGIN = 'https://sandbox.bayleaf.dev';
export const SERVICE_AUTHORIZE_PATH = '/auth/service/authorize';
const FLOW_SECONDS = 600;
const SESSION_SECONDS = 86400;
export const serviceNow = () => Math.floor(Date.now() / 1000);
export const serviceToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export const validServiceToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function serviceHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function validVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}
function inputObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key));
}
export function serviceApiOrigin(env: Bindings): string | null {
  try {
    const url = new URL(env.PREVIEWS_API_ORIGIN ?? '');
    return url.protocol === 'https:' && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}
export interface ServiceFlow {
  id: string; verifier_hash: string; broker_hash: string | null;
  stage: 'started' | 'bound' | 'proved' | 'issued'; code_hash: string | null;
  email: string | null; name: string | null; expires_at: number;
}
export async function readServiceFlow(env: Bindings, id: unknown): Promise<ServiceFlow | null> {
  if (!validServiceToken(id)) return null;
  return env.DB.prepare('SELECT * FROM service_login_flows WHERE id=? AND expires_at>?')
    .bind(id, serviceNow()).first<ServiceFlow>();
}
interface SessionRow { email: string; name: string; owner_hash: string; expires_at: number }
async function sessionIdentity(env: Bindings, session: unknown) {
  if (!validServiceToken(session)) return null;
  const row = await env.DB.prepare('SELECT email,name,owner_hash,expires_at FROM service_sessions WHERE session_hash=? AND expires_at>?')
    .bind(await serviceHash(session), serviceNow()).first<SessionRow>();
  if (!row) return null;
  const owner = await getAccountRow(row.email, env);
  if (!owner || owner.account_generation !== row.owner_hash) return null;
  return { user: { email: row.email, name: row.name }, expiresAt: row.expires_at };
}

export class SandboxManagement extends WorkerEntrypoint<Bindings> {
  async beginLogin(input: unknown) {
    if (!inputObject(input, ['verifierHash']) || !validServiceToken(input.verifierHash)) return null;
    const origin = serviceApiOrigin(this.env);
    if (!origin) return null;
    try {
      const flow = serviceToken();
      await this.env.DB.prepare("INSERT INTO service_login_flows(id,verifier_hash,stage,expires_at) VALUES (?,?,'started',?)")
        .bind(flow, input.verifierHash, serviceNow() + FLOW_SECONDS).run();
      return { flow, authorizeUrl: `${origin}${SERVICE_AUTHORIZE_PATH}?flow=${flow}` };
    } catch { return null; }
  }

  async proveLogin(input: unknown) {
    if (!inputObject(input, ['flow', 'verifier']) || !validServiceToken(input.flow) || !validVerifier(input.verifier)) return null;
    const origin = serviceApiOrigin(this.env);
    if (!origin) return null;
    try {
      const row = await this.env.DB.prepare(`UPDATE service_login_flows SET stage='proved'
        WHERE id=? AND verifier_hash=? AND stage='bound' AND expires_at>? RETURNING id`)
        .bind(input.flow, await serviceHash(input.verifier), serviceNow()).first();
      return row ? { authorizeUrl: `${origin}${SERVICE_AUTHORIZE_PATH}?flow=${input.flow}` } : null;
    } catch { return null; }
  }

  async exchangeLogin(input: unknown) {
    if (!inputObject(input, ['flow', 'code', 'verifier']) || !validServiceToken(input.flow) ||
        !validServiceToken(input.code) || !validVerifier(input.verifier)) return null;
    try {
      // DELETE RETURNING is the single-use boundary, including concurrent exchanges.
      const flow = await this.env.DB.prepare(`DELETE FROM service_login_flows
        WHERE id=? AND code_hash=? AND verifier_hash=? AND stage='issued' AND expires_at>?
        RETURNING email,name`).bind(input.flow, await serviceHash(input.code), await serviceHash(input.verifier), serviceNow())
        .first<{ email: string; name: string }>();
      if (!flow) return null;
      // Only this successful, proved login may establish a first-time owner row.
      // Ordinary-key revocation does not suspend the account or this login.
      let owner = await getAccountRow(flow.email, this.env);
      if (!owner) {
        owner = await ensureUserRow(flow.email, this.env);
      }
      if (!owner) return null;
      const session = serviceToken();
      const expiresAt = serviceNow() + SESSION_SECONDS;
      await this.env.DB.prepare('INSERT INTO service_sessions(session_hash,email,name,owner_hash,expires_at) VALUES (?,?,?,?,?)')
        .bind(await serviceHash(session), flow.email, flow.name, owner.account_generation, expiresAt).run();
      return { session, user: { email: flow.email, name: flow.name }, expiresAt };
    } catch { return null; }
  }

  async readSession(input: unknown) {
    if (!inputObject(input, ['session'])) return null;
    try { return await sessionIdentity(this.env, input.session); } catch { return null; }
  }

  async logout(input: unknown) {
    if (!inputObject(input, ['session']) || !validServiceToken(input.session)) return false;
    try {
      await this.env.DB.prepare('DELETE FROM service_sessions WHERE session_hash=?').bind(await serviceHash(input.session)).run();
      return true;
    } catch { return false; }
  }

  async managed(input: unknown): Promise<{ status: number; body: unknown }> {
    if (!inputObject(input, ['session', 'operation', 'service']) || !validServiceToken(input.session) ||
        !['status', 'start', 'restart', 'wake-existing'].includes(input.operation as string) ||
        (input.operation === 'wake-existing' ? input.service !== undefined : !serviceDef(input.service))) {
      return { status: 400, body: { error: 'invalid_operation' } };
    }
    try {
      const identity = await sessionIdentity(this.env, input.session);
      if (!identity) return { status: 401, body: { error: 'login_required' } };
      if (input.operation === 'wake-existing') {
        const response = await wakeExistingSandbox(identity.user.email, this.env);
        return { status: response.status, body: await response.json() };
      }
      if (!browserEnabled(this.env)) return { status: 503, body: { error: 'browser_disabled' } };
      const stub = this.env.SANDBOX_BROWSER.get(this.env.SANDBOX_BROWSER.idFromName(identity.user.email));
      const response = await stub.fetch(`https://controller/${input.operation}${input.service ? `?service=${input.service}` : ''}`, {
        method: input.operation === 'status' ? 'GET' : 'POST', headers: { 'X-BayLeaf-Owner': identity.user.email },
      });
      return { status: response.status, body: await response.json() };
    } catch { return { status: 503, body: { error: 'service_unavailable' } }; }
  }
}

export async function cleanupServiceSessions(env: Bindings): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM service_login_flows WHERE expires_at<=?').bind(serviceNow()),
    env.DB.prepare('DELETE FROM service_sessions WHERE expires_at<=?').bind(serviceNow()),
  ]);
}
