// Off-Sealed providers: Transformers.js (in this browser) and Localhost (a server on this computer), their picker entries and settings.

import * as store from '../store.ts';
import { $, el } from '../dom.ts';
import { LOCAL, engine as localEngine, importFiles as localImport, remove as localRemove, stored as localStored } from '../local/engine.ts';
import { HINTS, isLocal } from '../local/provider.ts';
import { DEFAULT_URL, TRANSPORTS, isLocalhost, parseLocalhostUrl, testConnection } from '../localhost.ts';
import type { App } from './app.ts';
import type { LocalProgress, Support } from '../local/engine.ts';
import type { LocalHint } from '../local/provider.ts';
import type { LocalhostModelInfo, LocalhostTest, LocalhostTransport } from '../localhost.ts';
import type { LocalhostConfig, SessionId } from '../agent-types.ts';
import type { Api, Model } from '@earendil-works/pi-ai';

// Localhost as set up by the user and kept in settings ('localhost').
export interface LocalhostSetup {
  base: string; key: string; transport: LocalhostTransport; transportChoice?: LocalhostTransport | 'auto';
  detected?: LocalhostTransport; models: LocalhostModelInfo[]; testedAt?: number;
}
// Download or load progress for the status line; downloading: a /task download (models get).
export type LocalStatusProgress = LocalProgress & { downloading?: boolean };

export interface ProvidersRegion {
  canSend(): boolean;
  clearHint(sid: SessionId | null | undefined): void;
  // Download (asking first) and start Transformers.js; false with a status line when it cannot.
  ensureLocal(): Promise<boolean>;
  get lh(): LocalhostSetup | null; set lh(v: LocalhostSetup | null);
  lhAgentConfig(): LocalhostConfig | null;
  lhModels(): LocalhostModelInfo[];
  lhRuns: Set<string>; // sessions whose current turn runs on Localhost
  readonly lhWaitShown: boolean;
  LOCAL_ID: string | null;
  localhostOptions(saved: string): HTMLOptionElement[];
  localhostPicked(): boolean;
  // model: the one loading, for 'slow'; 'flowing' clears the line.
  localhostWait(kind: 'slow' | 'flowing', model?: Model<Api>): void;
  get localOk(): Support; set localOk(v: Support);
  localOption(saved: string): HTMLOptionElement[];
  localPicked(): boolean;
  localProgress(p: LocalStatusProgress): void;
  localRuns: Set<string>; // sessions whose current turn runs on Transformers.js
  mib(n: number): string;
  offSealed(id: string): boolean;
  offSealedPicked(): boolean;
  pickerProvider(): void;
  renderHint(): void;
  renderLocalhostSettings(result?: LocalhostTest): void;
  renderLocalSettings(): Promise<void>;
  showHint(kind: LocalHint): void;
}

