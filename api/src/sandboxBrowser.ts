/** Owner-scoped lifecycle coordinator. GET observes; only POST begins work.
 * Durable alarms resume bounded setup steps. No prompts, credentials, or logs
 * are stored in the Durable Object. Only bounded step/timing metadata is kept.
 * See SANDBOX-BROWSER.md.
 */
import type { Bindings } from './types';
import setupSource from '../scripts/browser-setup.py';
import jupyterSource from '../scripts/jupyter-adapter.py';
import nanobotAssets from '../.nanobot-assets.json';
import { getAccountRow, activeSandboxCredential, ensureSandboxCredential, revokeSandboxCredentials, rotateSandboxCredential } from './sandboxCredentials';
import { DAYTONA_DEFAULT_API_URL, DAYTONA_DEFAULT_PROXY_URL } from './constants';
import { persistentSandboxParams } from './daytona';
import { registerBrowserPreview, revokeUserPreview, previewsEnabled } from './routes/previews';
import { SERVICE_DEFS, serviceDef, type ServiceId, type ServiceDef } from './serviceDefs';

const LINK_SECONDS = 24 * 3600;
const SETUP_SECONDS = 20 * 60;
const now = () => Math.floor(Date.now() / 1000);
export const browserEnabled = (env: Bindings) => env.BROWSER_SANDBOX_ENABLED === 'true' && previewsEnabled(env);
export const keyHash = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
  b => b.toString(16).padStart(2, '0')).join('');

type Phase = 'opening' | 'ready' | 'failed' | 'expired' | 'stopped';
type Step = 'discover' | 'credentials' | 'wake' | 'prepare' | 'inspect' | 'register' | 'finalize' | 'inspect_final';
interface ProgressEvent { step: string; at: number; error?: string }
interface Operation {
  service?: ServiceId; // Missing on legacy OpenChamber operations.
  nextAt?: number;
  invalidated?: boolean;
  email: string;
  operation: string;
  ownerKeyHash: string;
  phase: Phase;
  step: Step;
  deadline: number;
  setupDeadline: number;
  updatedAt: number;
  sandboxId?: string;
  progress: string;
  error?: string;
  url?: string;
  wakeRequested?: boolean;
  launches?: number;
  creationAttempted?: boolean;
  restart?: boolean;
  transientFailures?: number;
  startedAt?: number;
  timeline?: ProgressEvent[];
  previousFailure?: { at: number; error: string; progress: string; elapsed: number };
  heartbeatAt?: number;
}
interface Machine {
  id: string;
  state: string;
  public?: boolean;
  memory?: number;
  labels?: Record<string, string>;
}
class Problem extends Error {}
const fail = (code: string): never => { throw new Problem(code); };
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

