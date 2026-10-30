// The agent loop: pi-durable conversations over the BayLeaf Sealed lane.
//
// Security boundary (do not loosen): every model request leaves this module
// through the Tinfoil SecureClient's fetch, which EHBP-encrypts the body in the
// page to the attested enclave before BayLeaf relays it. There is no plaintext
// path: if no verified client is available, the request fails.
//
// Layers, outside in:
//   UI  ->  openAgent() API  ->  pi-durable Harness (durable transcript, tools,
//   compaction)  ->  pi-ai openai-completions  ->  sealedFetch  ->  Tinfoil EHBP
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createRegistry, defineExtension, defineTool, section, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb';
import { Type } from 'typebox';
import { createSubagents, REPORT_KIND, STEER_KIND, MESSAGE_KIND } from './subagents.js';
import { WATCH_KIND } from './ns/watch.js';
import { attachmentContext } from './attachments.js';
import { LOCAL_PROVIDER, isLocal, localApi, localModel } from './local/provider.js';

export { Type, MemoryStorage, REPORT_KIND };

const PROVIDER = 'bayleaf-sealed';
// Must match the TinfoilAI client's baseURL: the SDK's encrypting fetch refuses
// any origin other than the one it attested for, which is a second guard.
const BASE_URL = 'https://api.bayleaf.dev/sealed/v1/';
const DB_NAME = 'bayleaf-pouch-agent';
const USER_KIND = 'pouch.user'; // a user message whose model view carries Pouch's notes
const TOOL_OUTPUT_CAP = 50_000; // chars sent to the model per tool result
const ctx = BACKGROUND_CONTEXT; // waits here are ours to cancel through abort(), not contexts

// Compaction budget per context window. A 1M window is not a reason to send
// 1M tokens every turn (cost, latency, and long-context quality all suffer),
// so we compact as if the window were at most 256k.
const EFFECTIVE_WINDOW = 262_144;
function compactionFor(contextWindow = 131_072) {
  const budget = Math.min(contextWindow, EFFECTIVE_WINDOW);
  // pi-durable caps a summary at 0.8 * reserveTokens, and reasoning models spend
  // part of that thinking; keep at least 16k reserved (half of a small window).
  const reserve = Math.max(Math.round(budget * 0.125), Math.min(16_384, Math.round(budget / 2)));
  return {
    reserveTokens: contextWindow - budget + reserve, // blocking threshold
    keepRecentTokens: Math.min(40_000, Math.round(budget * 0.15)),
    backgroundTokens: Math.round(budget * 0.125), // start summarizing this far before blocking
  };
}

// pi-ai model records for the sealed catalog. compat turns off OpenAI-only
// request fields the enclave's servers may reject; thinking still streams,
// because pi-ai reads `reasoning`, `reasoning_content` and `reasoning_text` deltas.
// Optional m.cost is USD per 1M tokens ({ input, output, cacheRead }), as in
// /sealed/models `pricing`; without it usage.cost stays 0.
function toModel(m) {
  const ctxWindow = m.contextWindow ?? 131_072;
  return {
    id: m.id, name: m.name ?? m.id, api: 'openai-completions', provider: PROVIDER, baseUrl: BASE_URL,
    reasoning: !!m.reasoning, input: m.multimodal === true ? ['text', 'image'] : ['text'],
    cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: 0 },
    contextWindow: ctxWindow, maxTokens: Math.min(32_768, Math.floor(ctxWindow / 4)),
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
}

