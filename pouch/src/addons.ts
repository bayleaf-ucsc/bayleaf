// Add-ons (LANGUAGE.md): optional things Pouch keeps in this browser so a tool
// or a Provider can work: code, weights or data, fetched only when wanted,
// checked against hashes this page was built with, kept outside the Workspace,
// removable at any time. One registry (src/addons-registry.ts, built from the
// build's pins), one service for everyone who installs: the `addons` command
// (agents and the terminal, src/addons-cli.ts), Settings > Add-ons, and the
// workers that need one (src/jobs.ts jobs call ensure() before they start).
//
// Two files backends, one rule (src/assets.ts): `origin` is content-hash parts
// from Pouch's own origin (partAssets), `gateway` is pinned upstream files from
// the BayLeaf HF gateway in byte ranges (src/models.ts, fillFile).
//
// Consent has two tiers, derived from the entry, never declared:
// - quiet: at most QUIET_MAX bytes, from Pouch's own origin, no license beyond
//   the NOTICE Pouch ships. It installs on first use; the /task note and the
//   tool's output say so ("installing pdf.js (3.9 MiB, once, from Pouch's own
//   origin)").
// - asked: everything else. Only a person's click on the install sheet
//   approves; no approve hook means deny. A tool that needs an asked add-on
//   returns at once with NOT_INSTALLED and never opens a sheet itself; an
//   agent runs `addons install <id>`, which opens the sheet naming who asks.
// Removing is the person's right without asking; an agent's remove always asks.
// Every install is a /task entry (kind 'install'), stoppable through its ctl,
// the tray and Settings; installing again resumes.
import { mib, openStore, partAssets } from './assets.ts';
import { createModelStore, GATEWAY } from './models.ts';
import type { AssetProgress, FetchImpl, PartsManifest, RuntimeFiles } from './assets.ts';
import type { ModelRelease } from './models.ts';
import type { ModelPin, PartsPin } from './trust.ts';
import type { Task, Tasks } from './ns/tasks.ts';

export const QUIET_MAX = 10 * 2 ** 20;
export const ORIGIN_STORE = 'pouch-runtime', GATEWAY_STORE = 'pouch-models'; // Cache Storage names (kept: renaming orphans installed bytes)

// ── The registry entry ──────────────────────────────────────────────
export type AddonKind = 'tool' | 'model';
export type AddonTier = 'quiet' | 'asked';
export type AddonFiles = { origin: PartsPin } | { gateway: ModelPin };
export interface AddonSupport { ok: boolean; reason?: string }
export interface AddonDef {
  id: string;                // what `addons install` takes (unique prefixes work)
  label: string;             // what people read: "pdf.js", "LFM3 1.7B"
  kind: AddonKind;
  files: AddonFiles;
  size?: number;             // bytes, when the pin does not say (origin pins carry bytes)
  needs?: string[];          // installed with it, first (LFM3: the Transformers.js code)
  hidden?: boolean;          // not listed alone: shown as part of what needs it
  license: string;           // as the sheet shows it
  extraLicense?: boolean;    // terms beyond the NOTICE Pouch ships: always asks
  attribution?: string;      // required credit (CC-BY), shown on the sheet and in `addons info`
  runs?: string;             // where it runs, for the sheet and `addons info` ("only in this browser, on this computer's GPU")
  notice?: string;           // the shipped NOTICE, relative to the page
  usedBy?: string[];         // the commands that need it
  provider?: string;         // or the Provider it serves
  device?(): AddonSupport | Promise<AddonSupport>; // can this browser run it; checked before anything is fetched
}

