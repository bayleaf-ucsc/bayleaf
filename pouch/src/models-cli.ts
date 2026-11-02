// The `models` command and the service behind it: model weights in this
// browser, for agents, the terminal and Settings alike.
//
//   models list [--offline]   pinned models and the gateway catalog, with what is kept here
//   models status <name>      one model: size, license, files kept, download state
//   models get <name> [--wait]  ask the user, then download as a /task entry (ctl: stop)
//   models remove <name>      free the storage
//   models verify <name>      re-check every kept chunk (no network)
//
// Consent: `get` always opens an approval sheet naming the size, where it is
// kept, the license and attribution, and the origin it comes from. Anyone may
// ask (an agent, the terminal, Settings); only the user's click approves, and
// no hook means deny. `remove` by the user needs no approval (it is theirs to
// free); an agent's `remove` asks too, because it destroys a download the user
// consented to, breaks offline use of the Transformers.js provider, and costs
// a 1 GB download to undo, while an agent never needs the space for itself.
// The download is a /task entry whatever asked for it, so `echo stop >
// /task/<id>/ctl`, the tray and Settings' Stop all stop the same download.
//
// Network: list and status read the gateway's public catalog (metadata, no
// content); downloads carry nothing but which byte ranges are wanted. All
// bytes are checked against the build's pins (src/models.ts).
import type { Command, defineCommand as DefineCommand, ExecResult, ResolvedCommandContext } from 'just-bash';
import { GATEWAY } from './models.ts';
import type { ModelPin, ModelProgress, ModelStatus, ModelStore, ModelRelease } from './models.ts';
import type { Task, Tasks } from './ns/tasks.ts';

// Who asks: the user (via the terminal or Settings) or an agent's conversation.
export type ModelWho = { by: 'user'; via?: string } | { by: 'agent'; caller?: unknown; sid?: string | number | null; name?: string };
export interface ModelSupport { ok: boolean; reason?: string }
// What the approval sheet shows.
export interface ModelRequest {
  action: 'get' | 'remove'; id: string; label: string; who: ModelWho; bytes: number; total: number; location: string;
  license: string; licenseUrl: string | null; attribution: string; distribution: string | null; origin: string;
}
export interface ModelServiceDeps {
  store: ModelStore; tasks: Tasks; approve?: (req: ModelRequest, who: ModelWho) => Promise<boolean>;
  onChange?(): void; supports?(id: string): ModelSupport | Promise<ModelSupport>; // can this browser run it; checked before the sheet
}
export type DownloadTask = Task & { progress?: ModelProgress | { done: number; total: number }; promise?: Promise<ModelStatus> };
export interface ModelRow { id: string; bytes: number; license: string; qualification: string; state: string; pinned: boolean }
export type ModelService = ReturnType<typeof createModelService>;

const ok = (stdout = '', stderr = '') => ({ stdout, stderr, exitCode: 0 });
const fail = (msg: string) => ({ stdout: '', stderr: msg + '\n', exitCode: 1 });
const usage = (msg: string) => ({ stdout: '', stderr: `models: ${msg}\nRun \`models --help\` for usage.\n`, exitCode: 2 });
const size = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
const pad = (s: unknown, n: number) => String(s).padEnd(n);

export const HELP = `models: model weights kept in this browser (from the BayLeaf HF gateway, ${GATEWAY})

  models list [--offline]      pinned models and the gateway catalog; what is downloaded here
  models status <name>         size, license, files kept, download state
  models get <name> [--wait]   ask the user to approve, then download as a /task entry;
                               stop it with: echo stop > /task/<id>/ctl
  models remove <name>         free the storage (an agent's request asks the user)
  models verify <name>         re-check every kept chunk against its receipt (no network)

Every file is checked against the SHA-256 this build pins (models.lock.json);
the gateway's catalog is informative. Downloads send no content: only which
byte ranges of which public file. Exit codes: 0 ok, 1 error or denied, 2 usage.
`;