// The encrypting fetch, resolved per request so sign-in/out takes effect at
// once. TinfoilAI keeps its SecureClient and bearer token in fields that are
// private in TypeScript only; tinfoil is exact-pinned, and we check the shape
// so an SDK change fails loudly instead of silently.
function sealedFetch(getClient, onRequest) {
  return async (input, init = {}) => {
    const client = await getClient();
    if (!client) throw new Error('Not connected to BayLeaf Sealed: sign in (or use campus access) and wait for verification.');
    const doc = await client.getVerificationDocument();
    if (!doc?.securityVerified) throw new Error('Enclave attestation is not verified; refusing to send.');
    const secure = client.secureClient, token = client.openAIOptions?.apiKey;
    if (typeof secure?.fetch !== 'function' || typeof token !== 'string') throw new Error('Unexpected Tinfoil SDK shape; refusing to send.');
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(BASE_URL).origin) throw new Error(`Refusing to send to ${url.origin}`);
    // pi-ai's own OpenAI client carries a placeholder key; the real bearer is the
    // one the TinfoilAI was built with (a BayLeaf key or 'campus').
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    // Counted as it leaves (one request from the allowance), for the tray's live spend.
    if (init.signal?.aborted) throw new DOMException('Stopped before sending.', 'AbortError');
    onRequest?.();
    return secure.fetch(input, { ...init, headers });
  };
}

// Provider-level seam: every request the Harness makes (generation,
// compaction summaries, hooks) goes through the same fetch.
const withFetch = (api, fetch) => ({
  stream: (m, c, o) => api.stream(m, c, { ...o, fetch }),
  streamSimple: (m, c, o) => api.streamSimple(m, c, { ...o, fetch }),
});

const cap = (text) => text.length <= TOOL_OUTPUT_CAP ? text
  : `${text.slice(0, TOOL_OUTPUT_CAP)}\n\n[output truncated: ${text.length - TOOL_OUTPUT_CAP} more characters not shown]`;

// UI tool spec -> pi-durable tool. Streaming output goes to api.output (shown
// live in pi.live); the returned string is what the model reads. `caller` is
// the calling conversation, so hooks can tell a subagent from the main agent.
// Running calls by id, so the composer tray can stop one call (a long `run`)
// without aborting the whole turn: the tool fails with "Stopped." and the
// model reads that and carries on.
const callStops = new Map(); // call id -> AbortController
function toTool(t) {
  return defineTool({
    name: t.name, label: t.label ?? t.name, description: t.description, parameters: t.parameters,
    execute: async (args, api, context) => {
      const stop = new AbortController();
      const signal = AbortSignal.any([context.abortSignal, stop.signal].filter(Boolean));
      callStops.set(api.callId, stop);
      try {
        const text = await t.execute(args, { signal, output: (s) => api.output(String(s)), caller: api.conversationId, callId: api.callId });
        return { output: [{ type: 'text', text: cap(String(text ?? '')) }] };
      } finally { callStops.delete(api.callId); }
    },
  });
}

// Hold one IndexedDB storage. pi-durable has no cross-process locking, so two
// tabs on one database would corrupt it: each database has its own Web Lock,
// held for as long as this page has it open.
async function acquireLock(name) {
  if (typeof navigator === 'undefined' || !navigator.locks) return () => {};
  return new Promise((resolve, reject) => {
    navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) return reject(new Error('This session is open in Pouch in another tab. Close it there to use it here.'));
      return new Promise((release) => resolve(release));
    }).catch(reject);
  });
}

// Storage layout (L2): pi-durable has no way to delete a conversation, so
// each session gets its own database, and deleting the session deletes the
// database. Sessions made before this ('legacy': numeric ids) stay in the
// one shared database; it can only be dropped whole, which dropLegacy() does
// once no legacy session is left in the index (and Erase all does anyway).
export const isLegacy = (id) => !String(id).startsWith('p-');
const dbFor = (id) => `${DB_NAME}-${id}`;
const newId = () => `p-${crypto.randomUUID()}`;
const dbExists = async (name) => !indexedDB.databases || (await indexedDB.databases()).some((d) => d.name === name);

// Model ids starting "local:" are the Local lane (src/local/provider.js):
// generated on this device, never sent. Every other id is Sealed.
const modelRef = (modelId) => ({ provider: isLocal(modelId) ? LOCAL_PROVIDER : PROVIDER, modelId });