export function createProvidersRegion(app: App): ProvidersRegion {
  // ── Transformers.js provider (src/local/): a model in this browser, chosen explicitly
  // The picker offers it when this build carries it and WebGPU works; otherwise
  // it is listed disabled with the reason. Nothing is downloaded without asking.
  let localOk: Support = { ok: false, reason: '' };
  const localRuns = new Set<string>(); // sessions whose current turn runs on Transformers.js
  const LOCAL_ID = LOCAL ? 'local:' + LOCAL.id : null;
  // A thrown value's fields, without trusting its shape.
  const fieldOf = (e: unknown, k: string) => String(typeof e === 'object' && e !== null ? Reflect.get(e, k) ?? '' : k === 'message' ? e : '');
  const localPicked = () => isLocal($<HTMLSelectElement>('model').value);
  const canSend = () => !!app.state.agent && (offSealedPicked() || (app.connection.verified && !app.connection.offline));
  const mib = (n: number) => `${(n / 2 ** 20).toLocaleString(undefined, { maximumFractionDigits: 0 })} MB`;
  // A saved choice of Transformers.js stays selected even when unavailable (a phone,
  // a weak adapter): Send then refuses with the reason (ensureLocal) instead of
  // quietly sending the message to Sealed.
  function localOption(saved: string) {
    if (!LOCAL || !LOCAL_ID) return [];
    const o = new Option(localOk.ok ? `${LOCAL.label} (in this browser)` : `${LOCAL.label} (unavailable: ${localOk.reason})`, LOCAL_ID, false, saved === LOCAL_ID);
    o.disabled = !localOk.ok;
    o.title = localOk.ok ? 'Runs in this browser on your GPU. Nothing is sent.' : localOk.reason;
    return [o];
  }
  function pickerProvider() {
    const local = localPicked(), lhost = localhostPicked(), label = $<HTMLSelectElement>('model').closest<HTMLElement>('.provider-model');
    if (!label) throw new Error('pouch.html: #model is outside .provider-model');
    label.dataset.sealedTitle ??= label.title; // the page's own wording, kept from the first call
    label.querySelector('use')?.setAttribute('href', local ? '#i-chip' : lhost ? '#i-laptop' : '#i-lock');
    // Providers keep fixed theme colors (continuity): no two providers share one.
    label.classList.toggle('provider-tjs', local);
    label.classList.toggle('provider-localhost', lhost);
    label.title = local ? 'Transformers.js: runs in this browser, nothing is sent.' : lhost ? 'Localhost: your server on this computer runs the model. The model applies to your next user turn.' : label.dataset.sealedTitle;
    $('shield-btn')?.classList.toggle('provider-tjs', local);
    $('shield-btn')?.classList.toggle('provider-localhost', lhost);
    if (app.connection.offline) $<HTMLTextAreaElement>('input').placeholder = local || lhost ? app.queues.PLACEHOLDER : 'Offline: keep typing; Send comes back with the network';
    label.title = local ? 'Transformers.js: the model runs in this browser; nothing is sent. The model applies when you next send.' : 'BayLeaf Sealed: requests are encrypted to the enclave. The model applies when you next send; running work keeps its model.';
    app.state.composer?.refreshShield();
  }
  // Downloading is a choice (about 1.1 GB): the same approval sheet and /task
  // download as `models get` (src/models-cli.ts); progress shows in the status
  // line and Settings, and Stop writes the download's /task ctl.
  let localLoading: Promise<boolean> | null = null;
  async function ensureLocal() {
    if (!localOk.ok) { app.state.status(`Transformers.js is not available: ${localOk.reason}`, 'bad'); return false; }
    if (!LOCAL) { app.state.status('Transformers.js is not available: this build of Pouch does not include it.', 'bad'); return false; }
    if (localEngine.loaded()) return true;
    const st = await localStored();
    if (!st.complete) {
      if (!navigator.onLine) { app.state.status('The Transformers.js model is not in this browser yet, and you are offline. Settings can load a saved copy from a folder.', 'bad'); return false; }
      let r;
      try { r = await app.sessionList.modelService.get(LOCAL.id, { by: 'user', via: 'Settings' }); }
      catch (e) { const denied = fieldOf(e, 'code') === 'EDENIED'; app.state.status(denied ? 'Not downloaded.' : 'Transformers.js model: ' + fieldOf(e, 'message'), denied ? '' : 'bad'); return false; }
      if (!r.already) {
        renderLocalSettings();
        try { await r.promise; }
        catch (e) { const stopped = fieldOf(e, 'name') === 'AbortError'; app.state.status(stopped ? `Download stopped at ${mib((await localStored()).bytes)}; Download resumes where it stopped.` : 'Transformers.js model: ' + fieldOf(e, 'message'), stopped ? '' : 'bad'); renderLocalSettings(); return false; }
      }
    }
    return startLocal(LOCAL.label);
  }
  function startLocal(label: string): Promise<boolean> {
    const box = $('local-settings');
    box.dataset.state = 'loading';
    localLoading ??= localEngine.start({ onProgress: localProgress, network: navigator.onLine })
      .then(() => { box.dataset.state = 'ready'; app.state.status(`${label} is ready in this browser (Transformers.js).`); return true; },
        (e: Error) => { box.dataset.state = 'error'; box.dataset.error = e.message; app.state.status('Transformers.js model: ' + e.message, 'bad'); return false; })
      .finally(() => { localLoading = null; renderLocalSettings(); });
    return localLoading;
  }
  let progressAt = 0;
  function localProgress(p: LocalStatusProgress) {
    if (p.phase !== 'loading' && p.done < p.total && Date.now() - progressAt < 150) return; // a few updates a second
    progressAt = Date.now();
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    const text = p.phase === 'loading' ? `Transformers.js: verified ${mib(p.total)}; starting the model on your GPU...`
      : p.phase === 'runtime' ? `Transformers.js: ${p.fetched || p.repaired ? 'fetching and checking' : 'checking'} the runtime, ${mib(p.done)} of ${mib(p.total)} (${pct}%)`
      : `Transformers.js: ${p.downloading ? 'downloading from api.bayleaf.dev and checking' : p.fetched || p.repaired ? 'downloading and checking' : 'checking'} ${mib(p.done)} of ${mib(p.total)} (${pct}%)${p.repaired ? `, ${p.repaired} damaged chunk${p.repaired > 1 ? 's' : ''} fetched again` : ''}`;
    app.state.status(text);
    const bar = $<HTMLProgressElement>('local-progress');
    if (bar) { bar.hidden = false; bar.max = p.total || 1; bar.value = p.done; }
  }
  // A reason to suggest Sealed (never a switch): shown under the composer for the session that ran.
  const hints = new Map<string, Set<LocalHint>>(); // sid -> Set of kinds
  function showHint(kind: LocalHint) {
    const sid = [...localRuns].at(-1);
    if (sid == null) return;
    let kinds = hints.get(sid);
    if (!kinds) hints.set(sid, kinds = new Set());
    kinds.add(kind);
    renderHint();
  }
  function clearHint(sid: SessionId | null | undefined) { hints.delete(String(sid)); renderHint(); }
  function renderHint() {
    const box = $('local-hint'), kinds = [...(hints.get(String(app.sessionList.sessions.current?.id)) ?? [])];
    box.hidden = !kinds.length;
    if (!kinds.length) return;
    $('local-hint-text').textContent = kinds.map((k) => HINTS[k]).join(' ') + ' BayLeaf Sealed (a larger model, encrypted to the enclave) may do better.';
  }
  $('local-hint-switch').onclick = async () => {
    const to = (await store.getSetting<string>('sealedModel')) ?? app.connection.models[0]?.id;
    if (!to || !app.connection.models.some((m) => m.id === to)) return app.state.status('No BayLeaf Sealed model is available right now.', 'bad');
    $<HTMLSelectElement>('model').value = to; await store.setSetting('model', to); pickerProvider(); app.queues.updateSend();
    clearHint(app.sessionList.sessions.current?.id);
    app.state.status(`Switched the picker to BayLeaf Sealed (${app.transcript.modelName(to)}) for your next message. Nothing was sent.`);
  };
  $('local-hint-dismiss').onclick = () => clearHint(app.sessionList.sessions.current?.id);
  async function renderLocalSettings() {
    const box = $('local-settings');
    if (!box) return;
    if (!LOCAL) { $('local-state').textContent = 'This build of Pouch does not include the Transformers.js model.'; box.querySelectorAll('button').forEach((b) => { b.hidden = true; }); return; }
    const st = await localStored();
    $('local-state').textContent = !localOk.ok ? `Not available here: ${localOk.reason}${st.bytes ? ` A downloaded copy (${mib(st.bytes)}) is kept in this browser; Remove frees the space.` : ''}`
      : st.complete ? `${LOCAL.label} is kept in this browser (${mib(st.bytes)}${st.persistent ? '' : ', for this page load only'}). It works offline.`
      : st.bytes ? `${mib(st.bytes)} of ${mib(st.total)} downloaded.` : `Not downloaded (about ${mib(LOCAL.bytes)}).`;
    const dl = app.sessionList.modelService.downloads.get(LOCAL.id);
    const running = dl?.status === 'running';
    if (running) $('local-state').textContent = `Downloading from api.bayleaf.dev as /task/${dl.id}: ${mib(dl.progress?.done ?? 0)} of ${mib(dl.progress?.total ?? LOCAL.bytes)}. Every file is checked against this page's pins.`;
    else if (!st.complete && st.bytes) $('local-state').textContent = `${mib(st.bytes)} of ${mib(st.total)} downloaded and kept; Download resumes where it stopped.`;
    $('local-download').hidden = !localOk.ok || st.complete || running;
    $('local-download').textContent = st.bytes && !st.complete ? 'Resume download' : 'Download';
    $('local-stop').hidden = !running;
    $('local-remove').hidden = !st.bytes || running;
    if (!localLoading && !running) $('local-progress').hidden = true;
  }
  $('local-download').onclick = async () => { if (await ensureLocal()) renderLocalSettings(); };
  // Stop is the download's /task ctl, as `echo stop > /task/<id>/ctl` in the terminal.
  $('local-stop').onclick = () => { const t = LOCAL && app.sessionList.modelService.downloads.get(LOCAL.id); if (t?.status === 'running') app.namespaces.ctl(`/task/${t.id}/ctl`, 'stop').catch((e: Error) => app.state.status(e.message, 'bad')); };
  $('local-remove').onclick = async () => {
    if (localRuns.size) return app.state.status('Stop the Transformers.js turn before removing the model.', 'bad');
    if (!(await app.tree.ask('Remove the Transformers.js model from this browser? Sessions and files stay. Downloading it again takes about 1.1 GB.', 'Remove', 'danger'))) return;
    await localRemove(); // the same store code as `models remove` (src/models.ts)
    if (localPicked()) { $<HTMLSelectElement>('model').value = (await store.getSetting('sealedModel')) ?? app.connection.models[0]?.id ?? ''; await store.setSetting('model', $<HTMLSelectElement>('model').value); pickerProvider(); app.queues.updateSend(); }
    const est = await navigator.storage?.estimate?.().catch(() => null);
    app.state.status(`Transformers.js model removed.${est?.usage != null ? ` This site now uses ${mib(est.usage)} of storage.` : ''}`);
    renderLocalSettings();
  };
  for (const id of ['local-folder', 'local-files']) {
    $(id + '-btn').onclick = () => $(id).click();
    $(id).onchange = async () => {
      const files = $<HTMLInputElement>(id).files;
      if (!files?.length) return;
      app.state.status('Checking the picked files against this page\'s pins...');
      try {
        const r = await localImport(files);
        $<HTMLInputElement>(id).value = '';
        app.state.status(r.complete ? `Transformers.js model loaded from your files (${r.added} files verified${r.bad ? `, ${r.bad} refused` : ''}).`
          : `${r.added} files verified${r.bad ? `, refused (wrong bytes): ${r.refused.join(', ') || r.bad}` : ''}; ${mib(r.total - r.bytes)} still missing.`, r.bad ? 'bad' : '');
      } catch (e) { app.state.status(fieldOf(e, 'message'), 'bad'); }
      renderLocalSettings();
    };
  }

  // ── Localhost provider (src/localhost.ts): a model server on this computer
  // Set up only here, by the user: an address on loopback, an optional key (kept in
  // this browser's IndexedDB like the BayLeaf key, shown masked, removable; Erase all
  // removes it), and the transport. Test connection checks reachability, CORS, the
  // key, the model list and the transport, without generating anything.
  let lh: LocalhostSetup | null = null;
  const lhRuns = new Set<string>(); // sessions whose current turn runs on Localhost
  const localhostPicked = () => isLocalhost($<HTMLSelectElement>('model').value);
  const offSealed = (id: string) => isLocal(id) || isLocalhost(id);
  const offSealedPicked = () => offSealed($<HTMLSelectElement>('model').value);
  const lhModels = () => lh?.models ?? [];
  const lhAgentConfig = () => (lh?.base && lh.models?.length ? { base: lh.base, key: lh.key || '', transport: lh.transport, models: lh.models } : null);
  function localhostOptions(saved: string) {
    if (!lh) return [];
    const { base } = lh;
    return lhModels().map((m) => {
      const o = new Option(`${m.id} (your machine)`, 'localhost:' + m.id, false, saved === 'localhost:' + m.id);
      o.title = `Runs on your server at ${base}. Pouch sends it this session's messages and the files the model reads.`;
      return o;
    });
  }
  async function saveLocalhost(next: LocalhostSetup | null) {
    lh = next;
    await store.setSetting('localhost', lh ?? undefined);
    app.state.agent?.setLocalhost?.(lhAgentConfig());
    await app.connection.loadModels();
    renderLocalhostSettings();
  }
  const mask = (k: string) => (k.length <= 8 ? '•'.repeat(k.length) : `${k.slice(0, 3)}${'•'.repeat(6)}${k.slice(-4)}`);
  function renderLocalhostSettings(result?: LocalhostTest) {
    if (!$('lh-settings')) return;
    if (document.activeElement !== $<HTMLInputElement>('lh-url')) $<HTMLInputElement>('lh-url').value = lh?.base ?? $<HTMLInputElement>('lh-url').value ?? '';
    if (!$<HTMLInputElement>('lh-url').value) $<HTMLInputElement>('lh-url').placeholder = DEFAULT_URL;
    $<HTMLSelectElement>('lh-transport').value = lh?.transportChoice ?? 'auto';
    $<HTMLInputElement>('lh-key').value = '';
    $<HTMLInputElement>('lh-key').placeholder = lh?.key ? `saved: ${mask(lh.key)} (type to replace)` : 'only if your server asks for one';
    $('lh-key-remove').hidden = !lh?.key;
    $('lh-forget').hidden = !lh;
    $('lh-key-state').textContent = lh?.key ? `Key saved in this browser (${mask(lh.key)}), never synced; it is sent only to ${lh.base}. Remove key or Erase all deletes it.` : 'Kept in this browser only, never synced or sent anywhere but your server. Erase all removes it.';
    if (result) {
      $('lh-steps').replaceChildren(...result.steps.map((s) => el('li', { className: s.ok ? 'ok' : 'bad', textContent: s.text })));
      $('lh-fix').hidden = result.ok;
      $('lh-fix').textContent = result.ok ? '' : fixFor(result);
    } else if (lh?.models?.length && !$('lh-steps').childElementCount) {
      $('lh-steps').replaceChildren(el('li', { className: 'ok', textContent: `Set up: ${lh.models.length} model${lh.models.length === 1 ? '' : 's'} from ${lh.base}, ${TRANSPORTS[lh.transport]}. They are in the model picker under Localhost.` }));
    }
  }
  function fixFor(r: { ok: boolean; kind?: string }) {
    if (r.kind === 'cors') return `To fix: allow the origin ${location.origin} on your server, restart it, then press Test connection again. Pouch cannot do this for you: your server decides who may call it.`;
    if (r.kind === 'lna') return 'To fix: allow this site to reach devices on your local network (Chrome asks once; the site settings let you change your answer), then test again.';
    if (r.kind === 'unreachable') return 'To fix: start your server and check the port. Pouch only tries the address above.';
    if (r.kind === 'auth') return 'To fix: copy the API key from your server\'s settings into the key field.';
    return '';
  }
  $<HTMLButtonElement>('lh-test').onclick = async () => {
    const url = $<HTMLInputElement>('lh-url').value.trim() || DEFAULT_URL;
    const parsed = parseLocalhostUrl(url);
    const typedKey = $<HTMLInputElement>('lh-key').value.trim();
    const key = typedKey || (lh && parsed.ok && parsed.base === lh.base ? lh.key : '') || '';
    const picked = $<HTMLSelectElement>('lh-transport').value;
    const choice = picked === 'completions' || picked === 'responses' ? picked : 'auto';
    $<HTMLButtonElement>('lh-test').disabled = true;
    $('lh-steps').replaceChildren(el('li', { className: 'ok', textContent: 'Testing...' }));
    try {
      const r = await testConnection({ url, key, transport: choice });
      if (r.ok) {
        await saveLocalhost({ base: r.base, key, transport: r.transport, transportChoice: choice, detected: r.detected, models: r.models, testedAt: Date.now() });
        app.state.status(`Localhost is set up: ${r.models.length} model${r.models.length === 1 ? '' : 's'} in the picker under Localhost.`);
      }
      renderLocalhostSettings(r);
      if (!r.ok) app.state.status('Localhost test failed: ' + r.error, 'bad');
    } finally { $<HTMLButtonElement>('lh-test').disabled = false; }
  };
  $('lh-key-remove').onclick = async () => {
    if (!lh?.key) return;
    if (!(await app.tree.ask('Remove the Localhost API key from this browser? Your server keeps its own copy; Pouch will send no key until you add one again.', 'Remove key', 'danger', 'Remove key?'))) return;
    await saveLocalhost({ ...lh, key: '' });
    app.state.status('Localhost key removed from this browser.');
  };
  $('lh-forget').onclick = async () => {
    if (lhRuns.size) return app.state.status('Stop the Localhost turn before removing Localhost.', 'bad');
    if (!(await app.tree.ask('Remove Localhost from this browser: its address, key and model list? Sessions stay; picking a Localhost model again needs a new Test connection.', 'Remove', 'danger', 'Remove Localhost?'))) return;
    const was = localhostPicked();
    await saveLocalhost(null);
    $('lh-steps').replaceChildren(); $<HTMLInputElement>('lh-url').value = '';
    if (was) { $<HTMLSelectElement>('model').value = (await store.getSetting('sealedModel')) ?? app.connection.models[0]?.id ?? ''; await store.setSetting('model', $<HTMLSelectElement>('model').value); pickerProvider(); app.queues.updateSend(); }
    app.state.status('Localhost removed from this browser.' + (was ? ' The picker is back on a BayLeaf Sealed model.' : ''));
  };
  // A long wait for the first token is usually the server loading the model.
  let lhWaitShown = false;
  function localhostWait(kind: 'slow' | 'flowing', model?: Model<Api>) {
    if (kind === 'slow') { lhWaitShown = true; app.state.status(`Waiting for your server: it may be loading ${model ? model.id.slice('localhost:'.length) : 'the model'} (the first use after a while can take a minute).`); }
    else if (lhWaitShown) { lhWaitShown = false; app.state.status(''); }
  }

  return {
    canSend,
    clearHint,
    ensureLocal,
    get lh() { return lh; }, set lh(v) { lh = v; },
    lhAgentConfig,
    lhModels,
    lhRuns,
    get lhWaitShown() { return lhWaitShown; },
    LOCAL_ID,
    localhostOptions,
    localhostPicked,
    localhostWait,
    get localOk() { return localOk; }, set localOk(v) { localOk = v; },
    localOption,
    localPicked,
    localProgress,
    localRuns,
    mib,
    offSealed,
    offSealedPicked,
    pickerProvider,
    renderHint,
    renderLocalhostSettings,
    renderLocalSettings,
    showHint,
  };
}