const isOrigin = (f: AddonFiles): f is { origin: PartsPin } => 'origin' in f;
// Bytes to install this entry alone.
export const ownSize = (d: AddonDef) => d.size ?? (isOrigin(d.files) ? d.files.origin.bytes ?? 0 : d.files.gateway.files.reduce((n, f) => n + f.bytes, 0));
// Everything included: an add-on and what it needs, each once.
export function closure(def: AddonDef, byId: ReadonlyMap<string, AddonDef>): AddonDef[] {
  const out: AddonDef[] = [], seen = new Set<string>();
  const visit = (d: AddonDef) => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    for (const n of d.needs ?? []) { const dep = byId.get(n); if (!dep) throw new Error(`add-on ${d.id} needs ${n}, which is not in the registry`); visit(dep); }
    out.push(d);
  };
  visit(def);
  return out;
}
// The consent rule: quiet only if every part is small, from this origin and under the shipped NOTICE.
export function tierOf(def: AddonDef, byId: ReadonlyMap<string, AddonDef>): AddonTier {
  const all = closure(def, byId);
  const quiet = all.every((d) => isOrigin(d.files) && !d.extraLicense) && all.reduce((n, d) => n + ownSize(d), 0) <= QUIET_MAX;
  return quiet ? 'quiet' : 'asked';
}
// MiB below 1 GiB, GB above (one decimal).
export const sizeText = (n: number) => (n >= 2 ** 30 ? `${(n / 1e9).toFixed(1)} GB` : mib(n));

