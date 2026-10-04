/** Owner-scoped lifecycle coordinator. GET observes; only POST begins work.
 * Durable alarms resume bounded setup steps. No prompts, credentials, or logs
 * are stored in the Durable Object. See SANDBOX-BROWSER.md.
 */
import type { Bindings } from './types';
import setupSource from '../scripts/browser-setup.py';
import sandboxSkills from '../.sandbox-skills.json';
import { getActiveRow } from './provision';
import { DAYTONA_DEFAULT_API_URL, DAYTONA_DEFAULT_PROXY_URL } from './constants';
import { registerBrowserPreview, revokeUserPreview, previewsEnabled } from './routes/previews';

const ROOT = '/home/daytona/.local/share/bayleaf/browser';
const SECONDS = 6 * 3600;
const SETUP_SECONDS = 20 * 60;
const now = () => Math.floor(Date.now() / 1000);
export const browserEnabled = (env: Bindings) => env.BROWSER_SANDBOX_ENABLED === 'true' && previewsEnabled(env);
export const keyHash = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
  b => b.toString(16).padStart(2, '0')).join('');

type Phase = 'opening' | 'ready' | 'failed' | 'expired' | 'stopped';
type Step = 'discover' | 'wake' | 'prepare' | 'inspect' | 'register';
interface Operation {
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
async function upload(env: Bindings, id: string, name: string, content: string) {
  const form = new FormData();
  form.append('file', new Blob([content]), 'file');
  const r = await fetch(toolbox(env, id, `/files/upload?path=${encodeURIComponent(`${ROOT}/${name}`)}`), {
    method: 'POST', headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}` }, body: form,
    redirect: 'manual', signal: AbortSignal.timeout(15_000),
  }).catch(() => fail('setup_transfer_failed'));
  if (!r.ok) fail('setup_transfer_failed');
  await r.body?.cancel();
}
const launch = (operation: string) => `python3 -c ${JSON.stringify(
  `import subprocess; subprocess.Popen(['python3','${ROOT}/setup.py','setup','--operation','${operation}'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)`
)}`;

export class SandboxBrowser {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private state: DurableObjectState, private env: Bindings) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Do not hold blockConcurrencyWhile across provider calls (30-second limit).
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async save(op: Operation) {
    op.updatedAt = now();
    await this.state.storage.put('operation', op);
  }
  private async retire(op: Operation, phase: Phase, error?: string) {
    // Keep retrying invalidation if D1/DO transport is temporarily unavailable.
    await this.state.storage.setAlarm(Date.now() + 30_000);
    op.phase = phase; op.error = error; delete op.url;
    await this.save(op);
    if (!await revokeUserPreview(this.env, op.email, '__browser')) return;
    await this.state.storage.deleteAlarm();
  }
  private async view(email: string) {
    const op = await this.state.storage.get<Operation>('operation');
    const row = await getActiveRow(email, this.env);
    if (!row) return response({ phase: 'unavailable', error: 'personal_key_required' }, 403);
    const validKey = !op || await keyHash(row.bayleaf_token) === op.ownerKeyHash;
    // Control-plane GET only. No readiness probes, file reads, or last-activity writes.
    const current = op?.sandboxId ? await machine(this.env, op.sandboxId) : await discover(this.env, email);
    // A destroyed shared machine cannot retain an actionable installation error.
    // Keep old operation metadata internally for reconciliation, not in the UI.
    if (!current && op?.phase !== 'opening') return response({ phase: 'idle', machine: 'absent', progress: 'unchecked' });
    const owned = current && current.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] === email;
    const expired = !!op && op.deadline <= now();
    const ready = op?.phase === 'ready' && !expired && validKey && owned && current.state === 'started';
    return response({ phase: !op ? 'idle' : !validKey ? 'failed' : expired ? 'expired' : op.phase,
      machine: current ? owned ? current.state : 'unavailable' : 'absent',
      progress: op?.progress ?? 'unchecked', operation: op?.operation,
      error: !validKey ? 'credential_changed' : op?.error,
      deadline: op?.deadline, url: ready ? op.url : undefined,
      // Setup status freshness is explicit; GET never probes the application.
      updated_at: op?.updatedAt });
  }

  async fetch(req: Request): Promise<Response> {
    try {
      const u = new URL(req.url);
      const email = req.headers.get('X-BayLeaf-Owner') ?? '';
      if (!email || !this.state.id.equals(this.env.SANDBOX_BROWSER.idFromName(email))) return response({ error: 'denied' }, 403);
      if (!browserEnabled(this.env)) return response({ error: 'browser_disabled' }, 503);
      if (req.method === 'GET' && u.pathname === '/status') return await this.view(email);
      if (req.method !== 'POST' || !['/start', '/continue', '/restart', '/stop'].includes(u.pathname)) return response({ error: 'not_found' }, 404);
      return await this.exclusive(async () => {
        const row = await getActiveRow(email, this.env);
        if (!row) return response({ error: 'personal_key_required' }, 403);
        const previous = await this.state.storage.get<Operation>('operation');
        if (u.pathname === '/stop') {
          if (previous) {
            await this.retire(previous, 'stopped');
            // Explicit stop may contact Toolbox once. Expiry never does.
            if (previous.sandboxId) {
              const m = await machine(this.env, previous.sandboxId);
              if (m?.state === 'started' && m.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] === email) {
                await execute(this.env, m.id, `python3 ${ROOT}/setup.py stop`);
              }
            }
          }
          return response({ phase: 'stopped' });
        }
        // Repeated clicks during setup converge on one persisted operation.
        if (previous?.phase === 'opening' && previous.setupDeadline > now() && previous.deadline > now()) {
          return response({ phase: previous.phase, operation: previous.operation }, 202);
        }
        const hash = await keyHash(row.bayleaf_token);
        if (u.pathname === '/start' && previous?.phase === 'ready' && previous.deadline > now() && previous.ownerKeyHash === hash && previous.sandboxId) {
          const m = await machine(this.env, previous.sandboxId);
          if (m?.state === 'started' && m.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] === email) return this.view(email);
        }
        const deadline = u.pathname !== '/continue' && previous && previous.deadline > now()
          ? previous.deadline : now() + SECONDS;
        const op: Operation = { email, operation: crypto.randomUUID(), ownerKeyHash: hash,
          phase: 'opening', step: 'discover', progress: 'locating_sandbox', deadline,
          setupDeadline: Math.min(now() + SETUP_SECONDS, deadline), updatedAt: now(), restart: u.pathname === '/restart' };
        await this.save(op);
        await this.state.storage.setAlarm(Date.now() + 1);
        return response({ phase: op.phase, operation: op.operation }, 202);
      });
    } catch {
      // Provider errors can contain credentials/URLs. Never log or echo them.
      return response({ error: 'lifecycle_unavailable' }, 503);
    }
  }

  async alarm() {
    await this.exclusive(async () => {
      const op = await this.state.storage.get<Operation>('operation');
      if (!op) return;
      // Persist retry intent before side effects, including after an eviction.
      await this.state.storage.setAlarm(Date.now() + 15_000);
      try {
        const row = await getActiveRow(op.email, this.env);
        if (!browserEnabled(this.env) || !row || await keyHash(row.bayleaf_token) !== op.ownerKeyHash) {
          await this.retire(op, 'failed', 'credential_or_feature_unavailable'); return;
        }
        if (op.deadline <= now()) { await this.retire(op, 'expired'); return; }
        if (['failed', 'stopped', 'expired'].includes(op.phase)) { await this.retire(op, op.phase, op.error); return; }
        if (op.phase === 'ready') { await this.state.storage.setAlarm(op.deadline * 1000); return; }
        if (op.setupDeadline <= now()) { await this.retire(op, 'failed', 'setup_timeout'); return; }

        if (op.step === 'discover') {
          await revokeUserPreview(this.env, op.email, '__browser');
          let m = await discover(this.env, op.email);
          if (!m) {
            // Never automatically retry an ambiguous POST. A deliberate retry
            // re-discovers the label before another create attempt.
            if (op.creationAttempted) return await this.retire(op, 'failed', 'creation_uncertain');
            op.creationAttempted = true;
            op.progress = 'creating_sandbox'; await this.save(op);
            let created: Response;
            try {
              created = await platform(this.env, '/sandbox', 'POST', {
                snapshot: 'daytona-medium', public: false, name: `${this.env.DAYTONA_DEPLOYMENT_LABEL}/${op.email}`,
                labels: { [this.env.DAYTONA_DEPLOYMENT_LABEL]: op.email },
                autoStopInterval: 15, autoArchiveInterval: 60,
                autoDeleteInterval: parseInt(this.env.DAYTONA_AUTO_DELETE_MINUTES, 10) || -1,
              });
            } catch { return await this.retire(op, 'failed', 'creation_uncertain'); }
            if (!created.ok) return await this.retire(op, 'failed', 'creation_failed');
            m = await created.json() as Machine;
          }
          if (!m?.id || m.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] !== op.email) fail('ownership_mismatch');
          if (m.public === true) fail('public_sandbox');
          if (typeof m.memory === 'number' && m.memory < 2) fail('requires_2_gib');
          op.sandboxId = m.id; op.step = 'wake'; op.progress = 'starting_sandbox';
          await this.env.DB.prepare('UPDATE user_keys SET daytona_sandbox_id=? WHERE email=? AND revoked=0')
            .bind(m.id, op.email).run();
        } else {
          const id = op.sandboxId!;
          const m = await machine(this.env, id);
          if (!m || m.labels?.[this.env.DAYTONA_DEPLOYMENT_LABEL] !== op.email) throw new Problem('sandbox_missing');
          if (m.public === true) fail('public_sandbox');
          if (op.step === 'wake') {
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
            await upload(this.env, id, 'skills.bundle.next.json', JSON.stringify(sandboxSkills));
            await upload(this.env, id, 'setup.next.py', setupSource);
            await upload(this.env, id, 'request.next.json', JSON.stringify({ operation: op.operation, deadline: op.deadline, restart: op.restart }));
            await upload(this.env, id, 'credentials/incoming', row.bayleaf_token);
            await execute(this.env, id, `bash -c 'chmod 600 ${ROOT}/credentials/incoming; mv ${ROOT}/setup.next.py ${ROOT}/setup.py; mv ${ROOT}/skills.bundle.next.json ${ROOT}/skills.bundle.json; mv ${ROOT}/request.next.json ${ROOT}/request.json'`);
            op.step = 'inspect'; op.progress = 'checking'; op.launches = 1;
            await this.save(op); // A crash here resumes via inspect, then relaunch.
            await execute(this.env, id, launch(op.operation));
          } else if (op.step === 'inspect') {
            const text = await execute(this.env, id, `python3 ${ROOT}/setup.py inspect`);
            if (text.length > 8192) fail('invalid_setup_status');
            const result = JSON.parse(text) as Record<string, unknown>;
            const phases = ['checking', 'installing', 'configuring', 'starting', 'ready', 'failed'];
            if (result.operation !== op.operation || typeof result.updated_at !== 'number' || result.updated_at < now() - 45) {
              if ((op.launches ?? 0) >= 3) fail('setup_interrupted');
              op.launches = (op.launches ?? 0) + 1; await this.save(op);
              await execute(this.env, id, launch(op.operation));
            } else {
              if (!phases.includes(String(result.phase))) fail('invalid_setup_status');
              op.progress = String(result.phase);
              if (result.phase === 'failed') {
                const allowed = ['node_22_required', 'insufficient_disk', 'requires_2_gib', 'installation_failed',
                  'credential_missing', 'credential_invalid', 'provider_configuration_unavailable', 'port_in_use',
                  'application_not_ready', 'setup_failed', 'work_period_expired'];
                fail(allowed.includes(String(result.error)) ? String(result.error) : 'setup_failed');
              }
              if (result.phase === 'ready' && result.ready === true && result.port === 3100) op.step = 'register';
            }
          } else if (op.step === 'register') {
            const r = await platform(this.env, `/sandbox/${encodeURIComponent(id)}/ports/3100/signed-preview-url?expiresInSeconds=${Math.max(1, op.deadline - now())}`);
            if (!r.ok) fail('preview_unavailable');
            const signed = await r.json() as { url: string };
            const preview = await registerBrowserPreview(this.env, op.email, signed.url, op.deadline, op.ownerKeyHash);
            if (preview instanceof Response) fail('preview_unavailable');
            else { op.url = preview.url; op.phase = 'ready'; op.progress = 'ready'; }
          }
        }
        op.transientFailures = 0;
        await this.save(op);
        await this.state.storage.setAlarm(op.phase === 'ready' ? op.deadline * 1000 : Date.now() + (op.step === 'inspect' ? 10_000 : 1000));
      } catch (error) {
        // A started machine's Toolbox can lag behind its control-plane status.
        // Replaying prepare replaces staging files; inspect reconciles an ambiguous launch.
        if (error instanceof Problem && ['toolbox_unavailable', 'setup_transfer_failed'].includes(error.message)
            && (op.transientFailures ?? 0) < 5) {
          op.transientFailures = (op.transientFailures ?? 0) + 1;
          await this.save(op);
          await this.state.storage.setAlarm(Date.now() + 10_000);
          return;
        }
        // Fail visibly rather than silently executing an unbounded repair loop.
        await this.retire(op, 'failed', error instanceof Problem ? error.message : 'provider_unavailable');
      }
    });
  }
}
