// Sealed connection: verification and its client, the network state and the Sealed model list.

import * as store from '../store.ts';
import { $, el } from '../dom.ts';
import { sealedModels } from '../bayleaf-api.ts';
import { createSealedClient } from '../sealed.ts';
import type { App } from './app.ts';
import type { AttestationStep, SealedHandle, SealedModelList } from '../trust.ts';
import type { SealedModelInfo, SessionId } from '../agent-types.ts';

// The shield's verification state, as a class on #badge and #shield-btn.
export type BadgeState = 'pending' | 'ok' | 'bad' | 'offline';
// A Sealed chat model in the picker (loadModels).
export type PickerModel = SealedModelInfo & { name: string; windowReported?: boolean };

export interface ConnectionRegion {
  // Verify the enclave for the current credential; fails closed.
  connect(): Promise<void>;
  goOffline(): void;
  isNetworkError(msg: string | null | undefined): boolean;
  loadModels(): Promise<void>;
  lostRuns: Set<SessionId>; // sessions whose turn the network cut off
  // Sealed chat models with tool calling, as last loaded.
  readonly models: PickerModel[];
  readonly offline: boolean;
  OFFLINE: string;
  // Can the relay be reached at all?
  probe(): Promise<boolean>;
  // The verified Sealed client, or null: written only here, at each verification.
  sealed(): SealedHandle | null;
  readonly verified: boolean;
}