/** Separate from legacy ensureSandbox: a provider outage must never mean absent. */
async function platform(env: Bindings, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch((env.DAYTONA_API_URL || DAYTONA_DEFAULT_API_URL).replace(/\/+$/, '') + path, {
    method, headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
}
async function machine(env: Bindings, id: string): Promise<Machine | null> {
  const r = await platform(env, `/sandbox/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) return fail('provider_unavailable');
  return r.json();
}
async function discover(env: Bindings, email: string): Promise<Machine | null> {
  const labels = { [env.DAYTONA_DEPLOYMENT_LABEL]: email };
  const r = await platform(env, `/sandbox?labels=${encodeURIComponent(JSON.stringify(labels))}`);
  if (!r.ok) return fail('provider_unavailable');
  const data = await r.json() as Machine[] | { items: Machine[]; total?: number };
  const entries = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(entries)) return fail('provider_unavailable');
  const matches = entries.filter(x => x.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] === email);
  if (matches.length > 1 || (!Array.isArray(data) && data.total !== undefined && data.total > entries.length)) return fail('ambiguous_sandbox');
  return matches[0] ?? null;
}
function toolbox(env: Bindings, id: string, path: string) {
  return `${(env.DAYTONA_PROXY_URL || DAYTONA_DEFAULT_PROXY_URL).replace(/\/+$/, '')}/${encodeURIComponent(id)}${path}`;
}
async function execute(env: Bindings, id: string, command: string): Promise<string> {
  const r = await fetch(toolbox(env, id, '/process/execute'), {
    method: 'POST', headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, timeout: 10000 }), redirect: 'manual', signal: AbortSignal.timeout(15_000),
  }).catch(() => fail('toolbox_unavailable'));
  if (!r.ok) return fail('toolbox_unavailable');
  const data = await r.json() as { exitCode?: number; result?: string };
  if (data.exitCode !== 0) return fail('setup_command_failed');
  return data.result ?? '';
}
async function upload(env: Bindings, id: string, root: string, name: string, content: string) {
  const form = new FormData();
  form.append('file', new Blob([content]), 'file');
  const r = await fetch(toolbox(env, id, `/files/upload?path=${encodeURIComponent(`${root}/${name}`)}`), {
    method: 'POST', headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}` }, body: form,
    redirect: 'manual', signal: AbortSignal.timeout(15_000),
  }).catch(() => fail('setup_transfer_failed'));
  if (!r.ok) fail('setup_transfer_failed');
  await r.body?.cancel();
}
const launch = (operation: string, def: ServiceDef) => `python3 -c ${JSON.stringify(
  `import subprocess; subprocess.Popen(['python3','${def.root}/setup.py','--service','${def.id}','setup','--operation','${operation}'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)`
)}`;
const operationKey = (service: ServiceId = 'openchamber') => service === 'openchamber' ? 'operation' : `operation/${service}`;
const dueAt = (op: Operation) => op.phase === 'ready' ? op.deadline * 1000 :
  op.phase === 'opening' ? Math.min(op.nextAt ?? 0, op.setupDeadline * 1000, op.deadline * 1000) :
  !op.invalidated ? op.nextAt ?? 0 : Infinity;

// Reconstructible per-operation application credential, never DO metadata or a
// management response. Apps may return their own WS token (ttyd /token).
// Purpose-separated from preview encryption/session signing.
async function managedAppSecret(env: Bindings, op: Operation): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.PREVIEWS_SECRET),
    {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key,
    encoder.encode(`bayleaf:${op.service}:bootstrap:v1:${op.operation}:${op.ownerKeyHash}`));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
}

