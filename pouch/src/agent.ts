// The engine: pi-durable conversations, as Pouch extends them, over the
// BayLeaf Sealed, Transformers.js and Localhost providers. Profiles: src/profiles.ts.
//
// Security boundary (do not loosen): every BayLeaf Sealed request leaves this
// module through the Tinfoil SecureClient's fetch, which EHBP-encrypts the body in
// the page to the attested enclave before BayLeaf relays it. There is no plaintext
// path to BayLeaf: if no verified client is available, the request fails. The one
// plaintext path is Localhost (src/localhost.ts), to a loopback server the user
// configured, through its own origin-checked fetch; it never reaches BayLeaf.
//
// Layers, outside in:
//   UI  ->  openAgent() API  ->  pi-durable Harness (durable transcript, tools,
//   compaction)  ->  pi-ai openai-completions  ->  sealedFetch  ->  Tinfoil EHBP
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createRegistry, defineExtension, defineTool, section, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb';
import { Type } from 'typebox';
import type { Api, AssistantMessage, Context as PiContext, ImageContent, Model, ProviderStreams, StreamOptions, TextContent, ThinkingContent, TranscriptContext } from '@earendil-works/pi-ai';
import type { ConversationId, ConversationView, Cursor, EntryId, EntryRecord, HarnessOptions, InputSubmissionDraft, LiveState, ModelRef, SettledSubmissionRecord, Storage, Submission, SubmissionId, SubmissionRecord, ToolRegistration, UsageState } from '@earendil-works/pi-durable';
import type { AgentToolSpec, AssistantItem, Attachments, ContentLike, LocalhostConfig, LookOutput, NormalizedView, OpenAgentOptions, PouchEntry, SealedModelInfo, SessionId, StoredMessage, ThreadItem, UserItem, ThreadUsage, ThreadView, ToolItem } from './agent-types.ts';
import type { SubagentRow } from './subagents-types.ts';
type Subagents = ReturnType<typeof createSubagents>;
import { createSubagents, REPORT_KIND, STEER_KIND, MESSAGE_KIND } from './subagents.ts';
import { WATCH_KIND } from './ns/watch.ts';
import { asRef, relabel } from './graph.ts';
import { attachmentContext } from './attachments.ts';
import { contextOf } from './context.ts';
import { LOCAL_PROVIDER, isLocal, localApi, localModel } from './local/provider.ts';
import { LOCALHOST_PROVIDER, isLocalhost, localhostApi, localhostModel } from './localhost.ts';
import { BASE_URL, sealedFetch } from './sealed.ts';

export { Type, MemoryStorage, REPORT_KIND };

// Anti-corruption layer: pi-durable's words, read in Pouch's (LANGUAGE.md).
// pi-durable code, docs and errors keep their own terms; past this module
// (and src/subagents.ts, which also drives pi-durable) Pouch's apply.
//   pi-durable                              Pouch
//   conversation, its entries               Thread storage: one agent's record (a revert forks
//                                           it; the session's pointer names the current fork)
//   "session" (pi docs, SDK errors)         not a Pouch Session: one agent's persisted log
//   one Harness over one database           one Session's storage: main's thread and its subagents'
//   ownerless conversation                  a subagent's thread (src/subagents.ts)
//   submit(..., { whenBusy: 'steer' })      Steer: read after the current step
//   input admitted while busy ("followUp")  Follow-up; Pouch holds its own in the page (src/interface/queues.ts)
//                                           and submits when the turn ends
//   extension, modelTools, instructions     parts of a Profile (src/profiles.ts)
const PROVIDER = 'bayleaf-sealed';
const DB_NAME = 'bayleaf-pouch-agent';
const USER_KIND = 'pouch.user'; // a user message whose model view carries Pouch's notes
const TOOL_OUTPUT_CAP = 50_000; // chars sent to the model per tool result
const ctx = BACKGROUND_CONTEXT; // waits here are ours to cancel through abort(), not contexts