// pointer: { get(id), set(id, convId) } keeps which conversation in a
// session's database is current; a revert (D12) forks and moves it.
// subagents: { reg: { get(sid), set(sid, list) }, onChange(sid, list),
// onReport(sid, submission, child), onSettle(sid, child), lowAllowance() }
// (src/subagents.js); without reg there is no subagent tool.
// onInterrupted(sids): sessions whose run a reload cut off (aborted, not resumed).
// local: { info: LOCAL_MODEL, engine, onHint } adds the Local lane's provider.
export async function openAgent({ storage, tools = [], systemPrompt, getClient, models: initialModels = [], pointer, subagents: saDeps, onInterrupted, local, onRequest }) {
  const models = createModels();
  let catalog = [];
  const api = withFetch(openAICompletionsApi(), sealedFetch(getClient, onRequest));
  function setModels(list) {
    catalog = list.map(toModel);
    models.setProvider(createProvider({
      id: PROVIDER, name: 'BayLeaf Sealed', baseUrl: BASE_URL, models: catalog, api,
      auth: { apiKey: { name: 'BayLeaf Sealed', resolve: async () => ({ auth: { apiKey: 'sealed' } }) } },
    }));
  }
  setModels(initialModels);
  if (local?.info) {
    models.setProvider(createProvider({
      id: LOCAL_PROVIDER, name: 'Local (on this device)', baseUrl: 'local:', models: [localModel(local.info)], api: localApi(local.engine, { onHint: local.onHint }),
      auth: { apiKey: { name: 'Local', resolve: async () => ({ auth: { apiKey: 'local' } }) } },
    }));
  }

  // Which session a conversation belongs to (its own, a revert's fork, or a
  // subagent's), filled as lanes open and conversations are made.
  const sidByConv = new Map();
  const sidOf = (convId) => sidByConv.get(convId) ?? convId; // shared lanes: the id is the session
  const subagents = saDeps?.reg ? createSubagents({
    ...saDeps, ctx, sidOf, modelRef,
    laneOf: (sid) => laneOf(sid), lane: (name) => lane(name), conv: (sid) => conv(sid),
  }) : null;

  const registry = createRegistry();
  registry.install(defineExtension({
    name: 'pouch',
    tools: [...tools.map(toTool), ...(subagents ? [subagents.tool, subagents.peerTool] : [])],
    sections: systemPrompt ? [section('pouch', () => systemPrompt(), { tag: false })] : [],
  }));

  const options = {
    models, registry,
    identity: { attribution: null }, // no app-attribution headers to anyone
    settings: {
      retry: { maxRetries: 2 },
      afterFailedRun: 'withdraw', // a failed run should not leave later inputs stranded
      // Every queued steer joins the next step (default: one per step), so
      // messages from several sessions of a graph arrive together, in order.
      steeringMode: 'all',
      compaction: {
        enabled: true,
        ...compactionFor(),
        // Getter: recomputed from whatever catalog setModels() installed last.
        get modelOverrides() {
          return Object.fromEntries(catalog.map((m) => [`${PROVIDER}/${m.id}`, compactionFor(m.contextWindow)]));
        },
      },
    },
  };

  // A lane is one open Harness over one database (name -> Promise<lane>),
  // opened on first use and kept until delete or close. An injected storage
  // (tests) is one shared lane for every session, like the legacy database.
  const lanes = new Map();
  function lane(name) {
    if (!lanes.has(name)) {
      const p = (async () => {
        const release = storage ? () => {} : await acquireLock(name);
        try {
          const st = storage ?? await IndexedDbStorage.open(name);
          const harness = await Harness.open(st, options, ctx);
          const sid = name.startsWith(DB_NAME + '-') ? name.slice(DB_NAME.length + 1) : null;
          if (sid) {
            let cursor;
            do {
              const page = await st.scanConversations({}, 100, cursor, ctx);
              for (const c of page.items) sidByConv.set(c.id, sid);
              cursor = page.next;
            } while (cursor);
          }
          // A reload must never spend Sealed requests by itself, so pending
          // work is not resumed (no harness.resume()): every conversation with
          // a live run or queued input is aborted, which runs abort handlers
          // only, and reported to onInterrupted; the user resumes with a click.
          const interrupted = await quiesce(harness);
          return { harness, release, storage: st, sid, interrupted };
        } catch (e) { release(); throw e; }
      })();
      lanes.set(name, p);
      p.catch(() => lanes.delete(name)); // let a later attempt retry (the other tab may close)
      // Children the last page left running are marked interrupted (or, if
      // they settled unreported, reported quietly); then parents are told.
      p.then(async (l) => {
        if (l.sid) await subagents?.resume(l.sid, l.interrupted);
        const parents = l.interrupted.filter((c) => !subagents?.owner(c));
        if (parents.length) onInterrupted?.(parents.map((c) => sidOf(c)));
      }, () => {});
    }
    return lanes.get(name);
  }
  async function quiesce(harness) {
    const ins = await harness.inspect(ctx);
    const ids = new Set([...ins.tasks.map((t) => t.record.conversationId), ...ins.submissions.map((x) => x.conversationId)].filter((x) => x != null));
    for (const id of ids) await (await harness.conversation(id, ctx))?.abort(ctx).catch(() => {});
    return [...ids];
  }
  async function closeLane(name) {
    const p = lanes.get(name);
    if (!p) return;
    lanes.delete(name);
    const l = await p.catch(() => null);
    if (l) try { await l.harness.close(ctx); } finally { l.release(); }
  }
  const shared = (id) => storage || isLegacy(id);
  const laneOf = (id) => shared(id) ? (storage ? 'memory' : DB_NAME) : dbFor(id);

  // Pouch id -> pi-durable conversation id. Shared lanes use the conversation
  // id itself. A session database holds its first conversation and the forks
  // that reverts made of it; the pointer says which one is current, and a
  // session never reverted has only the first.
  const convIds = new Map();
  async function locate(id) {
    const { harness, storage: st } = await lane(laneOf(id));
    if (shared(id)) return { harness, convId: id };
    if (!convIds.has(id)) {
      let convId = await pointer?.get(id);
      if (convId == null) {
        const page = await st.scanConversations({}, 1, undefined, ctx);
        if (!page.items[0]) throw new Error(`No such session: ${id}`);
        convId = page.items[0].id;
      }
      convIds.set(id, convId);
      own(id, convId);
    }
    return { harness, convId: convIds.get(id) };
  }
  const conv = async (id) => {
    const { harness, convId } = await locate(id);
    const c = await harness.conversation(convId, ctx);
    if (!c) throw new Error(`No such session: ${id}`);
    return c;
  };
  const watchers = new Map(); // dispose -> session id

  async function watch(id, onView, child) {
    const c = child ? await subagents.childConv(id, child) : await conv(id);
    // The view holds only the active context, which compaction and reset
    // cut short. Keep the whole transcript for display: scan what is stored,
    // then append each entry the view adds (entries are immutable).
    const history = [], ids = new Set();
    const add = (e) => { if (!ids.has(e.id)) { ids.add(e.id); history.push(e); } };
    let cursor;
    do {
      const page = await c.entries(cursor ? {} : { order: 'ascending' }, 500, cursor, ctx);
      page.items.forEach(add);
      cursor = page.next;
    } while (cursor);
    const view = await c.viewState(ctx);
    const push = (value) => { value.entries.forEach(add); onView(normalize({ ...value, entries: history })); };
    push(view.value);
    const unsubscribe = view.subscribe(push);
    const dispose = () => { watchers.delete(dispose); unsubscribe?.(); view.dispose(); };
    watchers.set(dispose, String(id));
    return dispose;
  }
  function own(sid, convId) { sidByConv.set(convId, String(sid)); }
  // Poll a steer's submission until it leaves the inbox; see steer().
  async function placement(id, sub, child) {
    let rec;
    for (;;) {
      rec = await sub.status(ctx).catch(() => null);
      if (!rec || rec.status !== 'queued') break;
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!rec?.entry) return null;
    let v = null;
    (await watch(id, (x) => { v = x; }, child))();
    return { late: !v?.items.find((i) => i.entry === rec.entry)?.steer };
  }

  async function point(id, convId) {
    for (const [d, sid] of watchers) if (sid === String(id)) d();
    convIds.set(id, convId);
    own(id, convId);
    await pointer?.set(id, convId);
  }

  return {
    setModels,
    isLegacy: (id) => !storage && isLegacy(id),
    async createSession(modelId) {
      const id = storage ? null : newId();
      const { harness } = await lane(storage ? 'memory' : dbFor(id));
      const c = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: modelRef(modelId) } }, ctx);
      if (storage) return c.id;
      convIds.set(id, c.id);
      own(id, c.id);
      return id;
    },
    // Stop the work, then erase the session's database. A shared-lane
    // (legacy) session can only be stopped and reset: its entries stay until
    // dropLegacy() or Erase all. Resolves to { erased }.
    async deleteSession(id) {
      for (const [d, sid] of watchers) if (sid === String(id)) d();
      if (shared(id)) {
        const c = await conv(id).catch(() => null);
        if (c) { await c.abort(ctx); await c.reset(undefined, ctx); }
        return { erased: false };
      }
      const name = dbFor(id);
      if (!lanes.has(name) && !(await dbExists(name))) return { erased: true };
      const c = await conv(id).catch((e) => { if (/another tab/.test(e.message)) throw e; return null; });
      if (c) await c.abort(ctx).catch(() => {});
      await subagents?.stopAll(id).catch(() => {});
      await closeLane(name);
      convIds.delete(id);
      await IndexedDbStorage.delete(name);
      return { erased: true };
    },
    // Drop the shared legacy database once the index holds none of its
    // sessions (what is left in it are transcripts of deleted ones).
    async dropLegacy() {
      if (storage || !(lanes.has(DB_NAME) || await dbExists(DB_NAME))) return false;
      for (const [d, sid] of watchers) if (isLegacy(sid)) d();
      await closeLane(DB_NAME);
      let release;
      try { release = await acquireLock(DB_NAME); } catch { return false; } // in use in another tab
      try { await IndexedDbStorage.delete(DB_NAME); } finally { release(); }
      return true;
    },
    // Revert to here (D12): fork the current conversation just after entry
    // `at` and make the fork current. The model then sees nothing past `at`.
    // The old conversation stays in the session's database (deleted with it),
    // so point(id, from) undoes the revert. Resolves to { from, to }.
    async revert(id, at) {
      if (shared(id)) throw new Error('This session was saved before per-session storage and cannot be reverted.');
      const c = await conv(id);
      const fork = await c.fork(at, { ownership: { kind: 'ownerless' } }, ctx);
      const from = c.id;
      await point(id, fork.id);
      return { from, to: fork.id };
    },
    point,
    async setModel(id, modelId) {
      await (await conv(id)).configure({ model: modelRef(modelId) }, ctx);
    },
    // notes: what the user did since the last turn (undos, edits). The model
    // reads them before the message; the transcript entry keeps only `text`.
    async send(id, text, notes = [], attachments = { files: [], images: [] }, modelId) {
      // Fail before admitting the input, so it is not queued behind a dead lane.
      // A Local turn needs no Sealed connection (and makes no request).
      const c = await conv(id);
      if (!isLocal(modelId ?? (await c.agent(ctx))?.model?.modelId) && !(await getClient())) throw new Error('Not connected to BayLeaf Sealed: sign in (or use campus access) and wait for verification.');
      const state = await c.viewState(ctx), running = !!state.value.docs['pi.live']?.run;
      state.dispose();
      if (running) throw new Error('This conversation is still running. Wait or stop it before sending.');
      // Only a user submission may change the configured model, never a picker change.
      if (modelId) await c.configure({ model: modelRef(modelId) }, ctx);
      const current = modelId ?? (await c.agent(ctx))?.model?.modelId;
      if (attachments.images.length && !catalog.find((m) => m.id === current)?.input.includes('image')) throw new Error('Choose an image-capable model before sending. No request was sent.');
      const content = (notes.length ? `[Note from Pouch, not typed by the user: since your last turn, ${notes.join('; ')}.]\n\n` : '') + text + attachmentContext(attachments.files);
      const input = { type: 'input', whenBusy: 'reject', content: attachments.images.length ? [{ type: 'text', text: content }, ...attachments.images] : content,
        ...(notes.length || attachments.files.length ? { entry: { kind: USER_KIND, data: { text, attachments: attachments.files } } } : {}) };
      const sub = await c.submit(input, ctx);
      subagents?.newTurn(id); // the user spoke: the scope's message caps start over
      const settled = await sub.wait(ctx);
      if (settled.status !== 'done') throw new Error(describeUnanswered(settled));
    },
    // Steer (JOURNEYS D25): the user's text joins the running turn at its
    // next step boundary. Resolves to { id, placed }: placed resolves once it
    // left the inbox, to { late } (late: the turn had already ended, so it
    // started the next one) or null (withdrawn). Pouch never sends a steer
    // to an idle conversation itself; late covers the run ending in between.
    async steer(id, text) {
      const c = await conv(id);
      const sub = await c.submit({ type: 'input', content: text, whenBusy: 'steer', entry: { kind: STEER_KIND, data: { text } } }, ctx);
      return { id: sub.id, placed: placement(id, sub) };
    },
    // Take back a steer that has not been placed: 'aborted' (it was still
    // queued), 'already_placed' or 'settled'.
    async withdraw(id, subId) {
      const { harness } = await locate(id);
      const sub = await harness.submission(subId, ctx);
      return sub ? sub.abort(ctx) : 'settled';
    },
    // Wait for a placed steer that started its own turn (its run's end).
    async waitFor(id, subId) {
      const { harness } = await locate(id);
      await (await harness.submission(subId, ctx))?.wait(ctx);
    },
    async abort(id) {
      await (await conv(id)).abort(ctx);
    },
    // Stop one running tool call; false if it already finished.
    stopCall(callId) {
      const c = callStops.get(callId);
      c?.abort();
      return !!c;
    },
    async compact(id) {
      const { harness } = await locate(id);
      const taskId = await (await conv(id)).compact(undefined, ctx);
      const { outcome } = (await harness.waitForTask(taskId, ctx)).state;
      if (outcome?.status !== 'completed') throw new Error(`Compaction ${outcome?.status ?? 'failed'}: ${outcome?.error?.message ?? ''}`.trim());
      // No submission means nothing old enough to summarize (all of it is
      // within keepRecentTokens); otherwise wait until the summary is placed.
      if (outcome.result?.submissionId === undefined) throw new Error('Nothing to compact yet: the conversation is still short.');
      await (await harness.submission(outcome.result.submissionId, ctx))?.wait(ctx);
    },
    watch,
    // Subagents of a session (src/subagents.js): registry rows, and actions
    // for the card's buttons. watchChild(sid, child, onView) is watch() of one.
    subagents: subagents && {
      list: (sid) => subagents.list(sid),
      stop: (sid, child) => subagents.stop(sid, child),
      // Stop every running subagent of a session (Stop all): aborts their requests in flight.
      stopAll: (sid) => subagents.stopAll(sid),
      message: (sid, child, text) => subagents.message(sid, child, text, { user: true }),
      // From the subagent's view: joins its running work, never restarts it.
      steer: (sid, child, text) => subagents.steer(sid, child, text),
      watch: (sid, child, onView) => watch(sid, onView, child),
      resume: (sid) => subagents.resume(sid),
      // Main's blocking calls (a foreground spawn, a wait): [{ kind, ids, since }].
      blocked: (sid) => subagents.blocked(sid),
      // G10/G12: return them at once; text (the user's message) joins main's
      // next step as a steer. Resolves to false (nothing blocked), true, or
      // with text, { id, placed } as steer() does.
      detach: async (sid, text) => {
        const sub = await subagents.detach(sid, text == null ? {} : { text, input: { type: 'input', content: text, entry: { kind: STEER_KIND, data: { text } } } });
        return sub && typeof sub === 'object' ? { id: sub.id, placed: placement(sid, sub) } : sub;
      },
      // Steering a subagent; resolves to { note, id, placed }.
      steerTracked: async (sid, child, text) => {
        const out = {};
        const note = await subagents.steer(sid, child, text, out);
        return { note, id: out.sub.id, placed: placement(sid, out.sub, child) };
      },
      refOf: (l, c) => subagents.refOf(l, c),
      // File watches (src/ns/watch.js): deliver an event; is that session running?
      notify: (sid, ref, ev) => subagents.notify(sid, ref, ev),
      busyOf: (sid, ref) => subagents.busyOf(sid, ref),
    },
    // Who made a tool call: { sid, child, ns } (child: the subagent id, or null;
    // ns: the mounts its spawn declared, if any).
    who(convId) {
      const o = subagents?.owner(convId);
      return o ? { sid: o.sid, child: o.id, ns: o.ns } : { sid: sidByConv.has(convId) ? sidByConv.get(convId) : null, child: null };
    },
    // Open the lanes of these sessions, so their running children carry on.
    async open(ids) { for (const id of ids) if (!shared(id)) await lane(dbFor(id)).catch(() => {}); },
    // One normalized view, without staying subscribed (titles, token totals).
    async snapshot(id) {
      let v = null;
      (await watch(id, (x) => { v = x; }))();
      return v;
    },
    async close() {
      subagents?.close();
      for (const d of [...watchers.keys()]) d();
      await Promise.all([...lanes.keys()].map(closeLane));
    },
  };
}