export class SandboxBrowser {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private state: DurableObjectState, private env: Bindings) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Do not hold blockConcurrencyWhile across provider calls (30-second limit).
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async operations() {
    const records = await Promise.all(Object.keys(SERVICE_DEFS).map(id =>
      this.state.storage.get<Operation>(operationKey(id as ServiceId))));
    return records.filter((op): op is Operation => !!op);
  }
  private async arm() {
    const times = (await this.operations()).map(dueAt).filter(Number.isFinite);
    if (times.length) await this.state.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...times)));
    else await this.state.storage.deleteAlarm();
  }
  private async schedule(op: Operation, at: number) {
    op.nextAt = at;
    await this.save(op);
  }
  private async save(op: Operation) {
    op.updatedAt = now();
    op.startedAt ??= op.updatedAt;
    const timeline = op.timeline ??= [];
    const step = ['failed','expired','stopped'].includes(op.phase) ? op.phase : op.progress;
    if (timeline.at(-1)?.step !== step || timeline.at(-1)?.error !== op.error) {
      timeline.push({ step, at: op.updatedAt, ...(op.error ? {error:op.error} : {}) });
    }
    op.timeline = timeline.slice(-40);
    await this.state.storage.put(operationKey(op.service), op);
  }
  private async retire(op: Operation, phase: Phase, error?: string) {
    // Keep retrying invalidation if D1/DO transport is temporarily unavailable.
    op.invalidated = false;
    op.nextAt = Date.now() + 30_000;
    op.phase = phase; op.error = error; delete op.url;
    await this.save(op);
    await this.arm();
    op.invalidated = await revokeUserPreview(this.env, op.email, SERVICE_DEFS[op.service ?? 'openchamber'].slot);
    await this.save(op);
  }
  private async linkDeadline(op: Operation) {
    if (!op.url) return 0;
    const record = await this.env.DB.prepare(`SELECT expires_at FROM preview_registrations
      WHERE hostname=? AND email=? AND deployment='__browser' AND slot=? AND owner_key_hash=?`)
      .bind(new URL(op.url).hostname, op.email, SERVICE_DEFS[op.service ?? 'openchamber'].slot, op.ownerKeyHash)
      .first<{ expires_at: number }>();
    return Math.min(op.deadline, record?.expires_at ?? 0);
  }
  private async view(email: string, service: ServiceId = 'openchamber') {
    const op = await this.state.storage.get<Operation>(operationKey(service));
    const row = await getAccountRow(email, this.env);
    if (!row) return response({ phase: 'unavailable', error: 'personal_key_required' }, 403);
    const access = op?.sandboxId ? await activeSandboxCredential(this.env, email, op.sandboxId) : null;
    const validKey = !op || op.step === 'discover' || op.step === 'credentials' || access?.id === op.ownerKeyHash;
    // Control-plane GET only. No readiness probes, file reads, or last-activity writes.
    const recorded = op?.sandboxId ? await machine(this.env, op.sandboxId) : null;
    const current = recorded ?? await discover(this.env, email);
    // Chat/API may have replaced a deleted machine since the last managed setup.
    // A confirmed 404 permits passive rediscovery, never inheritance of its app URL.
    if (current && op?.sandboxId && current.id !== op.sandboxId && op.phase !== 'opening') {
      return response({ phase: 'idle', machine: current.state, progress: 'unchecked' });
    }
    // A destroyed shared machine cannot retain an actionable installation error.
    // Keep old operation metadata internally for reconciliation, not in the UI.
    if (!current && op?.phase !== 'opening') return response({ phase: 'idle', machine: 'absent', progress: 'unchecked' });
    const owned = current && current.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] === email;
    // Reconcile historical six-hour registrations and externally revoked links
    // without contacting compute or extending a lease on a passive read.
    const deadline = op?.phase === 'ready' ? await this.linkDeadline(op) : op?.deadline;
    const expired = deadline !== undefined && deadline <= now();
    const ready = op?.phase === 'ready' && !expired && validKey && owned && current.state === 'started';
    return response({ phase: !op ? 'idle' : !validKey ? 'failed' : expired ? 'expired' : op.phase,
      machine: current ? owned ? current.state : 'unavailable' : 'absent',
      progress: op?.progress ?? 'unchecked', operation: op?.operation,
      error: !validKey ? 'credential_changed' : op?.error,
      deadline, url: ready ? op.url : undefined,
      // Setup status freshness is explicit; GET never probes the application.
      updated_at: op?.updatedAt, started_at: op?.startedAt,
      heartbeat_at: op?.heartbeatAt, timeline: op?.timeline ?? [], previous_failure: op?.previousFailure });
  }

  async fetch(req: Request): Promise<Response> {
    try {
      const u = new URL(req.url);
      const email = req.headers.get('X-BayLeaf-Owner') ?? '';
      if (!email || !this.state.id.equals(this.env.SANDBOX_BROWSER.idFromName(email))) return response({ error: 'denied' }, 403);
      // The management login may wake compute without enabling or installing an
      // application. This path is private to the service binding, never routed
      // by the public /sandbox/browser adapter.
      if (req.method === 'POST' && u.pathname === '/wake-existing') {
        return await this.exclusive(async () => {
          if (!await getAccountRow(email, this.env)) return response({ error: 'account_required' }, 403);
          const current = await discover(this.env, email);
          if (!current) return response({ state: 'absent' });
          if (!current.id || current.public === true) return response({ error: 'sandbox_unavailable' }, 503);
          const ops = await this.operations();
          // Active setup already owns wake/recovery and must not be interrupted.
          if (ops.some(op => op.phase === 'opening' && op.setupDeadline > now())) return response({ state: 'opening' });
          if (['stopped', 'archived'].includes(current.state)) {
            // Mount before waking, so first attachment never needs to interrupt compute.
            // Login alone does not authorize issuance: app setup does that.
            if (!await activeSandboxCredential(this.env, email, current.id)) return response({ state: current.state });
            // A control-plane wake does not restore application processes. Do
            // not let an old ready record become apparently usable after wake.
            for (const op of ops) if (op.phase === 'ready') await this.retire(op, 'stopped');
            await this.arm();
            const result = await platform(this.env, `/sandbox/${encodeURIComponent(current.id)}/start`, 'POST');
            await result.body?.cancel();
            return result.ok ? response({ state: 'starting' }) : response({ error: 'wake_unavailable' }, 503);
          }
          if (current.state === 'started') {
            const result = await platform(this.env, `/sandbox/${encodeURIComponent(current.id)}/last-activity`, 'POST');
            await result.body?.cancel();
            return result.ok ? response({ state: 'started' }) : response({ error: 'wake_unavailable' }, 503);
          }
          return response({ state: 'transitioning' });
        });
      }
      if (req.method === 'POST' && ['/access/revoke', '/access/rotate'].includes(u.pathname)) {
        return await this.exclusive(async () => {
          const row = await getAccountRow(email, this.env);
          if (!row) return response({ error: 'account_required' }, 403);
          const sc = row.daytona_sandbox_id ? await activeSandboxCredential(this.env, email, row.daytona_sandbox_id) : null;
          if (u.pathname === '/access/rotate') {
            if (!sc) return response({ error: 'sandbox_access_unavailable' }, 409);
            await rotateSandboxCredential(this.env, sc);
          } else {
            if (row.daytona_sandbox_id) await revokeSandboxCredentials(this.env, row.daytona_sandbox_id);
            for (const op of await this.operations()) await this.retire(op, 'stopped', 'sandbox_access_revoked');
            await this.arm();
          }
          return response({ success: true });
        });
      }
      if (!browserEnabled(this.env)) return response({ error: 'browser_disabled' }, 503);
      const def = serviceDef(u.searchParams.get('service') ?? 'openchamber');
      if (!def) return response({ error: 'invalid_operation' }, 400);
      if (req.method === 'GET' && u.pathname === '/status') return await this.view(email, def.id);
      if (req.method !== 'POST' || !['/start', '/restart'].includes(u.pathname)) return response({ error: 'not_found' }, 404);
      return await this.exclusive(async () => {
        const row = await getAccountRow(email, this.env);
        if (!row) return response({ error: 'personal_key_required' }, 403);
        const previous = await this.state.storage.get<Operation>(operationKey(def.id));
        const other = (await this.operations()).find(op => (op.service ?? 'openchamber') !== def.id && op.phase === 'opening');
        if (other) return response({ error: 'service_busy', service: other.service ?? 'openchamber' }, 409);
        // Repeated clicks during setup converge on one persisted operation.
        if (previous?.phase === 'opening' && previous.setupDeadline > now() && previous.deadline > now()) {
          return response({ phase: previous.phase, operation: previous.operation }, 202);
        }
        const access = row.daytona_sandbox_id ? await activeSandboxCredential(this.env, email, row.daytona_sandbox_id) : null;
        const hash = access?.id ?? row.account_generation;
        if (u.pathname === '/start' && previous?.phase === 'ready' && previous.deadline > now() && previous.ownerKeyHash === hash && previous.sandboxId && await this.linkDeadline(previous) > now()) {
          const m = await machine(this.env, previous.sandboxId);
          if (m?.state === 'started' && m.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] === email) return this.view(email, def.id);
        }
        // Link lifetime is independent of compute and the bounded installer.
        const deadline = now() + LINK_SECONDS;
        const op: Operation = { email, service: def.id, operation: crypto.randomUUID(), ownerKeyHash: hash,
          phase: 'opening', step: 'discover', progress: 'locating_sandbox', deadline,
          setupDeadline: Math.min(now() + SETUP_SECONDS, deadline), updatedAt: now(), startedAt: now(), restart: u.pathname === '/restart',
          previousFailure: previous?.phase === 'failed' ? { at:previous.updatedAt,
            error:previous.error ?? 'setup_failed', progress:previous.progress,
            elapsed:Math.max(0,previous.updatedAt - (previous.startedAt ?? previous.updatedAt)) } : previous?.previousFailure };
        await this.save(op);
        await this.arm();
        return response({ phase: op.phase, operation: op.operation }, 202);
      });
    } catch {
      // Provider errors can contain credentials/URLs. Never log or echo them.
      return response({ error: 'lifecycle_unavailable' }, 503);
    }
  }

  async alarm() {
    await this.exclusive(async () => {
      // One alarm for the owner. Retire due links and advance at most one setup.
      await this.state.storage.setAlarm(Date.now() + 15_000);
      try {
        for (const service of Object.keys(SERVICE_DEFS)) {
          // A preceding step can retire a sibling's stale ready state on wake.
          // Read it now, not from an earlier all-services snapshot.
          const op = await this.state.storage.get<Operation>(operationKey(service as ServiceId));
          if (op && dueAt(op) <= Date.now()) await this.advance(op);
        }
      } finally { await this.arm(); }
    });
  }
  private async advance(op: Operation) {
      const def = SERVICE_DEFS[op.service ?? 'openchamber'];
      const ROOT = def.root;
      const INSTALL_STEPS = new Set<string>(def.steps);
      const SETUP_ERRORS = new Set<string>(def.errors);
      // Persist retry intent before side effects, including after an eviction.
      await this.schedule(op, Date.now() + 15_000);
      try {
        const row = await getAccountRow(op.email, this.env);
        const access = op.sandboxId ? await activeSandboxCredential(this.env, op.email, op.sandboxId) : null;
        if (!browserEnabled(this.env) || !row ||
            (!['discover', 'credentials'].includes(op.step) && access?.id !== op.ownerKeyHash)) {
          await this.retire(op, 'failed', 'credential_or_feature_unavailable'); return;
        }
        if (op.deadline <= now()) { await this.retire(op, 'expired'); return; }
        if (['failed', 'stopped', 'expired'].includes(op.phase)) { await this.retire(op, op.phase, op.error); return; }
        if (op.phase === 'ready') return;
        if (op.setupDeadline <= now()) { await this.retire(op, 'failed', 'setup_timeout'); return; }
        if (op.url && await this.linkDeadline(op) <= now()) { await this.retire(op, 'expired'); return; }

        if (op.step === 'discover') {
          await revokeUserPreview(this.env, op.email, def.slot);
          let m = await discover(this.env, op.email);
          if (!m) {
            // Never automatically retry an ambiguous POST. A deliberate retry
            // re-discovers the label before another create attempt.
            if (op.creationAttempted) await this.state.storage.put('creationUncertain', true);
            if (await this.state.storage.get('creationUncertain')) return await this.retire(op, 'failed', 'creation_uncertain');
            await this.state.storage.put('creationUncertain', true);
            op.creationAttempted = true;
            op.progress = 'creating_sandbox'; await this.save(op);
            let created: Response;
            try {
              created = await platform(this.env, '/sandbox', 'POST', persistentSandboxParams(op.email, this.env));
            } catch { return await this.retire(op, 'failed', 'creation_uncertain'); }
            if (!created.ok) {
              // Daytona documents 401 as missing/invalid credentials and 403 as
              // lack of permission for the operation (SDK Errors reference).
              // These authorization rejections cannot create compute. Its create
              // OpenAPI has no other failure contract: do not guess from a 400,
              // 409, 429, redirect, or 5xx that no side effect occurred.
              if ([401, 403].includes(created.status)) {
                op.creationAttempted = false;
                await this.save(op);
                await this.state.storage.delete('creationUncertain');
              }
              await created.body?.cancel();
              return await this.retire(op, 'failed', [401, 403].includes(created.status) ? 'creation_failed' : 'creation_uncertain');
            }
            m = await created.json() as Machine;
          }
          if (!m?.id || m.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] !== op.email) fail('ownership_mismatch');
          await this.state.storage.delete('creationUncertain');
          if (m.public === true) fail('public_sandbox');
          if (typeof m.memory === 'number' && m.memory < def.memoryGiB) fail('requires_2_gib');
          if (['stopped', 'archived'].includes(m.state)) {
            for (const other of await this.operations()) {
              if (other.phase === 'ready') await this.retire(other, 'stopped');
            }
          }
          op.sandboxId = m.id; op.step = 'credentials'; op.progress = 'starting_sandbox';
          await this.env.DB.prepare('UPDATE user_keys SET daytona_sandbox_id=? WHERE email=?')
            .bind(m.id, op.email).run();
        } else {
          const id = op.sandboxId!;
          const m = await machine(this.env, id);
          if (!m || m.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] !== op.email) throw new Problem('sandbox_missing');
          if (m.public === true) fail('public_sandbox');
          if (op.step === 'credentials') {
            if (op.creationAttempted && m.state === 'started' && !access) {
              // Newly-created, empty machines need one stop/start for first mount.
              const stopped = await platform(this.env, `/sandbox/${encodeURIComponent(id)}/stop`, 'POST');
              if (!stopped.ok) fail('stop_failed');
              await stopped.body?.cancel();
            } else if (!['stopping','starting','creating','pending_build','pulling_snapshot'].includes(m.state)) {
              const credential = await ensureSandboxCredential(this.env, op.email, id).catch(error => {
                const code = error instanceof Error ? error.message : '';
                return fail(['credential_migration_requires_stop','existing_secret_mounts','sandbox_credential_setup_failed'].includes(code)
                  ? code : 'sandbox_access_unavailable');
              });
              op.ownerKeyHash = credential.id;
              op.step = 'wake'; op.progress = 'starting_sandbox';
            }
          } else if (op.step === 'wake') {
            if (m.state === 'started') { op.step = 'prepare'; op.progress = 'preparing_setup'; }
            else if (['stopped', 'archived'].includes(m.state) && !op.wakeRequested) {
              op.wakeRequested = true; await this.save(op);
              const r = await platform(this.env, `/sandbox/${encodeURIComponent(id)}/start`, 'POST');
              if (!r.ok) fail('start_failed');
              await r.body?.cancel();
            } else if (m.state === 'error') fail('sandbox_error');
          } else if (m.state !== 'started') {
            fail('sandbox_stopped_during_setup');
          } else if (op.step === 'prepare') {
            await execute(this.env, id, `bash -c 'umask 077; mkdir -p ${ROOT}/credentials; chmod 700 ${ROOT} ${ROOT}/credentials'`);
            await upload(this.env, id, ROOT, 'setup.next.py', setupSource);
            await upload(this.env, id, ROOT, 'request.next.json', JSON.stringify({ operation: op.operation, deadline: op.setupDeadline, restart: op.restart }));
            if (def.credential) {
              if (!access?.placeholder) fail('sandbox_access_unavailable');
              await upload(this.env, id, ROOT, 'credentials/incoming', access!.placeholder!);
            }
            if (['nanobot', 'jupyter', 'ttyd'].includes(def.id)) {
              await upload(this.env, id, ROOT, 'credentials/app-secret', await managedAppSecret(this.env, op));
            }
            if (def.id === 'jupyter') await upload(this.env, id, ROOT, 'jupyter-adapter.py', jupyterSource);
            if (def.id === 'nanobot') {
              await upload(this.env, id, ROOT, 'assets.json', JSON.stringify(nanobotAssets));
            }
            await execute(this.env, id, `bash -c '${def.credential ? `chmod 600 ${ROOT}/credentials/incoming; ` : ''}mv ${ROOT}/setup.next.py ${ROOT}/setup.py; mv ${ROOT}/request.next.json ${ROOT}/request.json'`);
            op.step = 'inspect'; op.progress = 'checking'; op.launches = 1;
            await this.save(op); // A crash here resumes via inspect, then relaunch.
            await execute(this.env, id, launch(op.operation, def));
          } else if (op.step === 'finalize') {
            await upload(this.env, id, ROOT, 'request.next.json', JSON.stringify({operation:op.operation,
              deadline:op.setupDeadline, restart:false, preview_url:op.url}));
            await execute(this.env, id, `mv ${ROOT}/request.next.json ${ROOT}/request.json`);
            op.step = 'inspect_final'; op.progress = 'configuring_preview'; op.launches = 1;
            await this.save(op);
            await execute(this.env, id, launch(op.operation, def));
          } else if (op.step === 'inspect' || op.step === 'inspect_final') {
            const text = await execute(this.env, id, `python3 ${ROOT}/setup.py${def.id === 'openchamber' ? '' : ` --service ${def.id}`} inspect`);
            if (text.length > 8192) fail('invalid_setup_status');
            const result = JSON.parse(text) as Record<string, unknown>;
            const phases = ['checking', 'installing', 'configuring', 'starting', 'ready', 'failed'];
            if (result.operation !== op.operation || typeof result.updated_at !== 'number' || result.updated_at < now() - 45) {
              if ((op.launches ?? 0) >= 3) fail('setup_interrupted');
              op.launches = (op.launches ?? 0) + 1; await this.save(op);
              await execute(this.env, id, launch(op.operation, def));
            } else {
              if (!phases.includes(String(result.phase))) fail('invalid_setup_status');
              op.heartbeatAt = Math.min(now(), Number(result.updated_at));
              // Sandbox-owned metadata is diagnostic, never authorization. Only
              // known step/error codes and bounded timestamps enter storage/UI.
              if (Array.isArray(result.timeline)) {
                const timeline = op.timeline ??= [];
                for (const item of result.timeline.slice(-40)) {
                  if (!item || typeof item !== 'object' || !INSTALL_STEPS.has(item.step) ||
                      !Number.isInteger(item.at) || item.at < (op.startedAt ?? 0) || item.at > now()) continue;
                  const event: ProgressEvent = {step:item.step, at:item.at};
                  if (SETUP_ERRORS.has(item.error)) event.error = item.error;
                  if (!timeline.some(e=>e.step===event.step && e.at===event.at)) timeline.push(event);
                }
                op.timeline = timeline.sort((a,b)=>a.at-b.at).slice(-40);
              }
              op.progress = INSTALL_STEPS.has(String(result.progress)) ? String(result.progress) : String(result.phase);
              if (result.phase === 'failed') {
                fail(SETUP_ERRORS.has(String(result.error)) ? String(result.error) : 'setup_failed');
              }
              if (result.phase === 'ready' && result.ready === true && result.port === def.port &&
                  (result.service === def.id || (def.id === 'openchamber' && result.service === undefined))) {
                if (op.step === 'inspect_final') {
                  if (result.preview_url !== op.url) fail('preview_configuration_invalid');
                  op.phase = 'ready'; op.progress = 'ready';
                } else { op.step = 'register'; op.progress = 'registering_preview'; }
              }
            }
          } else if (op.step === 'register') {
            // Reconcile the D1 commit / DO save crash window. Discover revoked
            // the previous slot before setup; only this serialized operation can
            // write a managed slot. Never rotate generations on an alarm retry.
            const existing = def.id === 'nanobot' ? await this.env.DB.prepare(`SELECT hostname, expires_at FROM preview_registrations
              WHERE email=? AND deployment='__browser' AND slot=? AND owner_key_hash=?`)
              .bind(op.email, def.slot, op.ownerKeyHash).first<{hostname:string;expires_at:number}>() : null;
            if (existing) {
              if (existing.expires_at <= now()) fail('preview_configuration_invalid');
              op.url = `https://${existing.hostname}/`; op.deadline = Math.min(op.deadline, existing.expires_at);
              op.step = 'finalize'; op.progress = 'configuring_preview';
            } else {
            const r = await platform(this.env, `/sandbox/${encodeURIComponent(id)}/ports/${def.port}/signed-preview-url?expiresInSeconds=${Math.max(1, op.deadline - now())}`);
            if (!r.ok) fail('preview_unavailable');
            const signed = await r.json() as { url: string };
            const preview = await registerBrowserPreview(this.env, op.email, signed.url, op.deadline, op.ownerKeyHash, def.slot,
              ['nanobot','jupyter','ttyd'].includes(def.id) ? await managedAppSecret(this.env, op) : undefined);
            if (preview instanceof Response) fail('preview_unavailable');
            else {
              op.url = preview.url; op.deadline = Math.floor(Date.parse(preview.expires_at) / 1000);
              if (def.id === 'nanobot') { op.step = 'finalize'; op.progress = 'configuring_preview'; }
              else { op.phase = 'ready'; op.progress = 'ready'; }
            }
            }
          }
        }
        op.transientFailures = 0;
        await this.save(op);
        await this.schedule(op, op.phase === 'ready' ? op.deadline * 1000 : Date.now() + (['inspect','inspect_final'].includes(op.step) ? 10_000 : 1000));
      } catch (error) {
        // A started machine's Toolbox can lag behind its control-plane status.
        // Replaying prepare replaces staging files; inspect reconciles an ambiguous launch.
        if (error instanceof Problem && ['toolbox_unavailable', 'setup_transfer_failed'].includes(error.message)
            && (op.transientFailures ?? 0) < 5) {
          op.transientFailures = (op.transientFailures ?? 0) + 1;
          op.progress = 'waiting_for_toolbox';
          await this.save(op);
          await this.schedule(op, Date.now() + 10_000);
          return;
        }
        // Fail visibly rather than silently executing an unbounded repair loop.
        await this.retire(op, 'failed', error instanceof Problem ? error.message : 'provider_unavailable');
      }
  }
}
