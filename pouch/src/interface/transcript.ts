// Transcript: attaching a session, rendering its log, the message toolbar and revert.

import * as store from '../store.ts';
import { normalize } from '../vfs.ts';
import { highlight } from '../editor.ts';
import { renderMarkdown } from '../markdown.ts';
import { CWD } from '../tools.ts';
import { shownLines } from '../open-cli.ts';
import { $, el, icon, seeded } from '../dom.ts';
import { asRef } from '../graph.ts';
import { interruptedKey, revertKey, sameId, turnsKey } from '../sessions.ts';
import { egressOf } from '../egress.ts';
import { LOCAL } from '../local/host.ts';
import { isLocalhost } from '../localhost.ts';
import type { ConversationId, EntryId } from '@earendil-works/pi-durable';
import type { AssistantItem, MessageMarks, NormalizedView, ReportItem, SessionId, ThreadItem, ThreadView, ToolItem, UserItem } from '../agent-types.ts';
import type { MarkdownContext, PathKind } from '../markdown.ts';
import type { App } from './app.ts';

// A tool call's arguments, as cards and summaries read them (the tools' own schemas are wider).
export interface ToolArgs {
  command?: string; code?: string; path?: string; paths?: string[]; content?: string; note?: string;
  edits?: { oldText?: string; newText?: string }[]; oldText?: string; newText?: string;
  action?: string; id?: unknown; ids?: unknown; to?: unknown; text?: string; name?: string; task?: string; mode?: string;
  background?: boolean; once?: boolean; by?: string;
}
// Rendered replies by text, reused while their link answers hold (linkVer).
export type ReplyCache = Map<string, { node: HTMLElement; ver: number }>;
// A message with a toolbar: the user's, a reply, or a subagent's report; draft: text going back into the box.
export type MessageItem = (UserItem | AssistantItem | ReportItem) & { streaming?: boolean; error?: string; model?: string; draft?: string; draftAt?: number };
// Any thread item, read for its marks without narrowing first.
type Marked = MessageMarks & { type: string; text?: string; error?: string; streaming?: boolean };
type QuietItem = ReportItem | ToolItem;
// The last revert, while it can be undone (store, revertKey); branch: display-only outline.
interface RevertToken { session: string; from: ConversationId; to: ConversationId; at?: number; cut?: EntryId; branch?: { who: string; text: string }[] }
// Tool arguments arrive untyped from the model.
const toolArgs = (v: unknown) => (v && typeof v === 'object' ? v as ToolArgs : undefined);
// One id or a list of them, as concat would spread it.
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
// A spawn's tool result names its child conversation once it exists.
const spawnedChild = (details: unknown) => (details && typeof details === 'object' && 'child' in details ? details.child as ConversationId | undefined : undefined);
const isMessage = (i: ThreadItem): i is UserItem | AssistantItem | ReportItem => i.type === 'user' || i.type === 'assistant' || i.type === 'report';

export interface TranscriptRegion {
  argSummary(name: string, args: unknown): string;
  // Open the current session's thread in the log (newest call wins).
  attach(): Promise<void>;
  // A send in sid ends the current session's reload interruption (send clears the stored flag).
  clearInterrupted(sid: SessionId): void;
  // Files changed: path links are rechecked lazily and cached replies re-render.
  filesChanged(): void;
  // A reload cut these sessions' runs off; the current one offers Continue.
  markInterrupted(sids: SessionId[]): void;
  mdCtx: MarkdownContext;
  modelName(id: string): string;
  // Disclosures the user opened, by key, across renders.
  openTools: Set<string>;
  reasoningCard(it: AssistantItem, key: string | number): HTMLDetailsElement;
  recordTurn(sid: SessionId, v: NormalizedView | null, ms: number): Promise<void>;
  renderLog(): void;
  replyBody(text: string, next: ReplyCache): HTMLElement;
  revealDir(path: string): Promise<void>;
  revertTo(it: MessageItem): Promise<void>;
  scheduleRender(): void;
  shortTime(t: number | null | undefined): string;
  toolCard(it: ToolItem, prefix?: string): HTMLDetailsElement;
  undoRevert(sid: SessionId | null | undefined): Promise<void>;
  // The current session's last normalized view; written only here.
  readonly view: ThreadView | null;
}