export function createModelService({ store, tasks, approve, onChange = () => {}, supports = () => ({ ok: true }) }: ModelServiceDeps) {
  const downloads = new Map<string, DownloadTask>(); // id -> task
  const resolve = (name: string) => {
    const ids = store.models.map((m) => m.id);
    if (ids.includes(name)) return store.get(name);
    const hits = ids.filter((i) => i.startsWith(name));
    if (hits.length === 1) return store.get(hits[0]);
    throw Object.assign(new Error(hits.length ? `"${name}" matches ${hits.join(', ')}; say which.` : `no pinned model "${name}". Run \`models list\` for names.`), { code: 'ENOENT' });
  };
  async function request(m: ModelPin, action: ModelRequest['action'], who: ModelWho): Promise<ModelRequest> {
    const rel = await store.release(m.id);
    const st = await store.status(m.id);
    return {
      action, id: m.id, label: m.label, who,
      bytes: action === 'get' ? st.total - st.bytes : st.bytes, total: st.total,
      location: `this browser's site storage for ${globalThis.location?.host || 'this page'} (Cache Storage, pouch-models)${st.persistent ? '' : '; this page load only'}`,
      license: rel?.license?.name ?? m.license, licenseUrl: rel?.license?.url ?? null,
      attribution: `${m.repo} at ${m.revision.slice(0, 12)}${rel?.base_model ? `, from ${rel.base_model}` : ''}`,
      distribution: rel?.distribution?.basis ?? null,
      origin: `${new URL(GATEWAY).host} (BayLeaf's mirror of Hugging Face; Hugging Face sees no request)`,
    };
  }

  async function get(name: string, who: ModelWho, { signal }: { signal?: AbortSignal } = {}): Promise<
    { already: true; status: ModelStatus; task?: undefined; promise?: undefined; joined?: undefined } | { already?: undefined; task: DownloadTask; promise: Promise<ModelStatus>; joined?: boolean }> {
    const m = resolve(name);
    const st = await store.status(m.id);
    const can = await supports(m.id);
    if (st.complete && !can.ok) throw Object.assign(new Error(`${m.label} is downloaded, but cannot run in this browser. ${can.reason}`), { code: 'ENOTSUP' });
    if (st.complete) return { already: true, status: st };
    if (downloads.get(m.id)?.status === 'running') return { task: downloads.get(m.id)!, promise: downloads.get(m.id)!.promise!, joined: true };
    if (!can.ok) throw Object.assign(new Error(`${m.label} cannot run in this browser, so it was not downloaded (nothing was fetched). ${can.reason}`), { code: 'ENOTSUP' });
    let allowed = false;
    try { allowed = approve ? await approve(await request(m, 'get', who), who) === true : false; } catch { allowed = false; }
    if (!allowed) throw Object.assign(new Error(`denied by the user: ${m.label} was not downloaded (nothing was fetched).`), { code: 'EDENIED' });
    let last = -1;
    const task: DownloadTask = tasks.add({ kind: 'download', label: `models get ${m.id}`, sid: who.by === 'agent' ? who.sid : undefined,
      ns: [`writes: browser storage (pouch-models), reads: ${GATEWAY}/${m.repo}`], kill: () => store.stop(m.id) });
    task.note(`approved by the user; ${size(st.total - st.bytes)} to fetch`);
    task.progress = { done: st.bytes, total: st.total };
    task.promise = store.download(m.id, { signal, onProgress: (p) => {
      task.progress = p;
      const pct = Math.floor((p.done / p.total) * 100);
      if (pct >= last + 5 || p.done === p.total) { last = pct - (pct % 5); task.note(`${size(p.done)} of ${size(p.total)} (${pct}%)`); }
      onChange();
    }, onRetry: (r) => task.note(`range ${r.i} retry ${r.attempt}: ${r.error}`) }).then((s) => { task.end('done', `verified ${size(s.total)} against the pins`); onChange(); return s; },
      (e) => { task.end(e.name === 'AbortError' ? 'stopped' : 'failed', e.name === 'AbortError' ? 'stopped; run `models get` again to resume' : e.message); onChange(); throw e; });
    task.promise.catch(() => {});
    downloads.set(m.id, task);
    onChange();
    return { task, promise: task.promise };
  }

  async function remove(name: string, who: ModelWho): Promise<{ nothing: true; freed?: undefined } | { nothing?: undefined; freed: number }> {
    const m = resolve(name);
    const st = await store.status(m.id);
    if (!st.bytes && !st.downloading) return { nothing: true };
    if (who.by === 'agent') {
      let allowed = false;
      try { allowed = approve ? await approve(await request(m, 'remove', who), who) === true : false; } catch { allowed = false; }
      if (!allowed) throw Object.assign(new Error(`denied by the user: ${m.label} was kept.`), { code: 'EDENIED' });
    }
    await store.remove(m.id);
    onChange();
    return { freed: st.bytes };
  }

  async function rows({ offline = false } = {}) {
    let catalog: ModelRelease[] | null = null, note = '';
    if (!offline) { try { catalog = await store.catalog(); } catch (e) { note = `(gateway catalog unavailable: ${(e as Error).message}; showing pinned models only)`; } }
    const out: ModelRow[] = [];
    for (const m of store.models) {
      const st = await store.status(m.id), rel = catalog?.find((r) => r.repo === m.repo && r.revision === m.revision);
      out.push({ id: m.id, bytes: st.total, license: rel?.license?.name ?? m.license.split(' (')[0], qualification: rel?.qualification?.map((q) => `${q.client}: ${q.status}`).join('; ') ?? '-',
        state: st.complete ? 'downloaded' : st.downloading ? `downloading ${Math.floor((st.bytes / st.total) * 100)}%` : st.bytes ? `partial ${Math.floor((st.bytes / st.total) * 100)}% (models get resumes)` : 'not downloaded', pinned: true });
    }
    for (const r of catalog ?? []) {
      if (store.models.some((m) => m.repo === r.repo && m.revision === r.revision)) continue;
      out.push({ id: r.repo, bytes: r.files.reduce((n, f) => n + f.bytes, 0), license: r.license?.name ?? '?', qualification: r.qualification?.map((q) => `${q.client}: ${q.status}`).join('; ') ?? '-', state: 'not in this build (no pin)', pinned: false });
    }
    return { rows: out, note, fromGateway: !!catalog };
  }

  return { get, remove, rows, request, resolve, status: (name: string) => store.status(resolve(name).id), downloads, store };
}

