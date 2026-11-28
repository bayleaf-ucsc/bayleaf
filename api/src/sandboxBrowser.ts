/** Owner-scoped lifecycle coordinator. GET observes; only POST begins work.
 * Durable alarms resume bounded setup steps. No prompts, credentials, or logs
 * are stored in the Durable Object. Only bounded step/timing metadata is kept.
 * See SANDBOX-BROWSER.md.
 */
import type { Bindings } from './types';
import setupSource from '../scripts/browser-setup.py';
import jupyterSource from '../scripts/jupyter-adapter.py';
import appAuthRelaySource from '../scripts/app-auth-relay.py';
import desktopCleanupSource from '../scripts/desktop-cleanup.py';
import sandboxCliAssets from '../.sandbox-cli-assets.json';
import { getAccountRow, activeSandboxCredential, ensureSandboxCredential, revokeSandboxCredentials, rotateSandboxCredential, v2SecretName, v2CredentialApplied } from './sandboxCredentials';
import { DAYTONA_DEFAULT_API_URL, DAYTONA_DEFAULT_PROXY_URL } from './constants';
import { persistentSandboxParams, createPersistentSandbox, createSignedPreview, refreshActivity, lookupOwnedV2Sandbox, wakeV2Sandbox } from './daytona';
import { daytonaV2, legacySandboxId, getV2Sandbox, v2Execute, v2Toolbox } from './daytonaV2';
import { registerBrowserPreview, revokeUserPreview, previewsEnabled } from './routes/previews';
import { SERVICE_DEFS, serviceDef, managedAppAuth, appAuthRelayPort, type ServiceId, type ServiceDef } from './serviceDefs';

const LINK_SECONDS = 24 * 3600;
const SETUP_SECONDS = 20 * 60;
const RESUME_SECONDS = 120;
const now = () => Math.floor(Date.now() / 1000);
export const browserEnabled = (env: Bindings) => env.BROWSER_SANDBOX_ENABLED === 'true' && previewsEnabled(env);
export const keyHash = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
  b => b.toString(16).padStart(2, '0')).join('');