// ── What agents and people read (one sentence each: state, then the next step) ──
export const say = {
  notInstalled: (d: AddonDef, size: number, tier: AddonTier = 'asked') => `not installed: ${d.label} (${sizeText(size)}). Run \`addons install ${d.id}\`${tier === 'asked' ? '; the user will be asked' : ''}.`,
  offline: (d: AddonDef, size: number) => `not installed, and the network is not available: ${d.label} (${sizeText(size)}). Try again when online.`,
  notHere: (d: AddonDef, reason: string) => `not available here: ${reason}; nothing was fetched (${d.label}).`,
  installedNotHere: (d: AddonDef, reason: string) => `not available here: ${reason} (${d.label} is installed; \`addons remove ${d.id}\` frees the space).`,
  denied: (d: AddonDef) => `denied by the user: nothing was installed (${d.label}).`,
  deniedRemove: (d: AddonDef) => `denied by the user: ${d.label} was kept.`,
  stopped: (d: AddonDef) => `stopped; \`addons install ${d.id}\` resumes.`,
  installing: (d: AddonDef, size: number) => `installing ${d.label} (${sizeText(size)}, once, from Pouch's own origin)`,
  notBuilt: (label: string) => `not available here: this build of Pouch leaves ${label} out.`,
};
// The update notice's line: "This update changes pdf.js: 1.2 MiB to fetch; LFM3 1.7B unchanged."
export function updateLine(changes: { label: string; tier: AddonTier; change: 'unchanged' | 'changed' | 'removed'; bytes: number; weights: boolean }[]): string {
  if (!changes.length) return '';
  const changed = changes.filter((c) => c.change === 'changed'), removed = changes.filter((c) => c.change === 'removed'), same = changes.filter((c) => c.change === 'unchanged');
  const parts = [
    ...changed.map((c) => `${c.label}: ${sizeText(c.bytes)} to fetch${c.tier === 'asked' ? ' (asks again)' : ''}`),
    ...removed.map((c) => `${c.label}: not in the new build`),
    ...(same.length ? [`${same.map((c) => c.label).join(', ')} unchanged`] : []),
  ];
  const weights = changes.filter((c) => c.weights).map((c) => c.label);
  return `${changed.length || removed.length ? 'This update changes ' : 'Add-ons: '}${parts.join('; ')}.${weights.length ? ` (${weights.join(', ')}: only the code from Pouch's origin is compared; a weights change shows after updating.)` : ''}`;
}
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

// ── Files backends ──────────────────────────────────────────────────
export interface Stored { bytes: number; total: number; complete: boolean; persistent: boolean }
export interface AddonFilesOut { files: RuntimeFiles; manifest?: PartsManifest; repaired: number }
export interface AddonBackend {
  store: string; from: string;  // the Cache Storage name; where bytes come from (the sheet's "From")
  stored(): Promise<Stored>;
  fill(o: { signal?: AbortSignal; onProgress?(done: number): void; onRetry?(line: string): void }): Promise<void>;
  files(o: { network?: boolean; signal?: AbortSignal; onProgress?(p: { done: number; total: number }): void }): Promise<AddonFilesOut>;
  importFiles(list: File[]): Promise<{ added: number; refused: string[] }>;
  remove(): Promise<void>;
  release?(): Promise<ModelRelease | null>; // display metadata (license, qualification), never trusted for bytes
  // Which keys of its store this build's pin names (the sweep keeps them); none: keep the store whole.
  owns?(): Promise<(key: string) => boolean>;
  // Origin parts only: bytes a new manifest needs that are not kept (the update notice).
  toFetch?(next: PartsManifest): Promise<number>;
}
export interface BackendOptions { fetchImpl?: FetchImpl; base?: () => string; gateway?: string; chunk?: number }

export function originBackend(pin: PartsPin, { fetchImpl, base }: BackendOptions = {}): AddonBackend {
  const pa = partAssets(pin, { storeName: ORIGIN_STORE, ...(fetchImpl ? { fetchImpl } : {}), ...(base ? { base } : {}) });
  return {
    store: ORIGIN_STORE, from: `${globalThis.location?.host || 'this page'}/${pin.dir} (Pouch's own origin)`,
    stored: () => pa.stored(),
    async fill({ signal, onProgress }) { await pa.obtain({ network: true, signal, onProgress: (p: AssetProgress) => onProgress?.(p.done) }); },
    async files({ network = true, signal, onProgress }) { const got = await pa.obtain({ network, signal, onProgress }); return { files: got.files, manifest: got.manifest, repaired: got.progress.repaired }; },
    async importFiles(list) { const r = await pa.importFiles(list); return { added: r.added, refused: r.bad ? [`${r.bad} part${r.bad > 1 ? 's' : ''} of ${pin.dir}`] : [] }; },
    remove: () => pa.remove(),
    // The pin's manifest and, once it is kept, exactly its parts. Before that, every part
    // under its directory stays: a new build reuses unchanged content-hash parts.
    async owns() {
      const m = await pa.storedManifest(), mine = pa.key(pin.manifest);
      const parts = m && new Set(m.files.flatMap((f) => f.parts.map((p) => pa.key(p.path))));
      return (k) => k === mine || (k.startsWith(pin.dir) && (parts ? parts.has(k) : !/manifest\.[0-9a-f]{16}\.json$/.test(k)));
    },
    async toFetch(next) {
      const st = await openStore(ORIGIN_STORE, { create: false }), have = new Set(await st.keys(pin.dir));
      return next.files.flatMap((f) => f.parts).filter((p) => !have.has(pa.key(p.path))).reduce((n, p) => n + p.bytes, 0);
    },
  };
}

export function gatewayBackend(pin: ModelPin, { fetchImpl, gateway = GATEWAY, chunk }: BackendOptions = {}): AddonBackend {
  const st = createModelStore([pin], { gateway, ...(fetchImpl ? { fetchImpl } : {}), ...(chunk ? { chunk } : {}) });
  return {
    store: GATEWAY_STORE, from: `${new URL(gateway).host} (BayLeaf's mirror of Hugging Face; Hugging Face sees no request)`,
    stored: async () => { const s = await st.status(pin.id); return { bytes: s.bytes, total: s.total, complete: s.complete, persistent: s.persistent }; },
    async fill({ signal, onProgress, onRetry }) { await st.download(pin.id, { signal, onProgress: (p) => onProgress?.(p.done), onRetry: (r) => onRetry?.(`range ${r.i} retry ${r.attempt}: ${r.error}`) }); },
    async files({ network = true, onProgress }) { const r = await st.files(pin.id, { network, onProgress }); return { files: r.files, repaired: r.repaired }; },
    async importFiles(list) { const r = await st.ingest(pin.id, list); return { added: r.added, refused: r.bad }; },
    remove: () => st.remove(pin.id),
    release: () => st.release(pin.id),
    async owns() { const ks = st.keysOf(pin.id); return (k) => ks.some((x) => k === x + '.state' || k.startsWith(x + '#')); },
  };
}
export const backendOf = (d: AddonDef, o: BackendOptions = {}) => (isOrigin(d.files) ? originBackend(d.files.origin, o) : gatewayBackend(d.files.gateway, o));

// ── The service ─────────────────────────────────────────────────────
// Who asks: the user (the terminal, Settings) or an agent's conversation.
export type AddonWho = { by: 'user'; via?: string } | { by: 'agent'; caller?: unknown; sid?: string | number | null; name?: string };
export type AddonState = 'not installed' | 'installing' | 'partly installed' | 'installed' | 'not available here';
export interface AddonStatus {
  id: string; label: string; kind: AddonKind; tier: AddonTier; size: number; bytes: number; state: AddonState;
  reason?: string; installed: boolean; persistent: boolean; task?: InstallTask; usedBy: string[]; provider?: string; hidden: boolean;
  parts: { id: string; label: string; size: number; bytes: number; complete: boolean }[];
}
// What the install sheet shows, per add-on.
export interface AddonRequestItem { id: string; label: string; kind: AddonKind; bytes: number; size: number; license: string; licenseUrl: string | null; attribution: string | null; runs: string | null; distribution: string | null; from: string[] }
export interface AddonRequest { action: 'install' | 'remove'; who: AddonWho; items: AddonRequestItem[]; bytes: number; location: string }
// The sheet's title: an agent asks by name; the user's own request is a question.
export function askTitle(req: Pick<AddonRequest, 'action' | 'who' | 'items'>): string {
  const what = req.items.length === 1 ? req.items[0].label : `${req.items.length} add-ons`;
  if (req.who.by === 'agent') return `${req.who.name ?? 'An agent'} asks to ${req.action} ${what}`;
  return `${req.action === 'install' ? 'Install' : 'Remove'} ${what}?`;
}
export type InstallTask = Task & { progress?: { done: number; total: number }; promise?: Promise<AddonStatus> };
export type InstallResult = { already: true; status: AddonStatus } | { already?: undefined; task: InstallTask; promise: Promise<AddonStatus>; joined?: boolean };
export interface AddonsOptions {
  entries: AddonDef[]; tasks: Tasks;
  approve?(req: AddonRequest): Promise<boolean>;
  onChange?(): void;
  beforeRemove?(id: string): unknown;         // let a running worker go (the Transformers.js worker holds the weights)
  online?(): boolean;
  backend?(d: AddonDef): AddonBackend;        // tests swap the files backend
  otherBuilds?(): Promise<number | null>;     // open tabs running another build (null: cannot tell); see buildLock
}

// ── Open builds (Web Locks) ─────────────────────────────────────────
// Every page holds a shared lock pouch-build:<sha256 of its pouch.html> for its
// lifetime, so the sweep can see whether another tab runs a different build: that
// tab's add-on keys are not this build's, and deleting them would break it. A page
// that does not know its hash (no pinned offline copy yet) holds pouch-build:unknown,
// which never vouches for a build: one is this page's own, any other counts.
export const BUILD_LOCK = 'pouch-build:';
export interface SweepResult { skipped: boolean; blocked?: 'install' | 'other build' | 'unchecked'; unchecked?: boolean; bytes: number; keys: number }
export interface LockManagerLike {
  request(name: string, options: { mode: 'shared' }, callback: () => Promise<unknown>): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
}
export function buildLock(locks: LockManagerLike | undefined) {
  let mine: string | null = null, held: Promise<void> = Promise.resolve();
  return {
    // Held until the page closes (the callback's promise never settles).
    hold(hash: string | null) {
      if (!locks || mine) return;
      mine = hash ?? 'unknown';
      held = new Promise<void>((granted) => { locks.request(BUILD_LOCK + mine, { mode: 'shared' }, () => { granted(); return new Promise(() => {}); }).catch(() => granted()); });
    },
    async others(): Promise<number | null> {
      if (!locks) return null;
      await held;
      const names = ((await locks.query()).held ?? []).map((l) => l.name ?? '').filter((n) => n.startsWith(BUILD_LOCK)).map((n) => n.slice(BUILD_LOCK.length));
      const me = mine ?? 'unknown', unknown = names.filter((n) => n === 'unknown').length;
      return names.filter((n) => n !== me).length + (me === 'unknown' ? Math.max(0, unknown - (mine ? 1 : 0)) : 0);
    },
  };
}
export type Addons = ReturnType<typeof createAddons>;

export function createAddons({ entries, tasks, approve, onChange = () => {}, beforeRemove, online = () => globalThis.navigator?.onLine !== false, backend = (d) => backendOf(d), otherBuilds }: AddonsOptions) {
  const byId = new Map(entries.map((d) => [d.id, d]));
  if (byId.size !== entries.length) throw new Error('two add-ons share an id');
  const backends = new Map(entries.map((d) => [d.id, backend(d)]));
  const be = (d: AddonDef) => { const b = backends.get(d.id); if (!b) throw new Error(`no files backend for ${d.id}`); return b; };
  const installs = new Map<string, InstallTask>(); // id -> its latest install task
  const get = (id: string) => { const d = byId.get(id); if (!d) throw coded(`unknown add-on "${id}". Run \`addons list\`.`, 'ENOENT'); return d; };
  // An exact id (hidden ones too), else a unique prefix of a listed one.
  function resolve(name: string): AddonDef {
    const exact = byId.get(name);
    if (exact) return exact;
    const hits = entries.filter((d) => !d.hidden && d.id.startsWith(name));
    if (hits.length === 1) return hits[0];
    throw coded(hits.length ? `"${name}" matches ${hits.map((d) => d.id).join(', ')}; say which.` : `no add-on "${name}". Run \`addons list\` for names.`, 'ENOENT');
  }
  async function support(d: AddonDef): Promise<AddonSupport> {
    for (const x of closure(d, byId)) {
      let s: AddonSupport;
      try { s = await (x.device?.() ?? { ok: true }); } catch (e) { s = { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
      if (!s.ok) return s;
    }
    return { ok: true };
  }
  const running = (id: string) => { const t = installs.get(id); return t?.status === 'running' ? t : undefined; };

  async function status(name: string): Promise<AddonStatus> {
    const d = resolve(name), all = closure(d, byId);
    const parts = await Promise.all(all.map(async (x) => { const s = await be(x).stored(); return { id: x.id, label: x.label, size: ownSize(x), bytes: s.complete ? ownSize(x) : Math.min(s.bytes, ownSize(x)), complete: s.complete, persistent: s.persistent }; }));
    const size = parts.reduce((n, p) => n + p.size, 0), bytes = parts.reduce((n, p) => n + p.bytes, 0), installed = parts.every((p) => p.complete);
    const can = await support(d), task = running(d.id) ?? all.map((x) => running(x.id)).find(Boolean);
    const state: AddonState = !can.ok ? 'not available here' : task ? 'installing' : installed ? 'installed' : bytes ? 'partly installed' : 'not installed';
    return { id: d.id, label: d.label, kind: d.kind, tier: tierOf(d, byId), size, bytes, state, ...(can.ok ? {} : { reason: can.reason ?? 'this browser cannot run it' }),
      installed, persistent: parts.every((p) => p.persistent), task, usedBy: d.usedBy ?? [], provider: d.provider, hidden: !!d.hidden, parts: parts.map(({ persistent: _, ...p }) => p) };
  }
  const list = () => Promise.all(entries.filter((d) => !d.hidden).map((d) => status(d.id)));

  async function item(d: AddonDef, action: AddonRequest['action']): Promise<AddonRequestItem> {
    const s = await status(d.id), all = closure(d, byId);
    const rel = (await Promise.all(all.map((x) => be(x).release?.().catch(() => null) ?? null))).find((r) => r) ?? null;
    const attribution = d.attribution ?? (isOrigin(d.files) ? null : `${d.files.gateway.repo} at ${d.files.gateway.revision.slice(0, 12)}${rel?.base_model ? `, from ${rel.base_model}` : ''}`);
    return { id: d.id, label: d.label, kind: d.kind, bytes: action === 'install' ? s.size - s.bytes : s.bytes, size: s.size,
      license: rel?.license?.name ?? all.map((x) => x.license).filter((l, i, a) => a.indexOf(l) === i).join('; '), licenseUrl: rel?.license?.url ?? null,
      attribution, runs: d.runs ?? null, distribution: rel?.distribution?.basis ?? null, from: [...new Set(all.map((x) => be(x).from))] };
  }
  async function request(ds: AddonDef[], action: AddonRequest['action'], who: AddonWho): Promise<AddonRequest> {
    const items = await Promise.all(ds.map((d) => item(d, action)));
    const persistent = (await Promise.all(ds.map((d) => status(d.id)))).every((s) => s.persistent);
    const stores = [...new Set(ds.flatMap((d) => closure(d, byId).map((x) => be(x).store)))].join(', ');
    return { action, who, items, bytes: items.reduce((n, i) => n + i.bytes, 0),
      location: `this browser's site storage for ${globalThis.location?.host || 'this page'} (Cache Storage, ${stores})${persistent ? '' : '; this page load only'}` };
  }
  async function ask(req: AddonRequest) { try { return approve ? await approve(req) === true : false; } catch { return false; } }

  // Check device, state and network; ask if the tier says so. approved: installAll's
  // one combined sheet already asked (private: callers outside go through install).
  const install = (name: string, who: AddonWho) => prepare(resolve(name), who, false);
  async function prepare(d: AddonDef, who: AddonWho, approved: boolean): Promise<InstallResult> {
    const s = await status(d.id);
    if (s.reason !== undefined) throw coded(s.installed ? say.installedNotHere(d, s.reason) : say.notHere(d, s.reason), 'ENOTSUP');
    if (s.installed) return { already: true, status: s };
    const joined = running(d.id);
    if (joined?.promise) return { task: joined, promise: joined.promise, joined: true };
    if (!online()) throw coded(say.offline(d, s.size), 'ENETDOWN');
    if (s.tier === 'asked' && !approved && !(await ask(await request([d], 'install', who)))) throw coded(say.denied(d), 'EDENIED');
    // Another caller may have started it while the sheet was open: join, so one task owns the download and its Stop.
    const late = running(d.id);
    if (late?.promise) return { task: late, promise: late.promise, joined: true };
    return start(d, s, who);
  }
  function start(d: AddonDef, s: AddonStatus, who: AddonWho): InstallResult {
    const all = closure(d, byId), ctrl = new AbortController();
    const task: InstallTask = tasks.add({ kind: 'install', label: `addons install ${d.id}`, sid: who.by === 'agent' ? who.sid : undefined,
      ns: [`writes: browser storage (${[...new Set(all.map((x) => be(x).store))].join(', ')}), reads: ${[...new Set(all.map((x) => be(x).from))].join('; ')}`], kill: () => ctrl.abort() });
    task.note(s.tier === 'quiet' ? say.installing(d, s.size - s.bytes) : `approved by the user; ${sizeText(s.size - s.bytes)} to fetch`);
    task.progress = { done: s.bytes, total: s.size };
    let last = -1;
    task.promise = (async () => {
      let before = 0;
      for (const x of all) {
        const own = s.parts.find((p) => p.id === x.id);
        if (own?.complete) { before += own.size; continue; }
        if (ctrl.signal.aborted) throw new DOMException('Stopped.', 'AbortError');
        await be(x).fill({ signal: ctrl.signal, onRetry: (l) => task.note(l), onProgress: (done) => {
          const p = { done: Math.min(before + done, s.size), total: s.size };
          task.progress = p;
          const pct = Math.floor((p.done / p.total) * 100);
          if (pct >= last + 5 || p.done === p.total) { last = pct - (pct % 5); task.note(`${sizeText(p.done)} of ${sizeText(p.total)} (${pct}%)`); }
          onChange();
        } });
        before += ownSize(x);
      }
      return status(d.id);
    })().then((r) => { task.end('done', `installed ${d.label} (${sizeText(r.size)}), checked against this page's hashes`); onChange(); return r; },
      (e) => { const stop = e instanceof Error && e.name === 'AbortError'; task.end(stop ? 'stopped' : 'failed', stop ? say.stopped(d) : e instanceof Error ? e.message : String(e)); onChange(); throw e; });
    task.promise.catch(() => {});
    for (const x of all) installs.set(x.id, task);
    onChange();
    return { task, promise: task.promise };
  }

  // Before a worker starts: installed, or installed quietly now (note says so),
  // or refused at once with the string the tool returns. Never opens a sheet.
  async function ensure(name: string, who: AddonWho, { note, signal }: { note?(line: string): void; signal?: AbortSignal } = {}): Promise<{ fresh: boolean }> {
    const d = resolve(name), s = await status(d.id);
    if (s.reason !== undefined) throw coded(s.installed ? say.installedNotHere(d, s.reason) : say.notHere(d, s.reason), 'ENOTSUP');
    if (s.installed) return { fresh: false };
    if (s.tier === 'asked') throw coded(say.notInstalled(d, s.size), 'ENOTINSTALLED');
    const r = await install(d.id, who);
    if (r.already) return { fresh: false };
    note?.(say.installing(d, s.size - s.bytes));
    // Stopping the job stops an install it started; a joined one (Settings', another job's) keeps going.
    let leave = () => {};
    const left = new Promise<never>((_, rej) => { leave = () => rej(new DOMException('Stopped.', 'AbortError')); });
    const kill = r.joined ? leave : () => r.task.kill?.();
    signal?.addEventListener('abort', kill, { once: true });
    try { await (r.joined ? Promise.race([r.promise, left]) : r.promise); } finally { signal?.removeEventListener('abort', kill); }
    return { fresh: true };
  }

  // Every file of an add-on and what it needs, each verified (a damaged part is
  // fetched again when the network may be used). Not installed: NOT_INSTALLED.
  async function files(name: string, { network = online(), signal, onProgress }: { network?: boolean; signal?: AbortSignal; onProgress?(p: { done: number; total: number; id: string }): void } = {}) {
    const d = resolve(name), s = await status(d.id);
    if (!s.installed) throw coded(network || s.tier === 'asked' ? say.notInstalled(d, s.size, s.tier) : say.offline(d, s.size), 'ENOTINSTALLED');
    const out: Record<string, AddonFilesOut> = {};
    for (const x of closure(d, byId)) out[x.id] = await be(x).files({ network, signal, onProgress: (p) => onProgress?.({ ...p, id: x.id }) });
    return out;
  }
  // A worker's verified files, installing quietly first when allowed (src/pdf.ts, src/media.ts).
  const assets = (name: string, who: AddonWho = { by: 'user' }) => ({
    async obtain({ network, signal, note }: { network?: boolean; signal?: AbortSignal; note?(line: string): void } = {}) {
      await ensure(name, who, { note, signal });
      const d = resolve(name), got = (await files(name, { network, signal }))[d.id];
      return { files: got.files, manifest: got.manifest };
    },
  });

  async function remove(name: string, who: AddonWho): Promise<{ nothing: true; freed?: undefined } | { nothing?: undefined; freed: number }> {
    const d = resolve(name), s = await status(d.id);
    // Hidden parts go with the last listed add-on that needs them.
    const others = entries.filter((x) => x.id !== d.id && !x.hidden);
    const keep = new Set<string>();
    for (const o of others) if ((await status(o.id)).bytes) for (const x of closure(o, byId)) keep.add(x.id);
    const drop = closure(d, byId).filter((x) => x.id === d.id || (x.hidden && !keep.has(x.id)));
    if (!s.bytes && !s.task) return { nothing: true };
    if (who.by === 'agent' && !(await ask(await request([d], 'remove', who)))) throw coded(say.deniedRemove(d), 'EDENIED');
    for (const x of drop) { running(x.id)?.kill?.(); await running(x.id)?.promise?.catch(() => {}); }
    for (const x of drop) await beforeRemove?.(x.id);
    let freed = 0;
    for (const x of drop) { freed += (await be(x).stored()).bytes; await be(x).remove(); }
    onChange();
    return { freed };
  }

  // Everything this device can run that is not installed: quiet ones directly,
  // asked ones through one combined sheet.
  async function installAll(who: AddonWho) {
    const rows = await list(), want = rows.filter((s) => !s.installed && s.state !== 'not available here' && !s.task);
    const joined = [...new Set(rows.flatMap((s) => (s.task ? [s.task] : [])))]; // already running: --wait waits for them too
    const asked = want.filter((s) => s.tier === 'asked').map((s) => get(s.id));
    if (!online() && want.length) throw coded(`not installed, and the network is not available: ${want.map((s) => s.label).join(', ')}. Try again when online.`, 'ENETDOWN');
    const approved = asked.length ? await ask(await request(asked, 'install', who)) : true;
    const started: InstallTask[] = [];
    for (const s of want) {
      if (s.tier === 'asked' && !approved) continue;
      const r = await prepare(get(s.id), who, s.tier === 'asked');
      if (!r.already) started.push(r.task);
    }
    return { started, joined: joined.filter((t) => !started.includes(t)), denied: approved ? [] : asked.map((d) => d.label), already: (await list()).filter((s) => s.installed).length };
  }
  const total = async () => (await list()).filter((s) => s.state !== 'not available here').reduce((n, s) => n + s.size, 0);

  // Picked files (a saved folder, the original upstream files): each checked like an install.
  async function importFiles(name: string, list: Iterable<File>) {
    const d = resolve(name), picked = [...list];
    let added = 0; const refused: string[] = [];
    for (const x of closure(d, byId)) { const r = await be(x).importFiles(picked); added += r.added; refused.push(...r.refused); }
    onChange();
    return { added, refused, status: await status(d.id) };
  }
  // Re-check every kept byte with no network.
  async function verify(name: string) {
    const got = await files(name, { network: false });
    const blobs = Object.values(got).flatMap((g) => Object.values(g.files));
    return { files: blobs.length, bytes: blobs.reduce((n, b) => n + b.size, 0) };
  }
  // Stale-part sweep: delete what no entry of this build names any more (parts of
  // older manifests, other revisions' chunks), never a current pin's keys and never
  // while an install runs. A store with a backend that cannot say what it owns is
  // left whole. dry: only measure (Settings' "Free N MiB from older versions").
  // While another tab runs a different build nothing is deleted (blocked: 'other build',
  // with what would be freed); auto (boot) also waits when it cannot tell (no Web Locks:
  // unchecked, and Settings says so).
  async function sweep({ dry = false, auto = false }: { dry?: boolean; auto?: boolean } = {}): Promise<SweepResult> {
    const busy = () => entries.some((d) => running(d.id));
    if (busy()) return { skipped: true, blocked: 'install', bytes: 0, keys: 0 };
    const others = otherBuilds ? await otherBuilds().catch(() => null) : 0;
    if (others === null && auto) return { skipped: true, blocked: 'unchecked', bytes: 0, keys: 0 };
    const blocked = others ? 'other build' : undefined;
    if (blocked && auto) return { skipped: true, blocked, bytes: 0, keys: 0 };
    const measure = dry || !!blocked;
    let bytes = 0, keys = 0;
    for (const name of [ORIGIN_STORE, GATEWAY_STORE]) {
      const mine = entries.map((d) => be(d)).filter((b) => b.store === name);
      if (mine.some((b) => !b.owns)) continue;
      const owners = await Promise.all(mine.map((b) => b.owns?.() ?? ((): boolean => true)));
      const st = await openStore(name, { create: false });
      for (const k of await st.keys()) {
        if (owners.some((o) => o(k))) continue;
        if (busy()) return { skipped: true, blocked: 'install', bytes, keys }; // an install began meanwhile
        bytes += (await st.get(k))?.size ?? 0; keys++;
        if (!measure) await st.del(k);
      }
      if (!measure && keys && !(await st.keys()).length) await st.drop();
    }
    if (!measure && keys) onChange();
    return { skipped: !!blocked, ...(blocked ? { blocked } : {}), ...(others === null ? { unchecked: true } : {}), bytes, keys };
  }

  // What a published build changes among the installed add-ons, read from its
  // SHA256SUMS (manifest paths, each with its hash) and those manifests (read(path),
  // checked by the caller). Origin parts only: gateway pins live in the new page.
  async function updateChanges(sums: Record<string, string>, read: (path: string) => Promise<PartsManifest>) {
    const out: { id: string; label: string; tier: AddonTier; change: 'unchanged' | 'changed' | 'removed'; bytes: number; weights: boolean }[] = [];
    for (const d of entries.filter((x) => !x.hidden)) {
      if (!(await status(d.id)).installed) continue;
      let change: 'unchanged' | 'changed' | 'removed' = 'unchanged', bytes = 0;
      for (const x of closure(d, byId)) {
        if (!isOrigin(x.files)) continue;
        const pin = x.files.origin, next = Object.keys(sums).find((p) => p.startsWith(pin.dir) && /manifest\.[0-9a-f]{16}\.json$/.test(p));
        if (!next) { change = 'removed'; continue; }
        if (next === pin.dir + pin.manifest) continue;
        if (change !== 'removed') change = 'changed';
        bytes += await be(x).toFetch?.(await read(next)) ?? 0;
      }
      out.push({ id: d.id, label: d.label, tier: tierOf(d, byId), change, bytes, weights: closure(d, byId).some((x) => !isOrigin(x.files)) });
    }
    return out;
  }

  const release = async (name: string) => { for (const x of closure(resolve(name), byId)) { const r = await be(x).release?.().catch(() => null); if (r) return r; } return null; };

  return { entries, get, resolve, status, list, install, ensure, files, assets, remove, installAll, total, importFiles, verify, release, request, sweep, updateChanges,
    stop: (name: string) => running(resolve(name).id)?.kill?.(), installing: running, tier: (d: AddonDef) => tierOf(d, byId), closure: (d: AddonDef) => closure(d, byId) };
}