// Compaction budget per context window. A 1M window is not a reason to send
// 1M tokens every turn (cost, latency, and long-context quality all suffer),
// so we compact as if the window were at most 256k.
const EFFECTIVE_WINDOW = 262_144;
export function compactionFor(contextWindow: number = 131_072) {
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
function toModel(m: SealedModelInfo): Model<'openai-completions'> {
  const ctxWindow = m.contextWindow ?? 131_072;
  return {
    id: m.id, name: m.name ?? m.id, api: 'openai-completions', provider: PROVIDER, baseUrl: BASE_URL,
    reasoning: !!m.reasoning, input: m.multimodal === true ? ['text', 'image'] : ['text'],
    cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: 0 },
    contextWindow: ctxWindow, maxTokens: Math.min(32_768, Math.floor(ctxWindow / 4)),
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
}

// Provider-level seam: every request the Harness makes (generation,
// compaction summaries, hooks) goes through the same fetch.
const withFetch = (api: ProviderStreams, fetch: StreamOptions['fetch']): ProviderStreams => ({
  stream: (m, c, o) => api.stream(m, c, { ...o, fetch }),
  streamSimple: (m, c, o) => api.streamSimple(m, c, { ...o, fetch }),
});

const cap = (text: string) => text.length <= TOOL_OUTPUT_CAP ? text
  : `${text.slice(0, TOOL_OUTPUT_CAP)}\n\n[output truncated: ${text.length - TOOL_OUTPUT_CAP} more characters not shown]`;

// UI tool spec -> pi-durable tool. Streaming output goes to api.output (shown
// live in pi.live); the returned string is what the model reads. `caller` is
// the calling conversation, so hooks can tell a subagent from the main agent.
// Running calls by id, so the composer tray can stop one call (a long `run`)
// without aborting the whole turn: the tool fails with "Stopped." and the
// model reads that and carries on.
const callStops = new Map<string, AbortController>(); // call id -> AbortController
// seesImages(ref): whether the calling conversation's model takes images
// (undefined when unknown), asked only for a tool marked `images` (look),
// which may return { text, images }.
function toTool(t: AgentToolSpec, seesImages: (ref: ModelRef | undefined) => boolean | undefined = () => undefined) {
  // label: not in pi-durable's tool type, passed through as before (hence the cast).
  return defineTool({
    name: t.name, label: t.label ?? t.name, description: t.description, parameters: t.parameters,
    execute: async (args, api, context) => {
      const stop = new AbortController();
      const signal = AbortSignal.any([context.abortSignal, stop.signal].filter(Boolean) as AbortSignal[]);
      callStops.set(api.callId, stop);
      try {
        // A string, or look's { text, images }.
        const r = await t.execute(args as Record<string, unknown>, { signal, output: (s) => api.output(String(s)), caller: api.conversationId, callId: api.callId, seesImages: t.images ? seesImages((await api.agent?.(context))?.model) : undefined }) as Partial<LookOutput>;
        if (Array.isArray(r?.images)) return { output: [{ type: 'text', text: cap(String(r.text ?? '')) }, ...r.images] };
        return { output: [{ type: 'text', text: cap(String(r ?? '')) }] };
      } finally { callStops.delete(api.callId); }
    },
  } as ToolRegistration);
}

// Hold one IndexedDB storage. pi-durable has no cross-process locking, so two
// tabs on one database would corrupt it: each database has its own Web Lock,
// held for as long as this page has it open.
async function acquireLock(name: string): Promise<() => void> {
  if (typeof navigator === 'undefined' || !navigator.locks) return () => {};
  return new Promise<() => void>((resolve, reject) => {
    navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) return reject(new Error('This session is open in Pouch in another tab. Close it there to use it here.'));
      return new Promise<void>((release) => resolve(release));
    }).catch(reject);
  });
}

// Storage layout (L2): pi-durable has no way to delete a conversation, so
// each session gets its own database, and deleting the session deletes the
// database. Sessions made before this ('legacy': numeric ids) stay in the
// one shared database; it can only be dropped whole, which dropLegacy() does
// once no legacy session is left in the index (and Erase all does anyway).
export const isLegacy = (id: SessionId) => !String(id).startsWith('p-');
const dbFor = (id: SessionId) => `${DB_NAME}-${id}`;
const newId = () => `p-${crypto.randomUUID()}`;
const dbExists = async (name: string) => !indexedDB.databases || (await indexedDB.databases()).some((d) => d.name === name);

// Model ids starting "local:" are the Transformers.js provider (src/local/provider.ts,
// profile transformersjs): generated in this browser, never sent. "localhost:" ids are
// the Localhost provider (src/localhost.ts, profile localhost). Every other id is BayLeaf Sealed.
const modelRef = (modelId: string): ModelRef => ({ provider: isLocal(modelId) ? LOCAL_PROVIDER : isLocalhost(modelId) ? LOCALHOST_PROVIDER : PROVIDER, modelId });
export const needsSealed = (modelId: string | undefined) => !isLocal(modelId) && !isLocalhost(modelId);