// A thrown value's message (a library may throw a non-Error).
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createConnectionRegion(app: App): ConnectionRegion {
  // ── Sealed client: verification and credential ───────────────────────
  let client: SealedHandle | null = null; // verified once per credential
  let verified = false;
  let models: PickerModel[] = [];
  function fact(label: string, value: string, cls = '') {
    $('facts').append(el('dt', { textContent: label }), el('dd', { textContent: value, className: cls }));
  }

  async function connect() {
    verified = false; client = null; app.queues.updateSend();
    setBadge('pending', 'Verifying enclave');
    let cacheSecret = await store.getSetting<string>('cacheSecret');
    if (!cacheSecret) {
      // Scopes Tinfoil's prompt cache to this device; persists so multi-turn chats hit it.
      cacheSecret = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await store.setSetting('cacheSecret', cacheSecret);
    }
    const c = createSealedClient({ bearerToken: app.state.key ?? 'campus', cacheSecret });
    $('facts').replaceChildren();
    try {
      await c.ready();
      const doc = await c.getVerificationDocument();
      const ok = doc.securityVerified === true;
      // Hashes fold behind "Verified · Details" (critique 10); the summary says the verdict.
      const same = doc.codeFingerprint === doc.enclaveFingerprint;
      // A step listed without a result counts as failed (shown, and not Verified).
      const steps = Object.entries(doc.steps ?? {}).map(([k, x]): [string, AttestationStep] => [k, x ?? { status: 'missing' }]);
      const good = ok && same && steps.every(([, x]) => x.status === 'success');
      const more = el('dl', {});
      const sub = (label: string, value: string, cls = '') => more.append(el('dt', { textContent: label }), el('dd', { textContent: value, className: cls }));
      sub('Enclave', doc.enclaveHost ?? '?');
      sub('Code repo', doc.configRepo ?? '?');
      sub('Release', (doc.releaseTag ? doc.releaseTag + ' ' : '') + (doc.releaseDigest ?? '?'));
      // Equal fingerprints mean the running enclave is the published release.
      sub('Published code', doc.codeFingerprint ?? '?');
      sub('Running enclave', doc.enclaveFingerprint ?? '?', same ? 'ok' : 'bad');
      sub('Verified at', doc.verifiedAt ?? '?');
      for (const [step, state] of steps) sub('Step: ' + step, state.status + (state.error ? ' – ' + state.error : ''), state.status === 'success' ? 'ok' : 'bad');
      $('facts').append(el('dt', { textContent: 'Enclave' }), el('dd', {},
        el('details', { className: 'facts-more' }, el('summary', {}, el('span', { className: good ? 'ok' : 'bad', textContent: good ? 'Verified' : 'Not verified' }), ` · ${doc.releaseTag ?? ''} · Details`), more)));
      fact('Credential', app.state.key ? 'personal key (stored in this browser)' : 'Campus Pass (no account; campus network only)');
      if (!ok) throw new Error('attestation did not verify');
      client = c; verified = true;
      setBadge('ok', 'BayLeaf Sealed: enclave verified');
      app.state.status(app.state.key ? '' : app.auth.campusLine(app.state.usage.state));
    } catch (e) {
      // Fail closed: no plaintext fallback exists anywhere in this app. An
      // unreachable network is not a failed verification: say which it was.
      if (!navigator.onLine || isNetworkError(messageOf(e))) goOffline();
      else {
        setBadge('bad', 'Enclave not verified: nothing will be sent');
        app.state.status('Could not verify the enclave, so nothing will be sent: ' + messageOf(e), 'bad');
      }
    }
    app.queues.updateSend();
  }

  // ── Network (F1, F2) ────────────────────────────────────────────────
  // Offline means the model is unreachable; everything else in the page keeps
  // working. Detected from the browser's online/offline events and from requests
  // that fail like a dropped network; left after a cheap re-check of the relay.
  let offline = false;
  let recheck: ReturnType<typeof setInterval> | null = null;
  const lostRuns = new Set<SessionId>(); // sessions whose turn the network cut off
  const OFFLINE = 'Offline: the model is unreachable. Files, the editor, archives and run keep working; sending comes back when the network does.';
  const LOCAL_OFFLINE = 'Offline: BayLeaf Sealed is unreachable. Transformers.js keeps working; it needs no network.';
  const LOCALHOST_OFFLINE = 'Offline: BayLeaf Sealed is unreachable. Localhost keeps working: your server is on this computer.';
  function isNetworkError(msg: string | null | undefined) { return /failed to fetch|networkerror|network ?error|load failed|connection (error|lost)|ERR_INTERNET|ERR_NETWORK|fetch failed/i.test(msg ?? ''); }
  function goOffline() {
    const was = offline;
    offline = true; verified = false; client = null;
    setBadge('offline', 'Offline: the model is unreachable');
    app.state.status(app.providers.localPicked() ? LOCAL_OFFLINE : app.providers.localhostPicked() ? LOCALHOST_OFFLINE : OFFLINE, 'offline');
    $<HTMLTextAreaElement>('input').placeholder = app.providers.offSealedPicked() ? app.queues.PLACEHOLDER : 'Offline: keep typing; Send comes back with the network';
    // A turn waiting on a dead stream would otherwise hang until the socket times out.
    // Transformers.js and Localhost turns need no network beyond this computer.
    for (const sid of app.sessionList.sessions.running) { if (app.providers.localRuns.has(sid) || app.providers.lhRuns.has(sid)) continue; lostRuns.add(sid); app.state.agent?.abort(sid).catch(() => {}); }
    if (!was) { clearInterval(recheck ?? undefined); recheck = setInterval(probe, 15_000); }
    app.queues.updateSend(); app.transcript.scheduleRender();
  }
  // Can the relay be reached at all? The model list is small and unauthenticated.
  async function probe() {
    if (!navigator.onLine) return false;
    try { await sealedModels({ cache: 'no-store', signal: AbortSignal.timeout(8000) }); }
    catch { return false; }
    if (offline) backOnline();
    return true;
  }
  async function backOnline() {
    offline = false; clearInterval(recheck ?? undefined); recheck = null;
    $<HTMLTextAreaElement>('input').placeholder = app.queues.PLACEHOLDER;
    app.state.status('Back online: verifying the enclave again.');
    if (!models.length) await loadModels();
    await connect(); // re-verifies; sets badge, status and Send
    app.state.usage.refresh();
  }
  addEventListener('offline', goOffline);
  addEventListener('online', () => { probe(); });
  // The shield in the top bar: its color is the verification state; it opens Trust.
  function setBadge(state: BadgeState, text: string) {
    const b = $('badge');
    b.className = 'icon ' + state;
    b.ariaLabel = text; b.title = text + '. Click for what BayLeaf can see.';
    const href = state === 'ok' ? '#i-shield-check' : state === 'bad' ? '#i-shield-alert' : '#i-shield';
    b.querySelector('use')?.setAttribute('href', href);
    // The composer's shield shows the same state; it opens the provider popover.
    $('shield-btn').querySelector('use')?.setAttribute('href', href);
    $('shield-btn').className = 'icon ' + state;
    app.state.composer?.refreshShield();
  }
  $('badge').onclick = () => app.state.layout.toggle('trust');

  async function loadModels() {
    try {
      const data = ((await (await sealedModels()).json()) as SealedModelList).data ?? []; // JSON from the relay: typed where it enters
      // Chat models that can call tools. Tinfoil's tool-like entries (websearch,
      // doc-upload, pii-filter) stay out until their data paths are reviewed.
      models = data
        .filter((m) => m.tool_calling && m.endpoints?.includes('/v1/chat/completions'))
        .filter((m) => !/safeguard|websearch|doc-upload|pii-filter/i.test(m.id))
        .map((m) => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.context_window ?? 131072, windowReported: m.context_window != null, reasoning: !!m.reasoning, multimodal: m.multimodal === true,
          cost: m.pricing && { input: m.pricing.inputTokenPricePer1M ?? 0, output: m.pricing.outputTokenPricePer1M ?? 0, cacheRead: 0 } }));
    } catch (e) {
      app.state.status('Could not load the BayLeaf Sealed model list: ' + messageOf(e), 'bad');
    }
    const saved = (await store.getSetting<string>('model')) ?? 'glm-5-3';
    // Transformers.js is never the default: without a BayLeaf Sealed list, a placeholder holds the place.
    // The picker groups models by provider (LANGUAGE.md), each named specifically.
    const none = !models.length && saved !== app.providers.LOCAL_ID ? [Object.assign(new Option('Model list unavailable', '', true, true), { disabled: true })] : [];
    const group = (label: string, opts: HTMLOptionElement[]) => (opts.length ? [el('optgroup', { label }, ...opts)] : []);
    $<HTMLSelectElement>('model').replaceChildren(...group('BayLeaf Sealed', [...none, ...models.map((m) => new Option(m.name + (m.multimodal ? ' · images' : ''), m.id, false, m.id === saved))]), ...group('Transformers.js', app.providers.localOption(saved)), ...group('Localhost', app.providers.localhostOptions(saved)));
    app.state.agent?.setModels?.(models);
    app.providers.pickerProvider();
  }
  let lastPick: string | null = null;
  $<HTMLSelectElement>('model').onfocus = () => { lastPick = $<HTMLSelectElement>('model').value; };
  $<HTMLSelectElement>('model').onchange = async () => {
    // Switching providers is always this explicit choice; Pouch never switches by itself.
    if (app.providers.localPicked() && !(await app.providers.ensureLocal())) { $<HTMLSelectElement>('model').value = lastPick ?? models[0]?.id ?? ''; app.providers.pickerProvider(); return; }
    await store.setSetting('model', $<HTMLSelectElement>('model').value);
    if (!app.providers.localPicked()) await store.setSetting('sealedModel', $<HTMLSelectElement>('model').value);
    app.providers.pickerProvider(); app.queues.updateSend();
    app.state.status(app.providers.localPicked() ? 'Transformers.js selected for your next user turn: the model runs in this browser and nothing is sent.'
      : app.providers.localhostPicked() ? 'Localhost selected for your next user turn: your server on this computer runs it. No allowance is used.' : 'Model selected for your next user turn. Running work is unchanged.');
  };

  return {
    connect,
    goOffline,
    isNetworkError,
    loadModels,
    lostRuns,
    get models() { return models; },
    get offline() { return offline; },
    OFFLINE,
    probe,
    sealed: () => (verified ? client : null),
    get verified() { return verified; },
  };
}
