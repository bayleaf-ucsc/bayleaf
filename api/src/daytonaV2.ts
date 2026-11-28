/** Daytona v2 wire contract. The rollback-only v0 transport lives in daytona.ts. */
import type { Bindings } from './types';
import type { SandboxInfo, ExecResult } from './daytona';

const API = 'https://api.daytona.com';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const daytonaV2 = (env: Bindings) => env.DAYTONA_API_VERSION === '2';
export const legacySandboxId = (id: string) => UUID.test(id);
export const v2SandboxPath = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;

export function v2Call(env: Bindings, path: string, method = 'GET', body?: unknown, headers?: HeadersInit) {
  const outgoing = new Headers(headers);
  outgoing.set('Authorization', `Bearer ${env.DAYTONA_API_KEY}`);
  if (body !== undefined) outgoing.set('Content-Type', 'application/json');
  return fetch(API + path, { method, headers: outgoing, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30_000),
    body: body === undefined ? undefined : JSON.stringify(body) });
}

interface V2Sandbox {
  id: string;
  status: string;
  name?: string;
  labels?: Record<string, string>;
  persistent?: boolean;
  cpu?: number;
  cores_max?: number;
  memory_mib?: number;
  memory_max_mib?: number;
  disk_max_mib?: number;
  created_at?: string;
  updated_at?: string;
  toolbox_proxy_url?: string;
  region_id?: string;
  lifecycle_policy?: { last_activity_at?: string; idle_expiry_seconds?: number; on_idle_timeout?: string };
}

function normalize(m: V2Sandbox): SandboxInfo {
  if (!m || typeof m.id !== 'string' || !m.id.startsWith('sbx_') || typeof m.status !== 'string') {
    throw new Error('Invalid Daytona v2 sandbox metadata');
  }
  const states: Record<string, string> = { running: 'started', queued: 'starting', pending: 'starting',
    assigned: 'starting', booting: 'starting', failed: 'error', lost: 'error' };
  return {
    id: m.id, name: m.name, labels: m.labels, state: states[m.status] ?? m.status, persistent: m.persistent,
    cpu: m.cores_max === undefined ? undefined : m.cores_max * 2,
    reservedCpu: m.cpu === undefined ? undefined : m.cpu * 2,
    memory: m.memory_max_mib === undefined ? undefined : m.memory_max_mib / 1024,
    reservedMemory: m.memory_mib === undefined ? undefined : m.memory_mib / 1024,
    disk: m.disk_max_mib === undefined ? undefined : m.disk_max_mib / 1024,
    createdAt: m.created_at, updatedAt: m.updated_at, lastActivityAt: m.lifecycle_policy?.last_activity_at,
    idlePauseMinutes: m.lifecycle_policy?.on_idle_timeout === 'pause' && m.lifecycle_policy.idle_expiry_seconds
      ? m.lifecycle_policy.idle_expiry_seconds / 60 : undefined,
    toolboxProxyUrl: m.toolbox_proxy_url, target: m.region_id,
  };
}

async function readV2Sandbox(id: string, env: Bindings): Promise<SandboxInfo | null> {
  if (legacySandboxId(id)) throw new Error('Sandbox migration has not completed');
  const r = await v2Call(env, v2SandboxPath(id));
  if (r.status === 404) { await r.body?.cancel(); return null; }
  if (!r.ok) { await r.body?.cancel(); throw new Error(`Daytona sandbox lookup failed (${r.status})`); }
  const m = normalize(await r.json() as V2Sandbox);
  if (m.id !== id) throw new Error('Daytona returned a different sandbox ID');
  return m;
}

export async function getV2Sandbox(id: string, env: Bindings): Promise<SandboxInfo | null> {
  const m = await readV2Sandbox(id, env);
  return m?.state === 'deleted' ? null : m;
}

export async function listV2Sandboxes(env: Bindings, email?: string): Promise<string[]> {
  const query = new URLSearchParams({ limit: '100' });
  if (email !== undefined) query.set('labels', JSON.stringify({ [env.DAYTONA_DEPLOYMENT_LABEL]: email }));
  const ids = new Set<string>();
  const cursors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const r = await v2Call(env, `/sandboxes/search?${query}`);
    if (!r.ok) { await r.body?.cancel(); throw new Error(`Daytona sandbox search failed (${r.status})`); }
    const data = await r.json() as { sandboxes?: V2Sandbox[]; next_cursor?: string | null };
    if (!Array.isArray(data.sandboxes) || !Object.hasOwn(data, 'next_cursor')) throw new Error('Invalid sandbox search page');
    for (const m of data.sandboxes) {
      if (!m || typeof m.id !== 'string' || !m.id.startsWith('sbx_')) throw new Error('Invalid sandbox search entry');
      if (m.status !== 'deleted') ids.add(m.id);
    }
    if (data.next_cursor === null) return [...ids];
    if (typeof data.next_cursor !== 'string' || !data.next_cursor || cursors.has(data.next_cursor)) break;
    cursors.add(data.next_cursor);
    query.set('cursor', data.next_cursor);
  }
  throw new Error('Daytona sandbox search did not complete');
}

export async function findV2Sandbox(email: string, env: Bindings): Promise<SandboxInfo | null> {
  const matches: SandboxInfo[] = [];
  for (const id of await listV2Sandboxes(env, email)) {
    const s = await getV2Sandbox(id, env);
    if (s?.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] === email) matches.push(s);
  }
  if (matches.length > 1) throw new Error('Multiple Daytona sandboxes match the owner');
  return matches[0] ?? null;
}