export function createTranscriptRegion(app: App): TranscriptRegion {
  // watch() is slow (it scans stored history), so switches can overlap. Only the
  // newest attach may install its watcher or touch the view; a superseded one
  // disposes itself, or a slow scan of session A would paint over session B.
  let attachGen = 0;
  let interrupted = false; // the current session's last run was cut off by a reload
  let view: ThreadView | null = null; // last normalized view of the current session
  let unwatch: (() => void) | null = null; // the current session's watcher
  let lastHeight: number | null = null; // the log's height at the last render (the "New reply below" pill)
  async function resumeRun() {
    const sid = app.sessionList.sessions.current?.id;
    if (sid == null) return;
    await store.setSetting(interruptedKey(sid), undefined);
    interrupted = false;
    app.send.send('Continue where you left off: a page reload interrupted your last run.');
  }
  let attachError: string | null = null; // why the current session could not open (held by another tab)
  let revertable: { at?: number; cut?: EntryId; branch: { who: string; text: string }[] } | null = null; // while the current session's last revert can be undone
  async function attach() {
    app.providers.renderHint();
    const gen = ++attachGen;
    if (app.sessionList.focus) app.subagents.swapDraft('child:' + app.sessionList.focus.id, 'main');
    app.sessionList.focus = null;
    unwatch?.(); unwatch = null; view = null; attachError = null; turnTimes = {}; lastHeight = null; $('below').hidden = true; app.state.follow.pin(); app.subagents.dropKidWatches(); renderLog(); app.queues.updateSend();
    const session = app.sessionList.sessions.current;
    if (!session || !app.state.agent) return;
    await app.subagents.loadKids(session.id);
    if (gen !== attachGen) return;
    app.subagents.watchKids();
    const token = await store.getSetting<RevertToken>(revertKey(session.id));
    if (gen !== attachGen) return;
    revertable = token ? { at: token.at, cut: token.cut, branch: token.branch ?? [] } : null;
    interrupted = !!(await store.getSetting(interruptedKey(session.id)));
    turnTimes = (await store.getSetting<Record<string, number>>(turnsKey(session.id))) ?? {};
    if (gen !== attachGen) return;
    // Another tab may hold this session's database (its Web Lock): say so.
    const dispose = await app.state.agent.watch(session.id, (v) => {
      if (gen !== attachGen) return;
      view = v; scheduleRender(); app.queues.updateSend();
    }).catch((e) => { if (gen === attachGen) { attachError = e.message; renderLog(); app.state.status(e.message, 'bad'); } return () => {}; });
    if (gen !== attachGen) return dispose();
    unwatch = dispose;
  }

  // ── Transcript rendering ────────────────────────────────────────────
  // textContent only: model output is never parsed as HTML, so a reply cannot
  // inject script into the page that holds your key.
  const openTools = new Set<string>();
  function reasoningCard(it: AssistantItem, key: string | number) {
    // Streaming: a capped box showing the newest lines, overflow hidden (no
    // inner scroller, so nothing traps a wheel or a finger); done: full height.
    const words = it.streaming ? 0 : it.thinking.trim().split(/\s+/).length;
    const thinking = el('div', { className: 'thinking', textContent: it.thinking });
    const d = el('details', { className: 'reasoning' + (it.streaming ? ' live' : '') }, el('summary', { textContent: it.streaming ? 'Reasoning (in progress)' : `Reasoning, ${words.toLocaleString()} word${words === 1 ? '' : 's'}` }),
      thinking);
    if (it.streaming) thinking.dataset.sk = 'live:' + key;
    return app.state.settings.bind(d, `reasoning:${app.sessionList.sessions.current?.id}:${key}`, 'reasoning');
  }
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderLog(); });
  }

  // Tool calls read as what they do: a write is a path and its text, an edit is
  // old and new lines, bash is its command. Never JSON with escaped newlines.
  function argSummary(name: string, raw: unknown) {
    if (typeof raw === 'string') return raw.slice(0, 120);
    if (!raw) return '';
    const args = toolArgs(raw);
    if (!args) return JSON.stringify(raw).slice(0, 120);
    if (name === 'bash') return (args.command ?? '').split('\n')[0];
    if (name === 'run' && args.code != null) return 'js: ' + (args.code.split('\n').find((l) => l.trim()) ?? '');
    if (name === 'agents' || name === 'subagent') return app.subagents.agentSummary(name, args);
    if (name === 'look') { const ps = Array.isArray(args.paths) ? args.paths : []; return `${ps.length} image${ps.length === 1 ? '' : 's'}: ${ps.map((p) => String(p).split('/').pop()).join(', ')}`; }
    if (name === 'watch') return args.action === 'watch' ? `${(args.paths ?? []).join(', ')}${args.once ? ' (once)' : ''}${args.by && args.by !== 'user' ? ` by ${args.by}` : ''}` : `${args.action ?? ''} ${args.id ?? ''}`.trim();
    return args.path ?? JSON.stringify(args).slice(0, 120);
  }
  function lines(text: unknown, prefix: string, cls: string) {
    return el('span', { className: cls, textContent: String(text ?? '').split('\n').map((l) => prefix + l).join('\n') + '\n' });
  }
  function toolDetail(it: ToolItem) {
    const a = toolArgs(it.args);
    const parts: HTMLElement[] = [];
    if (!a) { if (it.args) parts.push(el('pre', { textContent: String(it.args) })); }
    else if (it.name === 'bash') parts.push(el('pre', { className: 'cmd', textContent: '$ ' + (a.command ?? '') }));
    else if (it.name === 'write') parts.push(el('pre', { className: 'content', textContent: a.content ?? '' }));
    else if (it.name === 'run') {
      const { code, ...rest } = a;
      if (code != null) parts.push(el('pre', { className: 'content', textContent: code }));
      if (Object.keys(rest).length) parts.push(el('pre', { textContent: JSON.stringify(rest, null, 1) }));
    }
    else if (it.name === 'edit') {
      const edits = a.edits?.length ? a.edits : [a];
      const pre = el('pre', { className: 'mini-diff' });
      edits.forEach((e, i) => {
        if (i) pre.append(el('span', { className: 'sep', textContent: '...\n' }));
        pre.append(lines(e.oldText, '- ', 'del'), lines(e.newText, '+ ', 'add'));
      });
      parts.push(pre);
    } else if (it.name === 'look') {
      if (a.note) parts.push(el('p', { className: 'look-note', textContent: a.note }));
      if (it.images?.length) parts.push(el('div', { className: 'look-strip big' }, ...lookThumbs(it)), el('p', { className: 'look-note', textContent: `Sent ${it.images.length} image${it.images.length > 1 ? 's' : ''} to the model as shown; they count toward this conversation's context.` }));
    } else if (it.name !== 'read') parts.push(el('pre', { textContent: JSON.stringify(a, null, 1) }));
    // The marker line becomes the badge and this note; the rest stays as sent.
    const eg = it.name === 'bash' ? egressOf(it.output) : null;
    const e = eg ?? app.sessionList.liveEgress.get(it.id);
    if (e) {
      parts.push(el('p', { className: 'egress-note', textContent: `Left the pouch (${e.commands.join(', ')}). Who can see it: ${e.audiences.join('; ') || 'see the bayleaf-cli skill'}.` }));
    }
    parts.push(el('pre', { textContent: (eg ? eg.text : it.output) || (it.status === 'running' ? 'running...' : '') }));
    return parts;
  }

  // Paths in replies become buttons, but only for files that exist: a token is
  // checked once, then rechecked lazily after the files change (pathGen).
  // linkVer counts answers that changed, so cached replies know to re-render.
  const pathSeen = new Map<string, { kind: PathKind; gen: number }>(); // absolute path -> { kind, gen }
  let pathGen = 0, linkVer = 0;
  const PATH = /((?:\.?\/)?[\w@+-]+(?:[./][\w@+-]+)*)(?::(\d+))?/g;
  function pathKind(abs: string): PathKind {
    const hit = pathSeen.get(abs);
    const kind = hit?.kind ?? 'unknown';
    if (!hit || hit.gen !== pathGen) {
      pathSeen.set(abs, { kind, gen: pathGen });
      app.state.vfs.fs.stat(abs).then((s): PathKind => (s.isDirectory ? 'dir' : 'file'), (): PathKind => 'missing').then((k) => {
        if (k !== kind) { pathSeen.set(abs, { kind: k, gen: pathGen }); linkVer++; scheduleRender(); }
      });
    }
    return kind;
  }
  const isFile = (abs: string) => pathKind(abs) === 'file';

  // A folder link reveals the folder: expand the way down and show the tree.
  async function revealDir(path: string) {
    app.state.layout.open('files');
    await app.tree.reveal(path);
  }
  // Navigation is not governed by connect-src: the address itself is the leak.
  function openExternal(url: string) {
    app.state.sheet('Open external link?', [['Open', () => { window.open(url, '_blank', 'noopener,noreferrer'); }]],
      el('div', {}, el('p', { textContent: 'This opens a page outside Pouch. Anything in the link address goes to that site.' }), el('pre', { textContent: url })));
  }
  const mdCtx: MarkdownContext = {
    cwd: CWD,
    kind: pathKind,
    text: (t) => linkify(t),
    highlight: (code, lang) => highlight(code, lang),
    copy: (t) => navigator.clipboard.writeText(t),
    external: openExternal,
    image: (path, alt) => app.state.localImages.render(path, alt),
    open: (t) => (t.kind === 'dir' ? revealDir(t.path) : app.editing.openFile(t.path, t.line, { link: true })).catch((e) => app.tree.fail(e.message)),
  };
  // Streaming re-renders the whole log each frame; only replies whose text or
  // link answers changed are re-parsed. Unused entries drop out each render.
  let mdCache: ReplyCache = new Map(); // text -> { node, ver }
  function replyBody(text: string, next: ReplyCache) {
    const hit = mdCache.get(text);
    if (hit && hit.ver === linkVer && !next.has(text)) { next.set(text, hit); return hit.node; }
    const node = el('div', { className: 'body md' }, ...renderMarkdown(text, mdCtx));
    if (!next.has(text)) next.set(text, { node, ver: linkVer });
    return node;
  }
  // Split text into text nodes and buttons; DOM nodes only, never HTML.
  function linkify(text: string) {
    const out: Node[] = [];
    let last = 0;
    for (const m of text.matchAll(PATH)) {
      const [tok, p, line] = m;
      if (!p.includes('/') && !/\.\w+$/.test(p)) continue;
      const abs = normalize(p.startsWith('/') ? p : CWD + '/' + p);
      if (!isFile(abs)) continue;
      out.push(document.createTextNode(text.slice(last, m.index)));
      const b = el('button', { type: 'button', className: 'path', textContent: tok, title: 'Open ' + abs + (line ? ' at line ' + line : '') });
      b.onclick = () => app.editing.openFile(abs, line ? Number(line) : undefined, { link: true }).catch((e) => app.tree.fail(e.message));
      out.push(b);
      last = m.index + tok.length;
    }
    out.push(document.createTextNode(text.slice(last)));
    return out;
  }

  function toolCard(it: ToolItem, prefix = '') {
    const k = prefix + it.id;
    const d = app.state.settings.bind(el('details', { className: 'tool' + (it.status === 'error' ? ' error' : '') }), `tool:${app.sessionList.sessions.current?.id}:${k}`, 'tools');
    const mark = it.status === 'running' ? '... ' : it.status === 'error' ? '! ' : '';
    const sum = el('summary', {}, el('span', { className: 'what', textContent: `${mark}${it.name}: ${argSummary(it.name, it.args)}` }));
    const eg = it.name === 'bash' ? (egressOf(it.output) ?? app.sessionList.liveEgress.get(it.id)) : null;
    if (eg) {
      const who = eg.audiences.length ? eg.audiences.join('\n') : 'see the bayleaf-cli skill';
      sum.prepend(el('span', { className: 'egress', title: `Sent outside the pouch (${eg.commands.join(', ')}) to:\n${who}` }, icon('egress'), el('span', { textContent: 'left the pouch' })));
    }
    // A look stays visible while collapsed: small thumbnails in its summary.
    if (it.name === 'look' && it.images?.length) sum.append(el('span', { className: 'look-strip', title: 'Sent to the model' }, ...lookThumbs(it)));
    d.append(sum, ...toolDetail(it));
    return d;
  }
  // Thumbnails of what a look sent, from the stored bytes (blob URLs, no network).
  // The log re-renders every frame, so each image's URL is made once, keyed by
  // its bytes (providers reuse call ids across conversations), and revoked once
  // a render no longer shows it (sweepLooks, after renderLog builds).
  const lookUrls = new Map<string, string>(); // base64 data -> blob URL
  const lookShown = new Set<string>();
  function sweepLooks() {
    for (const [k, url] of lookUrls) if (!lookShown.has(k)) { URL.revokeObjectURL(url); lookUrls.delete(k); }
    lookShown.clear();
  }
  function lookThumbs(it: ToolItem) {
    const names: string[] = [];
    for (const [, path, n] of String(it.output ?? '').matchAll(/^(.+): image (\d+),/gm)) names[Number(n) - 1] = path;
    return (it.images ?? []).map((img, i) => {
      const k = img.data;
      lookShown.add(k);
      if (!lookUrls.has(k)) {
        const bin = atob(img.data), bytes = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        lookUrls.set(k, URL.createObjectURL(new Blob([bytes], { type: img.mimeType })));
      }
      return el('img', { src: lookUrls.get(k), alt: names[i] ?? `image ${i + 1}`, title: names[i] ?? '', loading: 'lazy' });
    });
  }
  // A report without words: where its work went instead (it sent it by message).
  function quietText(it: ReportItem) {
    if (it.status === 'stopped') return 'Stopped before it reported. Pouch is told at its next turn.';
    if (it.byMessage) return `Sent its findings to ${it.byMessage}${it.lastSent?.text ? `: "${it.lastSent.text.slice(0, 120)}${it.lastSent.text.length > 120 ? '...' : ''}"` : '.'}`;
    return 'Finished without a report.';
  }
  // Consecutive quiet reports and main's joins (G7): one summary line, the
  // cards inside. "Joined 4 subagents: 3 reported to chair (a2), 1 quiet".
  function quietGroup(items: QuietItem[], nextCache: ReplyCache) {
    const who = new Map<string | undefined, string>(); // ref -> where it sent its work, or ''
    const rows = app.subagents.kids.get(String(app.sessionList.sessions.current?.id)) ?? [];
    for (const it of items) {
      if (it.type === 'report') who.set(it.ref ?? it.name, it.byMessage || who.get(it.ref ?? it.name) || '');
      else for (const id of list(toolArgs(it.args)?.ids ?? toolArgs(it.args)?.id ?? [])) {
        const c = rows.find((x) => x.ref === asRef(id) || x.name === String(id));
        const ref = c?.ref ?? String(id);
        if (!who.get(ref)) who.set(ref, c?.lastSent && c.sentIn === c.sub ? c.lastSent.to : '');
      }
    }
    const to = new Map<string, number>();
    for (const v of who.values()) if (v) to.set(v, (to.get(v) ?? 0) + 1);
    const quiet = [...who.values()].filter((v) => !v).length;
    const joins = items.some((i) => i.type === 'tool');
    const head = `${joins ? `Joined ${who.size} subagent${who.size === 1 ? '' : 's'}` : `${who.size} subagent${who.size === 1 ? '' : 's'} finished`}: `;
    const parts = [...[...to].map(([k, n]) => seeded(el('span', { className: 'sa-to' }, el('span', { className: 'sa-dot', ariaHidden: 'true' }), `${n} reported to ${k}`), /\(([as]\d+)\)/.exec(k)?.[1])), ...(quiet ? [el('span', { textContent: `${quiet} quiet` })] : [])];
    const what = el('span', { className: 'what' }, head);
    parts.forEach((p, i) => what.append(...(i ? [', '] : []), p));
    const d = el('details', { className: 'tool sa-joins' }, el('summary', {}, what));
    d.append(...items.map((it) => (it.type === 'report' ? reportCard(it, nextCache) : toolCard(it))));
    return d;
  }
  // A subagent's report, where it joined the parent (the model saw it as a message).
  const REPORT_VERB: Record<string, string | undefined> = { finished: 'finished', failed: 'failed', stopped: 'was stopped', interrupted: 'was interrupted' };
  const REPORT_LAST: Record<string, string | undefined> = { stopped: 'Last output before stop', failed: 'Last output before it failed', interrupted: 'Last output before the reload' };
  function reportCard(it: ReportItem, nextCache: ReplyCache) {
    const kids_: HTMLElement[] = [el('div', { className: 'sa-report-head' }, el('span', { className: `sa-status ${it.status}`, textContent: it.status }), ` Subagent ${it.name} ${REPORT_VERB[it.status ?? ''] ?? it.status}`)];
    // Not finished: its last words are work in progress, not a report (critique 49, 59).
    const last = REPORT_LAST[it.status ?? ''];
    if (it.text && last) kids_.push(el('p', { className: 'sa-last muted', textContent: last + ':' }));
    if (it.text) kids_.push(replyBody(it.text, nextCache));
    else kids_.push(el('div', { className: 'body muted', textContent: quietText(it) }));
    return seeded(message({ ...it, type: 'report', text: it.text }, last ? `${last} from subagent ${it.name}` : `Report from subagent ${it.name}`, ...kids_), it.ref);
  }

  // "Pouch is editing..." in the editor header while a write or edit to the open
  // file is being sent or carried out, by main or a subagent (critique 10).
  function markEditing() {
    const at = (p: unknown) => (typeof p === 'string' && p ? normalize(p.startsWith('/') ? p : '/work/' + p) : null);
    const views = [view, ...app.subagents.childViews.values()].filter((v) => v != null);
    const on = !!app.editing.openPath && views.some((v) => v.items.some((it) => it.type === 'tool' && it.status === 'running' && (it.name === 'write' || it.name === 'edit') && at(toolArgs(it.args)?.path) === app.editing.openPath));
    $('editor-busy').hidden = !on;
  }
  function renderLog() {
    const log = $('log');
    markEditing();
    // Before building: cached reply nodes move out of the live log while the
    // new one is built, and a layout read then would clamp its scroll to 0.
    const mark = app.state.follow.mark();
    log.classList.toggle('child-view', !!app.sessionList.focus);
    // The frame (Batch D): the chat column, composer included, in the agent's hue.
    const fc = app.sessionList.focus && app.subagents.focusedChild(), chat = $('chat');
    chat.classList.toggle('in-child', !!app.sessionList.focus);
    chat.classList.toggle('child-ended', !!fc && fc.status !== 'running');
    if (fc?.ref) seeded(chat, fc.ref); else chat.style.removeProperty('--seed');
    if (app.sessionList.focus) {
      log.replaceChildren(...app.subagents.childLog()); app.state.follow.restore(mark);
      sweepLooks();
      if (app.sessionList.focus.pinTop) app.state.follow.top();
      else app.state.follow.stick();
      app.queues.playArrivals(log);
      app.queues.updateSend();
      app.state.composer?.renderTray();
      return;
    }
    const out: HTMLElement[] = [];
    if (!view?.items.length) {
      out.push(el('p', { className: 'notice' + (attachError ? ' bad' : ''), textContent: attachError ? attachError : app.state.agent
        ? 'Ask Pouch to read, write or reorganize files in /work or a mounted folder. ' + (app.providers.localhostPicked() ? 'Files stay in this browser; model requests go to your server on this computer.' : 'Everything stays in this browser; model requests are sealed.') + (!app.sessionList.sessions.current ? ' This session appears in the sidebar and is saved only when you send your first message.' : '')
        : (app.boot.agentError ?? 'Starting...') }));
    }
    const nextCache: ReplyCache = new Map();
    finals = turnFinals(view);
    let quietRun: QuietItem[] = [];
    const flushQuiet = () => {
      const manyIds = quietRun.length === 1 && quietRun[0].type === 'tool' && list(toolArgs(quietRun[0].args)?.ids ?? []).length > 1;
      if (quietRun.length > 1 || manyIds) out.push(quietGroup(quietRun, nextCache));
      else for (const it of quietRun) out.push(it.type === 'report' ? reportCard(it, nextCache) : toolCard(it));
      quietRun = [];
    };
    const items = view?.items ?? [];
    for (const it of items) {
      const quietItem = (it.type === 'report' && !it.text && it.status === 'finished') ||
        (it.type === 'tool' && it.name === 'subagent' && toolArgs(it.args)?.action === 'join' && it.status === 'done');
      if (quietItem) { quietRun.push(it); continue; }
      flushQuiet();
      if (it.type === 'user' && it.watch) {
        // A file-watch event (G14): labeled with the watch that caused it, as a
        // wake (it started this turn) or read between steps.
        const ws = it.watch.watches ?? [];
        const label = `${it.steer || it.watch.mode === 'steer' ? 'From' : 'Woken by'} watch ${ws.map((w) => w.id + (w.note ? `: ${w.note}` : '')).join('; ')}`;
        const m = message(it, label, el('span', { className: 'sa-who msg-from watch-from', textContent: label }), el('div', { className: 'body', textContent: (it.watch.lines ?? []).filter((l) => l.startsWith('[from files]')).map((l) => l.slice(13)).join('\n') || it.text }));
        m.classList.add('from', 'watch');
        out.push(m);
      } else if (it.type === 'user' && it.from) {
        // From a session of this scope (G7): labeled with its sender.
        const m = message(it, `Message from ${it.from.name} (${it.from.ref})`, seeded(el('span', { className: 'sa-who msg-from', textContent: `from ${it.from.name} (${it.from.ref})` }), it.from.ref), el('div', { className: 'body', textContent: it.text }));
        m.classList.add('from');
        out.push(m);
      } else if (it.type === 'user' && it.steer) {
        // Read mid-turn, between steps (D25): the label the subagent view uses.
        const m = message(it, 'Your steering message', el('span', { className: 'sa-who', textContent: app.state.STEER_LABEL }), el('div', { className: 'body', textContent: it.text }));
        m.classList.add('steer');
        out.push(m);
      } else if (it.type === 'user') {
        out.push(message(it, 'Your message', el('div', { className: 'body', textContent: it.text }),
          ...(it.attachments?.length ? [el('div', { className: 'attachment-refs' }, ...it.attachments.map((f) => el('span', { title: f.path, textContent: `${f.name} (${f.size.toLocaleString()} B) `, ariaLabel: `${f.name}, ${f.size} bytes, ${f.path}` })))] : [])));
      } else if (it.type === 'assistant') {
        const kids: HTMLElement[] = [];
        if (it.thinking) kids.push(reasoningCard(it, items.indexOf(it)));
        if (it.text) kids.push(replyBody(it.text, nextCache));
        if (it.error) kids.push(el('div', { className: 'body bad', textContent: app.connection.lostRuns.has(String(app.sessionList.sessions.current?.id)) && it === items.findLast((i: Marked) => i.error) ? 'Connection lost: the network dropped during this turn. Nothing more was sent; send again when back online.' : it.error }));
        if (it.streaming) kids.push(el('span', { className: 'typing', role: 'img', ariaLabel: 'Pouch is replying', title: 'Replying' }, el('i'), el('i'), el('i')));
        out.push(message(it, 'Reply from Pouch', ...kids));
      } else if (it.type === 'tool') {
        const spawn = it.name === 'subagent' && toolArgs(it.args)?.action === 'spawn';
        const child = spawn && it.status !== 'error' ? spawnedChild(it.details) : null;
        const early = child == null && spawn && it.status === 'running' ? app.commands.spawnedAs(it) : null;
        out.push(child != null ? app.subagents.subagentCard(it, child) : early ? app.subagents.subagentCard(it, early.id) : app.commands.startingSpawn(it) ? app.subagents.subagentCard(it, null) : toolCard(it));
        if (it.name === 'bash') out.push(...shownLines(it.output).map(app.editing.shownCard));
      } else if (it.type === 'report') {
        out.push(reportCard(it, nextCache));
      } else if (it.type === 'compaction') {
        out.push(el('details', { className: 'tool' }, el('summary', { textContent: 'Earlier turns were summarized' }), el('pre', { textContent: it.summary ?? '' })));
      } else if (it.type === 'notice') {
        out.push(el('p', { className: 'notice', textContent: it.text }));
      }
    }
    flushQuiet();
    // A reload cut off the last run; nothing resumes without a click (no request spent).
    if (interrupted && view && !app.queues.busy()) {
      const b = el('button', { type: 'button', className: 'primary', textContent: 'Resume' });
      b.onclick = () => { b.disabled = true; resumeRun(); };
      out.push(el('p', { className: 'notice reverted', role: 'status' }, 'The page reloaded while Pouch was working, so that run stopped.', b));
    }
    // "Reverted to <time>. Undo", where the conversation was cut.
    if (revertable && view) {
      const undo = el('button', { type: 'button', textContent: 'Undo', disabled: app.queues.busy() });
      undo.onclick = () => undoRevert(app.sessionList.sessions.current?.id).catch((e) => app.tree.fail(e.message));
      const note = el('p', { className: 'notice reverted', role: 'status' }, `Reverted to ${shortTime(revertable.at)}. Files stay as they are.`, undo);
      const n = revertable.branch.length;
      const other = n ? el('details', { className: 'other-branch' },
        el('summary', { textContent: `Other branch: ${n} message${n === 1 ? '' : 's'} Pouch no longer sees` }),
        ...revertable.branch.map((b) => el('p', {}, el('b', { textContent: b.who + ': ' }), b.text))) : null;
      const cut = String(revertable.cut), shown = other ? [note, other] : [note];
      const at = out.findIndex((n) => n.dataset?.cut === cut);
      if (at < 0) out.push(...shown);
      else out.splice(at + 1, 0, ...shown);
    }
    mdCache = nextCache;
    // Rebuilding the log drops focus; give it back to the same message or button.
    const f = document.activeElement, fKey = f && log.contains(f) ? f.closest<HTMLElement>('.msg')?.dataset.key : null;
    const fAct = fKey && f instanceof HTMLElement ? f.dataset.act : undefined;
    log.replaceChildren(...out); app.state.follow.restore(mark);
    app.state.localImages.sweep(); sweepLooks();
    if (fKey) log.querySelector<HTMLElement>(`.msg[data-key="${CSS.escape(fKey)}"]${fAct ? ` [data-act="${fAct}"]` : ''}`)?.focus({ preventScroll: true });
    app.state.follow.stick();
    // Scrolled up while something new arrived below: say so (critique 19).
    if (!app.state.follow.following && log.scrollHeight > (lastHeight ?? 0) + 4 && lastHeight != null) $('below').hidden = false;
    lastHeight = log.scrollHeight;
    app.queues.playArrivals(log);
    app.state.composer?.renderTray();
  }

  // ── Message toolbar (D11) and revert to here (D12) ──────────────────
  // Each settled message has a toolbar row under it: time, Copy, Revert to
  // here. Its space is always reserved; it shows on hover, on focus within
  // the message (messages are focusable), and after a tap (touch). A turn's
  // final reply gets the turn footer instead: model, duration and time always
  // visible, the actions (Copy, Revert to here, More) shown the same way.
  const shortTime = (t: number | null | undefined) => t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'an earlier point';
  let shownKey: EntryId | null | undefined = null; // the message whose toolbar a tap revealed
  let finals = new Map<ThreadItem, UserItem | ReportItem>(); // final reply of a settled turn -> the item that started the turn
  let turnTimes: Record<string, number> = {}; // turn-start entry -> duration measured in this browser (ms)
  // A turn starts at a user message or a subagent report and ends at its last
  // reply with text. The turn still running has no final reply yet.
  function turnFinals(v: NormalizedView | null) {
    const out = new Map<ThreadItem, UserItem | ReportItem>();
    let start: UserItem | ReportItem | null = null, last: AssistantItem | null = null;
    const close = () => { if (start && last) out.set(last, start); };
    for (const it of v?.items ?? []) {
      if ((it.type === 'user' && !it.steer) || it.type === 'report') { close(); start = it; last = null; }
      else if (it.type === 'assistant' && !it.streaming && it.entry && (it.text || it.error)) last = it;
    }
    if (!v?.busy) close();
    return out;
  }
  // Remember how long the turn just settled took, under its start entry.
  async function recordTurn(sid: SessionId, v: NormalizedView | null, ms: number) {
    const start = v?.items.findLast((i) => i.type === 'user' || i.type === 'report');
    if (!start?.entry) return;
    const all: Record<string, number> = { ...((await store.getSetting<Record<string, number>>(turnsKey(sid))) ?? {}), [start.entry]: ms };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete all[k]; // bounded
    await store.setSetting(turnsKey(sid), all);
    if (sameId(sid, app.sessionList.sessions.current?.id)) { turnTimes = all; scheduleRender(); }
  }
  const modelName = (id: string) => app.connection.models.find((m) => m.id === id)?.name ?? (LOCAL && id === app.providers.LOCAL_ID ? `${LOCAL.label} (Transformers.js)` : isLocalhost(id) ? `${id.slice('localhost:'.length)} (Localhost)` : id);
  function message(it: MessageItem, label: string, ...kids: (Node | string)[]) {
    // A step that only thought before calling tools gets no toolbar: it has
    // nothing to copy, and its reply's toolbar reverts to after its tools.
    const bar = !it.streaming && it.entry && (it.type === 'user' || it.text || it.error);
    const m = el('div', { className: `msg ${it.type}${it.streaming ? ' streaming' : ''}${bar ? '' : ' bare'}`, role: 'article', ariaLabel: label }, ...kids);
    if (!bar) return m;
    m.tabIndex = 0;
    m.dataset.key = String(it.entry);
    m.dataset.cut = String(it.cut);
    if (shownKey === it.entry) m.classList.add('show');
    m.onclick = (e) => {
      if (e.target instanceof Element && e.target.closest('button, a, summary, input')) return;
      shownKey = shownKey === it.entry ? null : it.entry;
      for (const x of $('log').querySelectorAll('.msg.show')) x.classList.remove('show');
      if (shownKey) m.classList.add('show');
    };
    const start = finals.get(it);
    const row = el('div', { className: 'msg-bar' + (start ? ' footer' : '') });
    const when = it.at && el('time', { className: 'when', textContent: shortTime(it.at), title: new Date(it.at).toLocaleString(), dateTime: new Date(it.at).toISOString() });
    const ms = start?.entry != null ? turnTimes[start.entry] : undefined;
    if (start) {
      const parts = [it.model && modelName(it.model), ms != null && app.subagents.fmtDur(ms), when].filter((x): x is string | HTMLTimeElement => !!x);
      const meta = el('span', { className: 'meta' });
      parts.forEach((x, i) => meta.append(...(i ? [el('span', { className: 'sep', ariaHidden: 'true', textContent: '·' })] : []), x));
      if (when) when.className = '';
      meta.title = [it.model && `Model: ${it.model}`, ms != null ? `Turn took ${app.subagents.fmtDur(ms)}` : 'Turn duration not recorded', it.at && new Date(it.at).toLocaleString()].filter(Boolean).join('\n');
      row.append(meta);
    } else if (when) row.append(when);
    const acts = start ? el('span', { className: 'acts' }) : row;
    const tool = (act: string, name: string, tip: string, fn: () => Promise<unknown>, disabled = false) => {
      const b = el('button', { type: 'button', className: 'icon', ariaLabel: tip, title: tip, disabled }, icon(name));
      b.dataset.act = act;
      b.onclick = () => fn().catch((e) => app.tree.fail(e.message));
      acts.append(b);
    };
    // The text as written: what the user typed, or the reply's markdown source.
    tool('copy', 'copy', it.type === 'user' ? 'Copy message' : 'Copy reply (markdown)', async () => {
      await navigator.clipboard.writeText(it.text ?? '');
      app.state.status('Copied.');
    }, !it.text);
    const sid = app.sessionList.sessions.current?.id;
    const why = app.queues.busy() ? ' (not while Pouch is working)' : sid != null && app.state.agent?.isLegacy(sid) ? ' (not for sessions saved before per-session storage)' : '';
    tool('revert', 'undo', 'Revert to here' + why, () => revertTo(it), !!why);
    if (start) {
      tool('more', 'ellipsis', 'More', async () => {
        const dl = el('dl', { className: 'reply-facts' });
        const fact = (k: string, v: string) => dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
        fact('Model', it.model ?? 'unknown');
        if (start.at) fact('Turn started', new Date(start.at).toLocaleString());
        fact('Turn took', ms != null ? app.subagents.fmtDur(ms) : 'not recorded (measured only for turns run in this browser since this feature)');
        if (it.at) fact('Reply began', new Date(it.at).toLocaleString());
        app.state.sheet('This reply', [['Copy as plain text', async () => {
          await navigator.clipboard.writeText(m.querySelector<HTMLElement>('.body')?.innerText ?? it.text ?? '');
          app.state.status('Copied.');
        }]], dl);
      });
      row.append(acts);
    }
    m.append(row);
    return m;
  }

  // Fork the conversation just after `it` (agent.revert): later messages leave
  // the model's context and fold into a dimmed "other branch" (D12). Files are
  // never touched. Kept for undoRevert: the previous conversation id and a
  // short, display-only outline of the branch (store, revertKey).
  const branchOutline = (items: ThreadItem[]) => items.filter((i) => i.type === 'user' || (i.type === 'assistant' && i.text)).slice(0, 40)
    .map((i: Marked) => ({ who: i.type === 'user' ? 'You' : 'Pouch', text: String(i.text ?? '').slice(0, 160) }));
  async function revertTo(it: MessageItem): Promise<void> {
    const s = app.sessionList.sessions.current;
    if (!s || app.queues.busy() || !view) return;
    const sid = s.id;
    // Your own message: revert to just before it, and its text comes back into
    // the box to edit and send again (D12), never a message left without a reply.
    if (it.type === 'user' && !it.steer && !it.watch && !it.from?.ref) {
      const items = view.items, at = items.indexOf(it);
      const before = items.slice(0, at).findLast((i): i is MessageItem => isMessage(i) && !!i.entry && !(i.type === 'assistant' && i.streaming) && (i.type === 'user' || !!i.text || (i.type === 'assistant' && !!i.error)));
      if (!before) return revertFirst(it, at, sid, items);
      return revertTo({ ...before, draft: it.text, draftAt: at });
    }
    const idx = view.items.findIndex((i: Marked) => i.cut === it.cut && i.entry === it.entry && i.type === it.type);
    const later = view.items.slice(idx + 1).filter((i) => i.type === 'user' || (i.type === 'assistant' && (i.text || i.error))).length;
    const body = el('div', { className: 'revert-body' }, el('p', {
      textContent: `${it.draft != null ? 'Your message goes back into the box to edit and send again. ' : ''}${later ? `${later} later message${later > 1 ? 's' : ''} fold${later > 1 ? '' : 's'} into another branch, and Pouch will not see ${later > 1 ? 'them' : 'it'} again.` : 'Nothing comes after this message.'} Files stay as they are. You can undo this.`,
    }));
    app.state.sheet(it.draft != null ? 'Revert to before this message?' : 'Revert to here?', [['Revert', async () => {
      const v = view, agent = app.state.agent;
      if (app.queues.busy() || !v || !agent) return;
      if (it.cut == null) throw new Error('This message has no point to revert to.');
      const branch = branchOutline(v.items.slice(idx + 1));
      const r = await agent.revert(sid, it.cut);
      await store.setSetting(revertKey(sid), { session: String(sid), from: r.from, to: r.to, at: it.at, cut: it.cut, branch });
      // Motion carries continuity: the leaving messages dim before they fold.
      const leaving = [...$('log').querySelectorAll('.msg, .tool, .notice')].filter((n) => n.compareDocumentPosition($('log').querySelector(`[data-cut="${CSS.escape(String(it.cut))}"]`) ?? n) & Node.DOCUMENT_POSITION_PRECEDING);
      for (const n of leaving) n.classList.add('leaving');
      if (leaving.length && !matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise((res) => setTimeout(res, 220));
      if (sameId(sid, app.sessionList.sessions.current?.id)) await attach();
      app.state.status(`Reverted to ${shortTime(it.at)}. Files were not changed.${it.draft != null ? ' Your message is back in the box.' : ''}`);
      if (it.draft != null) app.queues.putBack(it.draft);
    }]], body);
  }
  // Before the first message there is nothing to keep: the session is deleted
  // and a blank session takes its place, with the message back in the box, so it is
  // named again by its next first turn and does not linger if you leave. No
  // branch is kept, so this one cannot be undone (the sheet says so).
  function revertFirst(it: UserItem, at: number, sid: SessionId, items: ThreadItem[]) {
    const later = items.slice(at + 1).filter((i) => i.type === 'user' || (i.type === 'assistant' && (i.text || i.error))).length;
    const agents = (app.subagents.kids.get(String(sid)) ?? []).length;
    const body = el('div', { className: 'revert-body' }, el('p', {
      textContent: `Your message goes back into the box to edit and send again. This is the first message, so the session is deleted${later ? ` with the ${later} message${later > 1 ? 's' : ''} after it` : ''}${agents ? ' and its subagents' : ''}, and a new one starts when you send. Files stay as they are. This cannot be undone.`,
    }));
    app.state.sheet('Revert to before this message?', [['Revert', async () => {
      if (app.queues.busy()) return;
      // Not deleted (another tab holds it): the status says why. Deleted: the message
      // comes back even if another session was opened meanwhile. Until it settles, a
      // send to this session is refused (it would start a turn the delete then erases).
      app.queues.deleting.add(String(sid)); app.queues.updateSend();
      let gone;
      try { gone = await app.sessionList.sessions.remove(sid, false, { stay: true }); }
      finally { app.queues.deleting.delete(String(sid)); app.queues.updateSend(); }
      if (!gone) return;
      // A follow-up held for this session (paused by Stop) comes back too: the blank session has another key.
      const held = app.queues.followUps.get(String(sid));
      if (held) { app.queues.followUps.delete(String(sid)); app.state.composer?.renderTray(); app.queues.putBack(held.text); }
      app.state.status(`${app.sessionList.sessions.current ? 'Deleted that session' : 'Reverted to an empty session'}. Files were not changed. Your message is back in the box.`);
      app.queues.putBack(it.text);
    }, 'danger']], body);
  }

  async function undoRevert(sid: SessionId | null | undefined) {
    if (sid == null) return;
    if (!sameId(sid, app.sessionList.sessions.current?.id)) await app.sessionList.sessions.select(sid);
    const t = await store.getSetting<RevertToken>(revertKey(sid));
    if (!t) return;
    if (app.queues.busy()) return app.state.status('Stop Pouch before undoing the revert.', 'bad');
    // Turns sent since the revert stay behind in the abandoned branch.
    const items = view?.items ?? [], cut = items.findIndex((i: Marked) => String(i.cut) === String(t.cut));
    const since = cut < 0 ? 0 : items.slice(cut + 1).filter((i) => i.type === 'user').length;
    if (since && !(await app.tree.ask(`Undo the revert? The ${since} message${since > 1 ? 's' : ''} you sent since leave${since > 1 ? '' : 's'} the view, and the branch from before the revert comes back.`, 'Undo the revert'))) return;
    if (!app.state.agent) return app.state.status('Pouch is not ready yet: try the undo again in a moment.', 'bad');
    await app.state.agent.point(sid, t.from);
    await store.setSetting(revertKey(sid), undefined);
    await attach();
    app.state.status('Revert undone.');
  }

  return {
    argSummary,
    attach,
    clearInterrupted: (sid) => { if (interrupted && sameId(sid, app.sessionList.sessions.current?.id)) interrupted = false; },
    filesChanged: () => { pathGen++; linkVer++; scheduleRender(); },
    markInterrupted: (sids) => { if (sids.some((x) => sameId(x, app.sessionList.sessions.current?.id))) { interrupted = true; scheduleRender(); } },
    mdCtx,
    modelName,
    openTools,
    reasoningCard,
    recordTurn,
    renderLog,
    replyBody,
    revealDir,
    revertTo,
    scheduleRender,
    shortTime,
    toolCard,
    undoRevert,
    get view() { return view; },
  };
}