function describeUnanswered(s) {
  const detail = typeof s.detail === 'string' ? s.detail : s.detail?.message ?? (s.detail ? JSON.stringify(s.detail) : '');
  return { aborted: 'Stopped.', run_failed: 'An earlier request failed.' }[s.reason] ?? `${s.reason}${detail ? `: ${detail}` : ''}`;
}

// ---- view normalization: pi-durable's ConversationView -> flat render list ----

const textOf = (content) => typeof content === 'string' ? content
  : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');

// One pi-ai AssistantMessage -> an assistant item (if it says anything) plus
// one tool item per call. Partial messages carry partial tool arguments.
function assistantItems(msg, streaming, tools) {
  const out = [];
  const text = msg.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
  const thinking = msg.content?.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('') ?? '';
  const error = msg.stopReason === 'error' ? (msg.errorMessage || 'Model error') : msg.stopReason === 'aborted' ? 'Stopped.' : undefined;
  if (text || thinking || error || streaming) out.push({ type: 'assistant', text, thinking, streaming, ...(error ? { error } : {}) });
  for (const b of msg.content ?? []) {
    if (b.type !== 'toolCall') continue;
    const item = { type: 'tool', id: b.id, name: b.name, args: b.arguments ?? b.partialArgs ?? {}, output: '', status: 'running' };
    tools.set(b.id, item);
    out.push(item);
  }
  return out;
}