// pointer keeps which conversation in a session's database is current; a
// revert (D12) forks and moves it. local adds the Transformers.js provider,
// localhost the Localhost provider; setLocalhost(config or null) replaces it
// (Settings, key removal). Options: OpenAgentOptions (src/agent-types.ts).
export type PouchAgent = Awaited<ReturnType<typeof openAgent>>;
export async function openAgent({ storage, tools = [], systemPrompt, getClient, models: initialModels = [], pointer, subagents: saDeps, onInterrupted, local, localhost, onRequest }: OpenAgentOptions) {
  const models = createModels();
  let catalog: Model<'openai-completions'>[] = [];
  const api = withFetch(openAICompletionsApi(), sealedFetch(getClient, onRequest));
  const quietSealed = withFetch(openAICompletionsApi(), sealedFetch(getClient)); // complete(): same encryption, counted by its caller
  function setModels(list: SealedModelInfo[]) {
    catalog = list.map(toModel);
    models.setProvider(createProvider({
      id: PROVIDER, name: 'BayLeaf Sealed', baseUrl: BASE_URL, models: catalog, api,
      auth: { apiKey: { name: 'BayLeaf Sealed', resolve: async () => ({ auth: { apiKey: 'sealed' } }) } },
    }));
  }
  setModels(initialModels);
  let lhConfig: LocalhostConfig | null = null, lhCatalog: Model<Api>[] = [];
  const lhApi = localhostApi({ completions: openAICompletionsApi(), responses: openAIResponsesApi() }, () => lhConfig, { onWait: localhost?.onWait });
  function setLocalhost(config: Partial<LocalhostConfig> | null | undefined) {
    lhConfig = config?.base ? config as LocalhostConfig : null;
    lhCatalog = lhConfig ? (lhConfig.models ?? []).map((m) => localhostModel(m, lhConfig!)) : [];
    models.setProvider(createProvider({
      id: LOCALHOST_PROVIDER, name: 'Localhost (your machine)', baseUrl: lhConfig?.base ?? 'http://127.0.0.1/v1', models: lhCatalog, api: lhApi,
      auth: { apiKey: { name: 'Localhost', resolve: async () => ({ auth: { apiKey: lhConfig?.key || 'none' } }) } },
    }));
  }
  setLocalhost(localhost?.config);
  if (local?.info) {
    models.setProvider(createProvider({
      id: LOCAL_PROVIDER, name: 'Transformers.js (in this browser)', baseUrl: 'local:', models: [localModel(local.info) as Model<Api>], api: localApi(local.engine, { onHint: local.onHint }),
      auth: { apiKey: { name: 'Transformers.js', resolve: async () => ({ auth: { apiKey: 'local' } }) } },
    }));
  }

  // Which session a conversation belongs to (its own, a revert's fork, or a
  // subagent's), filled as databases open and conversations are made.
  const sidByConv = new Map<ConversationId, SessionId>();
  const sidOf = (convId: ConversationId): SessionId => sidByConv.get(convId) ?? convId; // shared databases: the id is the session
  const subagents = saDeps?.reg ? createSubagents({
    ...saDeps, ctx, sidOf, modelRef,
    dbOf: (sid) => dbOf(sid), openDb: (name) => openDb(name), conv: (sid) => conv(sid),
  }) : null;

  // The same flag the composer's image guard reads (model.input from `multimodal`);
  // Transformers.js and Localhost models are text only.
  const seesImages = (ref: ModelRef | undefined) => !ref ? undefined
    : [...catalog, ...lhCatalog].find((m) => m.provider === ref.provider && m.id === ref.modelId)?.input.includes('image') ?? false;
  const registry = createRegistry();
  registry.install(defineExtension({
    name: 'pouch',
    tools: [...tools.map((t) => toTool(t, seesImages)), ...(subagents ? [subagents.tool, subagents.peerTool] : [])],
    sections: systemPrompt ? [section('pouch', () => systemPrompt(), { tag: false })] : [],
  }));

  const options: HarnessOptions = {
    models, registry,
    identity: { attribution: null }, // no app-attribution headers to anyone
    settings: {
      retry: { maxRetries: 2 },
      afterFailedRun: 'withdraw', // a failed run should not leave later inputs stranded
      // Every queued steer joins the next step (default: one per step), so
      // messages from several agents of a graph arrive together, in order.
      steeringMode: 'all',
      compaction: {
        enabled: true,
        ...compactionFor(),
        // Getter: recomputed from whatever catalog setModels() installed last.
        get modelOverrides() {
          return Object.fromEntries([...catalog.map((m) => [`${PROVIDER}/${m.id}`, compactionFor(m.contextWindow)]),
            ...lhCatalog.map((m) => [`${LOCALHOST_PROVIDER}/${m.id}`, compactionFor(m.contextWindow)])]);
        },
      },
    },
  };

  // One open Harness per database (name -> Promise<{ harness, ... }>),
  // opened on first use and kept until delete or close. An injected storage
  // (tests) is one shared database for every session, like the legacy one.
  interface OpenDb { harness: Harness; release: () => void; storage: Storage; sid: string | null; interrupted: ConversationId[] }
  const dbs = new Map<string, Promise<OpenDb>>();
  function openDb(name: string): Promise<OpenDb> {
    if (!dbs.has(name)) {
      const p = (async () => {
        const release = storage ? () => {} : await acquireLock(name);
        try {
          const st = storage ?? await IndexedDbStorage.open(name);
          const harness = await Harness.open(st, options, ctx);
          const sid = name.startsWith(DB_NAME + '-') ? name.slice(DB_NAME.length + 1) : null;
          if (sid) {
            let cursor: Cursor | undefined;
            do {
              const page = await st.scanConversations({}, 100, cursor, ctx);
              for (const c of page.items) sidByConv.set(c.id, sid);
              cursor = page.next;
            } while (cursor);
          }
          // A reload must never spend BayLeaf Sealed requests by itself, so pending
          // work is not resumed (no harness.resume()): every conversation with
          // a live run or queued input is aborted, which runs abort handlers
          // only, and reported to onInterrupted; the user resumes with a click.
          const interrupted = await quiesce(harness);
          return { harness, release, storage: st, sid, interrupted };
        } catch (e) { release(); throw e; }
      })();
      dbs.set(name, p);
      p.catch(() => dbs.delete(name)); // let a later attempt retry (the other tab may close)
      // Children the last page left running are marked interrupted (or, if
      // they settled unreported, reported quietly); then parents are told.
      p.then(async (l) => {
        if (l.sid) await subagents?.resume(l.sid, l.interrupted);
        const parents = l.interrupted.filter((c) => !subagents?.owner(c));
        if (parents.length) onInterrupted?.(parents.map((c) => sidOf(c)));
      }, () => {});
    }
    return dbs.get(name)!;
  }
  async function quiesce(harness: Harness) {
    const ins = await harness.inspect(ctx);
    const ids = new Set([...ins.tasks.map((t) => t.record.conversationId), ...ins.submissions.map((x) => x.conversationId)].filter((x): x is ConversationId => x != null));
    for (const id of ids) await (await harness.conversation(id, ctx))?.abort(ctx).catch(() => {});
    return [...ids];
  }
  async function closeDb(name: string) {
    const p = dbs.get(name);
    if (!p) return;
    dbs.delete(name);
    const l = await p.catch(() => null);
    if (l) try { await l.harness.close(ctx); } finally { l.release(); }
  }
  const shared = (id: SessionId) => storage || isLegacy(id);
  const dbOf = (id: SessionId) => shared(id) ? (storage ? 'memory' : DB_NAME) : dbFor(id);

  // Pouch id -> pi-durable conversation id. Shared databases use the conversation
  // id itself. A session database holds its first conversation and the forks
  // that reverts made of it; the pointer says which one is current, and a
  // session never reverted has only the first.
  const convIds = new Map<SessionId, ConversationId>();
  async function locate(id: SessionId) {
    const { harness, storage: st } = await openDb(dbOf(id));
    if (shared(id)) return { harness, convId: id as ConversationId };
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
    return { harness, convId: convIds.get(id)! };
  }
  const conv = async (id: SessionId) => {
    const { harness, convId } = await locate(id);
    const c = await harness.conversation(convId, ctx);
    if (!c) throw new Error(`No such session: ${id}`);
    return c;
  };
  const watchers = new Map<() => void, string>(); // dispose -> session id

  async function watch(id: SessionId, onView: (view: ThreadView) => void, child?: ConversationId) {
    const c = child ? await subagents!.childConv(id, child) : await conv(id);
    // The view holds only the active context, which compaction and reset
    // cut short. Keep the whole transcript for display: scan what is stored,
    // then append each entry the view adds (entries are immutable).
    const history: EntryRecord[] = [], ids = new Set<EntryId>();
    const add = (e: EntryRecord) => { if (!ids.has(e.id)) { ids.add(e.id); history.push(e); } };
    let cursor: Cursor | undefined;
    do {
      const page = await c.entries(cursor ? {} : { order: 'ascending' }, 500, cursor, ctx);
      page.items.forEach(add);
      cursor = page.next;
    } while (cursor);
    const view = await c.viewState(ctx);
    // context: sized from the active entries only (src/context.ts), not the whole history.
    const push = (value: ConversationView) => { value.entries.forEach(add); onView({ ...normalize({ ...value, entries: history }), context: contextOf(value.entries as readonly PouchEntry[]) }); };
    push(view.value);
    const unsubscribe = view.subscribe(push);
    const dispose = () => { watchers.delete(dispose); unsubscribe?.(); view.dispose(); };
    watchers.set(dispose, String(id));
    return dispose;
  }
  function own(sid: SessionId, convId: ConversationId) { sidByConv.set(convId, String(sid)); }
  // Poll a steer's submission until it leaves the inbox; see steer().
  async function placement(id: SessionId, sub: Submission, child?: ConversationId) {
    let rec: SubmissionRecord | null;
    for (;;) {
      rec = await sub.status(ctx).catch(() => null);
      if (!rec || rec.status !== 'queued') break;
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!rec?.entry) return null;
    let v = null as ThreadView | null;
    (await watch(id, (x) => { v = x; }, child))();
    return { late: !v?.items.find((i): i is UserItem => (i as UserItem).entry === rec!.entry)?.steer }; // the steer's own item
  }

  async function point(id: SessionId, convId: ConversationId) {
    for (const [d, sid] of watchers) if (sid === String(id)) d();
    convIds.set(id, convId);
    own(id, convId);
    await pointer?.set(id, convId);
  }

  return {
    setModels, setLocalhost,
    isLegacy: (id: SessionId) => !storage && isLegacy(id),
    async createSession(modelId: string): Promise<SessionId> {
      const id = (storage ? null : newId()) as string; // null only with an injected storage, which returns before using it
      const { harness } = await openDb(storage ? 'memory' : dbFor(id));
      const c = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: modelRef(modelId) } }, ctx);
      if (storage) return c.id;
      convIds.set(id, c.id);
      own(id, c.id);
      return id;
    },
    // Stop the work, then erase the session's database. A shared-database
    // (legacy) session can only be stopped and reset: its entries stay until
    // dropLegacy() or Erase all. Resolves to { erased }.
    async deleteSession(id: SessionId) {
      for (const [d, sid] of watchers) if (sid === String(id)) d();
      if (shared(id)) {
        const c = await conv(id).catch(() => null);
        if (c) { await c.abort(ctx); await c.reset(undefined, ctx); }
        return { erased: false };
      }
      const name = dbFor(id);
      if (!dbs.has(name) && !(await dbExists(name))) return { erased: true };
      const c = await conv(id).catch((e) => { if (/another tab/.test(e.message)) throw e; return null; });
      if (c) await c.abort(ctx).catch(() => {});
      await subagents?.stopAll(id).catch(() => {});
      await closeDb(name);
      convIds.delete(id);
      await IndexedDbStorage.delete(name);
      return { erased: true };
    },
    // Drop the shared legacy database once the index holds none of its
    // sessions (what is left in it are transcripts of deleted ones).
    async dropLegacy() {
      if (storage || !(dbs.has(DB_NAME) || await dbExists(DB_NAME))) return false;
      for (const [d, sid] of watchers) if (isLegacy(sid)) d();
      await closeDb(DB_NAME);
      let release: () => void;
      try { release = await acquireLock(DB_NAME); } catch { return false; } // in use in another tab
      try { await IndexedDbStorage.delete(DB_NAME); } finally { release(); }
      return true;
    },
    // Revert to here (D12): fork the current conversation just after entry
    // `at` and make the fork current. The model then sees nothing past `at`.
    // The old conversation stays in the session's database (deleted with it),
    // so point(id, from) undoes the revert. Resolves to { from, to }.
    async revert(id: SessionId, at: EntryId) {
      if (shared(id)) throw new Error('This session was saved before per-session storage and cannot be reverted.');
      const c = await conv(id);
      const fork = await c.fork(at, { ownership: { kind: 'ownerless' } }, ctx);
      const from = c.id;
      await point(id, fork.id);
      return { from, to: fork.id };
    },
    point,
    async setModel(id: SessionId, modelId: string) {
      await (await conv(id)).configure({ model: modelRef(modelId) }, ctx);
    },
    // notes: what the user did since the last turn (e.g. files they edited). The model
    // reads them before the message; the transcript entry keeps only `text`.
    async send(id: SessionId, text: string, notes: string[] = [], attachments: Attachments = { files: [], images: [] }, modelId?: string) {
      // Fail before admitting the input, so it is not queued behind a dead database.
      // A Transformers.js or Localhost turn needs no BayLeaf Sealed connection (and makes no request to it).
      const c = await conv(id);
      const target = modelId ?? (await c.agent(ctx))?.model?.modelId;
      if (isLocalhost(target) && !lhCatalog.some((m) => m.id === target)) throw new Error('That Localhost model is not set up in this browser any more: test the connection in Settings > Providers > Localhost, or pick another model. No request was sent.');
      if (needsSealed(target) && !(await getClient())) throw new Error('Not connected to BayLeaf Sealed: sign in (or use campus access) and wait for verification.');
      const state = await c.viewState(ctx), running = !!state.value.docs['pi.live']?.run;
      state.dispose();
      if (running) throw new Error('This conversation is still running. Wait or stop it before sending.');
      // Only a user submission may change the configured model, never a picker change.
      if (modelId) await c.configure({ model: modelRef(modelId) }, ctx);
      const current = modelId ?? (await c.agent(ctx))?.model?.modelId;
      if (attachments.images.length && !catalog.find((m) => m.id === current)?.input.includes('image')) throw new Error('Choose an image-capable model before sending. No request was sent.');
      const content = (notes.length ? `[Note from Pouch, not typed by the user: since your last turn, ${notes.join('; ')}.]\n\n` : '') + text + attachmentContext(attachments.files);
      const input: InputSubmissionDraft = { type: 'input', whenBusy: 'reject', content: attachments.images.length ? [{ type: 'text', text: content }, ...attachments.images] : content,
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
    async steer(id: SessionId, text: string) {
      const c = await conv(id);
      const sub = await c.submit({ type: 'input', content: text, whenBusy: 'steer', entry: { kind: STEER_KIND, data: { text } } }, ctx);
      return { id: sub.id, placed: placement(id, sub) };
    },
    // Take back a steer that has not been placed: 'aborted' (it was still
    // queued), 'already_placed' or 'settled'.
    async withdraw(id: SessionId, subId: SubmissionId) {
      const { harness } = await locate(id);
      const sub = await harness.submission(subId, ctx);
      return sub ? sub.abort(ctx) : 'settled';
    },
    // Wait for a placed steer that started its own turn (its run's end).
    async waitFor(id: SessionId, subId: SubmissionId) {
      const { harness } = await locate(id);
      await (await harness.submission(subId, ctx))?.wait(ctx);
    },
    async abort(id: SessionId) {
      await (await conv(id)).abort(ctx);
    },
    // Stop one running tool call; false if it already finished.
    stopCall(callId: string) {
      const c = callStops.get(callId);
      c?.abort();
      return !!c;
    },
    // One tool-less completion on modelId's own provider (session titles,
    // naming.ts): BayLeaf Sealed through the encrypting fetch, Localhost through
    // its guarded fetch, Transformers.js in the page's worker. Never another
    // provider: an unknown or unconfigured model fails, nothing is sent elsewhere.
    // A Sealed call is not reported to onRequest; the caller counts it (as a title).
    async complete(modelId: string, prompt: string, { maxTokens = 400, signal }: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<string> {
      const ref = modelRef(modelId);
      const model = models.getModel(ref.provider, modelId);
      if (!model) throw new Error(`${modelId} is not available in this browser now; nothing was sent.`);
      const context: PiContext = { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] };
      // A raw Context straight to the provider streams (pi-ai types want a normalized TranscriptContext).
      const r = ref.provider === PROVIDER
        ? await quietSealed.streamSimple(model, context as unknown as TranscriptContext, { maxTokens, signal, apiKey: 'sealed' }).result()
        : await models.completeSimple(model, context, { maxTokens, signal });
      if (r.stopReason === 'error' || r.stopReason === 'aborted') throw new Error(r.errorMessage || 'The model returned an error.');
      return r.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('');
    },
    async compact(id: SessionId) {
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
    // Subagents of a session (src/subagents.ts): registry rows, and actions
    // for the card's buttons. watchChild(sid, child, onView) is watch() of one.
    subagents: subagents && {
      list: (sid: SessionId) => subagents.list(sid),
      stop: (sid: SessionId, child: string) => subagents.stop(sid, child),
      // Stop every running subagent of a session (Stop all): aborts their requests in flight.
      stopAll: (sid: SessionId) => subagents.stopAll(sid),
      message: (sid: SessionId, child: string, text: string) => subagents.message(sid, child, text, { user: true }),
      // From the subagent's view: joins its running work, never restarts it.
      steer: (sid: SessionId, child: string, text: string) => subagents.steer(sid, child, text),
      watch: (sid: SessionId, child: ConversationId, onView: (view: ThreadView) => void) => watch(sid, onView, child),
      resume: (sid: SessionId) => subagents.resume(sid),
      // Main's blocking calls (a foreground spawn, a wait): [{ kind, ids, since }].
      blocked: (sid: SessionId) => subagents.blocked(sid),
      // G10/G12: return them at once; text (the user's message) joins main's
      // next step as a steer. Resolves to false (nothing blocked), true, or
      // with text, { id, placed } as steer() does.
      detach: async (sid: SessionId, text?: string | null) => {
        const sub = await subagents.detach(sid, text == null ? {} : { text, input: { type: 'input', content: text, entry: { kind: STEER_KIND, data: { text } } } });
        return sub && typeof sub === 'object' ? { id: sub.id, placed: placement(sid, sub) } : sub;
      },
      // Steering a subagent; resolves to { note, id, placed }.
      // child: the subagent's conversation id (its registry id).
      steerTracked: async (sid: SessionId, child: ConversationId, text: string) => {
        const out: { sub?: Submission } = {};
        const note = await subagents.steer(sid, child, text, out);
        return { note, id: out.sub!.id, placed: placement(sid, out.sub!, child) };
      },
      refOf: (l: SubagentRow[], c: SubagentRow) => subagents.refOf(l, c),
      // File watches (src/ns/watch.ts): deliver an event; is that session running?
      notify: (sid: SessionId, ref: string, ev: Parameters<Subagents['notify']>[2]) => subagents.notify(sid, ref, ev),
      busyOf: (sid: SessionId, ref: string) => subagents.busyOf(sid, ref),
      // Its last answer and request count (/session/<sid>/agents/a<n>/last).
      summary: (sid: SessionId, child: ConversationId) => subagents.summary(sid, child),
    },
    // Who made a tool call: { sid, child, ns } (child: the subagent id, or null;
    // ns: the mounts its spawn declared, if any).
    who(convId: ConversationId) {
      const o = subagents?.owner(convId);
      return o ? { sid: o.sid, child: o.id, ns: o.ns } : { sid: sidByConv.has(convId) ? sidByConv.get(convId) : null, child: null };
    },
    // Open the databases of these sessions, so their running children carry on.
    async open(ids: SessionId[]) { for (const id of ids) if (!shared(id)) await openDb(dbFor(id)).catch(() => {}); },
    // One normalized view, without staying subscribed (titles, token totals).
    async snapshot(id: SessionId) {
      let v = null as ThreadView | null;
      (await watch(id, (x) => { v = x; }))();
      return v;
    },
    async close() {
      subagents?.close();
      for (const d of [...watchers.keys()]) d();
      await Promise.all([...dbs.keys()].map(closeDb));
    },
  };
}

function describeUnanswered(s: Extract<SettledSubmissionRecord, { status: 'unanswered' }>) {
  const detail = typeof s.detail === 'string' ? s.detail : (s.detail as { message?: string } | undefined)?.message ?? (s.detail ? JSON.stringify(s.detail) : '');
  return ({ aborted: 'Stopped.', run_failed: 'An earlier request failed.' } as Record<string, string | undefined>)[s.reason] ?? `${s.reason}${detail ? `: ${detail}` : ''}`;
}

// ---- view normalization: pi-durable's ConversationView -> flat render list ----

const textOf = (content: ContentLike | undefined) => typeof content === 'string' ? content
  : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');

// One pi-ai AssistantMessage -> an assistant item (if it says anything) plus
// one tool item per call. Partial messages carry partial tool arguments.
type AssistantBlocks = AssistantMessage['content'] | undefined; // an assistant message's blocks
function assistantItems(msg: StoredMessage, streaming: boolean, tools: Map<string, ToolItem>) {
  const out: ThreadItem[] = [];
  const text = (msg.content as AssistantBlocks)?.filter((b) => b.type === 'text').map((b) => (b as TextContent).text).join('') ?? '';
  const thinking = (msg.content as AssistantBlocks)?.filter((b) => b.type === 'thinking').map((b) => (b as ThinkingContent).thinking).join('') ?? '';
  const error = msg.stopReason === 'error' ? (msg.errorMessage || 'Model error') : msg.stopReason === 'aborted' ? 'Stopped.' : undefined;
  if (text || thinking || error || streaming) out.push({ type: 'assistant', text, thinking, streaming, ...(error ? { error } : {}) });
  for (const b of (msg.content as AssistantBlocks) ?? []) {
    if (b.type !== 'toolCall') continue;
    const item: ToolItem = { type: 'tool', id: b.id, name: b.name, args: b.arguments ?? (b as { partialArgs?: unknown }).partialArgs ?? {}, output: '', status: 'running' };
    tools.set(b.id, item);
    out.push(item);
  }
  return out;
}

// Messages (user and assistant items) carry, for the toolbar and revert:
// entry, the entry they came from; at, its time (ms); cut and cutAt, the
// last entry a revert to just after this message keeps: the message itself,
// or for a reply that called tools, the last of those calls' results.
export function normalize(view: Pick<ConversationView, 'entries' | 'docs'>): NormalizedView {
  const items: ThreadItem[] = [], tools = new Map<string, ToolItem>(), owners = new Map<string, AssistantItem>(); // call id -> message item
  let steps = 0; // model responses: requests, for a subagent's card
  let toolErrors = 0; // failed tool calls, also for the card
  let ended = false; // the last reply had no tool calls: no turn is open
  const mark = <T extends ThreadItem>(it: T, e: PouchEntry, msg: { timestamp?: number } | undefined) => Object.assign(it, { entry: e.id, at: msg?.timestamp, cut: e.id, cutAt: msg?.timestamp });
  for (const e of view.entries as readonly PouchEntry[]) {
    const msg = e.model?.[0];
    if (e.kind === 'pi.assistant' && msg) ended = msg.stopReason !== 'toolUse';
    switch (e.kind) {
      case 'pi.user': items.push(mark({ type: 'user', text: textOf(msg?.content) }, e, msg)); break;
      // A steer placed after the turn ended (it raced the final reply) started
      // the next turn: an ordinary message, not one "while it worked".
      case STEER_KIND: items.push(mark({ type: 'user', ...(ended ? {} : { steer: true }), text: e.data?.text ?? textOf(msg?.content) }, e, msg)); break;
      // From another session of the scope (G4): labeled with its sender.
      case MESSAGE_KIND: items.push(mark({ type: 'user', from: { ref: asRef(e.data?.from), name: e.data?.name }, text: e.data?.text ?? textOf(msg?.content) }, e, msg)); break;
      // A file-watch event (G14): labeled with the watch that sent it.
      case WATCH_KIND: items.push(mark({ type: 'user', ...(ended || e.data?.mode !== 'steer' ? {} : { steer: true }), watch: e.data, text: (e.data?.lines ?? []).join('\n') || textOf(msg?.content) }, e, msg)); break;
      case USER_KIND: items.push(mark({ type: 'user', text: e.data?.text ?? textOf(msg?.content), attachments: e.data?.attachments ?? [] }, e, msg)); break;
      case 'pi.assistant': {
        if (!msg) break;
        steps++;
        const out = assistantItems(msg, false, tools);
        if (out[0]?.type === 'assistant') {
          mark(out[0], e, msg);
          (out[0] as AssistantItem).model = msg.model; // the turn footer names it
          for (const t of out) if (t.type === 'tool') owners.set(t.id, out[0] as AssistantItem);
        }
        items.push(...out);
        break;
      }
      case 'pi.tool-result': {
        const t = tools.get(msg?.toolCallId!);
        if (msg?.isError) toolErrors++;
        // images: what a look call sent, for the card's thumbnails (the bytes as sent, not the file now).
        const images = ((msg?.content ?? []) as ImageContent[]).filter((b) => b.type === 'image');
        if (t) Object.assign(t, { output: textOf(msg!.content), status: msg!.isError ? 'error' : 'done', ...(images.length ? { images } : {}), ...((msg!.details ?? e.data?.details) != null ? { details: msg!.details ?? e.data!.details } : {}) });
        const owner = owners.get(msg?.toolCallId!);
        if (owner) Object.assign(owner, { cut: e.id, cutAt: msg!.timestamp ?? owner.cutAt });
        break;
      }
      case 'pi.compaction': items.push({ type: 'compaction', summary: e.model?.map((m) => textOf(m.content)).join('\n') ?? '' }); break;
      case 'pi.reset': items.push({ type: 'notice', text: 'Context reset.' }); break;
      case REPORT_KIND: items.push(mark({ type: 'report', ...e.data, ...(e.data?.ref ? { ref: asRef(e.data.ref) } : {}), ...(e.data?.byMessage ? { byMessage: relabel(e.data.byMessage) } : {}), ...(e.data?.lastSent ? { lastSent: { ...e.data.lastSent, to: relabel(e.data.lastSent.to) } } : {}) } as ThreadItem, e, msg ?? { timestamp: e.createdAt })); break;
    }
  }
  const live = (view.docs['pi.live'] ?? {}) as LiveState;
  // Running tool output (results land as entries; this is the stream before that).
  for (const slot of live.tools ?? []) {
    const t = tools.get(slot.callId);
    if (t && t.status === 'running' && slot.output) t.output = slot.output;
  }
  if (live.generation?.message) items.push(...assistantItems(live.generation.message as StoredMessage, true, tools));
  if (live.generation?.retry) items.push({ type: 'notice', text: `Retrying: ${live.generation.retry.error}` });
  if (live.compactions?.length) items.push({ type: 'notice', text: 'Compacting context…' });
  if (live.compactionFailure) items.push({ type: 'notice', text: `Compaction failed: ${live.compactionFailure.error}` });
  // A run ended without a result for some calls (abort): don't leave them spinning.
  if (!live.run) for (const t of tools.values()) if (t.status === 'running') t.status = 'error';
  // A running call's details (a spawned subagent's id) before its result lands.
  for (const slot of live.tools ?? []) { const t = tools.get(slot.callId); if (t && slot.details != null && t.details == null) t.details = slot.details; }
  // requests: model responses (steps), for the Usage panel's Requests column.
  const usage: ThreadUsage | undefined = usageOf(view.docs['pi.usage'] as UsageState | undefined) ?? (steps ? { input: 0, output: 0, cost: 0 } : undefined);
  if (usage) usage.requests = steps;
  return { busy: !!live.run, items, steps, toolErrors, usage };
}

function usageOf(doc: UsageState | undefined): ThreadUsage | undefined {
  if (!doc) return undefined;
  const u = { input: 0, output: 0, cost: 0 };
  for (const m of Object.values(doc.models ?? {})) {
    u.input += m.input ?? 0; u.output += m.output ?? 0; u.cost += m.cost?.total ?? 0;
  }
  return u;
}