// The command, bound to who is typing: { by: 'user', via: 'terminal' } or an agent's who.
export function modelsCommands(defineCommand: typeof DefineCommand, service: ModelService | undefined, whoOf: ModelWho | (() => ModelWho)) {
  if (!service) return [];
  // Every known sub returns; the cast admits the unreachable fall-through (undefined).
  return [(defineCommand as (name: string, run: (args: string[], ctx: ResolvedCommandContext) => Promise<ExecResult | undefined>) => Command)('models', async (args, ctx) => {
    const [sub, ...rest] = args;
    if (!sub || sub === '--help' || sub === '-h' || sub === 'help' || rest.includes('--help')) return ok(HELP);
    const who = typeof whoOf === 'function' ? whoOf() : whoOf;
    const flags = rest.filter((a) => a.startsWith('-')), pos = rest.filter((a) => !a.startsWith('-'));
    const known = ({ list: ['--offline'], status: [], get: ['--wait'], remove: [], verify: [] } as Record<string, string[] | undefined>)[sub];
    if (!known) return usage(`unknown command: models ${sub}`);
    const bad = flags.find((f) => !known.includes(f));
    if (bad) return usage(`unknown option ${bad} for models ${sub}`);
    try {
      if (sub === 'list') {
        const { rows, note, fromGateway } = await service.rows({ offline: flags.includes('--offline') });
        const w = Math.max(4, ...rows.map((r) => r.id.length));
        const lines = [`${pad('NAME', w)}  ${pad('SIZE', 8)}  ${pad('LICENSE', 22)}  ${pad('STATE', 26)}  QUALIFICATION`,
          ...rows.map((r) => `${pad(r.id, w)}  ${pad(size(r.bytes), 8)}  ${pad(r.license.slice(0, 22), 22)}  ${pad(r.state, 26)}  ${r.qualification}`)];
        return ok(lines.join('\n') + '\n' + (note ? note + '\n' : ''), fromGateway ? `[read the public catalog at ${GATEWAY}/catalog; nothing about you was sent but the request]\n` : '');
      }
      if (pos.length !== 1) return usage(`models ${sub} takes one name`);
      if (sub === 'status') {
        const s = await service.status(pos[0]);
        const r = await service.store.release(s.id).catch(() => null);
        const m = service.store.get(s.id);
        const task = service.downloads.get(s.id);
        return ok([`${s.id}: ${s.label}`, `  state: ${s.complete ? 'downloaded, verified against the pins' : s.downloading ? `downloading (${size(s.bytes)} of ${size(s.total)})${task ? `, /task/${task.id}` : ''}` : s.bytes ? `partial: ${size(s.bytes)} of ${size(s.total)}; \`models get ${s.id}\` resumes` : `not downloaded (${size(s.total)}); \`models get ${s.id}\` asks the user`}`,
          `  source: ${m.repo}@${m.revision.slice(0, 12)} via ${GATEWAY}`, `  license: ${r?.license?.name ?? m.license}`,
          ...(r?.qualification ? [`  qualification: ${r.qualification.map((q) => `${q.client} ${q.status}`).join('; ')}`] : []),
          `  storage: ${s.persistent ? 'Cache Storage (kept across reloads)' : 'memory (this page load only)'}`,
          ...s.files.map((f) => `  ${f.complete ? 'ok  ' : f.kept ? 'part' : '-   '} ${pad(size(f.bytes), 8)} ${f.name}`)].join('\n') + '\n');
      }
      if (sub === 'get') {
        const r = await service.get(pos[0], who, { signal: undefined });
        if (r.already) return ok(`${r.status.id} is already downloaded and verified (${size(r.status.total)}).\n`);
        const where = `/task/${r.task.id}`;
        if (!flags.includes('--wait')) return ok(`${r.joined ? 'already downloading' : 'downloading'} ${pos[0]} as ${where}: cat ${where}/status (progress in ${where}/log); stop with: echo stop > ${where}/ctl\n`);
        const stopOnAbort = () => r.task.kill?.();
        ctx?.signal?.addEventListener('abort', stopOnAbort, { once: true });
        try { const s = await r.promise; return ok(`downloaded and verified ${s.id} (${size(s.total)}) as ${where}\n`); }
        catch (e) { return fail(`models: ${(e as Error).name === 'AbortError' ? `stopped (${where}); \`models get ${pos[0]}\` resumes where it stopped` : (e as Error).message}`); }
        finally { ctx?.signal?.removeEventListener('abort', stopOnAbort); }
      }
      if (sub === 'verify') {
        const m = service.resolve(pos[0]);
        const r = await service.store.files(m.id, { network: false });
        const total = Object.values(r.files).reduce((n, b) => n + b.size, 0);
        return ok(`verified ${Object.keys(r.files).length} files of ${m.id} (${size(total)}) against the receipts kept when they matched the pins; no network used.\n`);
      }
      if (sub === 'remove') {
        const r = await service.remove(pos[0], who);
        return ok(r.nothing ? `${pos[0]} is not downloaded; nothing to remove.\n` : `removed ${pos[0]}: freed ${size(r.freed)}. \`models get ${pos[0]}\` downloads it again (the user will be asked).\n`);
      }
    } catch (e) {
      return fail(`models: ${(e as Error).message}`);
    }
  })];
}