// Messages (user and assistant items) carry, for the toolbar and revert:
// entry, the entry they came from; at, its time (ms); cut and cutAt, the
// last entry a revert to just after this message keeps: the message itself,
// or for a reply that called tools, the last of those calls' results.
export function normalize(view) {
  const items = [], tools = new Map(), owners = new Map(); // call id -> message item
  let steps = 0; // model responses: requests, for a subagent's card
  let ended = false; // the last reply had no tool calls: no turn is open
  const mark = (it, e, msg) => Object.assign(it, { entry: e.id, at: msg?.timestamp, cut: e.id, cutAt: msg?.timestamp });
  for (const e of view.entries) {
    const msg = e.model?.[0];
    if (e.kind === 'pi.assistant' && msg) ended = msg.stopReason !== 'toolUse';
    switch (e.kind) {
      case 'pi.user': items.push(mark({ type: 'user', text: textOf(msg?.content) }, e, msg)); break;
      // A steer placed after the turn ended (it raced the final reply) started
      // the next turn: an ordinary message, not one "while it worked".
      case STEER_KIND: items.push(mark({ type: 'user', ...(ended ? {} : { steer: true }), text: e.data?.text ?? textOf(msg?.content) }, e, msg)); break;
      // From another session of the scope (G4): labeled with its sender.
      case MESSAGE_KIND: items.push(mark({ type: 'user', from: { ref: e.data?.from, name: e.data?.name }, text: e.data?.text ?? textOf(msg?.content) }, e, msg)); break;
      // A file-watch event (G14): labeled with the watch that sent it.
      case WATCH_KIND: items.push(mark({ type: 'user', ...(ended || e.data?.mode !== 'steer' ? {} : { steer: true }), watch: e.data, text: (e.data?.lines ?? []).join('\n') || textOf(msg?.content) }, e, msg)); break;
      case USER_KIND: items.push(mark({ type: 'user', text: e.data?.text ?? textOf(msg?.content), attachments: e.data?.attachments ?? [] }, e, msg)); break;
      case 'pi.assistant': {
        if (!msg) break;
        steps++;
        const out = assistantItems(msg, false, tools);
        if (out[0]?.type === 'assistant') {
          mark(out[0], e, msg);
          out[0].model = msg.model; // the turn footer names it
          for (const t of out) if (t.type === 'tool') owners.set(t.id, out[0]);
        }
        items.push(...out);
        break;
      }
      case 'pi.tool-result': {
        const t = tools.get(msg?.toolCallId);
        if (t) Object.assign(t, { output: textOf(msg.content), status: msg.isError ? 'error' : 'done', ...((msg.details ?? e.data?.details) != null ? { details: msg.details ?? e.data.details } : {}) });
        const owner = owners.get(msg?.toolCallId);
        if (owner) Object.assign(owner, { cut: e.id, cutAt: msg.timestamp ?? owner.cutAt });
        break;
      }
      case 'pi.compaction': items.push({ type: 'compaction', summary: e.model?.map((m) => textOf(m.content)).join('\n') ?? '' }); break;
      case 'pi.reset': items.push({ type: 'notice', text: 'Context reset.' }); break;
      case REPORT_KIND: items.push(mark({ type: 'report', ...e.data }, e, msg ?? { timestamp: e.createdAt })); break;
    }
  }
  const live = view.docs['pi.live'] ?? {};
  // Running tool output (results land as entries; this is the stream before that).
  for (const slot of live.tools ?? []) {
    const t = tools.get(slot.callId);
    if (t && t.status === 'running' && slot.output) t.output = slot.output;
  }
  if (live.generation?.message) items.push(...assistantItems(live.generation.message, true, tools));
  if (live.generation?.retry) items.push({ type: 'notice', text: `Retrying: ${live.generation.retry.error}` });
  if (live.compactions?.length) items.push({ type: 'notice', text: 'Compacting context…' });
  if (live.compactionFailure) items.push({ type: 'notice', text: `Compaction failed: ${live.compactionFailure.error}` });
  // A run ended without a result for some calls (abort): don't leave them spinning.
  if (!live.run) for (const t of tools.values()) if (t.status === 'running') t.status = 'error';
  // A running call's details (a spawned subagent's id) before its result lands.
  for (const slot of live.tools ?? []) { const t = tools.get(slot.callId); if (t && slot.details != null && t.details == null) t.details = slot.details; }
  // requests: model responses (steps), for the Usage panel's Requests column.
  const usage = usageOf(view.docs['pi.usage']) ?? (steps ? { input: 0, output: 0, cost: 0 } : undefined);
  if (usage) usage.requests = steps;
  return { busy: !!live.run, items, steps, usage };
}

function usageOf(doc) {
  if (!doc) return undefined;
  const u = { input: 0, output: 0, cost: 0 };
  for (const m of Object.values(doc.models ?? {})) {
    u.input += m.input ?? 0; u.output += m.output ?? 0; u.cost += m.cost?.total ?? 0;
  }
  return u;
}