type Phase = 'opening' | 'ready' | 'failed' | 'expired' | 'stopped';
type Step = 'discover' | 'credentials' | 'wake' | 'prepare' | 'inspect' | 'register' | 'verify-resume';
interface ProgressEvent { step: string; at: number; error?: string }
interface Operation {
  service?: ServiceId; // Missing on legacy OpenChamber operations.
  nextAt?: number;
  invalidated?: boolean;
  email: string;
  operation: string;
  ownerKeyHash: string;
  appAuthVersion?: 2; // Older operations must finish with the password already uploaded.
  appAuthRelay?: true; // A registration and its guest must use the same transport.
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
  bootId?: string;
  launches?: number;
  creationAttempted?: boolean;
  restart?: boolean;
  transientFailures?: number;
  startedAt?: number;
  timeline?: ProgressEvent[];
  previousFailure?: { at: number; error: string; progress: string; elapsed: number };
  heartbeatAt?: number;
  cleanupPending?: boolean;
  cleanupError?: string;
  launchAfterCleanup?: { deadline: number; restart: boolean };
  processesReaped?: number;
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
  if (daytonaV2(env)) return legacySandboxId(id) ? null : getV2Sandbox(id, env);
  const r = await platform(env, `/sandbox/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) return fail('provider_unavailable');
  return r.json();
}
async function discover(env: Bindings, email: string, cachedId?: string | null): Promise<Machine | null> {
  if (daytonaV2(env)) return lookupOwnedV2Sandbox(email, env, cachedId);
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
  if (daytonaV2(env)) {
    const m = await getV2Sandbox(id, env);
    if (!m) return fail('sandbox_missing');
    const result = await v2Execute(env, m, ['bash', '-c', command], 10_000).catch(() => fail('toolbox_unavailable'));
    if (result.exitCode !== 0) fail('setup_command_failed');
    return result.output;
  }
  const r = await fetch(toolbox(env, id, '/process/execute'), {
    method: 'POST', headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, timeout: 10000 }), redirect: 'manual', signal: AbortSignal.timeout(15_000),
  }).catch(() => fail('toolbox_unavailable'));
  if (!r.ok) return fail('toolbox_unavailable');
  const data = await r.json() as { exitCode?: number; result?: string };
  if (data.exitCode !== 0) return fail('setup_command_failed');
  return data.result ?? '';
}
async function sandboxBootId(env: Bindings, id: string): Promise<string> {
  const bootId = (await execute(env, id, 'cat /proc/sys/kernel/random/boot_id')).trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId)) return fail('toolbox_unavailable');
  return bootId;
}
async function upload(env: Bindings, id: string, root: string, name: string, content: string) {
  const form = new FormData();
  form.append('file', new Blob([content]), 'file');
  if (daytonaV2(env)) {
    const m = await getV2Sandbox(id, env);
    if (!m) return fail('sandbox_missing');
    const r = await v2Toolbox(env, m, `/files/upload?${new URLSearchParams({ path: `${root}/${name}` })}`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) }).catch(() => fail('setup_transfer_failed'));
    await r.body?.cancel();
    if (!r.ok) fail('setup_transfer_failed');
    return;
  }
  const r = await fetch(toolbox(env, id, `/files/upload?path=${encodeURIComponent(`${root}/${name}`)}`), {
    method: 'POST', headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}` }, body: form,
    redirect: 'manual', signal: AbortSignal.timeout(15_000),
  }).catch(() => fail('setup_transfer_failed'));
  if (!r.ok) fail('setup_transfer_failed');
  await r.body?.cancel();
}
// Daytona's own computer-use supervisor runs the Desktop stack. Bodies are
// parsed in memory and never logged; they carry only process records.
async function computerUse(env: Bindings, id: string, action: 'start' | 'stop' | 'status'): Promise<unknown> {
  const m = daytonaV2(env) ? await getV2Sandbox(id, env) : null;
  if (daytonaV2(env) && !m) return fail('sandbox_missing');
  const path = `/computeruse/${action}`;
  const init = {
    method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}` },
    redirect: 'manual' as const, signal: AbortSignal.timeout(15_000),
  };
  const r = await (m ? v2Toolbox(env, m, path, init) : fetch(toolbox(env, id, path), init))
    .catch(() => fail('toolbox_unavailable'));
  if (!r.ok) { await r.body?.cancel(); return fail('toolbox_unavailable'); }
  const text = await r.text();
  if (text.length > 8192) fail('invalid_desktop_status');
  try { return JSON.parse(text); } catch { return fail('invalid_desktop_status'); }
}
const DESKTOP_PROCESSES = ['xvfb', 'xfce4', 'x11vnc', 'novnc'];
/** GET status answers "active" or "partial". start/stop answer per-process
 * records whose keys are PascalCase in practice (`Running`), despite the
 * lowercase OpenAPI schema; accept either. Null means an unrecognized shape. */
function desktopRunning(data: unknown): boolean[] | null {
  const status = (data as { status?: unknown } | null)?.status;
  if (!status || typeof status !== 'object') return null;
  return DESKTOP_PROCESSES.map(name => {
    const p = (status as Record<string, Record<string, unknown> | undefined>)[name];
    return (p?.Running ?? p?.running) === true;
  });
}
const desktopActive = (data: unknown) => (data as { status?: unknown } | null)?.status === 'active' ||
  desktopRunning(data)?.every(Boolean) === true;
/** Stop the stack, then reap the session daemons /computeruse/stop leaks. */
async function stopDesktop(env: Bindings, id: string, def: ServiceDef): Promise<number> {
  if (daytonaV2(env)) {
    await computerUse(env, id, 'stop');
    const status = await computerUse(env, id, 'status') as { status?: unknown };
    if (status.status !== 'inactive') fail('invalid_stop_status');
    return 0;
  }
  const running = desktopRunning(await computerUse(env, id, 'stop'));
  if (!running || running.some(Boolean)) fail('invalid_stop_status');
  await execute(env, id, `mkdir -p ${def.root}`);
  await upload(env, id, def.root, 'desktop-cleanup.py', desktopCleanupSource);
  const text = await execute(env, id, `python3 ${def.root}/desktop-cleanup.py`);
  if (text.length > 1024) fail('invalid_stop_status');
  const result = JSON.parse(text) as Record<string, unknown>;
  if (result.stopped !== true || !Number.isInteger(result.reaped) || Number(result.reaped) < 0) fail('invalid_stop_status');
  return Math.min(Number(result.reaped), 1000);
}
// Match Lathe's v2 bridge port and local RFB target so its private share can
// coexist with managed Desktop. Refuse an unrelated listener on that port.
const ensureDesktopBridge = `python3 - <<'PY'
import http.client, pathlib, socket, subprocess, time
root = next((p for p in (pathlib.Path('/opt/novnc'), pathlib.Path('/usr/share/novnc'))
             if (p / 'vnc.html').is_file()), None)
if root is None:
    raise SystemExit('noVNC assets unavailable')
page = (root / 'vnc.html').read_bytes()
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
    s.connect(('192.0.2.1', 9))
    host = s.getsockname()[0]
def listening():
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex((host, 6080)) == 0
if not listening():
    subprocess.Popen(['websockify', '--web', str(root), '6080', '127.0.0.1:5900'],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    until = time.monotonic() + 5
    while not listening() and time.monotonic() < until:
        time.sleep(.2)
connection = http.client.HTTPConnection(host, 6080, timeout=2)
connection.request('GET', '/vnc.html')
response = connection.getresponse()
if response.status != 200 or response.read(len(page) + 1) != page:
    raise SystemExit(1)
PY`;
const launch = (operation: string, def: ServiceDef) => `python3 -c ${JSON.stringify(
  `import subprocess; subprocess.Popen(['python3','${def.root}/setup.py','--service','${def.id}','setup','--operation','${operation}'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)`
)}`;
const operationKey = (service: ServiceId = 'openchamber') => service === 'openchamber' ? 'operation' : `operation/${service}`;
const dueAt = (op: Operation) => op.phase === 'ready' ? op.deadline * 1000 :
  op.phase === 'opening' ? Math.min(op.nextAt ?? 0, op.setupDeadline * 1000, op.deadline * 1000) :
  op.launchAfterCleanup ? Math.min(op.nextAt ?? 0, op.launchAfterCleanup.deadline * 1000) :
    !op.invalidated || op.cleanupPending ? op.nextAt ?? 0 : Infinity;

// Reconstructible application credential, never DO metadata. OpenCode Web
// keeps it across link generations; the origin is configured separately.
// Never returned in management responses. Apps may expose their own WS token
// through the authenticated application (ttyd /token).
// Purpose-separated from preview encryption/session signing.
async function managedAppSecret(env: Bindings, op: Operation): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.PREVIEWS_SECRET),
    {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const context = op.service === 'opencode-web' && op.appAuthVersion === 2
    ? `bayleaf:${op.service}:bootstrap:v2:${op.ownerKeyHash}`
    : `bayleaf:${op.service}:bootstrap:v1:${op.operation}:${op.ownerKeyHash}`;
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(context));
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
    op.phase = phase; op.error = error; delete op.url; delete op.launchAfterCleanup;
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
  private async stop(op: Operation, wakeForCleanup = false) {
    // Persist intent and revoke access before touching compute. A late installer
    // breadcrumb cannot advance this operation back to register/ready.
    if (op.phase !== 'stopped') {
      op.cleanupPending = true;
      await this.retire(op, 'stopped');
    } else if (!op.invalidated) await this.retire(op, 'stopped');
    if (!op.invalidated || !op.cleanupPending) return;
    try {
      const m = op.sandboxId ? await machine(this.env, op.sandboxId) : null;
      if (m && m.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] !== op.email) fail('ownership_mismatch');
      if (!m || ['stopped', 'archived'].includes(m.state)) {
        // Sleep has removed processes. Never wake merely to clean up an app.
        op.cleanupPending = false;
      } else if (m.state === 'started' && SERVICE_DEFS[op.service ?? 'openchamber'].driver === 'computeruse') {
        op.processesReaped = await stopDesktop(this.env, m.id, SERVICE_DEFS[op.service!]);
        op.cleanupPending = false;
      } else if (m.state === 'started') {
        const def = SERVICE_DEFS[op.service ?? 'openchamber'];
        // Transfer the current stop implementation, including for older installs.
        // Keep it separate from a setup.py that may still be executing.
        await execute(this.env, m.id, `mkdir -p ${def.root}`);
        await upload(this.env, m.id, def.root, 'stop.py', setupSource);
        const text = await execute(this.env, m.id,
          `python3 ${def.root}/stop.py --service ${def.id} stop --operation ${op.operation}`);
        if (text.length > 1024) fail('invalid_stop_status');
        const result = JSON.parse(text) as Record<string, unknown>;
        if (result.stopped !== true || result.operation !== op.operation) fail('invalid_stop_status');
        op.cleanupPending = false;
      } else if (wakeForCleanup && m.state === 'paused' && m.public !== true) {
        await wakeV2Sandbox(m, this.env);
      }
      delete op.cleanupError;
    } catch {
      op.cleanupError = 'process_cleanup_pending';
    }
    op.nextAt = Date.now() + (wakeForCleanup ? 5000 : 30_000);
    await this.save(op);
  }
  private async queueSetup(email: string, def: ServiceDef, hash: string, previous: Operation | undefined, restart: boolean) {
    const deadline = now() + LINK_SECONDS;
    const op: Operation = { email, service: def.id, operation: crypto.randomUUID(), ownerKeyHash: hash,
      ...(def.id === 'opencode-web' ? { appAuthVersion: 2 as const } : {}),
      ...(appAuthRelayPort(def, daytonaV2(this.env)) ? { appAuthRelay: true as const } : {}),
      phase: 'opening', step: 'discover', progress: 'locating_sandbox', deadline,
      setupDeadline: Math.min(now() + SETUP_SECONDS, deadline), updatedAt: now(), startedAt: now(), restart,
      previousFailure: previous?.phase === 'failed' ? { at: previous.updatedAt,
        error: previous.error ?? 'setup_failed', progress: previous.progress,
        elapsed: Math.max(0, previous.updatedAt - (previous.startedAt ?? previous.updatedAt)) } : previous?.previousFailure };
    await this.save(op);
    await this.arm();
    return response({ phase: op.phase, operation: op.operation }, 202);
  }
  private async view(email: string, service: ServiceId = 'openchamber') {
    const op = await this.state.storage.get<Operation>(operationKey(service));
    const row = await getAccountRow(email, this.env);
    if (!row) return response({ phase: 'unavailable', error: 'personal_key_required' }, 403);
    const access = op?.sandboxId ? await activeSandboxCredential(this.env, email, op.sandboxId) : null;
    const validKey = !op || op.step === 'discover' || op.step === 'credentials' || access?.id === op.ownerKeyHash;
    // Control-plane GET only. No readiness probes, file reads, or last-activity writes.
    const recorded = op?.sandboxId && (!daytonaV2(this.env) || op.sandboxId === row.daytona_sandbox_id)
      ? await machine(this.env, op.sandboxId) : null;
    const current = recorded ?? await discover(this.env, email, row.daytona_sandbox_id);
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
     const expired = op && ['opening', 'ready'].includes(op.phase) && deadline !== undefined && deadline <= now();
    const ready = op?.phase === 'ready' && !expired && validKey && owned && current.state === 'started';
    const cleaningBeforeLaunch = op?.launchAfterCleanup && op.launchAfterCleanup.deadline > now() &&
      op.sandboxId === row.daytona_sandbox_id && owned;
    const canResumeCleanup = daytonaV2(this.env) && op?.phase === 'stopped' && op.invalidated &&
      op.cleanupPending && op.sandboxId === row.daytona_sandbox_id && owned && current.state === 'paused' && current.public !== true;
    return response({ phase: !op ? 'idle' : cleaningBeforeLaunch ? 'opening' : !validKey ? 'failed' : expired ? 'expired' : op.phase,
      machine: current ? owned ? current.state : 'unavailable' : 'absent',
      progress: cleaningBeforeLaunch ? 'starting_sandbox' : op?.progress ?? 'unchecked', operation: op?.operation,
      error: !validKey ? 'credential_changed' : op?.error,
      deadline, url: ready ? op.url : undefined,
      validate_open: ready && daytonaV2(this.env) ? true : undefined,
      can_resume_cleanup: canResumeCleanup ? true : undefined,
      // Setup status freshness is explicit; GET never probes the application.
      updated_at: op?.updatedAt, started_at: op?.startedAt,
      heartbeat_at: op?.heartbeatAt, timeline: op?.timeline ?? [], previous_failure: op?.previousFailure,
      access_revoked: op?.phase === 'stopped' ? op.invalidated === true : undefined,
      cleanup_pending: op?.cleanupPending, cleanup_error: op?.cleanupError });
  }

  async fetch(req: Request): Promise<Response> {
    try {
      if (this.env.SANDBOX_MIGRATION_READONLY === 'true') return response({ error: 'migration_in_progress' }, 503);
      const u = new URL(req.url);
      const email = req.headers.get('X-BayLeaf-Owner') ?? '';
      if (!email || !this.state.id.equals(this.env.SANDBOX_BROWSER.idFromName(email))) return response({ error: 'denied' }, 403);
      // The management login may wake compute without enabling or installing an
      // application. This path is private to the service binding, never routed
      // by the public /sandbox/browser adapter.
      if (req.method === 'POST' && u.pathname === '/wake-existing') {
        return await this.exclusive(async () => {
          const row = await getAccountRow(email, this.env);
          if (!row) return response({ error: 'account_required' }, 403);
          const current = await discover(this.env, email, row.daytona_sandbox_id);
          if (!current) return response({ state: 'absent' });
          if (!current.id || current.public === true) return response({ error: 'sandbox_unavailable' }, 503);
          const ops = await this.operations();
          // Active setup already owns wake/recovery and must not be interrupted.
          if (ops.some(op => (op.phase === 'opening' && op.setupDeadline > now()) ||
              (op.launchAfterCleanup?.deadline ?? 0) > now())) return response({ state: 'opening' });
          if (daytonaV2(this.env) && ['paused', 'stopped', 'started'].includes(current.state)) {
            if (current.state === 'started') {
              await refreshActivity(current.id, this.env);
              return response({ state: 'started' });
            }
            if (!await activeSandboxCredential(this.env, email, current.id)) return response({ state: current.state });
            if (current.state === 'stopped') for (const op of ops) {
              if (op.phase === 'ready') await this.retire(op, 'stopped');
            }
            await wakeV2Sandbox(current, this.env);
            await this.arm();
            return response({ state: 'starting' });
          }
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
      if (req.method !== 'POST' || !['/start', '/restart', '/stop'].includes(u.pathname)) return response({ error: 'not_found' }, 404);
      return await this.exclusive(async () => {
        const row = await getAccountRow(email, this.env);
        if (!row) return response({ error: 'personal_key_required' }, 403);
        const previous = await this.state.storage.get<Operation>(operationKey(def.id));
        if (u.pathname === '/stop') {
          if (!previous) {
            const revoked = await revokeUserPreview(this.env, email, def.slot);
            return response({ phase: 'stopped', access_revoked: revoked, cleanup_pending: false }, revoked ? 200 : 503);
          }
          if (previous.launchAfterCleanup) {
            delete previous.launchAfterCleanup;
            await this.save(previous);
          }
          await this.stop(previous);
          await this.arm();
          return response({ phase: 'stopped', access_revoked: previous.invalidated === true,
            cleanup_pending: previous.cleanupPending === true, cleanup_error: previous.cleanupError,
            processes_reaped: previous.processesReaped },
            previous.invalidated && !previous.cleanupPending ? 200 : 202);
        }
        const recoverCleanup = daytonaV2(this.env) && previous?.phase === 'stopped' &&
          previous.invalidated && previous.sandboxId && previous.sandboxId === row.daytona_sandbox_id &&
          (previous.cleanupPending || previous.launchAfterCleanup);
        if (!recoverCleanup && (previous?.cleanupPending || (previous?.phase === 'stopped' && !previous.invalidated))) {
          return response({ error: 'process_cleanup_pending' }, 409);
        }
        const other = (await this.operations()).find(op => (op.service ?? 'openchamber') !== def.id &&
          (op.phase === 'opening' || (op.launchAfterCleanup?.deadline ?? 0) > now()));
        if (other) return response({ error: 'service_busy', service: other.service ?? 'openchamber' }, 409);
        if (recoverCleanup) {
          if ((previous.launchAfterCleanup?.deadline ?? 0) <= now()) {
            previous.launchAfterCleanup = { deadline: now() + RESUME_SECONDS, restart: u.pathname === '/restart' };
            await this.schedule(previous, Date.now());
            await this.arm();
          }
          return response({ phase: 'opening', operation: previous.operation }, 202);
        }
        // Repeated clicks during setup converge on one persisted operation.
        if (previous?.phase === 'opening' && previous.setupDeadline > now() && previous.deadline > now()) {
          return response({ phase: previous.phase, operation: previous.operation }, 202);
        }
        const access = row.daytona_sandbox_id ? await activeSandboxCredential(this.env, email, row.daytona_sandbox_id) : null;
        const hash = access?.id ?? row.account_generation;
        const reuseTransport = !appAuthRelayPort(def, daytonaV2(this.env)) || previous?.appAuthRelay;
        if (reuseTransport && u.pathname === '/start' && previous?.phase === 'ready' && previous.deadline > now() && previous.ownerKeyHash === hash && previous.sandboxId && await this.linkDeadline(previous) > now()) {
          const m = await machine(this.env, previous.sandboxId);
          if (m?.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] === email) {
            if (!daytonaV2(this.env) && m.state === 'started') return this.view(email, def.id);
            if (daytonaV2(this.env) && m.id === row.daytona_sandbox_id && previous.bootId) {
              if (m.state === 'started' && await sandboxBootId(this.env, m.id) === previous.bootId) return this.view(email, def.id);
              if (['paused', 'pausing', 'starting'].includes(m.state)) {
                previous.phase = 'opening'; previous.step = 'verify-resume'; previous.progress = 'starting_sandbox';
                previous.setupDeadline = Math.min(now() + RESUME_SECONDS, previous.deadline);
                await this.schedule(previous, Date.now());
                await this.arm();
                return response({ phase: 'opening', operation: previous.operation }, 202);
              }
            }
          }
        }
        return this.queueSetup(email, def, hash, previous, u.pathname === '/restart');
      });
    } catch {
      // Provider errors can contain credentials/URLs. Never log or echo them.
      return response({ error: 'lifecycle_unavailable' }, 503);
    }
  }

  async alarm() {
    await this.exclusive(async () => {
      if (this.env.SANDBOX_MIGRATION_READONLY === 'true') {
        await this.state.storage.setAlarm(Date.now() + 60_000);
        return;
      }
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
      const relayPort = appAuthRelayPort(def, op.appAuthRelay === true && daytonaV2(this.env));
      const ROOT = def.root;
      const INSTALL_STEPS = new Set<string>(def.steps);
      const SETUP_ERRORS = new Set<string>(def.errors);
      // Persist retry intent before side effects, including after an eviction.
      await this.schedule(op, Date.now() + 15_000);
      try {
        if (op.phase === 'stopped' && (op.cleanupPending || op.launchAfterCleanup)) {
          const launch = op.launchAfterCleanup;
          const owner = launch && launch.deadline > now() && daytonaV2(this.env) && browserEnabled(this.env)
            ? await getAccountRow(op.email, this.env) : null;
          if (owner && op.sandboxId === owner.daytona_sandbox_id && launch) {
            await this.stop(op, true);
            if (!op.cleanupPending) {
              const credential = await activeSandboxCredential(this.env, op.email, op.sandboxId!);
              await this.queueSetup(op.email, def, credential?.id ?? owner.account_generation, op,
                launch.restart && def.driver !== 'computeruse');
            }
          } else {
            if (launch) {
              delete op.launchAfterCleanup;
              await this.save(op);
            }
            await this.stop(op);
          }
          return;
        }
        const row = await getAccountRow(op.email, this.env);
        const access = op.sandboxId ? await activeSandboxCredential(this.env, op.email, op.sandboxId) : null;
        if (!browserEnabled(this.env) || !row ||
            (!['discover', 'credentials'].includes(op.step) && access?.id !== op.ownerKeyHash)) {
          await this.retire(op, 'failed', 'credential_or_feature_unavailable'); return;
        }
        const inboxesEnabled = this.env.INBOXES_ENABLED === 'true' && !!this.env.INBOXES &&
          (!this.env.INBOXES_PILOT_OWNER || row.account_generation === this.env.INBOXES_PILOT_OWNER);
        // Hosted bayleaf-rooms skill only; the plugin adds no Rooms tools.
        const roomsEnabled = this.env.ROOMS_ENABLED === 'true' && !!this.env.ROOMS;
        if (op.deadline <= now()) { await this.retire(op, 'expired'); return; }
        if (['failed', 'stopped', 'expired'].includes(op.phase)) { await this.retire(op, op.phase, op.error); return; }
        if (op.phase === 'ready') return;
        if (op.setupDeadline <= now()) { await this.retire(op, 'failed', 'setup_timeout'); return; }
        if (op.url && await this.linkDeadline(op) <= now()) { await this.retire(op, 'expired'); return; }

        if (op.step === 'discover') {
          await revokeUserPreview(this.env, op.email, def.slot);
          let m = await discover(this.env, op.email, row.daytona_sandbox_id);
          if (!m) {
            // Desktop attaches to an existing machine only; it never creates one.
            if (def.driver === 'computeruse') return await this.retire(op, 'failed', 'sandbox_missing');
            if (daytonaV2(this.env)) {
              op.progress = 'creating_sandbox'; await this.save(op);
              m = await createPersistentSandbox(op.email, this.env).catch(() => fail('creation_failed'));
            } else {
              // v0 has no idempotency key. Only documented auth rejections
              // prove it did not create compute.
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
          const bound = await this.env.DB.prepare('UPDATE user_keys SET daytona_sandbox_id=? WHERE email=? AND (daytona_sandbox_id IS ? OR daytona_sandbox_id=?)')
            .bind(m.id, op.email, row.daytona_sandbox_id, m.id).run();
          if (bound.meta.changes !== 1) fail('ownership_mismatch');
        } else {
          const id = op.sandboxId!;
          const m = await machine(this.env, id);
          if (!m || m.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] !== op.email) throw new Problem('sandbox_missing');
          if (m.public === true) fail('public_sandbox');
          if (op.step === 'credentials') {
            if (!daytonaV2(this.env) && op.creationAttempted && m.state === 'started' && !access) {
              // Newly-created, empty machines need one stop/start for first mount.
              const stopped = await platform(this.env, `/sandbox/${encodeURIComponent(id)}/stop`, 'POST');
              if (!stopped.ok) fail('stop_failed');
              await stopped.body?.cancel();
            } else if (!['stopping','starting','creating','pending_build','pulling_snapshot','pausing'].includes(m.state)) {
              const credential = await ensureSandboxCredential(this.env, op.email, id).catch(error => {
                const code = error instanceof Error ? error.message : '';
                if (daytonaV2(this.env) && code === 'sandbox_secret_unavailable') return fail('toolbox_unavailable');
                return fail(['credential_migration_requires_stop','existing_secret_mounts','sandbox_credential_setup_failed'].includes(code)
                  ? code : 'sandbox_access_unavailable');
              });
              op.ownerKeyHash = credential.id;
              op.step = 'wake'; op.progress = 'starting_sandbox';
            }
          } else if (op.step === 'verify-resume') {
            if (!daytonaV2(this.env) || row.daytona_sandbox_id !== id) fail('sandbox_missing');
            if (m.state === 'paused') {
              await wakeV2Sandbox(m, this.env).catch(() => fail('start_failed'));
            } else if (m.state === 'started' || m.state === 'stopped') {
              if (m.state === 'started' && await sandboxBootId(this.env, id) === op.bootId) {
                op.phase = 'ready'; op.progress = 'ready';
              } else {
                await this.queueSetup(op.email, def, op.ownerKeyHash, op, false);
                return;
              }
            } else if (!['starting', 'pausing', 'stopping'].includes(m.state)) fail('sandbox_error');
          } else if (op.step === 'wake') {
            if (m.state === 'started') {
              if (daytonaV2(this.env)) op.bootId = await sandboxBootId(this.env, id);
              // OpenCode needs the exact private origin on its initial argv.
              op.step = def.id === 'opencode-web' ? 'register' : 'prepare';
              op.progress = def.id === 'opencode-web' ? 'registering_preview' : 'preparing_setup';
            }
            else if (['stopped', 'archived', 'paused'].includes(m.state) && !op.wakeRequested) {
              op.wakeRequested = true; await this.save(op);
              if (daytonaV2(this.env)) await wakeV2Sandbox(m, this.env).catch(() => fail('start_failed'));
              else {
                const r = await platform(this.env, `/sandbox/${encodeURIComponent(id)}/start`, 'POST');
                if (!r.ok) fail('start_failed');
                await r.body?.cancel();
              }
            } else if (m.state === 'error') fail('sandbox_error');
          } else if (m.state !== 'started') {
            fail('sandbox_stopped_during_setup');
          } else if (def.driver === 'computeruse' && op.step === 'prepare') {
            // Restart is a clean session: stop and reap, then start. Idempotent on replay.
            if (op.restart) op.processesReaped = await stopDesktop(this.env, id, def);
            op.step = 'inspect'; op.progress = 'starting_desktop'; op.launches = 1;
            await this.save(op); // A crash here resumes via inspect, then restart.
            const started = await computerUse(this.env, id, 'start');
            if ((daytonaV2(this.env) || desktopActive(started)) && desktopActive(await computerUse(this.env, id, 'status'))) {
              if (daytonaV2(this.env)) await execute(this.env, id, ensureDesktopBridge);
              op.step = 'register'; op.progress = 'registering_preview';
            }
          } else if (def.driver === 'computeruse' && op.step === 'inspect') {
            if (desktopActive(await computerUse(this.env, id, 'status'))) {
              if (daytonaV2(this.env)) await execute(this.env, id, ensureDesktopBridge);
              op.step = 'register'; op.progress = 'registering_preview';
            } else if ((op.launches ?? 0) >= 3) fail('desktop_not_ready');
            else {
              op.launches = (op.launches ?? 0) + 1; await this.save(op);
              await computerUse(this.env, id, 'start');
            }
          } else if (op.step === 'prepare') {
            if (def.id === 'opencode-web' && !op.url) {
              // An in-flight operation from the previous recipe may have
              // reached prepare before this deployment.
              op.step = 'register'; op.progress = 'registering_preview';
              await this.schedule(op, Date.now() + 1000);
              return;
            }
            if (def.credential && access && daytonaV2(this.env) && !await v2CredentialApplied(this.env, access)) {
              fail('toolbox_unavailable');
            }
            await execute(this.env, id, `bash -c 'umask 077; mkdir -p ${ROOT}/credentials; chmod 700 ${ROOT} ${ROOT}/credentials'`);
            await upload(this.env, id, ROOT, 'setup.next.py', setupSource);
            // Parent-owned shared CLI; deliberate setup partitions independently
            // published adapters without changing owner credential authority.
            await upload(this.env, id, ROOT, 'cli-assets.json', JSON.stringify(sandboxCliAssets));
            await upload(this.env, id, ROOT, 'request.next.json', JSON.stringify({ operation: op.operation, deadline: op.setupDeadline,
              restart: op.restart, inboxes_enabled: inboxesEnabled, rooms_enabled: roomsEnabled,
              ...(def.credential && daytonaV2(this.env) ? { secret_env: access?.secret_name } : {}),
              ...(def.id === 'opencode-web' && op.url ? { preview_origin: new URL(op.url).origin } : {}),
              ...(relayPort ? { app_auth_relay_port: relayPort } : {}) }));
            if (def.credential) {
              if (!access || (daytonaV2(this.env) ? !v2SecretName(access.secret_name) : !access.placeholder)) fail('sandbox_access_unavailable');
              if (access?.placeholder && !daytonaV2(this.env)) await upload(this.env, id, ROOT, 'credentials/incoming', access.placeholder);
            }
            if (managedAppAuth(def.slot)) {
              await upload(this.env, id, ROOT, 'credentials/app-secret', await managedAppSecret(this.env, op));
            }
            if (def.id === 'jupyter') await upload(this.env, id, ROOT, 'jupyter-adapter.py', jupyterSource);
            if (relayPort) await upload(this.env, id, ROOT, 'app-auth-relay.py', appAuthRelaySource);
            await execute(this.env, id, `bash -c '${def.credential && !daytonaV2(this.env) ? `chmod 600 ${ROOT}/credentials/incoming; ` : ''}mv ${ROOT}/setup.next.py ${ROOT}/setup.py; mv ${ROOT}/request.next.json ${ROOT}/request.json'`);
            op.step = 'inspect'; op.progress = 'checking'; op.launches = 1;
            await this.save(op); // A crash here resumes via inspect, then relaunch.
            await execute(this.env, id, launch(op.operation, def));
          } else if (op.step === 'inspect') {
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
                if (def.id === 'opencode-web' && op.url) {
                  if (result.preview_origin !== new URL(op.url).origin || await this.linkDeadline(op) <= now())
                    fail('preview_unavailable');
                  op.phase = 'ready'; op.progress = 'ready';
                } else {
                  op.step = 'register'; op.progress = 'registering_preview';
                }
              }
            }
          } else if (op.step === 'register') {
            // Reconcile the D1 commit / DO save crash window. Discover revoked
            // the previous slot before setup; only this serialized operation can
            // write a managed slot. Never rotate generations on an alarm retry.
            const existing = await this.env.DB.prepare(`SELECT hostname, expires_at FROM preview_registrations
              WHERE email=? AND deployment='__browser' AND slot=? AND owner_key_hash=?`)
              .bind(op.email, def.slot, op.ownerKeyHash).first<{hostname:string;expires_at:number}>();
            if (existing) {
              if (existing.expires_at <= now()) fail('preview_unavailable');
              const url = `https://${existing.hostname}/`;
              op.url = 'landing' in def ? new URL(def.landing, url).href : url;
              op.deadline = Math.min(op.deadline, existing.expires_at);
            } else {
              // Under v2, app-auth services are reached through their credential relay.
              const signed = await createSignedPreview(id, relayPort ?? def.port, this.env,
                Math.max(1, op.deadline - now()));
              if (!signed) return fail('preview_unavailable');
              const preview = await registerBrowserPreview(this.env, op.email, signed.url, op.deadline, op.ownerKeyHash, def.slot,
                managedAppAuth(def.slot) ? await managedAppSecret(this.env, op) : undefined, relayPort !== null);
              if (preview instanceof Response) fail('preview_unavailable');
              else {
                // The gateway's post-login redirect uses the same fixed landing path.
                op.url = 'landing' in def ? new URL(def.landing, preview.url).href : preview.url;
                op.deadline = Math.floor(Date.parse(preview.expires_at) / 1000);
              }
            }
            if (def.id === 'opencode-web') {
              op.step = 'prepare'; op.progress = 'preparing_setup';
            } else {
              op.phase = 'ready'; op.progress = 'ready';
            }
          }
        }
        op.transientFailures = 0;
        await this.save(op);
        const delay = op.step === 'inspect' ? 10_000 : op.step === 'verify-resume' ? 5000 : 1000;
        await this.schedule(op, op.phase === 'ready' ? op.deadline * 1000 : Date.now() + delay);
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