export async function createV2Sandbox(email: string, env: Bindings): Promise<SandboxInfo> {
  if (env.DAYTONA_V2_CREATE_ENABLED !== 'true' || !env.DAYTONA_V2_IMAGE || !env.DAYTONA_V2_REGION ||
      !env.DAYTONA_DEPLOYMENT_LABEL) throw new Error('Daytona v2 provisioning is not enabled');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.DAYTONA_DEPLOYMENT_LABEL}\0${email}`));
  const suffix = Array.from(new Uint8Array(digest).slice(0, 16), x => x.toString(16).padStart(2, '0')).join('');
  const username = email.split('@')[0].replace(/[^a-z0-9_-]+/g, '-').slice(0, 40);
  // Stable request identity across API/DO retries. A deleted replay advances the
  // generation; a provider or ownership error never advances it.
  for (let generation = 0; generation < 64; generation++) {
    const r = await v2Call(env, '/sandboxes', 'POST', {
      name: `bayleaf-${username}-${suffix.slice(0, 8)}`,
      idempotency_key: `bayleaf-${suffix}-${generation}`,
      labels: { [env.DAYTONA_DEPLOYMENT_LABEL]: email },
      image: env.DAYTONA_V2_IMAGE, region_id: env.DAYTONA_V2_REGION, persistent: true,
      cpu: 0.5, cores_max: 1, memory_mib: 2048, memory_max_mib: 2048, disk_max_mib: 10240,
      lifecycle_policy: { idle_expiry_seconds: 3600, on_idle_timeout: 'pause', timeout_seconds: 86400, on_timeout: 'pause' },
    });
    if (!r.ok) { await r.body?.cancel(); throw new Error(`Daytona v2 create failed (${r.status})`); }
    const created = await r.json() as { id?: string; status?: string };
    if (typeof created.id !== 'string' || !created.id.startsWith('sbx_')) throw new Error('Invalid Daytona create response');
    if (created.status === 'deleted') continue;
    const sandbox = await readV2Sandbox(created.id, env);
    if (sandbox?.state === 'deleted') continue;
    // A bare 404 can mean either a deleted replay or a fresh sandbox that is
    // not yet visible. Retry the same key on the next request; if Daytona only
    // ever returns 404 for a deleted replay, we cannot safely replace it here.
    if (!sandbox) throw new Error('Daytona create result is not visible; deletion is unconfirmed');
    if (sandbox.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== email || sandbox.persistent !== true) {
      throw new Error('New Daytona sandbox did not match provisioning policy');
    }
    return sandbox;
  }
  throw new Error('Daytona kept replaying deleted sandboxes');
}

export function v2Toolbox(env: Bindings, m: SandboxInfo, path: string, init: RequestInit = {}) {
  if (m.state !== 'started' || !m.toolboxProxyUrl) throw new Error('Daytona Toolbox requires a running sandbox');
  const url = new URL(m.toolboxProxyUrl);
  if (url.protocol !== 'https:' || !/^proxy\.[a-z0-9.-]+\.daytona\.app$/.test(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash || !/^\/toolbox\/?$/.test(url.pathname)) {
    throw new Error('Invalid Daytona regional Toolbox URL');
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${env.DAYTONA_API_KEY}`);
  return fetch(`${url.origin}/toolbox/${encodeURIComponent(m.id)}${path}`, { ...init, headers, redirect: 'manual' });
}

/** Upload to an existing directory without invoking a process in the guest. */
export async function v2UploadFile(env: Bindings, m: SandboxInfo, path: string, file: Blob): Promise<void> {
  const form = new FormData();
  form.append('file', file, 'file');
  const r = await v2Toolbox(env, m, `/files/upload?${new URLSearchParams({ path })}`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  await r.body?.cancel();
  if (!r.ok) throw new Error(`Daytona upload failed (${r.status})`);
}

interface LogPage {
  frames?: { data: string }[];
  nextCursor?: string;
  eof?: boolean;
  truncatedHead?: boolean;
}

export async function v2Execute(env: Bindings, m: SandboxInfo, argv: string[], timeoutMs: number, cwd?: string): Promise<ExecResult> {
  const r = await v2Toolbox(env, m, `/processes?waitMs=${timeoutMs + 1000}&logs=text`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs + 15_000),
    body: JSON.stringify({ argv, timeoutMs, cwd }),
  });
  if (!r.ok) { await r.body?.cancel(); throw new Error(`Daytona command transport failed (${r.status})`); }
  const p = await r.json() as { id: string; exitCode?: number; logs?: LogPage; truncatedHead?: boolean };
  let page = p.logs;
  const chunks: string[] = [];
  const seen = new Set<string>();
  if (p.truncatedHead || !page) throw new Error('Daytona output is incomplete');
  while (page) {
    if (page.truncatedHead || !Array.isArray(page.frames)) throw new Error('Daytona output is incomplete');
    for (const frame of page.frames) chunks.push(frame.data);
    if (page.eof !== false) return { exitCode: p.exitCode ?? -1, output: chunks.join('') };
    const cursor = page.nextCursor;
    if (!cursor || seen.has(cursor) || seen.size >= 100) throw new Error('Daytona output pagination did not complete');
    seen.add(cursor);
    const next = await v2Toolbox(env, m, `/processes/${encodeURIComponent(p.id)}/logs?${new URLSearchParams({ cursor, encoding: 'text' })}`,
      { signal: AbortSignal.timeout(15_000) });
    if (!next.ok) { await next.body?.cancel(); throw new Error('Daytona command logs unavailable'); }
    page = await next.json() as LogPage;
  }
  throw new Error('Daytona output is incomplete');
}
