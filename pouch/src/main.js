// BayLeaf Pouch: UI wiring. Files and the editor work with no account; only
// the agent needs a verified Sealed client (a key or Campus Pass).
//
// Plaintext never leaves this page except as EHBP ciphertext to the attested
// enclave. The only network peer is BayLeaf (enforced by connect-src).
import { TinfoilAI } from 'tinfoil';
import { createSettings } from './settings.js';
import { createAttachments, createLocalImages } from './attachments.js';
import * as store from './store.js';
import { Vfs, DEFAULTS, normalize } from './vfs.js';
import defaults from './defaults.js';
import { createEditor, highlight } from './editor.js';
import { renderMarkdown } from './markdown.js';
import { createPreview, previewOf, rememberedMode, rememberMode, MEDIA_MAX } from './preview.js';
import { createTools, systemPrompt, loadContext, CWD, defaultSubagentNs, describeSpecs } from './tools.js';
import { shownLines } from './open-cli.js';
import { openAgent, Type, compactionFor } from './agent.js';
import { describe as describeContext, autoCompactAt, contextFor } from './context.js';
import { collect, packTar, packZip, unpackTar, unpackZip } from './archive.js';
import { $, el, icon, seeded } from './dom.js';
import { arm, armed, play, flipFrom, fold, snapshot, reduced } from './motion.js';
import { createLayout } from './layout.js';
import { createUsage, renderMeter, labelComposer, renderPanel, exhaustedText, extractKey, createLedger } from './usage.js';
import { MAIN, refOf, asRef } from './graph.js';
import { createTerminal } from './terminal.js';
import { createSessions, sameId, titleOf, notesKey, convKey, revertKey, subagentsKey, interruptedKey, turnsKey, watchesKey } from './sessions.js';
import { createWatches, watchTool, baseOf, isGlob, MAX_WAKES } from './ns/watch.js';
import { parseSpecs, over } from './ns/namespace.js';
import { createControl, createChanges, why } from './ns/control.js';
import { TaskFs } from './ns/tasks.js';
import { createComposer } from './composer.js';
import { createEgress, egressOf, grantsFor, revoke, serviceName } from './egress.js';
import { LOCAL, support as localSupport, stored as localStored, engine as localEngine, importFiles as localImport, remove as localRemove, models as modelStore } from './local/engine.js';
import { createModelService } from './models-cli.js';
import { isLocal, HINTS, BUDGET } from './local/provider.js';
import { isLocalhost, testConnection, parseLocalhostUrl, explainMessage, DEFAULT_URL, TRANSPORTS } from './localhost.js';
import { createOffline, short } from './offline.js';
import { createFollow } from './follow.js';
import { dismissible, guardDialog } from './dismiss.js';

const API = 'https://api.bayleaf.dev';
const SEALED = API + '/sealed';
const settings = createSettings();

Object.assign(DEFAULTS, defaults);
const vfs = new Vfs();
// The user's own writes (editor, uploads, drops, unpack, rename, delete):
// attributed 'user', so file watches can tell them from the agent's (src/ns/watch.js).
const userFs = vfs.as('user');
const localImages = createLocalImages(vfs);

let key = null;        // sk-bayleaf-... or null for Campus Pass
let client = null;     // TinfoilAI, verified once per credential
let verified = false;
let agent = null;      // from openAgent, or null if it could not open
let models = [];       // Sealed chat models with tool calling
// How a message read mid-turn is labeled, in main's transcript and a subagent's (D25).
const STEER_LABEL = 'You, while it worked';
let view = null;       // last normalized view of the current session
let composer = null;   // composer.js: tray, autocomplete, shield popover (set below)
let unwatch = null;

function status(text, cls = '') { $('status').textContent = text; $('status').className = cls; }

// ── Frame: sidebar, rail and panels (layout.js) ─────────────────────
const usage = createUsage({ getKey: () => key });
// Every Sealed request of the allowance day, by session (usage.js); the day is
// the allowance's own (it ends at resetsAt).
const ledger = createLedger({ get: () => store.getSetting('requestLedger'), set: (v) => store.setSetting('requestLedger', v) },
  () => usage.state.resetsAt?.toISOString() ?? null);
// The allowance badge, its tooltip split into this browser's count and the allowance.
const meter = async () => renderMeter(usage.state, await ledger.snapshot().catch(() => null));
// Follow new content only while following (src/follow.js, README "Scrolling").
const follow = createFollow($('log'));
// Deferred: the layout restores a remembered panel while this module is still loading.
const layout = createLayout({ onPanel: (p) => { if (p === 'usage') queueMicrotask(renderUsagePanel); if (p === 'trust') queueMicrotask(() => { renderCopy(); renderNamespaces(); }); if (p === 'terminal' && !matchMedia('(pointer: coarse)').matches) queueMicrotask(() => $('term-input').focus()); } });

// ── Action sheet: one tap-friendly menu for every "..." button ──────
// `body` (text or a node) explains the choice, above the buttons.
function sheet(title, actions, body) {
  $('sheet-title').textContent = title;
  $('sheet-body').replaceChildren(...(body == null ? [] : [typeof body === 'string' ? el('p', { textContent: body }) : body]));
  $('sheet-body').hidden = body == null;
  // A tree row that opened the sheet may be rebuilt meanwhile: return focus to its successor.
  const opener = document.activeElement;
  $('sheet').addEventListener('close', () => {
    if (opener && !opener.isConnected && (opener.dataset?.path || opener.classList?.contains('more'))) treeRows().find((r) => r.dataset.path === focusPath)?.focus();
  }, { once: true });
  $('sheet-actions').replaceChildren(...actions.filter(Boolean).map(([label, fn, cls]) => {
    const b = el('button', { type: 'button', textContent: label, className: cls ?? '' });
    b.onclick = async () => { $('sheet').close(); try { await fn(); } catch (e) { fail(e.message); } };
    return b;
  }), el('button', { type: 'button', textContent: 'Cancel', onclick: () => $('sheet').close() }));
  // A field typed into and then dismissed comes back as it was (src/dismiss.js).
  const kept = sheetDrafts.get(title);
  sheetDrafts.delete(title);
  if (kept) [...$('sheet-body').querySelectorAll('input, textarea')].forEach((f, i) => { if (kept[i] != null) f.value = kept[i]; });
  $('sheet').querySelector(':scope > .keep-note')?.remove();
  $('sheet').showModal();
}
const sheetDrafts = new Map(); // sheet title -> the values of its fields when it was dismissed
// Every dialog, popover, menu and drawer dismisses by one rule (src/dismiss.js).
guardDialog($('sheet')); guardDialog($('claim')); guardDialog($('egress'));
dismissible({ layer: 3, isOpen: () => $('sheet').open, inside: () => [$('sheet')],
  keep: () => $('sheet').dataset.busy ?? null,
  close: () => {
    const v = [...$('sheet-body').querySelectorAll('input, textarea')].map((f) => f.value);
    if (v.some((x) => x.trim())) sheetDrafts.set($('sheet-title').textContent, v);
    $('sheet').close();
  } });
// Waiting for approval in another tab: dismissing is Cancel (start again any time).
dismissible({ layer: 3, isOpen: () => $('claim').open, inside: () => [$('claim')], close: () => $('claim-cancel').click() });
// A request waiting to leave: dismissing answers Deny, the answer that sends nothing.
dismissible({ layer: 3, isOpen: () => $('egress').open, inside: () => [$('egress')], close: () => $('egress-deny').click() });

// ── Editor ──────────────────────────────────────────────────────────
// The editor keeps a baseline: the text it last loaded or saved. When the
// file changes on disk under a dirty buffer, that is a conflict for the user
// to settle (story map R4), never a silent overwrite either way.
let openPath = null;
let dirty = false;
let conflict = null;   // disk text that arrived while the buffer was dirty
let merging = false;   // the conflict diff (theirs vs mine) is shown
const editor = createEditor($('editor'), {
  onSave: () => saveFile(),
  onChange: (d) => { dirty = d; $('save').disabled = !d; $('editor-path').classList.toggle('dirty', d); markEditor(); },
});

// Previews (src/preview.js, README "Previews"): Raw | Preview for markdown,
// HTML and SVG; images, audio and video open as a preview only (viewOnly:
// there is no text to edit, so nothing can be saved over them). A preview
// shows the saved file. HTML reports start Static every time: Interactive is
// never remembered, because its scripts keep a way out (WebRTC).
let fileView = 'raw', viewOnly = false, scripts = false, shown = null;
const preview = createPreview($('preview'), { markdown: (text, path) => renderMarkdown(text, { ...mdCtx, cwd: normalize(path + '/..') }) });
function setView(mode) {
  const p = openPath && previewOf(openPath);
  fileView = p ? mode : 'raw';
  $('view-mode').hidden = !p?.raw;
  for (const b of $('view-mode').children) b.setAttribute('aria-pressed', String(b.dataset.mode === fileView));
  $('editor').hidden = fileView === 'preview';
  $('preview').hidden = fileView !== 'preview';
  $('save').hidden = viewOnly;
  shown = null;
  if (fileView === 'preview') renderPreview();
  else { preview.clear(); $('preview-bar').hidden = true; }
}
// Draws the saved file; on a file change, only if its bytes changed.
async function renderPreview() {
  const path = openPath, p = previewOf(path), html = p.kind === 'html';
  $('script-mode').hidden = !html;
  for (const b of $('script-mode').children) b.setAttribute('aria-pressed', String((b.dataset.scripts === 'on') === scripts));
  $('preview-note').textContent = [
    dirty && 'Showing the saved version: save to preview your edits.',
    html && (scripts
      ? 'Interactive: scripts run. They cannot read Pouch or your files, and web requests are blocked, but a script can still reach the network over WebRTC (and in Safari, a link preconnect), so a hostile report could send out what it shows. Only for reports you trust.'
      : 'Static: no scripts run, and nothing in this report can reach the network.'),
  ].filter(Boolean).join(' ');
  $('preview-bar').hidden = !$('preview-note').textContent;
  try {
    const st = await vfs.fs.stat(path);
    if (!p.raw && st.size > MEDIA_MAX) return preview.notice(`This file is ${(st.size / 2 ** 20).toFixed(0)} MB; Preview shows files up to 50 MB. Download it instead.`);
    const bytes = await vfs.fs.readFileBuffer(path);
    const sig = [scripts, ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join();
    if (path !== openPath || fileView !== 'preview' || sig === shown) return;
    shown = sig;
    preview.render(path, bytes, { scripts });
  } catch (e) { preview.notice('Could not preview this file: ' + e.message); }
}
$('view-mode').onclick = (e) => {
  const m = e.target.closest('button')?.dataset.mode;
  if (!m || m === fileView || !openPath) return;
  rememberMode(previewOf(openPath).kind, m);
  setView(m);
  if (m === 'raw') editor.focus();
};
$('script-mode').onclick = (e) => {
  const on = e.target.closest('button')?.dataset.scripts;
  if (!on || (on === 'on') === scripts) return;
  scripts = on === 'on';
  renderPreview();
};

function showEditor(path) {
  $('editor-path').textContent = path;
  $('editor-pane').classList.remove('empty');
  layout.open('editor');
  renderTree();
}
// No file open: the Editor panel says how to open one.
function editorEmpty() {
  $('editor-path').textContent = 'No file open';
  $('editor-pane').classList.add('empty');
  markEditor();
}
// A dot on the Editor rail icon while the buffer holds unsaved or conflicting edits.
function markEditor() {
  $('rail').querySelector('[data-panel="editor"]').classList.toggle('dot', !!openPath && (dirty || conflict != null));
}
function setConflict(theirs) {
  conflict = theirs;
  $('conflict-bar').hidden = theirs == null;
  $('conflict-diff').hidden = merging; // the diff is already open (critique 3)
  if (theirs == null) editorStatus(null);
  markEditor();
}
// Save and conflict feedback, in the editor pane rather than under the chat
// composer, and cleared once the conflict is settled (critique 2).
function editorStatus(text, kind = '') {
  const n = $('editor-status');
  n.hidden = !text; n.textContent = text ?? ''; n.className = kind;
}
function setReviewBar(text) {
  $('review-bar').hidden = text == null;
  $('review-mine').hidden = $('review-theirs').hidden = true;
  $('review-text').textContent = text ?? '';
}

// link: opened from a reply, where an HTML report opens in Preview; a line
// number always opens Raw. Otherwise each kind opens in its last mode.
// mode, interactive: the terminal's `open` (src/open-cli.js) names both, and
// remembers neither. Returns true when opened, false when the user kept
// unsaved changes, or a reason it was not: 'binary', or recheck()'s (show).
async function openFile(path, line, { link = false, mode = null, interactive = false, recheck = null } = {}) {
  const p = previewOf(path);
  const want = mode ?? (line ? 'raw' : link && p?.kind === 'html' ? 'preview' : null);
  const wantScripts = !!mode && p?.kind === 'html' && interactive;
  // Reopening the file you are editing only moves the cursor: no reload, no loss.
  if (path !== openPath || merging) {
    if (dirty && !(await ask(`Discard unsaved changes to ${openPath}?`, 'Discard', 'danger'))) return false;
    if (p && !p.raw) { // image, audio, video: a preview only
      await vfs.fs.stat(path);
      const why = recheck?.(); if (why) return why;
      openPath = path; merging = false; viewOnly = true; scripts = false;
      setReviewBar(null); setConflict(null);
      editor.load(path, '');
      setView('preview');
      showEditor(path);
      return true;
    }
    const bytes = await vfs.fs.readFileBuffer(path);
    // The person's edits or activity during the read win over show (src/open-cli.js).
    const why = recheck?.(); if (why) return why;
    if (bytes.includes(0)) {
      sheet(path + ' looks binary', [
        ARCHIVE.test(path) && vfs.where(path) !== 'mount-ro' && ['Unpack here', () => unpackHere(path)],
        ARCHIVE.test(path) && ['List contents', () => listArchive(path)],
        ARCHIVE.test(path) && ['Layer under /work (read-only seed)', () => stackSeed(path)],
        ['Download', () => download(path)],
      ]);
      return 'binary';
    }
    openPath = path; merging = false; viewOnly = false; scripts = wantScripts;
    setReviewBar(null); setConflict(null);
    editor.load(path, new TextDecoder().decode(bytes));
    setView(want ?? (p ? rememberedMode(p.kind) : 'raw'));
  } else if (want && (want !== fileView || (mode && wantScripts !== scripts))) {
    if (mode) scripts = wantScripts;
    setView(want);
  }
  showEditor(path);
  if (line) editor.gotoLine(line);
  if (fileView === 'raw') editor.focus();
  return true;
}

// Show (LANGUAGE.md): an agent puts a file or folder in front of the person
// (bash `show`, src/open-cli.js). For now it opens at once only when that
// would not get in their way; otherwise the transcript offers it (shownCard).
// Provisional, pending experience with it.
const SHOW_QUIET_MS = 4000; // a touch of the page this recent means the person is busy
let lastTouch = 0;
for (const ev of ['keydown', 'pointerdown', 'wheel']) document.addEventListener(ev, () => { lastTouch = performance.now(); }, { capture: true, passive: true });
function showBusy(caller) {
  if (caller != null && agent?.who(caller)?.child != null) return 'a subagent asked';
  if (dirty) return 'unsaved edits';
  if (document.querySelector('dialog[open]')) return 'a dialog is open';
  if (performance.now() - lastTouch < SHOW_QUIET_MS) return 'typing or pointing just now';
  return null;
}
async function show({ path, dir, mode }, caller) {
  const reason = showBusy(caller);
  if (reason) return { opened: false, reason };
  if (dir) await revealDir(path);
  else {
    const r = await openFile(path, undefined, { mode, recheck: () => showBusy(caller) });
    if (r === 'binary') throw new Error('looks binary; not opened (the person was offered Download)');
    if (r !== true) return { opened: false, reason: r || 'unsaved edits' };
  }
  return { opened: true };
}
// A bash result's `shown:` lines, read back so the card survives reload.
function shownCard({ how, path, label, reason }) {
  const b = el('button', { type: 'button', textContent: 'Open', title: `Open ${path} (${label})` });
  b.onclick = () => (label === 'Files' ? revealDir(path) : openFile(path, undefined, { mode: label === 'Raw' ? 'raw' : 'preview' })).catch((e) => fail(e.message));
  const what = how === 'opened' ? `Shown: ${path} (${label})` : `Pouch wants to show you ${path} (${label}); not opened while you were busy (${reason})`;
  const card = el('p', { className: 'notice reverted shown', role: 'status' }, what, b);
  card.dataset.shown = how;
  return card;
}
async function saveFile() {
  if (!openPath || viewOnly) return;
  try {
    // In the conflict diff, Save is Done and then a write; with hunks left
    // unsettled it writes nothing and says so (neither side is ever dropped).
    if (merging && !settleDiff()) return;
    // Compare-and-swap: never overwrite a version you have not seen. A newer
    // one raises the conflict bar instead of saving.
    const disk = (await vfs.fs.exists(openPath)) ? await vfs.fs.readFile(openPath) : null;
    if (disk !== null && disk !== editor.baseline && disk !== editor.text()) {
      setConflict(disk);
      editorStatus('Not saved: Pouch changed this file meanwhile. Show diff, Keep mine or Take theirs, then Save.', 'bad');
      return;
    }
    await userFs.writeFile(openPath, editor.text()); editor.markSaved(); setConflict(null); vfs.changed();
    editorStatus(null);
  } catch (e) { editorStatus('Could not save: ' + e.message, 'bad'); }
}
// Leave the conflict diff once every hunk is kept or taken; until then the
// bar counts what is left and offers to settle the rest one way.
function settleDiff() {
  const n = editor.unresolved();
  if (n) {
    setReviewBar(`${n} change${n === 1 ? '' : 's'} not settled yet: Keep mine or Take theirs on each (nothing is saved until all are).`);
    $('review-mine').hidden = $('review-theirs').hidden = false;
    editor.focus();
    return false;
  }
  merging = false; setReviewBar(null); $('conflict-diff').hidden = false;
  editor.endDiff(); if (conflict != null) editor.setBaseline(conflict); setConflict(null);
  return true;
}
async function closeFile() {
  if (dirty && !(await ask(`Discard unsaved changes to ${openPath}?`, 'Discard', 'danger'))) return;
  openPath = null; dirty = false; merging = false; viewOnly = false; scripts = false;
  setReviewBar(null); setConflict(null);
  editor.load('', '');
  setView('raw');
  editorEmpty();
  layout.open('files');
  renderTree();
}
$('save').onclick = saveFile;
$('close-file').onclick = closeFile;
$('to-files').onclick = () => layout.open('files');

// Merged by hand: their version is now seen, the buffer is yours to save.
$('review-done').onclick = () => { settleDiff(); editor.focus(); };
$('review-mine').onclick = () => { editor.settleAll(true); settleDiff(); editor.focus(); };
$('review-theirs').onclick = () => { editor.settleAll(false); settleDiff(); editor.focus(); };
$('conflict-diff').onclick = () => {
  merging = true; $('conflict-diff').hidden = true;
  editor.diff(openPath, conflict, editor.text());
  setReviewBar('Each change shows Pouch\'s version struck through, then your version. Keep mine or Take theirs on each, then Done (or Save).');
  editor.focus();
};
$('conflict-mine').onclick = () => { editor.setBaseline(conflict); setConflict(null); editor.focus(); };
$('conflict-theirs').onclick = () => {
  merging = false; setReviewBar(null);
  editor.load(openPath, conflict); setConflict(null); editor.focus();
};

// When the agent changes the open file and you have no edits, follow it;
// with edits, raise a conflict. If it was deleted: close a clean buffer; keep
// a dirty one and say so (Save would re-create the file, deliberately).
async function syncEditor() {
  if (openPath && viewOnly && !(await vfs.fs.exists(openPath))) { openPath = null; viewOnly = false; setView('raw'); editorEmpty(); return; }
  if (openPath && !viewOnly) await syncText();
  if (!openPath && fileView !== 'raw') setView('raw'); // a deleted file closed
  if (openPath && fileView === 'preview' && (await vfs.fs.exists(openPath))) renderPreview();
}
async function syncText() {
  if (!openPath) return;
  if (!(await vfs.fs.exists(openPath))) {
    if (dirty) { $('editor-path').textContent = openPath + ' (deleted)'; return; }
    openPath = null; editorEmpty();
    return;
  }
  const text = await vfs.fs.readFile(openPath);
  if (!dirty && !merging) {
    if (text !== editor.text()) { const old = editor.text(); editor.load(openPath, text); editor.flash(old); }
    return;
  }
  if (text === editor.baseline || text === conflict) return;
  if (text === editor.text()) { editor.setBaseline(text); setConflict(null); return; } // same edit on both sides
  setConflict(text);
  editor.flash(text); // the lines Pouch's version changes, once, apart from the bar
  if (merging) editor.diff(openPath, text, editor.text());
}

// ── File browser ────────────────────────────────────────────────────
const expanded = new Set(['/work']);
const ROOTS = [['/work', 'work', 'this browser'], ['/pouch', 'pouch', 'shared'], ['/tmp', 'tmp', 'memory']];
// What each storage tag means: the tag's title on hover, the storage sheet on tap (T4).
const STORAGE = {
  'this browser': 'Kept in this browser (its private file system) until you press Erase all. Nothing is uploaded.',
  shared: 'Instructions (AGENTS.md) and skills the agent reads in every session, kept in this browser.',
  memory: 'Memory only: gone when you reload the page.',
  'memory only': 'This browser gives Pouch no private file system, so /work is memory only and is lost on reload.',
  device: 'A folder on your device, mounted read-write: changes, including the agent\'s, go straight to your disk.',
  'read-only': 'A folder on your device, mounted read-only: Pouch can read it but not change it.',
  'tap to reconnect': 'A device folder mounted earlier. Tap to grant access again; browsers ask after each reload.',
};
function storageInfo() {
  sheet('Where your files are kept', [['Upload files into /work', () => uploadTo('/work')]], [
    'work: this browser only, kept until you press Erase all. Nothing is uploaded.',
    'pouch: shared instructions (AGENTS.md) and skills the agent reads in every session, also in this browser.',
    'tmp: memory, gone when you reload.',
    'Mounted folders (Mount): real folders on your device. A read-write mount lets the agent change your files.',
    'What leaves this page: your messages and the files the agent reads, encrypted to the attested enclave.',
    'On a borrowed computer: Download all, then Erase all before you leave.',
  ].join('\n\n'));
}

function download(path, bytes) {
  const go = (b) => {
    const url = URL.createObjectURL(b instanceof Blob ? b : new Blob([b]));
    const a = el('a', { href: url, download: path.split('/').pop() });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return bytes ? go(bytes) : vfs.fs.readFileBuffer(path).then(go);
}

// Folders leave as .zip (opens natively on Windows, macOS and phones) or .tar.
async function downloadDir(path, format = 'zip', fileName) {
  const name = path.split('/').pop() || 'folder';
  const entries = await collect(vfs.fs, normalize(path + '/..'), name);
  download(fileName ?? `${name}.${format}`, format === 'zip' ? await packZip(entries) : packTar(entries));
  status(`Downloaded ${path} as .${format} (${entries.filter((e) => !e.dir).length} files).`);
}

// "file.txt" -> "file (2).txt", the first name not taken.
async function freeName(path) {
  const dir = normalize(path + '/..'), base = path.slice(dir.length).replace(/^\//, '');
  const [, stem, ext = ''] = base.match(/^(.+?)(\.[^.]*)?$/);
  for (let i = 2; ; i++) {
    const p = normalize(`${dir}/${stem} (${i})${ext}`);
    if (!(await vfs.fs.exists(p))) return p;
  }
}

// Ask with the sheet; resolves to the chosen value, or null if dismissed.
function choose(title, options, body) {
  return new Promise((resolve) => {
    $('sheet').addEventListener('close', () => resolve(null), { once: true });
    sheet(title, options.filter(Boolean).map(([value, label, cls]) => [label, () => resolve(value), cls]), body);
  });
}

// Write a batch of incoming files, [{ path, data: async () => bytes }], never
// overwriting silently (I1, I2): one question per batch, answered for all
// conflicts at once or one by one. Returns null if cancelled before writing.
async function writeBatch(where, items, dirs = []) {
  const clashes = new Set();
  for (const it of items) if (await vfs.fs.exists(it.path)) clashes.add(it);
  let policy = null;
  if (clashes.size) {
    const list = [...clashes].map((c) => c.path);
    const one = list.length === 1;
    const kept = one ? (await freeName(list[0])).split('/').pop() : null;
    policy = await choose(one ? `${list[0].split('/').pop()} already exists in ${normalize(list[0] + '/..')}` : `${list.length} of these already exist in ${where}`, [
      ['replace', one ? 'Replace it' : `Replace all ${list.length}`, 'danger'],
      ['keep', one ? `Keep both (the new one becomes ${kept})` : `Keep both for all ${list.length} (new ones get "(2)")`],
      ['skip', one ? 'Skip it' : `Skip all ${list.length}`],
      !one && ['each', 'Decide for each'],
    ], one ? undefined : list.join('\n'));
    if (!policy) return null;
  }
  for (const d of dirs) await userFs.mkdir(d, { recursive: true });
  let written = 0, skipped = 0;
  const paths = [];
  for (const it of items) {
    let dest = it.path;
    if (clashes.has(it)) {
      let p = policy;
      if (p === 'each') {
        p = await choose(`${dest} already exists`, [['replace', 'Replace it', 'danger'], ['keep', `Keep both (the new one becomes ${(await freeName(dest)).split('/').pop()})`], ['skip', 'Skip it']]);
        if (!p) { skipped += items.length - written - skipped; break; } // Cancel stops the rest
      }
      if (p === 'skip') { skipped++; continue; }
      if (p === 'keep') dest = await freeName(dest);
      else if ((await vfs.fs.stat(dest)).isDirectory) await userFs.rm(dest, { recursive: true });
    }
    await vfs.fs.mkdir(normalize(dest + '/..'), { recursive: true });
    await userFs.writeFile(dest, await it.data());
    written++; paths.push(dest);
  }
  return { written, skipped, paths };
}

async function addFiles(where, items, dirs, verb = 'Added') {
  try {
    const r = await writeBatch(where, items, dirs);
    if (r) { expanded.add(where); status(`${verb} ${r.written} file${r.written === 1 ? '' : 's'} in ${where}${r.skipped ? ` (${r.skipped} skipped)` : ''}.`); }
    return r;
  } catch (e) { fail('Could not add files: ' + e.message); }
  finally { vfs.changed(); }
}
const fileItem = (path, file) => ({ path, data: async () => new Uint8Array(await file.arrayBuffer()) });

// Dropped items may be folders: walk them with the (widely supported) entry API.
// Where that is missing (and for folder pickers), files carry their folder in
// webkitRelativePath. Both lists must be read before the first await: the
// browser empties a DataTransfer once the drop event returns.
async function dropInto(dir, dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = [...dataTransfer.files];
  const items = [], dirs = [];
  const walk = async (entry, rel) => {
    const path = normalize(dir + '/' + rel);
    if (entry.isFile) return items.push(fileItem(path, await new Promise((res, rej) => entry.file(res, rej))));
    dirs.push(path);
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, rel + '/' + e.name);
    }
  };
  try {
    if (entries.length) for (const e of entries) await walk(e, e.name);
    else for (const f of files) items.push(fileItem(normalize(dir + '/' + (f.webkitRelativePath || f.name)), f));
  } catch (e) { return fail('Could not read the dropped files: ' + e.message); }
  await addFiles(dir, items, dirs);
}

const canPickFolder = 'webkitdirectory' in HTMLInputElement.prototype;
function uploadTo(dir, folder = false) {
  const input = $(folder ? 'upload-dir' : 'upload');
  input.onchange = async () => {
    const files = [...input.files]; input.value = '';
    await addFiles(dir, files.map((f) => fileItem(normalize(dir + '/' + (f.webkitRelativePath || f.name)), f)));
    layout.open('files');
  };
  input.click();
}

// ── Archives: unpack and list (I4) ──
const ARCHIVE = /\.(zip|tar)$/i;
async function readArchive(path) {
  const bytes = await vfs.fs.readFileBuffer(path);
  const entries = /\.zip$/i.test(path) ? await unpackZip(bytes) : unpackTar(bytes);
  // Same zip-slip rule as extract(); macOS's __MACOSX resource forks are noise.
  return entries.filter((e) => !e.path.split('/').includes('..') && !/^__MACOSX(\/|$)/.test(e.path))
    .map((e) => ({ ...e, path: normalize('/' + e.path).slice(1) })).filter((e) => e.path);
}
// Stack /work over an archive (src/ns/seed.js): its files show under /work
// until you change or remove them; your own files win.
async function stackSeed(path) {
  try {
    const n = await vfs.stack(path.split('/').pop(), await vfs.fs.readFileBuffer(path));
    status(`/work is now stacked over ${path.split('/').pop()} (${n} files, read-only). Your files win; remove the layer under What can BayLeaf see?`);
    renderTree(); renderNamespaces(); vfs.watches?.rescan('seed');
  } catch (e) { status('Could not use it as a seed layer: ' + e.message, 'bad'); }
}
// The trust panel's mount tables: the agent's, then each task's.
function renderNamespaces() {
  const f = $('ns-facts');
  if (!f) return;
  f.replaceChildren(el('dt', { textContent: 'Agent' }), el('dd', {}, el('pre', { textContent: vfs.describe().join('\n') })));
  for (const t of vfs.tasks.list().slice().reverse()) {
    f.append(el('dt', { textContent: `/task/${t.id}: ${t.kind} ${t.label ?? ''} (${t.status})` }), el('dd', {}, el('pre', { textContent: vfs.tasks.mounts(t).join('\n') })));
  }
  $('seed-row').hidden = !vfs.seedLayer;
}
$('seed-remove').onclick = async () => { await vfs.unstack(); vfs.watches?.rescan('seed'); renderTree(); renderNamespaces(); status('Removed the seed layer; /work shows only your files.'); };
vfs.tasks.addEventListener('change', () => { if (layout.current() === 'trust') renderNamespaces(); });
// A bundled default (a skill) changed and the user's copy differs: ask once.
function offerDefaults() {
  const path = vfs.defaultUpdates?.[0];
  $('default-update').hidden = !path;
  if (!path) return;
  $('default-update-text').textContent = `A newer ${path.replace(/^\/skills\/|\/SKILL\.md$/g, '')} skill ships with this build, and your /pouch${path} differs from the one Pouch gave you. Take the new one (yours is replaced), or keep yours?`;
  $('default-take').onclick = () => vfs.resolveDefault(path, true).then(() => { status(`Updated /pouch${path}.`); offerDefaults(); });
  $('default-keep').onclick = () => vfs.resolveDefault(path, false).then(offerDefaults);
}

async function unpackHere(path) {
  const entries = await readArchive(path);
  const parent = normalize(path + '/..');
  // One top-level folder (zip -r proj.zip proj) becomes that folder; otherwise
  // a folder named after the archive, so loose files never spill into the parent.
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  const [top] = tops;
  const single = tops.size === 1 && entries.some((e) => e.path.startsWith(top + '/'));
  const dest = single ? parent : path.replace(ARCHIVE, '');
  const where = single ? normalize(parent + '/' + top) : dest;
  await addFiles(where, entries.filter((e) => !e.dir).map((e) => ({ path: normalize(dest + '/' + e.path), data: async () => e.data })),
    [where, ...entries.filter((e) => e.dir).map((e) => normalize(dest + '/' + e.path))], 'Unpacked');
  expanded.add(parent);
}
async function listArchive(path) {
  const entries = await readArchive(path);
  const n = entries.filter((e) => !e.dir).length;
  sheet(`${n} file${n === 1 ? '' : 's'} in ${path.split('/').pop()}`, [['Unpack here', () => unpackHere(path)]],
    el('pre', { textContent: entries.map((e) => (e.dir ? `${e.path}/` : `${e.path}  (${e.data.length} bytes)`)).join('\n') }));
}

// ── Clipboard, for borrowed computers (O4, I5) ──
async function copyText(path) {
  const bytes = await vfs.fs.readFileBuffer(path);
  if (bytes.includes(0)) return fail(`${path} looks binary. Download it instead.`);
  try { await navigator.clipboard.writeText(new TextDecoder().decode(bytes)); status(`Copied the text of ${path}.`); }
  catch (e) { fail(`This browser did not allow copying (${e.message}). Open the file, select all in the editor and copy from there.`); }
}
async function newFromClipboard(dir) {
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch (e) { return fail(`This browser did not allow reading the clipboard (${e.message}). Make a new file and paste into the editor instead.`); }
  if (!text) return fail('The clipboard holds no text.');
  const name = (await askName('New file from clipboard', `Name for the new file (${text.length} characters from the clipboard)`, 'pasted.txt'))?.trim();
  if (!name) return;
  const path = normalize(dir + '/' + name);
  const r = await addFiles(dir, [{ path, data: async () => new TextEncoder().encode(text) }]);
  if (r?.paths.length) openFile(r.paths[0]).catch((e) => fail(e.message));
}

// A name asked inline in the sheet (no native prompt); null when cancelled.
function askName(title, label, value = '', verb = 'Create') {
  return new Promise((resolve) => {
    const input = el('input', { id: 'name-input', className: 'key-input', value, spellcheck: false, autocomplete: 'off' });
    const form = el('form', { className: 'key-form' }, el('label', { htmlFor: 'name-input', textContent: label }), el('div', { className: 'key-row' }, input, el('button', { type: 'submit', className: 'primary', textContent: verb })));
    let done = false;
    // The sheet that opened this one closes just before: its close event must not count.
    const onClose = () => { if ($('sheet').open) return; $('sheet').removeEventListener('close', onClose); if (!done) resolve(null); };
    form.onsubmit = (e) => { e.preventDefault(); const v = input.value.trim(); if (!v) return input.focus(); done = true; $('sheet').close(); resolve(v); };
    sheet(title, [], form);
    $('sheet').addEventListener('close', onClose);
    input.focus();
  });
}
// A yes/no question in the sheet (never a native confirm, which blocks the
// page and is easy to dismiss by reflex). Resolves true only on the verb.
function ask(text, verb = 'OK', cls = 'primary', title = 'Are you sure?') {
  return new Promise((resolve) => {
    let done = false;
    const onClose = () => { if ($('sheet').open) return; $('sheet').removeEventListener('close', onClose); if (!done) resolve(false); };
    sheet(title, [[verb, () => { done = true; resolve(true); }, cls]], text);
    $('sheet').addEventListener('close', onClose);
  });
}
const fail = (m) => status(m, 'bad');
async function newEntry(dir, kind) {
  const name = await askName(kind === 'dir' ? 'New folder' : 'New file', `${kind === 'dir' ? 'Folder' : 'File'} name in ${dir}`);
  if (!name) return;
  const p = normalize(dir + '/' + name);
  if (kind === 'dir') await vfs.fs.mkdir(p, { recursive: true });
  else { await vfs.fs.mkdir(normalize(p + '/..'), { recursive: true }); if (!(await vfs.fs.exists(p))) await userFs.writeFile(p, ''); }
  // "a/b/c" makes several folders at once: open the way down to the new entry.
  for (let q = normalize(p + '/..'); q.length >= dir.length && q !== '/'; q = normalize(q + '/..')) expanded.add(q);
  vfs.changed();
  if (kind !== 'dir') openFile(p);
}

async function rename(path) {
  const name = await askName('Rename', 'Rename to', path.split('/').pop(), 'Rename');
  if (!name || name.includes('/')) return;
  const dest = normalize(path + '/../' + name);
  if (dest === path) return;
  // mv is copy-then-delete, so renaming onto a name in use would destroy it (R1).
  if (await vfs.fs.exists(dest)) return fail(`${name} already exists in ${normalize(path + '/..')}. Pick another name, or delete that one first.`);
  await userFs.mv(path, dest);
  // The open file may be the renamed entry or inside a renamed folder.
  if (openPath === path || openPath?.startsWith(path + '/')) { openPath = dest + openPath.slice(path.length); $('editor-path').textContent = openPath; }
  if (focusPath === path) focusPath = dest;
  vfs.changed();
}

async function remove(path, isDir) {
  if (!(await ask(`Delete ${path}${isDir ? ' and everything in it' : ''}?`, 'Delete', 'danger'))) return;
  await userFs.rm(path, { recursive: true, force: true });
  vfs.changed();
}

function mention(path) {
  const i = $('input');
  i.value = (i.value ? i.value.replace(/\s*$/, ' ') : '') + path + ' ';
  if (layout.narrow()) layout.close();
  i.focus();
}

function toggle(path) { expanded.has(path) ? expanded.delete(path) : expanded.add(path); renderTree(); }

function entryActions(path, isDir, mountName) {
  const ro = vfs.where(path) === 'mount-ro';
  const isRoot = ROOTS.some(([r]) => r === path);
  if (isDir) return [
    [expanded.has(path) ? 'Collapse' : 'Expand', () => toggle(path)],
    ['New file here', () => newEntry(path, 'file')],
    ['New folder here', () => newEntry(path, 'dir')],
    ['Upload files here', () => uploadTo(path)],
    canPickFolder && ['Upload a folder here', () => uploadTo(path, true)],
    navigator.clipboard && ['New file from clipboard', () => newFromClipboard(path)],
    ['Download as .zip', () => downloadDir(path, 'zip')], // neutral: no action here is the default (critique 8)
    ['Download as .tar', () => downloadDir(path, 'tar')],
    ['Mention in chat', () => mention(path)],
    !mountName && !isRoot && ['Rename', () => rename(path)],
    !mountName && !isRoot && ['Delete', () => remove(path, true), 'danger'],
    mountName && ['Unmount (the folder itself is untouched)', () => vfs.unmount(mountName), 'danger'],
  ].filter((a) => a && !(ro && /^(New|Upload|Rename|Delete)/.test(a[0])));
  return [
    ['Open in editor', () => openFile(path)],
    ARCHIVE.test(path) && !ro && ['Unpack here', () => unpackHere(path)],
    ARCHIVE.test(path) && ['List contents', () => listArchive(path)],
    /\.m?js$/.test(path) && ['Run script', () => runScript(path)],
    ['Download', () => download(path)],
    !ARCHIVE.test(path) && ['Copy text', () => copyText(path)],
    ['Mention in chat', () => mention(path)],
    !ro && ['Rename', () => rename(path)],
    !ro && ['Delete', () => remove(path, false), 'danger'],
  ];
}

// The tree is a flat list of treeitems with aria-level (A1, R1), and one
// roving tab stop: Tab enters at the last focused row, arrows move within.
let focusPath = '/work';
function row(depth, { path, name, isDir, tag, mountName, locked }) {
  const r = el('div', { className: 'row' + (path === openPath ? ' current' : ''), role: 'treeitem', tabIndex: -1,
    ariaLabel: name + (tag ? ', ' + tag : ''), ariaLevel: String(depth + 1), ariaSelected: String(path === openPath) });
  r.dataset.path = path;
  r.meta = { depth, isDir, locked };
  // A watched file that just woke the agent pulses once (G14, G17).
  play(r, 'pulse:' + path, [{ opacity: 0.45 }, { opacity: 1 }, { opacity: 0.6 }, { opacity: 1 }], 1100, { mark: 'pulsed' });
  if (isDir && !locked) r.ariaExpanded = String(expanded.has(path));
  r.style.setProperty('--depth', depth);
  r.append(
    el('span', { className: 'twisty', ariaHidden: 'true' }, ...(isDir ? [icon('chevron')] : [])),
    el('span', { className: 'name', textContent: name, title: path }),
  );
  if (tag) {
    // A button, so the explanation is a tap away on touch screens too (no hover there).
    const t = el('button', { type: 'button', className: 'tag', textContent: tag, tabIndex: -1, title: STORAGE[tag] ?? '' });
    t.onclick = (e) => { e.stopPropagation(); storageInfo(); };
    r.append(t);
  }
  if (locked) {
    r.onclick = () => vfs.reconnect(mountName, { ask: true }).catch((e) => fail(e.message));
    return r;
  }
  const more = el('button', { type: 'button', className: 'more', ariaLabel: 'Actions for ' + name, title: 'Actions', tabIndex: -1 }, icon('ellipsis'));
  more.onclick = (e) => { e.stopPropagation(); focusPath = path; sheet(path, entryActions(path, isDir, mountName)); };
  r.append(more);
  r.onclick = () => {
    focusPath = path;
    if (!isDir) return openFile(path);
    toggle(path);
  };
  // Drop onto a folder puts files in it; onto a file, next to it.
  const target = isDir ? path : normalize(path + '/..');
  r.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); r.classList.add('drop'); };
  r.ondragleave = () => r.classList.remove('drop');
  r.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); r.classList.remove('drop'); dropInto(target, e.dataTransfer); };
  return r;
}

const treeRows = () => [...$('tree').querySelectorAll('.row[data-path]')];
function focusRow(r) {
  if (!r) return;
  for (const x of treeRows()) x.tabIndex = -1;
  r.tabIndex = 0; focusPath = r.dataset.path; r.focus();
}
function rowMenu(r) {
  // click() returns undefined, so `more?.click() ?? r.click()` would click both.
  if (!$('sheet').open) (r.querySelector('.more') ?? r).click();
}
$('tree').onkeydown = (e) => {
  const r = e.target.closest?.('.row[data-path]');
  if (!r || e.target !== r) return;
  const list = treeRows(), i = list.indexOf(r), { depth, isDir, locked } = r.meta, path = r.dataset.path;
  const go = (n) => { e.preventDefault(); focusRow(list[Math.max(0, Math.min(n, list.length - 1))]); };
  if (e.key === 'ArrowDown') return go(i + 1);
  if (e.key === 'ArrowUp') return go(i - 1);
  if (e.key === 'Home') return go(0);
  if (e.key === 'End') return go(list.length - 1);
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (!isDir || locked) return;
    if (!expanded.has(path)) return toggle(path);
    if (list[i + 1]?.meta.depth > depth) focusRow(list[i + 1]);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (isDir && expanded.has(path)) return toggle(path);
    focusRow(list.slice(0, i).reverse().find((x) => x.meta.depth < depth));
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); r.click();
  } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault(); rowMenu(r);
  }
};
// Right-click, and the menu key where the browser turns it into this event.
$('tree').oncontextmenu = (e) => {
  const r = e.target.closest?.('.row[data-path]');
  if (!r) return;
  e.preventDefault(); focusPath = r.dataset.path; rowMenu(r);
};

async function children(path, depth, out) {
  let list;
  try { list = await vfs.list(path); } catch (e) {
    out.push(el('div', { className: 'row muted', textContent: e.message, style: `--depth:${depth}` })); return;
  }
  list.sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
  for (const d of list) {
    const p = normalize(path + '/' + d.name);
    out.push(row(depth, { path: p, name: d.name, isDir: d.isDirectory }));
    if (d.isDirectory && expanded.has(p)) await children(p, depth + 1, out);
  }
}

let treeGen = 0;
async function renderTree() {
  const gen = ++treeGen;
  const out = [];
  const roots = [...ROOTS];
  for (const [name, m] of vfs.mounts) roots.push(['/mnt/' + name, name, m.live ? (m.readOnly ? 'read-only' : 'device') : 'tap to reconnect', name, !m.live]);
  for (const [path, name, tag, mountName, locked] of roots) {
    out.push(row(0, { path, name, isDir: true, tag: path === '/work' && vfs.opfsMissing ? 'memory only' : tag, mountName, locked }));
    if (!locked && expanded.has(path)) await children(path, 1, out);
  }
  if (gen !== treeGen) return;
  // Keep the roving tab stop (and focus, if the tree had it) across rebuilds.
  const hadFocus = $('tree').contains(document.activeElement);
  $('tree').replaceChildren(...out);
  const stop = out.find((r) => r.dataset?.path === focusPath) ?? out.find((r) => r.dataset?.path);
  if (stop) { stop.tabIndex = 0; if (hadFocus) stop.focus(); }
}
// Dropping on empty tree space lands in /work.
$('tree').ondragover = (e) => e.preventDefault();
$('tree').ondrop = (e) => { e.preventDefault(); dropInto(CWD, e.dataTransfer); };

let changeTimer = 0;
vfs.addEventListener('change', () => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => { renderTree(); syncEditor(); pathGen++; linkVer++; scheduleRender(); }, 150);
});
$('refresh').onclick = () => vfs.changed();
// Everything in /work in one file: the "export before I leave" button (O3, L3).
$('download-all').onclick = () => downloadDir('/work', 'zip', `pouch-work-${new Date().toISOString().slice(0, 10)}.zip`).catch((e) => fail(e.message));
function mountFolder() {
  if (!window.showDirectoryPicker) return fail($('mount').title);
  sheet('Mount a folder from this device', [
    ['Read and write', () => vfs.pick(false).then((p) => { expanded.add(p); vfs.changed(); })],
    ['Read only', () => vfs.pick(true).then((p) => { expanded.add(p); vfs.changed(); })],
  ]);
}
if (!window.showDirectoryPicker) $('mount').title = 'This browser cannot mount device folders (Chromium only). Use upload and download instead.';
$('mount').onclick = mountFolder;

// ── First visit (A5, T4, L3) and the after-erase notice (L1) ──────────
$('welcome-where').onclick = storageInfo;
$('welcome-upload').onclick = () => uploadTo('/work');
if (window.showDirectoryPicker) $('welcome-mount').onclick = mountFolder; else $('welcome-mount').hidden = true;
$('welcome-dismiss').onclick = () => { $('welcome').hidden = true; store.setSetting('welcomed', true); };
$('erased-dismiss').onclick = () => { $('erased').hidden = true; };

// ── Run script (D18, D19): the run tool without the model ────────────
// Its writes are attributed to the current session's run (egress, watches). Works offline.
async function runScript(path) {
  const tool = toolList.find((t) => t.name === 'run');
  if (!tool) return fail('The run engine is not available.');
  if (busy() || activeRun) return fail('Wait for the current turn to finish, then run the script.');
  const sid = sessions.current?.id;
  if (sid != null) activeRun = String(sid);
  let text;
  status('Running ' + path);
  // A script saved in /work sees all of /work, as the agent's run of it most likely did.
  try { text = await tool.execute({ path, ...(path.startsWith(CWD + '/') ? { files: [CWD] } : {}) }); } catch (e) { text = e.message.replace(/^<harness>|<\/harness>$/g, '').trim(); }
  finally { activeRun = null; status(''); }
  sheet('Ran ' + path.split('/').pop(), [], el('pre', { className: 'run-out', textContent: text }));
}

// ── Sealed client: verification and credential ───────────────────────
function fact(label, value, cls = '') {
  $('facts').append(el('dt', { textContent: label }), el('dd', { textContent: value, className: cls }));
}

async function connect() {
  verified = false; client = null; updateSend();
  setBadge('pending', 'Verifying enclave');
  let cacheSecret = await store.getSetting('cacheSecret');
  if (!cacheSecret) {
    // Scopes Tinfoil's prompt cache to this device; persists so multi-turn chats hit it.
    cacheSecret = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await store.setSetting('cacheSecret', cacheSecret);
  }
  const c = new TinfoilAI({ bearerToken: key ?? 'campus', baseURL: SEALED + '/v1/', attestationBundleURL: SEALED, userCacheSecret: cacheSecret });
  $('facts').replaceChildren();
  try {
    await c.ready();
    const doc = await c.getVerificationDocument();
    const ok = doc.securityVerified === true;
    // Hashes fold behind "Verified · Details" (critique 10); the summary says the verdict.
    const same = doc.codeFingerprint === doc.enclaveFingerprint;
    const steps = Object.entries(doc.steps ?? {});
    const good = ok && same && steps.every(([, x]) => x.status === 'success');
    const more = el('dl', {});
    const sub = (label, value, cls = '') => more.append(el('dt', { textContent: label }), el('dd', { textContent: value, className: cls }));
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
    fact('Credential', key ? 'personal key (stored in this browser)' : 'Campus Pass (no account; campus network only)');
    if (!ok) throw new Error('attestation did not verify');
    client = c; verified = true;
    setBadge('ok', 'BayLeaf Sealed: enclave verified');
    status(key ? '' : campusLine(usage.state));
  } catch (e) {
    // Fail closed: no plaintext fallback exists anywhere in this app. An
    // unreachable network is not a failed verification: say which it was.
    if (!navigator.onLine || isNetworkError(e.message)) goOffline();
    else {
      setBadge('bad', 'Enclave not verified: nothing will be sent');
      status('Could not verify the enclave, so nothing will be sent: ' + e.message, 'bad');
    }
  }
  updateSend();
}

// ── Network (F1, F2) ────────────────────────────────────────────────
// Offline means the model is unreachable; everything else in the page keeps
// working. Detected from the browser's online/offline events and from requests
// that fail like a dropped network; left after a cheap re-check of the relay.
let offline = false;
let recheck = null;
const lostRuns = new Set(); // sessions whose turn the network cut off
const OFFLINE = 'Offline: the model is unreachable. Files, the editor, archives and run keep working; sending comes back when the network does.';
const LOCAL_OFFLINE = 'Offline: BayLeaf Sealed is unreachable. Transformers.js keeps working; it needs no network.';
const LOCALHOST_OFFLINE = 'Offline: BayLeaf Sealed is unreachable. Localhost keeps working: your server is on this computer.';
function isNetworkError(msg) { return /failed to fetch|networkerror|network ?error|load failed|connection (error|lost)|ERR_INTERNET|ERR_NETWORK|fetch failed/i.test(msg ?? ''); }
function goOffline() {
  const was = offline;
  offline = true; verified = false; client = null;
  setBadge('offline', 'Offline: the model is unreachable');
  status(localPicked() ? LOCAL_OFFLINE : localhostPicked() ? LOCALHOST_OFFLINE : OFFLINE, 'offline');
  $('input').placeholder = offSealedPicked() ? PLACEHOLDER : 'Offline: keep typing; Send comes back with the network';
  // A turn waiting on a dead stream would otherwise hang until the socket times out.
  // Transformers.js and Localhost turns need no network beyond this computer.
  for (const sid of sessions.running) { if (localRuns.has(sid) || lhRuns.has(sid)) continue; lostRuns.add(sid); agent?.abort(sid).catch(() => {}); }
  if (!was) { clearInterval(recheck); recheck = setInterval(probe, 15_000); }
  updateSend(); scheduleRender();
}
// Can the relay be reached at all? The model list is small and unauthenticated.
async function probe() {
  if (!navigator.onLine) return false;
  try { await fetch(SEALED + '/models', { cache: 'no-store', signal: AbortSignal.timeout(8000) }); }
  catch { return false; }
  if (offline) backOnline();
  return true;
}
async function backOnline() {
  offline = false; clearInterval(recheck); recheck = null;
  $('input').placeholder = PLACEHOLDER;
  status('Back online: verifying the enclave again.');
  if (!models.length) await loadModels();
  await connect(); // re-verifies; sets badge, status and Send
  usage.refresh();
}
addEventListener('offline', goOffline);
addEventListener('online', () => { probe(); });
// The shield in the top bar: its color is the verification state; it opens Trust.
function setBadge(state, text) {
  const b = $('badge');
  b.className = 'icon ' + state;
  b.ariaLabel = text; b.title = text + '. Click for what BayLeaf can see.';
  b.querySelector('use').setAttribute('href', state === 'ok' ? '#i-shield-check' : state === 'bad' ? '#i-shield-alert' : '#i-shield');
  // The composer's shield shows the same state; it opens the provider popover.
  $('shield-btn').querySelector('use').setAttribute('href', b.querySelector('use').getAttribute('href'));
  $('shield-btn').className = 'icon ' + state;
  composer?.refreshShield();
}
$('badge').onclick = () => layout.toggle('trust');

async function loadModels() {
  try {
    const data = (await (await fetch(SEALED + '/models')).json()).data ?? [];
    // Chat models that can call tools. Tinfoil's tool-like entries (websearch,
    // doc-upload, pii-filter) stay out until their data paths are reviewed.
    models = data
      .filter((m) => m.tool_calling && m.endpoints?.includes('/v1/chat/completions'))
      .filter((m) => !/safeguard|websearch|doc-upload|pii-filter/i.test(m.id))
      .map((m) => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.context_window ?? 131072, windowReported: m.context_window != null, reasoning: !!m.reasoning, multimodal: m.multimodal === true,
        cost: m.pricing && { input: m.pricing.inputTokenPricePer1M ?? 0, output: m.pricing.outputTokenPricePer1M ?? 0, cacheRead: 0 } }));
  } catch (e) {
    status('Could not load the BayLeaf Sealed model list: ' + e.message, 'bad');
  }
  const saved = (await store.getSetting('model')) ?? 'glm-5-3';
  // Transformers.js is never the default: without a BayLeaf Sealed list, a placeholder holds the place.
  // The picker groups models by provider (LANGUAGE.md), each named specifically.
  const none = !models.length && saved !== LOCAL_ID ? [Object.assign(new Option('Model list unavailable', '', true, true), { disabled: true })] : [];
  const group = (label, opts) => (opts.length ? [el('optgroup', { label }, ...opts)] : []);
  $('model').replaceChildren(...group('BayLeaf Sealed', [...none, ...models.map((m) => new Option(m.name + (m.multimodal ? ' · images' : ''), m.id, false, m.id === saved))]), ...group('Transformers.js', localOption(saved)), ...group('Localhost', localhostOptions(saved)));
  agent?.setModels?.(models);
  pickerProvider();
}
let lastPick = null;
$('model').onfocus = () => { lastPick = $('model').value; };
$('model').onchange = async () => {
  // Switching providers is always this explicit choice; Pouch never switches by itself.
  if (localPicked() && !(await ensureLocal())) { $('model').value = lastPick ?? models[0]?.id ?? ''; pickerProvider(); return; }
  await store.setSetting('model', $('model').value);
  if (!localPicked()) await store.setSetting('sealedModel', $('model').value);
  pickerProvider(); updateSend();
  status(localPicked() ? 'Transformers.js selected for your next user turn: the model runs in this browser and nothing is sent.'
    : localhostPicked() ? 'Localhost selected for your next user turn: your server on this computer runs it. No allowance is used.' : 'Model selected for your next user turn. Running work is unchanged.');
};

// ── Transformers.js provider (src/local/): a model in this browser, chosen explicitly
// The picker offers it when this build carries it and WebGPU works; otherwise
// it is listed disabled with the reason. Nothing is downloaded without asking.
let localOk = { ok: false, reason: '' };
const localRuns = new Set(); // sessions whose current turn runs on Transformers.js
const LOCAL_ID = LOCAL && 'local:' + LOCAL.id;
const localPicked = () => isLocal($('model').value);
const canSend = () => !!agent && (offSealedPicked() || (verified && !offline));
const mib = (n) => `${(n / 2 ** 20).toLocaleString(undefined, { maximumFractionDigits: 0 })} MB`;
// A saved choice of Transformers.js stays selected even when unavailable (a phone,
// a weak adapter): Send then refuses with the reason (ensureLocal) instead of
// quietly sending the message to Sealed.
function localOption(saved) {
  if (!LOCAL) return [];
  const o = new Option(localOk.ok ? `${LOCAL.label} (in this browser)` : `${LOCAL.label} (unavailable: ${localOk.reason})`, LOCAL_ID, false, saved === LOCAL_ID);
  o.disabled = !localOk.ok;
  o.title = localOk.ok ? 'Runs in this browser on your GPU. Nothing is sent.' : localOk.reason;
  return [o];
}
function pickerProvider() {
  const local = localPicked(), lhost = localhostPicked(), label = $('model').closest('.provider-model');
  label.dataset.sealedTitle ??= label.title; // the page's own wording, kept from the first call
  label.querySelector('use').setAttribute('href', local ? '#i-chip' : lhost ? '#i-laptop' : '#i-lock');
  // Providers keep fixed theme colors (continuity): no two providers share one.
  label.classList.toggle('provider-tjs', local);
  label.classList.toggle('provider-localhost', lhost);
  label.title = local ? 'Transformers.js: runs in this browser, nothing is sent.' : lhost ? 'Localhost: your server on this computer runs the model. The model applies to your next user turn.' : label.dataset.sealedTitle;
  $('shield-btn')?.classList.toggle('provider-tjs', local);
  $('shield-btn')?.classList.toggle('provider-localhost', lhost);
  if (offline) $('input').placeholder = local || lhost ? PLACEHOLDER : 'Offline: keep typing; Send comes back with the network';
  label.title = local ? 'Transformers.js: the model runs in this browser; nothing is sent. The model applies when you next send.' : 'BayLeaf Sealed: requests are encrypted to the enclave. The model applies when you next send; running work keeps its model.';
  composer?.refreshShield();
}
// Downloading is a choice (about 1.1 GB): the same approval sheet and /task
// download as `models get` (src/models-cli.js); progress shows in the status
// line and Settings, and Stop writes the download's /task ctl.
let localLoading = null;
async function ensureLocal() {
  if (!localOk.ok) { status(`Transformers.js is not available: ${localOk.reason}`, 'bad'); return false; }
  if (localEngine.loaded()) return true;
  const st = await localStored();
  if (!st.complete) {
    if (!navigator.onLine) { status('The Transformers.js model is not in this browser yet, and you are offline. Settings can load a saved copy from a folder.', 'bad'); return false; }
    let r;
    try { r = await modelService.get(LOCAL.id, { by: 'user', via: 'Settings' }); }
    catch (e) { status(e.code === 'EDENIED' ? 'Not downloaded.' : 'Transformers.js model: ' + e.message, e.code === 'EDENIED' ? '' : 'bad'); return false; }
    if (!r.already) {
      renderLocalSettings();
      try { await r.promise; }
      catch (e) { status(e.name === 'AbortError' ? `Download stopped at ${mib((await localStored()).bytes)}; Download resumes where it stopped.` : 'Transformers.js model: ' + e.message, e.name === 'AbortError' ? '' : 'bad'); renderLocalSettings(); return false; }
    }
  }
  return startLocal();
}
function startLocal() {
  const box = $('local-settings');
  box.dataset.state = 'loading';
  localLoading ??= localEngine.start({ onProgress: localProgress, network: navigator.onLine })
    .then(() => { box.dataset.state = 'ready'; status(`${LOCAL.label} is ready in this browser (Transformers.js).`); return true; },
      (e) => { box.dataset.state = 'error'; box.dataset.error = e.message; status('Transformers.js model: ' + e.message, 'bad'); return false; })
    .finally(() => { localLoading = null; renderLocalSettings(); });
  return localLoading;
}
let progressAt = 0;
function localProgress(p) {
  if (p.phase !== 'loading' && p.done < p.total && Date.now() - progressAt < 150) return; // a few updates a second
  progressAt = Date.now();
  const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
  const text = p.phase === 'loading' ? `Transformers.js: verified ${mib(p.total)}; starting the model on your GPU...`
    : p.phase === 'runtime' ? `Transformers.js: ${p.fetched || p.repaired ? 'fetching and checking' : 'checking'} the runtime, ${mib(p.done)} of ${mib(p.total)} (${pct}%)`
    : `Transformers.js: ${p.downloading ? 'downloading from api.bayleaf.dev and checking' : p.fetched || p.repaired ? 'downloading and checking' : 'checking'} ${mib(p.done)} of ${mib(p.total)} (${pct}%)${p.repaired ? `, ${p.repaired} damaged chunk${p.repaired > 1 ? 's' : ''} fetched again` : ''}`;
  status(text);
  const bar = $('local-progress');
  if (bar) { bar.hidden = false; bar.max = p.total || 1; bar.value = p.done; }
}
// A reason to suggest Sealed (never a switch): shown under the composer for the session that ran.
const hints = new Map(); // sid -> Set of kinds
function showHint(kind) {
  const sid = [...localRuns].at(-1);
  if (sid == null) return;
  (hints.get(sid) ?? hints.set(sid, new Set()).get(sid)).add(kind);
  renderHint();
}
function clearHint(sid) { hints.delete(String(sid)); renderHint(); }
function renderHint() {
  const box = $('local-hint'), kinds = [...(hints.get(String(sessions.current?.id)) ?? [])];
  box.hidden = !kinds.length;
  if (!kinds.length) return;
  $('local-hint-text').textContent = kinds.map((k) => HINTS[k]).join(' ') + ' BayLeaf Sealed (a larger model, encrypted to the enclave) may do better.';
}
$('local-hint-switch').onclick = async () => {
  const to = (await store.getSetting('sealedModel')) ?? models[0]?.id;
  if (!to || !models.some((m) => m.id === to)) return status('No BayLeaf Sealed model is available right now.', 'bad');
  $('model').value = to; await store.setSetting('model', to); pickerProvider(); updateSend();
  clearHint(sessions.current?.id);
  status(`Switched the picker to BayLeaf Sealed (${modelName(to)}) for your next message. Nothing was sent.`);
};
$('local-hint-dismiss').onclick = () => clearHint(sessions.current?.id);
async function renderLocalSettings() {
  const box = $('local-settings');
  if (!box) return;
  if (!LOCAL) { $('local-state').textContent = 'This build of Pouch does not include the Transformers.js model.'; box.querySelectorAll('button').forEach((b) => { b.hidden = true; }); return; }
  const st = await localStored();
  $('local-state').textContent = !localOk.ok ? `Not available here: ${localOk.reason}${st.bytes ? ` A downloaded copy (${mib(st.bytes)}) is kept in this browser; Remove frees the space.` : ''}`
    : st.complete ? `${LOCAL.label} is kept in this browser (${mib(st.bytes)}${st.persistent ? '' : ', for this page load only'}). It works offline.`
    : st.bytes ? `${mib(st.bytes)} of ${mib(st.total)} downloaded.` : `Not downloaded (about ${mib(LOCAL.bytes)}).`;
  const dl = modelService.downloads.get(LOCAL.id);
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
$('local-stop').onclick = () => { const t = modelService.downloads.get(LOCAL.id); if (t?.status === 'running') ctl(`/task/${t.id}/ctl`, 'stop').catch((e) => status(e.message, 'bad')); };
$('local-remove').onclick = async () => {
  if (localRuns.size) return status('Stop the Transformers.js turn before removing the model.', 'bad');
  if (!(await ask('Remove the Transformers.js model from this browser? Sessions and files stay. Downloading it again takes about 1.1 GB.', 'Remove', 'danger'))) return;
  await localRemove(); // the same store code as `models remove` (src/models.js)
  if (localPicked()) { $('model').value = (await store.getSetting('sealedModel')) ?? models[0]?.id ?? ''; await store.setSetting('model', $('model').value); pickerProvider(); updateSend(); }
  const est = await navigator.storage?.estimate?.().catch(() => null);
  status(`Transformers.js model removed.${est ? ` This site now uses ${mib(est.usage)} of storage.` : ''}`);
  renderLocalSettings();
};
for (const id of ['local-folder', 'local-files']) {
  $(id + '-btn').onclick = () => $(id).click();
  $(id).onchange = async () => {
    const files = $(id).files;
    if (!files?.length) return;
    status('Checking the picked files against this page\'s pins...');
    try {
      const r = await localImport(files);
      $(id).value = '';
      status(r.complete ? `Transformers.js model loaded from your files (${r.added} files verified${r.bad ? `, ${r.bad} refused` : ''}).`
        : `${r.added} files verified${r.bad ? `, refused (wrong bytes): ${r.refused.join(', ') || r.bad}` : ''}; ${mib(r.total - r.bytes)} still missing.`, r.bad ? 'bad' : '');
    } catch (e) { status(e.message, 'bad'); }
    renderLocalSettings();
  };
}

// ── Localhost provider (src/localhost.js): a model server on this computer
// Set up only here, by the user: an address on loopback, an optional key (kept in
// this browser's IndexedDB like the BayLeaf key, shown masked, removable; Erase all
// removes it), and the transport. Test connection checks reachability, CORS, the
// key, the model list and the transport, without generating anything.
let lh = null; // { base, key, transport, detected, models: [{ id, contextWindow }], testedAt }
const lhRuns = new Set(); // sessions whose current turn runs on Localhost
const localhostPicked = () => isLocalhost($('model').value);
const offSealed = (id) => isLocal(id) || isLocalhost(id);
const offSealedPicked = () => offSealed($('model').value);
const lhModels = () => lh?.models ?? [];
const lhAgentConfig = () => (lh?.base && lh.models?.length ? { base: lh.base, key: lh.key || '', transport: lh.transport, models: lh.models } : null);
function localhostOptions(saved) {
  return lhModels().map((m) => {
    const o = new Option(`${m.id} (your machine)`, 'localhost:' + m.id, false, saved === 'localhost:' + m.id);
    o.title = `Runs on your server at ${lh.base}. Pouch sends it this session's messages and the files the model reads.`;
    return o;
  });
}
async function saveLocalhost(next) {
  lh = next;
  await store.setSetting('localhost', lh ?? undefined);
  agent?.setLocalhost?.(lhAgentConfig());
  await loadModels();
  renderLocalhostSettings();
}
const mask = (k) => (k.length <= 8 ? '•'.repeat(k.length) : `${k.slice(0, 3)}${'•'.repeat(6)}${k.slice(-4)}`);
function renderLocalhostSettings(result) {
  if (!$('lh-settings')) return;
  if (document.activeElement !== $('lh-url')) $('lh-url').value = lh?.base ?? $('lh-url').value ?? '';
  if (!$('lh-url').value) $('lh-url').placeholder = DEFAULT_URL;
  $('lh-transport').value = lh?.transportChoice ?? 'auto';
  $('lh-key').value = '';
  $('lh-key').placeholder = lh?.key ? `saved: ${mask(lh.key)} (type to replace)` : 'only if your server asks for one';
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
function fixFor(r) {
  if (r.kind === 'cors') return `To fix: allow the origin ${location.origin} on your server, restart it, then press Test connection again. Pouch cannot do this for you: your server decides who may call it.`;
  if (r.kind === 'lna') return 'To fix: allow this site to reach devices on your local network (Chrome asks once; the site settings let you change your answer), then test again.';
  if (r.kind === 'unreachable') return 'To fix: start your server and check the port. Pouch only tries the address above.';
  if (r.kind === 'auth') return 'To fix: copy the API key from your server\'s settings into the key field.';
  return '';
}
$('lh-test').onclick = async () => {
  const url = $('lh-url').value.trim() || DEFAULT_URL;
  const parsed = parseLocalhostUrl(url);
  const typedKey = $('lh-key').value.trim();
  const key = typedKey || (lh && parsed.ok && parsed.base === lh.base ? lh.key : '') || '';
  const choice = $('lh-transport').value;
  $('lh-test').disabled = true;
  $('lh-steps').replaceChildren(el('li', { className: 'ok', textContent: 'Testing...' }));
  try {
    const r = await testConnection({ url, key, transport: choice });
    if (r.ok) {
      await saveLocalhost({ base: r.base, key, transport: r.transport, transportChoice: choice, detected: r.detected, models: r.models, testedAt: Date.now() });
      status(`Localhost is set up: ${r.models.length} model${r.models.length === 1 ? '' : 's'} in the picker under Localhost.`);
    }
    renderLocalhostSettings(r);
    if (!r.ok) status('Localhost test failed: ' + r.error, 'bad');
  } finally { $('lh-test').disabled = false; }
};
$('lh-key-remove').onclick = async () => {
  if (!lh?.key) return;
  if (!(await ask('Remove the Localhost API key from this browser? Your server keeps its own copy; Pouch will send no key until you add one again.', 'Remove key', 'danger', 'Remove key?'))) return;
  await saveLocalhost({ ...lh, key: '' });
  status('Localhost key removed from this browser.');
};
$('lh-forget').onclick = async () => {
  if (lhRuns.size) return status('Stop the Localhost turn before removing Localhost.', 'bad');
  if (!(await ask('Remove Localhost from this browser: its address, key and model list? Sessions stay; picking a Localhost model again needs a new Test connection.', 'Remove', 'danger', 'Remove Localhost?'))) return;
  const was = localhostPicked();
  await saveLocalhost(null);
  $('lh-steps').replaceChildren(); $('lh-url').value = '';
  if (was) { $('model').value = (await store.getSetting('sealedModel')) ?? models[0]?.id ?? ''; await store.setSetting('model', $('model').value); pickerProvider(); updateSend(); }
  status('Localhost removed from this browser.' + (was ? ' The picker is back on a BayLeaf Sealed model.' : ''));
};
// A long wait for the first token is usually the server loading the model.
let lhWaitShown = false;
function localhostWait(kind, model) {
  if (kind === 'slow') { lhWaitShown = true; status(`Waiting for your server: it may be loading ${model.id.slice('localhost:'.length)} (the first use after a while can take a minute).`); }
  else if (lhWaitShown) { lhWaitShown = false; status(''); }
}

// ── Device claim (RFC 8628 shape). One poll loop, its own controller. ─
async function claim() {
  const r = await fetch(API + '/auth/claim/initiate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'BayLeaf Pouch' }),
  });
  if (!r.ok) return status('Could not start sign-in (HTTP ' + r.status + ').', 'bad');
  const c = await r.json();
  $('claim-code').textContent = c.user_code;
  $('claim-url').textContent = c.claim_url;
  $('claim-state').textContent = 'Waiting for approval...'; $('claim-state').className = 'pending';
  $('claim').showModal();
  window.open(c.claim_url, '_blank', 'noopener');
  const stop = new AbortController();
  $('claim-cancel').onclick = () => { stop.abort(); $('claim').close(); };
  const deadline = Date.now() + c.expires_in * 1000;
  while (!stop.signal.aborted && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, (c.poll_interval || 3) * 1000));
    if (stop.signal.aborted) return;
    let p;
    try { p = await fetch(API + '/auth/claim/poll?d=' + encodeURIComponent(c.device_code), { signal: stop.signal }); }
    catch { continue; } // transient network error: keep polling
    if (p.status === 202) continue;
    const body = await p.json().catch(() => ({}));
    if (p.status === 200 && body.key) {
      // The poll is one-shot: the server deletes the claim as it answers.
      $('claim').close(); await useKey(body.key);
      return;
    }
    $('claim-state').textContent = body.status === 'denied' ? 'Denied.' : 'This code expired. Close and try again.';
    $('claim-state').className = 'bad';
    return;
  }
}
function renderAuth() {
  const b = $('auth');
  b.ariaLabel = key ? 'Forget key' : 'Sign in';
  b.title = key ? 'Signed in with your BayLeaf key. Click to forget it in this browser.' : 'Sign in (without a key, Campus Pass works on the UCSC network)';
  b.classList.toggle('on', !!key);
}
// Not signed in: what Campus Pass can do from here (the check says whether
// this network is on campus; unknown until it answers).
function campusLine(st) {
  if (st.mode === 'campus' && st.offCampus) return 'Not signed in, and this network is off campus, where Campus Pass does not work: sign in to send.';
  if (st.mode === 'campus' && st.remaining != null) return `Not signed in: using Campus Pass on this campus network (about ${st.remaining} of ${st.limit} shared requests left today).`;
  return 'Not signed in: using Campus Pass, which works only on the UCSC network.';
}
async function useKey(k) {
  key = k; await store.setSetting('key', key); renderAuth(); usage.refresh(); await connect();
}
// BayLeaf's verdict on a key before it is kept: true, or the reason it is not.
async function checkKey(k) {
  try {
    const r = await fetch(API + '/usage', { headers: { Authorization: 'Bearer ' + k } });
    if (r.status === 401 || r.status === 403) return `BayLeaf rejected this key (HTTP ${r.status}): it may be mistyped, revoked or expired. Get a new one at api.bayleaf.dev.`;
    return true; // other failures are not about the key: keep it, as before
  } catch { return true; } // offline: keep it; requests will say if it is wrong
}
// The sign-in sheet's inline key field (no native prompt): paste, Save, and an
// inline reason when the key is refused.
function keyForm() {
  const input = el('input', { type: 'password', id: 'key-input', className: 'key-input', placeholder: 'sk-bayleaf-...', autocomplete: 'off', spellcheck: false });
  const why = el('p', { id: 'key-why', className: 'key-why', role: 'status' });
  const save = el('button', { type: 'submit', className: 'primary', textContent: 'Save key' });
  const form = el('form', { className: 'key-form' },
    el('label', { htmlFor: 'key-input', textContent: 'Paste a key you already have (kept only in this browser), or approve below' }), el('div', { className: 'key-row' }, input, save), why);
  input.onpaste = (e) => { const k = extractKey(e.clipboardData?.getData('text')); if (k) { e.preventDefault(); input.value = k; why.textContent = ''; } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const k = extractKey(input.value);
    if (!k) { why.textContent = input.value.trim() ? 'That does not contain an sk-bayleaf- key: it starts with sk-bayleaf- followed by letters, digits, - or _.' : 'Paste your key first.'; why.className = 'key-why bad'; input.focus(); return; }
    save.disabled = true; why.className = 'key-why'; why.textContent = 'Checking the key with BayLeaf...';
    // A check in flight keeps the sheet open (src/dismiss.js): it would sign in after it closed.
    $('sheet').dataset.busy = 'Checking the key with BayLeaf: this closes by itself once it answers.';
    const ok = await checkKey(k).finally(() => delete $('sheet').dataset.busy);
    if (ok !== true) { why.textContent = ok; why.className = 'key-why bad'; save.disabled = false; input.focus(); return; }
    $('sheet').close(); await useKey(k);
  };
  return form;
}
$('auth').onclick = async () => {
  if (!key) { sheet('Sign in to BayLeaf', [['Approve on a device where you are signed in (recommended)', claim]], keyForm()); return; }
  if (!(await ask('Remove your BayLeaf key from this browser? Files and sessions stay.', 'Remove key', 'danger'))) return;
  key = null; await store.setSetting('key', undefined); renderAuth(); usage.refresh(); connect();
};

// ── Erase everything ────────────────────────────────────────────────
async function eraseAll() {
  if (!(await ask('Erase ALL Pouch data in this browser: files in /work, /pouch, sessions, your key and folder permissions? Folders you mounted from this device are not touched. This cannot be undone. (To keep /work, press Cancel, then Download all.)', 'Erase all', 'danger', 'Erase all?'))) return;
  status('Erasing...');
  try { await agent?.close(); } catch {}
  agent = null;
  await localEngine.dispose().catch(() => {});
  await shellCopy.uninstall({ remember: false }).catch(() => {}); // the next visit keeps a fresh copy
  await store.eraseEverything(); // includes the Local model's and the offline copy's Cache Storage
  location.hash = 'erased'; // the reloaded page says it worked (L1)
  location.reload();
}
$('erase').onclick = eraseAll;
// Phones: the bottom bar has no room for Trust and Erase all, so More holds them.
$('more').onclick = () => sheet('More', [
  ['Settings', () => layout.open('settings')],
  ['What can BayLeaf see?', () => layout.open('trust')],
  ['Download all of /work as .zip', () => $('download-all').click()],
  ['Erase all Pouch data in this browser', eraseAll, 'danger'],
]);

// ── Offline copy and updates (offline.js, sw.js) ──────────────────────
// The hosted page keeps a hash-checked copy of itself; it changes only on Update.
const SW_EXPECTED = typeof SW_SHA256 !== 'undefined' ? SW_SHA256 : null; // eslint-disable-line no-undef (build.mjs define)
const shellCopy = createOffline({ swSha256: SW_EXPECTED });
async function renderCopy(note, cls = '') {
  const f = $('copy-facts');
  const row = (label, value, c = '') => f.append(el('dt', { textContent: label }), el('dd', { textContent: value, className: c }));
  const pinned = await shellCopy.pinned().catch(() => null);
  const st = shellCopy.state;
  f.replaceChildren();
  row('Running from', location.protocol === 'file:' ? 'a file on this device' : shellCopy.servedOffline() ? 'the offline copy in this browser' : 'the network');
  row('Offline copy', !shellCopy.supported ? 'not available here (no service worker)' : pinned ? 'sha256 ' + short(pinned) : shellCopy.enabled() ? 'not kept yet' : 'uninstalled', pinned ? 'ok' : '');
  if (pinned) f.lastChild.prepend(swatch(pinned));
  if (shellCopy.supported) {
    row('Published', st.published ? `sha256 ${short(st.published)} (checked ${st.checkedAt.toLocaleTimeString()})` : st.error ? 'not checked: ' + st.error : 'not checked yet',
      st.published && pinned ? (st.published === pinned ? 'ok' : 'pending') : '');
    if (st.published) f.lastChild.prepend(swatch(st.published));
    const m = await shellCopy.swMatches();
    row('Service worker', m == null ? 'could not check sw.js' : m ? `sw.js matches this build (${short(SW_EXPECTED)})` : `sw.js differs from this build: expected ${short(SW_EXPECTED)}, served ${short(st.swScript)}`, m == null ? '' : m ? 'ok' : 'bad');
  }
  row('Installed', shellCopy.installed() ? 'yes: running as an app' : 'no: in a browser tab');
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  row('Storage', persisted ? 'persistent: the browser keeps it until you erase it' : 'best effort: the browser may clear it when space is low', persisted ? 'ok' : 'pending');
  $('copy-check').hidden = !shellCopy.supported || !pinned;
  $('copy-keep').hidden = !shellCopy.supported || !!pinned || shellCopy.enabled();
  $('copy-remove').hidden = !pinned;
  $('copy-install').hidden = !shellCopy.state.installPrompt || shellCopy.installed();
  if (note !== undefined) { $('copy-note').textContent = note; $('copy-note').className = cls; }
}
// Build identity (continuity): a swatch from the first byte of the page's
// sha256, so the same build always shows the same color and a new one a
// visibly different one. The hash beside it stays the authority.
function swatch(hash) {
  const n = parseInt(String(hash).slice(0, 2), 16);
  const s = el('span', { className: 'build-swatch', role: 'img', ariaLabel: `build color ${n}`, title: `Build color from sha256 ${short(hash)}` });
  s.style.setProperty('--seed', String(Number.isFinite(n) ? n : 0));
  return s;
}
async function checkUpdate(manual) {
  const r = await shellCopy.check();
  if (r.update) {
    $('update-swatches')?.replaceChildren(swatch(r.pinned), ' to ', swatch(r.published));
    $('update-text').textContent = `Update available. This copy is sha256 ${short(r.pinned)}; the published build is sha256 ${short(r.published)}. Nothing changes until you press Update, which checks the new files against SHA256SUMS first.`;
    $('update').hidden = false;
  } else $('update').hidden = true;
  if (manual) renderCopy(shellCopy.state.error ? 'Could not check: ' + shellCopy.state.error : r.update ? 'An update is available (see the notice above the chat).' : 'This copy is the published build.', shellCopy.state.error ? 'bad' : '');
  else if (layout.current() === 'trust') renderCopy();
}
async function applyUpdate() {
  const btn = $('update-go'); btn.disabled = true;
  const was = await shellCopy.pinned();
  try {
    await shellCopy.update();
    location.reload();
  } catch (e) {
    const msg = `Update refused: ${e.message}. Still running sha256 ${short(was)}; nothing was changed.`;
    $('update-text').textContent = msg; $('update').classList.add('bad');
    status(msg, 'bad'); renderCopy(msg, 'bad');
  } finally { btn.disabled = false; }
}
$('update-go').onclick = applyUpdate;
$('update-later').onclick = () => { $('update').hidden = true; };
$('copy-check').onclick = () => checkUpdate(true);
$('copy-remove').onclick = async () => {
  if (!(await ask('Uninstall the offline copy? Pouch then loads from the network each time (and not without it). Files and sessions stay.', 'Uninstall', 'danger'))) return;
  await shellCopy.uninstall();
  renderCopy('Offline copy removed. This tab keeps running; reloading loads the published build from the network.');
};
$('copy-keep').onclick = async () => {
  try { await shellCopy.keep(); renderCopy('Offline copy kept.'); } catch (e) { renderCopy('Could not keep a copy: ' + e.message, 'bad'); }
};
$('copy-install').onclick = async () => { const p = shellCopy.state.installPrompt; shellCopy.state.installPrompt = null; await p?.prompt(); renderCopy(); };
$('settings-copy').onclick = () => layout.open('trust');
// An installed app: ask once more for persistent storage (files, sessions, the Local model).
addEventListener('appinstalled', () => { navigator.storage.persist?.().catch(() => {}); renderCopy(); });

// ── Sessions (sessions.js) ──────────────────────────────────────────
// focus: the subagent of the current session whose view fills the chat pane
// (its live transcript; the composer steers it), or null for the session.
let focus = null; // { sid, id }
const sessions = createSessions({
  forgetWatches: (id) => watches.removeSession(id),
  agent: () => agent, view: () => view, connected: () => (agent && verified ? client : null),
  model: () => $('model').value, setModel: (id) => { $('model').value = id; pickerProvider(); }, hasModel: (id) => models.some((m) => m.id === id) || (localOk.ok && id === LOCAL_ID) || lhModels().some((m) => 'localhost:' + m.id === id), isLocal: offSealed,
  attach: () => attach(), status, ask, sheet, countRequest: (id, kind) => ledger.add(id, kind).then(meter), layout, usage, quotaError, exhaustedText,
  agentError: () => agentError,
  runningChildren: (sid) => (kids.get(String(sid)) ?? []).filter((c) => c.status === 'running').length,
  // Nested rows (steer journey S1): running children of any session, and
  // every child of the current one, newest first, at most five.
  children: (sid) => {
    const l = kids.get(String(sid)) ?? [], cur = sameId(sid, sessions.current?.id);
    return l.filter((c) => c.status === 'running' || cur).slice(-5).reverse()
      .map((c) => ({ id: c.id, ref: c.ref, name: c.name, task: c.task, state: childState(sid, c), msgs: msgCount(c), edges: edgeText(l, c), open: sameId(focus?.sid, sid) && focus?.id === c.id }));
  },
  openChild: (sid, id, from) => openChild(sid, id, from),
  onRender: (list) => { if (layout.current() === 'usage') renderUsagePanel(list); },
  grants: async (id) => (await grantsFor(id)).map((service) => ({ service, label: serviceName(service) })),
  revoke,
  // While a revert of this session can be undone (D12).
  extraActions: async (s) => {
    const t = await store.getSetting(revertKey(s.id));
    return t ? [[`Undo revert to ${shortTime(t.at)}`, () => undoRevert(s.id)]] : [];
  },
});

// ── Leaving the pouch (egress.js, D10) ──────────────────────────────
// The bayleaf command asks before every request; a run belongs to the
// session it was sent from, even if you switch away meanwhile.
// The session whose run is active (a turn, a resumed run or Run script), if any.
let activeRun = null;
const runSession = () => activeRun ?? (sessions.current ? String(sessions.current.id) : null);
const egress = createEgress({ sessionTitle: async (sid) => titleOf(await sessions.find(sid)), onPending: () => { composer?.renderTray(); sessions.render(); }, onGrant: () => composer?.refreshShield() });
// Running bash card id -> { commands, audiences }, until its output carries the marker.
const liveEgress = new Map();
function noteEgress(e) {
  if (!sameId(runSession(), sessions.current?.id)) return; // shown from the marker when you switch back
  const t = view?.items.findLast?.((i) => i.type === 'tool' && i.name === 'bash' && i.status === 'running');
  if (!t) return;
  const prev = liveEgress.get(t.id) ?? { commands: [], audiences: [] };
  liveEgress.set(t.id, {
    commands: [...new Set([...prev.commands, e.command.replace(/^bayleaf /, '')])],
    audiences: [...new Set([...prev.audiences, ...e.audiences])],
  });
  scheduleRender();
}
// caller: the conversation whose tool asks (agent.js); a subagent's request
// belongs to its own session and names it on the sheet.
const childOf = (caller) => {
  const w = caller == null ? null : agent?.who(caller);
  return w?.child != null ? { sid: w.sid, id: w.child, name: (kids.get(String(w.sid)) ?? []).find((c) => c.id === w.child)?.name ?? 'subagent' } : null;
};
const egressHooks = {
  bayleafCredential: () => key,
  approveEgress: (req, caller) => {
    const c = childOf(caller);
    return c ? egress.approve(req, c.sid, c.name) : egress.approve(req, runSession());
  },
  onEgress: (e, caller) => { if (!childOf(caller)) noteEgress(e); },
};

// ── Models (src/models-cli.js): weights from the BayLeaf HF gateway ─────
// One service for the `models` command (agents and the terminal) and
// Settings. Downloads ask on the approval sheet, one at a time; only a
// click approves. Each download is a /task entry with its own ctl.
const modelsWho = (caller) => {
  const w = caller == null ? null : agent?.who(caller), c = childOf(caller);
  return { by: 'agent', caller, sid: w?.sid ?? null, name: c ? `subagent "${c.name}"` : 'main (a1)' };
};
let modelAsks = Promise.resolve();
function approveModel(req, who) {
  const run = modelAsks.then(async () => {
    const asker = who.by === 'agent' ? `${who.sid != null ? `${titleOf(await sessions.find(who.sid).catch(() => null))} › ` : ''}${who.name}` : `you, in ${who.via ?? 'Pouch'}`;
    const get = req.action === 'get';
    const row = (k, v) => v ? [el('dt', { textContent: k }), el('dd', { textContent: v })] : [];
    const body = el('div', { className: 'model-approval' },
      el('p', { textContent: who.by === 'agent' ? `Asked by ${asker}. Only you can approve.` : `Asked by ${asker}.` }),
      el('dl', {}, ...row(get ? 'Size' : 'Frees', mib(req.bytes) + (get && req.bytes < req.total ? ` (of ${mib(req.total)}; the rest is already kept)` : '')),
        ...row('Kept in', req.location), ...row('License', req.license + (req.licenseUrl ? ` (${req.licenseUrl})` : '')), ...row('Attribution', req.attribution),
        ...row('Redistribution', req.distribution), ...row('From', req.origin)),
      el('p', { className: 'muted', textContent: get ? 'Every file is checked against the SHA-256 this page was built with. Nothing you type is sent; the gateway sees only which file ranges are requested. Stop any time from /task, Settings or the terminal; remove it any time.' : 'Sessions and files stay. Downloading it again takes the full size.' }));
    return ask(body, get ? 'Download' : 'Remove', get ? 'primary' : 'danger', get ? (who.by === 'agent' ? `${who.name} asks to download ${req.label}` : `Download ${req.label}?`) : `${who.name} asks to remove ${req.label}`);
  });
  modelAsks = run.catch(() => {});
  return run;
}
const modelService = createModelService({ store: modelStore, tasks: vfs.tasks, approve: approveModel,
  supports: (id) => (LOCAL && id === LOCAL.id ? localOk : { ok: true }),
  onChange: () => { const t = LOCAL && modelService.downloads.get(LOCAL.id); if (t?.status === 'running' && t.progress) localProgress({ ...t.progress, downloading: true }); renderLocalSettingsSoon(); } });
let settingsTimer = null;
const renderLocalSettingsSoon = () => { if (!settingsTimer) settingsTimer = setTimeout(() => { settingsTimer = null; renderLocalSettings(); }, 250); };

// ── Control plane (src/ns/control.js, README "Control plane") ─────────
// Everything that acts is a file under /session (agents) or /task (runs,
// terminal commands, watches). The Interface is one client: its buttons call
// ctl(), which writes those files through the user's namespace, exactly as
// the terminal's `echo stop > ...` does. What a write does is the harness
// side, below ("Control plane: the harness side"). The agent files are served
// from the same caches the Interface draws (kids, sessions.running), so the
// two cannot disagree; the Interface hears changes from the events tail.
const mainSince = new Map(); // session id -> when main's current turn started
async function agentRows(sid) {
  const k = String(sid);
  const l = kids.has(k) ? kids.get(k) : await loadKids(sid);
  const working = sessions.running.has(k);
  const state = stopping.has(k) ? 'stopping' : working ? (agent?.subagents?.blocked(sid).length ? 'waiting' : 'working') : 'idle';
  return [{ ref: MAIN, name: 'main', kind: 'main', state, since: working ? mainSince.get(k) : undefined, ns: vfs.describe() },
    ...l.map((c) => ({ ref: refOf(l, c), name: c.name, kind: 'subagent', state: c.status, since: c.resumed ?? c.started, ended: c.status === 'running' ? undefined : c.ended, task: c.task,
      ns: describeSpecs(vfs, c.ns?.length ? c.ns : defaultSubagentNs(vfs)) }))];
}
const changes = createChanges(); // what the agents changed this turn, per session
const control = createControl({
  sessions: async () => (await sessions.all()).map((x) => ({ id: x.id, title: titleOf(x) })),
  current: () => sessions.current?.id ?? null,
  agents: agentRows,
  last: async (sid, ref) => {
    if (asRef(ref) === MAIN) return (await agent?.snapshot(sid).catch(() => null))?.items.findLast((i) => i.type === 'assistant' && i.text)?.text ?? '';
    const l = kids.get(String(sid)) ?? [], c = l.find((x) => refOf(l, x) === ref);
    return c && agent?.subagents ? (await agent.subagents.summary(sid, c.id).catch(() => null))?.answer ?? '' : '';
  },
  // /session/<sid>/usage: the allowance, this turn's requests (spend) and today's (the ledger).
  usage: async (sid) => ({ allowance: usage.state, turn: spend.get(String(sid)) ?? 0, today: (await ledger.snapshot().catch(() => null))?.bySid?.[String(sid)] ?? 0 }),
  changes: (sid) => changes.list(sid),
});
// The user's namespace: the shared tree plus /session with the user's authority.
const userNs = over(vfs.fs, [['/session', control.view({ by: 'user' }), { label: 'control (you)' }]]);
// Every acting control in the Interface goes through here (test/controlplane-node.mjs).
const ctl = (path, text) => userNs.writeFile(path, text);
const agentFile = (sid, ref, file) => `/session/${sid}/agents/${asRef(ref)}/${file}`;
// Main sees its own session's control files, ctl writable, in refused (control.js).
const mainNs = new Map(); // sid -> namespace
function mainNamespace(sid, base) {
  if (sid == null) return base;
  // /task too is cut to this session: its runs, subagents and watches (src/ns/tasks.js).
  if (!mainNs.has(String(sid))) mainNs.set(String(sid), over(base, [['/session', control.view({ by: 'agent', sid }), { label: 'control (a1)' }],
    ['/task', new TaskFs(vfs.tasks, () => vfs.watches, { sid }), { label: 'tasks (this session)' }]]));
  return mainNs.get(String(sid));
}
{ // main's working/idle state, for /session and its events
  const r = sessions.running, add = r.add.bind(r), del = r.delete.bind(r);
  r.add = (k) => { const had = r.has(k); add(k); if (!had) { mainSince.set(k, Date.now()); control.state(k, MAIN, 'working'); } return r; };
  r.delete = (k) => { const had = del(k); if (had) control.state(k, MAIN, 'idle'); return had; };
}
// The events tail: a blocking-read loop, as any client would run it. Writes
// that came from the terminal or the main agent are said out loud here.
(async () => {
  for await (const evs of control.tail()) {
    let mine = false;
    for (const e of evs) {
      const [, sid, ref, kind, ...rest] = e.line.split(' ');
      if (!sameId(sid, sessions.current?.id)) continue;
      mine = true;
      const by = rest.join(' ').match(/by (you \(terminal\)|main \(a1\))/)?.[1];
      if (by && (kind === 'ctl' || kind === 'in')) announce(`${by === 'main (a1)' ? 'Main' : 'From the terminal'}: ${kind === 'ctl' ? rest[0] + (rest[1] === 'all' ? ' all' : '') : rest[0]} ${whoRef(ref)}.`, false);
    }
    if (mine) { composer?.renderTray(); updateSend(); sessions.render(); }
  }
})();

// ── Terminal (terminal.js) ──────────────────────────────────────────
// The user's shell over the same namespace; `bayleaf` asks every use. Ctrl+`
// opens it (or focuses it); opening it never sends anything.
const terminal = createTerminal({ vfs, fs: over(vfs.as('user'), [['/session', control.view({ by: 'user', label: 'terminal' }), { label: 'control (you)' }]]), onChange: () => renderTree(),
  hooks: { bayleafCredential: () => key, approveEgress: (req) => egress.approve(req, null, undefined, 'you, in the terminal'), models: modelService,
    openFile: ({ path, mode, interactive }) => openFile(path, undefined, { mode, interactive }), revealDir } });
document.addEventListener('keydown', (e) => {
  if (e.key !== '`' || !e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  if (layout.current() === 'terminal' && document.activeElement === $('term-input')) layout.close();
  else { layout.open('terminal'); terminal.focus(); }
});

// ── Subagents (subagents.js, D15/D16) ───────────────────────────────
// kids: session id -> its registry rows, as last changed. A report starts a
// parent run nobody sent; drive() does a send's bookkeeping for it.
const kids = new Map();
const childViews = new Map(); // child id -> normalized view (current session's children)
let childWatches = new Map(); // child id -> dispose
async function loadKids(sid) {
  if (sid == null || !agent?.subagents) return [];
  const l = await agent.subagents.list(sid);
  kids.set(String(sid), l);
  return l;
}
function watchKids() {
  const sid = sessions.current?.id;
  const want = new Set((kids.get(String(sid)) ?? []).map((c) => c.id));
  for (const [id, d] of childWatches) if (!want.has(id)) { d(); childWatches.delete(id); childViews.delete(id); }
  for (const id of want) {
    if (childWatches.has(id)) continue;
    childWatches.set(id, () => {});
    agent.subagents.watch(sid, id, (v) => { childViews.set(id, v); scheduleRender(); })
      .then((d) => { if (childWatches.has(id)) childWatches.set(id, d); else d(); }, () => childWatches.delete(id));
  }
}
function dropKidWatches() { for (const d of childWatches.values()) d(); childWatches = new Map(); childViews.clear(); }
let tick = 0;
// Subagents as /task entries (src/ns/tasks.js), so the agent and the tray read one source.
const TASK_STATE = { running: 'running', finished: 'done', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };
function onKids(sid, list) {
  kids.set(String(sid), list);
  if (childFollowUps.size) flushChildFollowUps(sid, list);
  for (const c of list) vfs.tasks.upsert('sa:' + c.id, { kind: 'subagent', sid, label: c.name, status: TASK_STATE[c.status] ?? c.status,
    ns: describeSpecs(vfs, c.ns?.length ? c.ns : defaultSubagentNs(vfs)), kill: () => stopChildOf(sid, c.id) });
  for (const c of list) control.state(sid, refOf(list, c), c.status);
  sessions.render();
  if (sameId(sid, sessions.current?.id)) { watchKids(); scheduleRender(); composer?.renderTray(); }
  if (layout.current() === 'usage') renderUsagePanel();
  // Elapsed times on running cards.
  const anyRunning = [...kids.values()].some((l) => l.some((c) => c.status === 'running'));
  if (anyRunning && !tick) tick = setInterval(() => { if (sessions.current && (kids.get(String(sessions.current.id)) ?? []).some((c) => c.status === 'running')) scheduleRender(); }, 1000);
  if (!anyRunning && tick) { clearInterval(tick); tick = 0; }
}
async function drive(sid, wait) {
  const t0 = Date.now();
  sessions.running.add(String(sid)); sessions.render();
  const mine = !activeRun;
  if (mine) activeRun = String(sid);
  try { await wait(); } catch {}
  finally {
    sessions.running.delete(String(sid));
    if (mine) activeRun = null;
  }
  const ms = Date.now() - t0;
  const v = await agent.snapshot(sid).catch(() => null);
  await recordTurn(sid, v, ms);
  await sessions.afterTurn(sid, v, true);
}
const lowAllowance = () => {
  const s = usage.state;
  if (s.remaining == null) return null;
  if (s.remaining <= 15) return `only ${s.mode === 'campus' ? 'about ' : ''}${s.remaining} requests are left today, and a subagent may use many of them; tell the user.`;
  return null;
};
// Agent graphs (G9): message counts per edge, from the registry rows.
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
const msgCount = (c) => sum(c.got) + sum(c.sent);
const refName = (l, ref) => { ref = asRef(ref); if (ref === MAIN) return `main (${MAIN})`; const c = l.find((x) => refOf(l, x) === ref); return c ? `${c.name} (${ref})` : ref; };
const byRef = (o) => Object.entries(o ?? {}).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
const edgeText = (l, c) => [...byRef(c.got).map(([r, n]) => `from ${refName(l, r)} ${n}`), ...byRef(c.sent).map(([r, n]) => `to ${refName(l, r)} ${n}`)].join(', ');
// A small to/from list, each peer in its own color (continuity: G9).
function edgeLine(l, c) {
  const entry = (dir, [r, n]) => seeded(el('li', { className: 'sa-edge' }, el('span', { className: 'sa-dot', ariaHidden: 'true' }), `${dir} ${refName(l, r)} `, el('span', { className: 'n', textContent: String(n) })), r);
  const got = byRef(c.got).map((e) => entry('from', e)), sent = byRef(c.sent).map((e) => entry('to', e));
  if (!got.length && !sent.length) return null;
  return el('div', { className: 'sa-edges', ariaLabel: 'Messages' }, el('span', { className: 'sa-edges-k', textContent: 'Messages' }),
    el('ul', {}, ...got, ...sent));
}
// Who a handle is, for pills: "chair (a2)", "main (a1)".
const whoRef = (ref) => refName(kids.get(String(sessions.current?.id)) ?? [], String(ref));
const refRange = (ids) => {
  ids = ids.map(asRef);
  const n = ids.map((x) => /^a(\d+)$/.exec(x)?.[1]).map(Number);
  if (ids.length > 2 && n.every((x, i) => x && (i === 0 || x === n[i - 1] + 1))) return `${ids[0]}-${ids.at(-1)}`;
  return ids.join(', ');
};
// The agents and subagent tools in words, not JSON (critique 9).
function agentSummary(name, a) {
  if (!a || typeof a !== 'object') return String(a ?? '');
  const ids = [].concat(a.ids ?? (a.action === 'join' ? a.id ?? [] : [])).map(String);
  const quote = (t) => t ? `: "${excerpt(t, 60)}"` : '';
  switch (a.action) {
    case 'message': { const to = [].concat(a.to ?? (ids.length ? ids : a.id ?? [])).map(String); return `message -> ${to.map(whoRef).join(', ') || '?'}${quote(a.text)}`; }
    case 'join': return `join ${refRange(ids)}`;
    case 'spawn': return `spawn ${a.mode === 'oneshot' ? 'one-shot ' : ''}${a.name ?? 'subagent'}${a.background === false ? ' (waits)' : ''}`;
    case 'list': return 'list';
    case 'stop': case 'status': return `${a.action} ${a.id ? whoRef(a.id) : ''}`.trim();
    default: return a.action ?? '';
  }
}
const fmtDur = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`; };
function messageChild(c) {
  const box = el('textarea', { className: 'sa-input', rows: 3, placeholder: `What should ${c.name} do or know?`, ariaLabel: `Message to subagent ${c.name}` });
  sheet(`Message subagent ${c.name}`, [[c.status === 'running' ? 'Send (joins its work)' : 'Send (it starts again)', async () => {
    const t = box.value.trim();
    if (!t) return;
    await ctl(agentFile(sessions.current.id, c.ref ?? refOf(kids.get(String(sessions.current.id)) ?? [], c), 'in'), 'message\n' + t).catch((e) => fail(why(e)));
  }]], el('div', {}, el('p', { textContent: c.status === 'running' ? 'It reads this after its current step. Its report will reflect it.' : 'It continues from where it ended and posts a new report.' }), box));
  setTimeout(() => box.focus(), 0);
}
// What a child is doing, in the words the session list and its view use:
// working, waiting (an approval of its is open), finished, stopped, failed, interrupted.
function childState(sid, c) {
  if (c.status === 'running') return egress.pending.some((p) => sameId(p.sid, sid) && p.agentName === c.name) ? 'waiting' : 'working';
  return c.status;
}
// The composer's text belongs to the view it was typed in: main's draft waits
// while a subagent is open, and that subagent's waits for its next opening.
const drafts = new Map();
function swapDraft(from, to) {
  const i = $('input');
  drafts.set(from, i.value);
  i.value = drafts.get(to) ?? '';
  drafts.delete(to);
  i.dispatchEvent(new Event('input', { bubbles: true }));
}
// Opening and leaving a subagent view (README "Subagent views"): the view zooms
// out of what was clicked (its card, tray row or sidebar row) and folds back
// into its card; under reduced motion the frame flashes instead.
function zoomIn(rect) {
  const log = $('log');
  if (reduced() || !rect?.width) { flash($('chat')); return; }
  const r = log.getBoundingClientRect();
  log.style.transformOrigin = '0 0';
  const a = log.animate([{ transform: `translate(${rect.left - r.left}px, ${rect.top - r.top}px) scale(${rect.width / r.width}, ${rect.height / r.height})`, opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: 'ease-out' });
  a.id = 'child-open';
  a.finished.catch(() => {}).finally(() => { log.style.transformOrigin = ''; });
}
function flash(node) {
  if (!node) return;
  node.classList.add('still-mark');
  setTimeout(() => node.classList.remove('still-mark'), 900);
}
// Open a subagent's own view (S2): select its parent session first if needed.
// from: what was clicked, the motion's origin (default: its card in the log).
async function openChild(sid, id, from = null) {
  const card = () => $('log').querySelector(`.subagent[data-child="${CSS.escape(String(id))}"]`);
  const origin = (from?.isConnected && from.getClientRects().length ? from : null) ?? card();
  const rect = origin?.getBoundingClientRect();
  if (!sameId(sid, sessions.current?.id)) await sessions.select(sid);
  if (!sameId(sid, sessions.current?.id)) return;
  const prev = focus;
  if (prev?.id === id) return;
  swapDraft(prev ? 'child:' + prev.id : 'main', 'child:' + id);
  // Reached from another subagent's view (a peer): the crumbs say so.
  focus = { sid: String(sid), id, from: prev ? (kids.get(prev.sid) ?? []).find((c) => c.id === prev.id)?.name ?? null : null };
  // Back pops out (one history entry per stay in subagent views).
  if (!prev) history.pushState({ pouchChild: id }, ''); else history.replaceState({ pouchChild: id }, '');
  if (layout.narrow() || layout.overlaid()) layout.setSide(false, false);
  // Open at the top, task header in view (critique 76-78); the transcript
  // fills in asynchronously, so stay there until the user scrolls.
  focus.pinTop = true;
  renderLog(); updateSend(); sessions.render();
  $('log').scrollTop = 0;
  zoomIn(rect);
  $('input').focus();
}
for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) $('log').addEventListener(ev, () => { if (focus) focus.pinTop = false; }, { passive: true });
// fromHistory: Back already took the entry off.
function closeChild(fromHistory = false) {
  if (!focus) return;
  const id = focus.id, snap = reduced() ? null : snapshot($('log'));
  swapDraft('child:' + id, 'main');
  focus = null;
  renderLog(); updateSend(); sessions.render();
  const card = $('log').querySelector(`.subagent[data-child="${CSS.escape(String(id))}"]`);
  card?.scrollIntoView({ block: 'center' });
  if (reduced()) flash(card ?? $('chat'));
  else { const a = fold(snap, card, 200); if (a) a.id = 'child-close'; }
  if (!fromHistory && history.state?.pouchChild != null) history.back();
}
addEventListener('popstate', () => { if (focus && history.state?.pouchChild == null) closeChild(true); });
// Esc pops out of a subagent view once nothing nearer took it (a popover,
// the completion list, a sheet: they call preventDefault). Drafts are kept.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !focus || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  closeChild();
});
const focusedChild = () => focus && (kids.get(focus.sid) ?? []).find((c) => c.id === focus.id);

// A child's transcript, for its card (compact: one line per tool call, the
// final answer set apart) and for its own view (full: the session's own
// rendering). The user's steering messages are marked in both.
function childItems(v, name, childId, compact) {
  const out = [], nextCache = new Map(), items = v?.items ?? [];
  const final = compact && !v?.busy ? items.findLast((x) => x.type === 'assistant' && x.text && !x.streaming) : null;
  let first = true;
  for (const x of items) {
    if (x.type === 'user') {
      const label = x.steer ? STEER_LABEL : x.from ? `from ${x.from.name} (${x.from.ref})` : first ? 'Task' : 'Message';
      const who = el('span', { className: `sa-who${x.from ? ' msg-from' : ''}`, textContent: label });
      if (x.from) seeded(who, x.from.ref);
      out.push(el('div', { className: `msg user bare${x.steer ? ' steer' : ''}${x.from ? ' from' : ''}`, role: 'article', ariaLabel: x.steer ? 'Your steering message' : x.from ? `Message to ${name} ${label}` : `${label} for ${name}` },
        who, el('div', { className: 'body', textContent: x.text })));
      first = false;
    } else if (x.type === 'assistant') {
      if (x === final) continue;
      out.push(el('div', { className: `msg assistant bare${x.streaming ? ' streaming' : ''}`, role: 'article', ariaLabel: `Reply from ${name}` },
        ...(x.thinking && !compact ? [reasoningCard(x, `child:${childId}:${items.indexOf(x)}`)] : []),
        ...(x.text ? [replyBody(x.text, nextCache)] : []),
        ...(x.error ? [el('div', { className: 'body bad', textContent: x.error })] : []),
        ...(x.streaming && !compact ? [el('span', { className: 'typing', role: 'img', ariaLabel: `${name} is replying`, title: 'Replying' }, el('i'), el('i'), el('i'))] : [])));
    } else if (x.type === 'tool') {
      // Spawns in one round read as one line: "spawn 4 one-shot judges".
      const prev = out.at(-1), spawn = x.name === 'subagent' && x.args?.action === 'spawn' ? x.args : null;
      if (compact && spawn && prev?.dataset?.spawn === (spawn.mode ?? 'agent')) {
        const names = [...JSON.parse(prev.dataset.names), spawn.name ?? 'subagent'];
        prev.dataset.names = JSON.stringify(names);
        prev.textContent = `subagent: ${spawnGroupText(names, spawn.mode)}`;
        prev.title = names.join(', ');
        continue;
      }
      const line = compact ? el('div', { className: 'sa-line' + (x.status === 'error' ? ' error' : ''), title: argSummary(x.name, x.args) },
        `${x.status === 'running' ? '... ' : x.status === 'error' ? '! ' : ''}${x.name}: ${argSummary(x.name, x.args)}`) : toolCard(x, 'sa:');
      if (compact && spawn && x.status !== 'error') { line.dataset.spawn = spawn.mode ?? 'agent'; line.dataset.names = JSON.stringify([spawn.name ?? 'subagent']); }
      out.push(line);
      if (x.name === 'bash') out.push(...shownLines(x.output).map(shownCard));
    } else if (x.type === 'notice') out.push(el('p', { className: 'notice', textContent: x.text }));
  }
  if (final) out.push(el('div', { className: 'sa-final', role: 'article', ariaLabel: `Final answer from ${name}` }, el('span', { className: 'sa-who', textContent: 'Final answer' }), replyBody(final.text, nextCache)));
  if (!items.length) out.push(el('p', { className: 'notice', textContent: v ? 'Nothing yet.' : 'Loading...' }));
  return out;
}

// "spawn 4 one-shot judges" from judge-argument, judge-evidence, ...
function spawnGroupText(names, mode) {
  const stem = names.every((n) => n.includes('-')) && new Set(names.map((n) => n.split('-')[0])).size === 1 ? names[0].split('-')[0] : null;
  return `spawn ${names.length} ${mode === 'oneshot' ? 'one-shot ' : ''}${stem ? stem + 's' : 'subagents'}`;
}
// The parent's name in a subagent's header and notes: its title once it has
// one, not the first-message placeholder, and never with a trailing period.
const parentName = (s) => (s?.titleSource || s?.titleEdited ? titleOf(s) : 'main').replace(/[.\s]+$/, '');
let saDetails = false; // the subagent header's Details disclosure, across renders

// The subagent's own view (S2, S3): who it is and what it may reach, its
// live transcript, and an end note once it is done. The composer steers it.
function childLog() {
  const c = focusedChild(), v = childViews.get(focus.id);
  const parent = parentName(sessions.current);
  if (!c) return [el('p', { className: 'notice bad', textContent: 'That subagent is no longer in this session.' })];
  const st = childState(focus.sid, c), t = vfs.tasks.byKeyOf('sa:' + c.id);
  // One bar (critique 3): back, name in its color, state, elapsed, requests,
  // Details, Stop. Task, messages and namespace fold under Details once the
  // transcript scrolls; at the top they show.
  // Breadcrumbs (Batch D): <this session> > <subagent>; the first pops out.
  const title = titleOf(sessions.current).replace(/[.\s]+$/, '');
  const back = el('button', { type: 'button', className: 'link sa-back', textContent: title, title: `Back to ${title} (Esc)` });
  back.onclick = () => closeChild();
  const crumbs = el('nav', { className: 'sa-crumbs', ariaLabel: 'Where you are' }, el('ol', {},
    el('li', {}, back),
    el('li', {}, el('span', { className: 'sa-dot', ariaHidden: 'true' }), el('span', { className: 'sa-name', ariaCurrent: 'page', textContent: c.name }),
      ...(focus.from ? [el('span', { className: 'sa-from muted', textContent: ` opened from ${focus.from}` })] : []))));
  const more = el('button', { type: 'button', className: 'sa-more-btn', textContent: 'Details', ariaExpanded: String(saDetails) });
  const acts = el('span', { className: 'sa-acts' }, more);
  if (c.status === 'running') {
    const stop = el('button', { type: 'button', className: 'danger', textContent: 'Stop', ariaLabel: `Stop subagent ${c.name}` });
    stop.onclick = () => { stop.disabled = true; ctl(agentFile(focus.sid, refOf(kids.get(String(focus.sid)) ?? [], c), 'ctl'), 'stop').catch((e) => fail(why(e))); };
    acts.append(stop);
  }
  const mounts = t ? vfs.tasks.mounts(t) : describeSpecs(vfs, c.ns?.length ? c.ns : defaultSubagentNs(vfs));
  const body = el('div', { className: 'sa-more', id: 'sa-more' },
    el('p', { className: 'sa-meta', textContent: [...(c.ref ? [c.ref] : []), `subagent of ${parent}`, ...(t ? [`/task/${t.id}`] : [])].join(' · ') }),
    el('p', { className: 'sa-task', textContent: c.task, title: c.task }),
    ...[edgeLine(kids.get(focus.sid) ?? [], c)].filter(Boolean),
    el('p', { className: 'sa-mounts', title: 'What this subagent can reach (its namespace)' }, 'Sees: ', ...mounts.map((m) => el('code', { textContent: m }))));
  more.setAttribute('aria-controls', 'sa-more');
  const head = seeded(el('section', { className: 'sa-view-head' + (saDetails ? ' details' : '') + ($('log').scrollTop > 24 ? ' collapsed' : ''), ariaLabel: `Subagent ${c.name} of ${parent}` },
    el('div', { className: 'sa-bar' }, crumbs,
      el('span', { className: `sa-status ${c.status}`, textContent: st }),
      el('span', { className: 'sa-meta sa-stats', textContent: [fmtDur((c.status === 'running' ? Date.now() : c.ended ?? Date.now()) - (c.resumed ?? c.started)), `${v?.steps ?? c.requests ?? 0} req`, ...((v?.toolErrors ?? c.toolErrors) ? [`${v?.toolErrors ?? c.toolErrors} tool err`] : [])].join(' · ') }),
      acts),
    body), c.ref);
  more.onclick = () => { saDetails = !saDetails; head.classList.toggle('details', saDetails); more.ariaExpanded = String(saDetails); };
  // On a phone the stats ride under Details, so the name keeps the bar (critique 7).
  body.prepend(el('p', { className: 'sa-stats-more muted', textContent: head.querySelector('.sa-stats').textContent }));
  const out = [head, ...childItems(v, c.name, c.id, false)];
  if (c.status !== 'running') {
    // Ended: one compact bar in place of the composer (critique 7).
    const b = el('button', { type: 'button', textContent: 'Back', ariaLabel: `Back to ${title}`, title: `Back to ${title} (Esc)` });
    b.onclick = () => closeChild();
    out.push(el('p', { className: 'notice sa-ended', role: 'status' }, el('span', { textContent: st === 'finished' ? `${c.name} finished; its report is in main's thread.` : `${c.name} ${{ stopped: 'was stopped', failed: 'failed', interrupted: 'was interrupted' }[st] ?? 'ended'}; its last output is in main's thread.` }), b));
  }
  return out;
}
let lastHeight = null; // the transcript's height at the last render (the "New reply below" pill)
$('below').onclick = () => { follow.pin(!matchMedia('(prefers-reduced-motion: reduce)').matches); $('below').hidden = true; };
$('log').addEventListener('scroll', () => { if (follow.following) $('below').hidden = true; }, { passive: true });
// The header folds to its bar once the transcript scrolls (critique 3).
$('log').addEventListener('scroll', () => {
  const h = focus && $('log').querySelector('.sa-view-head');
  if (h) h.classList.toggle('collapsed', $('log').scrollTop > 24);
}, { passive: true });

// The card at the spawn point (D16): status, time, requests, Stop, Message,
// Open (its own view), the transcript (compact; filled when opened, live while
// it runs), and the files it changed.
function subagentCard(it, childId) {
  const c = (kids.get(String(sessions.current?.id)) ?? []).find((x) => x.id === childId);
  const v = childViews.get(childId);
  const name = c?.name ?? it.details?.name ?? it.args?.name ?? 'subagent';
  const st = c?.status ?? (it.status === 'running' ? 'starting' : 'unknown');
  const box = seeded(el('section', { className: `subagent ${st}`, ariaLabel: `Subagent ${name}: ${st}` }), c?.ref ?? it.details?.ref);
  box.dataset.child = childId;
  const meta = [];
  if (c?.ref) meta.push(c.ref);
  if (c?.oneshot ?? it.details?.oneshot) meta.push('one-shot');
  if (c) meta.push(fmtDur((c.status === 'running' ? Date.now() : c.ended ?? Date.now()) - (c.resumed ?? c.started)));
  const steps = v?.steps ?? c?.requests;
  if (steps != null) meta.push(`${steps} request${steps === 1 ? '' : 's'}`);
  const fails = v?.toolErrors ?? c?.toolErrors;
  if (fails) meta.push(`${fails} tool error${fails === 1 ? '' : 's'}`);
  const head = el('div', { className: 'sa-head' },
    el('span', { className: 'sa-dot', ariaHidden: 'true' }),
    el('span', { className: 'sa-name', textContent: name }),
    el('span', { className: `sa-status ${st}`, textContent: st }),
    el('span', { className: 'sa-meta', textContent: meta.join(' · ') }));
  const acts = el('span', { className: 'sa-acts' });
  if (c) {
    const open = el('button', { type: 'button', textContent: 'Open', ariaLabel: `Open subagent ${name}` });
    open.onclick = () => openChild(sessions.current.id, c.id, box);
    const msg = el('button', { type: 'button', textContent: 'Message', ariaLabel: `Message subagent ${name}` });
    msg.onclick = () => messageChild(c);
    acts.append(open, ...(c.oneshot ? [] : [msg])); // a one-shot takes no messages
  }
  if (c?.status === 'interrupted') {
    const res = el('button', { type: 'button', className: 'primary', textContent: 'Resume', ariaLabel: `Resume subagent ${name}` });
    res.onclick = () => { res.disabled = true; ctl(agentFile(sessions.current.id, refOf(kids.get(String(sessions.current.id)) ?? [], c), 'in'), 'message\nContinue your task where you left off: a page reload interrupted you.').catch((e) => fail(why(e))); };
    acts.append(res);
  }
  if (c?.status === 'running') {
    const stop = el('button', { type: 'button', className: 'danger', textContent: 'Stop', ariaLabel: `Stop subagent ${name}` });
    stop.onclick = () => { stop.disabled = true; ctl(agentFile(sessions.current.id, refOf(kids.get(String(sessions.current.id)) ?? [], c), 'ctl'), 'stop').catch((e) => fail(why(e))); };
    acts.append(stop);
  }
  head.append(acts);
  box.append(head, el('p', { className: 'sa-task', textContent: c?.task ?? it.args?.task ?? '', title: c?.task ?? '' }));
  const edges = c && edgeLine(kids.get(String(sessions.current?.id)) ?? [], c);
  if (edges) box.append(edges);
  if (c?.error && st === 'failed') box.append(el('p', { className: 'sa-err', textContent: c.error }));
  const key = 'sa:' + childId;
  // The body is built when the disclosure opens, not only at the next render:
  // a toggle used to record the state and draw nothing until something else
  // re-rendered the log (never, once the child had finished).
  const d = el('details', { className: 'sa-log', open: openTools.has(key) });
  const n = v?.items.length ?? 0, steered = v?.items.filter((x) => x.steer).length ?? 0;
  d.append(el('summary', { textContent: (v ? `Transcript (${n} item${n === 1 ? '' : 's'})` : 'Transcript') + (steered ? `, steered by you ${steered === 1 ? 'once' : steered + ' times'}` : '') }));
  // Expanded, the transcript scrolls in its own tinted box under a sticky
  // "Collapse <name>" bar, so it never passes for the main session (critique 5).
  const fill = () => {
    if (d.querySelector('.sa-items')) return;
    const fold = el('button', { type: 'button', className: 'sa-fold', textContent: `Collapse ${name}`, ariaLabel: `Collapse the transcript of ${name}` });
    fold.onclick = () => { d.open = false; box.scrollIntoView({ block: 'nearest' }); };
    const items = el('div', { className: 'sa-items', tabIndex: 0, role: 'region', ariaLabel: `Transcript of ${name}` }, fold, ...childItems(childViews.get(childId), name, childId, true));
    items.dataset.sk = key; // keeps its place across re-renders (src/follow.js)
    d.append(items);
  };
  if (d.open) fill();
  d.ontoggle = () => { if (d.open) { openTools.add(key); fill(); } else openTools.delete(key); };
  box.append(d);
  return box;
}

// Token totals per session (Usage panel): the live view for the current
// session, otherwise what was recorded when its last run settled.
async function renderUsagePanel(list) {
  list ??= await sessions.all();
  const led = await ledger.snapshot();
  // Subagents' tokens roll into their parent session's row; requests come
  // from today's ledger (subagents and titles are counted under the session).
  const rows = await Promise.all(list.map(async (s) => {
    const current = sameId(s.id, sessions.current?.id);
    const u = (current && view?.usage) || s.usage || {};
    const subs = (await loadKids(s.id).catch(() => [])) ?? [];
    const sum = (k) => subs.reduce((n, c) => n + (c.usage?.[k] ?? 0), 0);
    return { title: titleOf(s), input: (u.input ?? 0) + sum('input'), output: (u.output ?? 0) + sum('output'), cost: (u.cost ?? 0) + sum('cost'),
      requests: led.bySid[String(s.id)] ?? 0, subagents: subs.length, current };
  }));
  const known = new Set(list.map((s) => String(s.id)));
  const gone = Object.entries(led.bySid).filter(([k]) => !known.has(k)).reduce((n, [, v]) => n + v, 0);
  if (gone) rows.push({ title: 'Deleted sessions', requests: gone, input: null, output: null });
  renderPanel($('usage-body'), usage.state, rows, led);
  // This session's context (the composer's meter, spelled out), above the allowance.
  const now = contextNow();
  if (now) {
    const s = sessions.current;
    const box = el('section', { className: 'ctx-now', ariaLabel: 'This session\'s context' },
      el('h3', { textContent: 'This session\'s context' }),
      el('div', { className: 'big' }, now.d.count, el('small', { textContent: now.d.of ? ` of ${now.d.of} tokens` : ' tokens' })),
      el('p', { textContent: now.d.label }),
      el('p', { className: 'muted', textContent: 'Counted in this browser from the stored conversation: the newest reply\'s own usage, as its server reported it, plus an estimate (about 3.5 characters a token) for anything since. Nothing is sent to count it.' }),
      el('button', { type: 'button', className: 'ctx-compact', textContent: `Compact now (${sessions.costOf(s)})`, onclick: async () => { await sessions.compact(s.id); if (layout.current() === 'usage') renderUsagePanel(); } }));
    box.dataset.level = now.d.level;
    $('usage-body').prepend(box);
  }
  if (LOCAL) $('usage-body').querySelector('.quota')?.after(el('p', { className: 'local-usage muted', textContent:
    `Transformers.js turns (${LOCAL.label}, in this browser) use none of this allowance: they send no requests.` }));
  // Subagents spend the same allowance (D16).
  const live = [...kids.entries()].flatMap(([sid, l]) => l.filter((c) => c.status === 'running').map((c) => ({ sid, c })));
  if (live.length) {
    $('usage-body').querySelector('.quota')?.after(el('p', { className: 'sa-usage', role: 'status', textContent:
      `${live.length} subagent${live.length > 1 ? 's are' : ' is'} running (${live.map(({ c }) => c.name).join(', ')}). Each of their steps uses a request too, so the number above is still going down.` }));
  }
}
$('usage-refresh').onclick = () => usage.refresh();

// watch() is slow (it scans stored history), so switches can overlap. Only the
// newest attach may install its watcher or touch the view; a superseded one
// disposes itself, or a slow scan of session A would paint over session B.
let attachGen = 0;
let interrupted = false; // the current session's last run was cut off by a reload
async function resumeRun() {
  const sid = sessions.current?.id;
  if (sid == null) return;
  await store.setSetting(interruptedKey(sid), undefined);
  interrupted = false;
  send('Continue where you left off: a page reload interrupted your last run.');
}
let attachError = null; // why the current session could not open (held by another tab)
let revertable = null; // { at, cut } while the current session's last revert can be undone
async function attach() {
  renderHint();
  const gen = ++attachGen;
  if (focus) swapDraft('child:' + focus.id, 'main');
  focus = null;
  unwatch?.(); unwatch = null; view = null; attachError = null; turnTimes = {}; lastHeight = null; $('below').hidden = true; follow.pin(); dropKidWatches(); renderLog(); updateSend();
  const session = sessions.current;
  if (!session || !agent) return;
  await loadKids(session.id);
  if (gen !== attachGen) return;
  watchKids();
  const token = await store.getSetting(revertKey(session.id));
  if (gen !== attachGen) return;
  revertable = token ? { at: token.at, cut: token.cut, branch: token.branch ?? [] } : null;
  interrupted = !!(await store.getSetting(interruptedKey(session.id)));
  turnTimes = (await store.getSetting(turnsKey(session.id))) ?? {};
  if (gen !== attachGen) return;
  // Another tab may hold this session's database (its Web Lock): say so.
  const dispose = await agent.watch(session.id, (v) => {
    if (gen !== attachGen) return;
    view = v; scheduleRender(); updateSend();
  }).catch((e) => { if (gen === attachGen) { attachError = e.message; renderLog(); status(e.message, 'bad'); } return () => {}; });
  if (gen !== attachGen) return dispose();
  unwatch = dispose;
}

// ── Transcript rendering ────────────────────────────────────────────
// textContent only: model output is never parsed as HTML, so a reply cannot
// inject script into the page that holds your key.
const openTools = new Set();
function reasoningCard(it, key) {
  // Streaming: a capped box showing the newest lines, overflow hidden (no
  // inner scroller, so nothing traps a wheel or a finger); done: full height.
  const words = it.streaming ? 0 : it.thinking.trim().split(/\s+/).length;
  const d = el('details', { className: 'reasoning' + (it.streaming ? ' live' : '') }, el('summary', { textContent: it.streaming ? 'Reasoning (in progress)' : `Reasoning, ${words.toLocaleString()} word${words === 1 ? '' : 's'}` }),
    el('div', { className: 'thinking', textContent: it.thinking }));
  if (it.streaming) d.lastChild.dataset.sk = 'live:' + key;
  return settings.bind(d, `reasoning:${sessions.current?.id}:${key}`, 'reasoning');
}
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderLog(); });
}

// Tool calls read as what they do: a write is a path and its text, an edit is
// old and new lines, bash is its command. Never JSON with escaped newlines.
function argSummary(name, args) {
  if (typeof args === 'string') return args.slice(0, 120);
  if (!args) return '';
  if (name === 'bash') return (args.command ?? '').split('\n')[0];
  if (name === 'run' && args.code != null) return 'js: ' + (args.code.split('\n').find((l) => l.trim()) ?? '');
  if (name === 'agents' || name === 'subagent') return agentSummary(name, args);
  if (name === 'look') { const ps = Array.isArray(args.paths) ? args.paths : []; return `${ps.length} image${ps.length === 1 ? '' : 's'}: ${ps.map((p) => String(p).split('/').pop()).join(', ')}`; }
  if (name === 'watch') return args.action === 'watch' ? `${(args.paths ?? []).join(', ')}${args.once ? ' (once)' : ''}${args.by && args.by !== 'user' ? ` by ${args.by}` : ''}` : `${args.action ?? ''} ${args.id ?? ''}`.trim();
  return args.path ?? JSON.stringify(args).slice(0, 120);
}
function lines(text, prefix, cls) {
  return el('span', { className: cls, textContent: String(text ?? '').split('\n').map((l) => prefix + l).join('\n') + '\n' });
}
function toolDetail(it) {
  const a = it.args && typeof it.args === 'object' ? it.args : null;
  const parts = [];
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
  if (eg || liveEgress.has(it.id)) {
    const e = eg ?? liveEgress.get(it.id);
    parts.push(el('p', { className: 'egress-note', textContent: `Left the pouch (${e.commands.join(', ')}). Who can see it: ${e.audiences.join('; ') || 'see the bayleaf-cli skill'}.` }));
  }
  parts.push(el('pre', { textContent: (eg ? eg.text : it.output) || (it.status === 'running' ? 'running...' : '') }));
  return parts;
}

// Paths in replies become buttons, but only for files that exist: a token is
// checked once, then rechecked lazily after the files change (pathGen).
// linkVer counts answers that changed, so cached replies know to re-render.
const pathSeen = new Map(); // absolute path -> { kind, gen }
let pathGen = 0, linkVer = 0;
const PATH = /((?:\.?\/)?[\w@+-]+(?:[./][\w@+-]+)*)(?::(\d+))?/g;
function pathKind(abs) {
  const hit = pathSeen.get(abs);
  const kind = hit?.kind ?? 'unknown';
  if (!hit || hit.gen !== pathGen) {
    pathSeen.set(abs, { kind, gen: pathGen });
    vfs.fs.stat(abs).then((s) => (s.isDirectory ? 'dir' : 'file'), () => 'missing').then((k) => {
      if (k !== kind) { pathSeen.set(abs, { kind: k, gen: pathGen }); linkVer++; scheduleRender(); }
    });
  }
  return kind;
}
const isFile = (abs) => pathKind(abs) === 'file';

// A folder link reveals the folder: expand the way down and show the tree.
async function revealDir(path) {
  for (let q = path; q !== '/'; q = normalize(q + '/..')) expanded.add(q);
  focusPath = path;
  layout.open('files');
  await renderTree();
  treeRows().find((r) => r.dataset.path === path)?.scrollIntoView({ block: 'nearest' });
}
// Navigation is not governed by connect-src: the address itself is the leak.
function openExternal(url) {
  sheet('Open external link?', [['Open', () => { window.open(url, '_blank', 'noopener,noreferrer'); }]],
    el('div', {}, el('p', { textContent: 'This opens a page outside Pouch. Anything in the link address goes to that site.' }), el('pre', { textContent: url })));
}
const mdCtx = {
  cwd: CWD,
  kind: pathKind,
  text: (t) => linkify(t),
  highlight: (code, lang) => highlight(code, lang),
  copy: (t) => navigator.clipboard.writeText(t),
  external: openExternal,
  image: (path, alt) => localImages.render(path, alt),
  open: (t) => (t.kind === 'dir' ? revealDir(t.path) : openFile(t.path, t.line, { link: true })).catch((e) => fail(e.message)),
};
// Streaming re-renders the whole log each frame; only replies whose text or
// link answers changed are re-parsed. Unused entries drop out each render.
let mdCache = new Map(); // text -> { node, ver }
function replyBody(text, next) {
  const hit = mdCache.get(text);
  if (hit && hit.ver === linkVer && !next.has(text)) { next.set(text, hit); return hit.node; }
  const node = el('div', { className: 'body md' }, ...renderMarkdown(text, mdCtx));
  if (!next.has(text)) next.set(text, { node, ver: linkVer });
  return node;
}
// Split text into strings and buttons; DOM nodes only, never HTML.
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(PATH)) {
    const [tok, p, line] = m;
    if (!p.includes('/') && !/\.\w+$/.test(p)) continue;
    const abs = normalize(p.startsWith('/') ? p : CWD + '/' + p);
    if (!isFile(abs)) continue;
    out.push(text.slice(last, m.index));
    const b = el('button', { type: 'button', className: 'path', textContent: tok, title: 'Open ' + abs + (line ? ' at line ' + line : '') });
    b.onclick = () => openFile(abs, line ? Number(line) : undefined, { link: true }).catch((e) => fail(e.message));
    out.push(b);
    last = m.index + tok.length;
  }
  out.push(text.slice(last));
  return out;
}

function toolCard(it, prefix = '') {
  const k = prefix + it.id;
  const d = settings.bind(el('details', { className: 'tool' + (it.status === 'error' ? ' error' : '') }), `tool:${sessions.current?.id}:${k}`, 'tools');
  const mark = it.status === 'running' ? '... ' : it.status === 'error' ? '! ' : '';
  const sum = el('summary', {}, el('span', { className: 'what', textContent: `${mark}${it.name}: ${argSummary(it.name, it.args)}` }));
  const eg = it.name === 'bash' ? (egressOf(it.output) ?? liveEgress.get(it.id)) : null;
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
const lookUrls = new Map(); // base64 data -> blob URL
const lookShown = new Set();
function sweepLooks() {
  for (const [k, url] of lookUrls) if (!lookShown.has(k)) { URL.revokeObjectURL(url); lookUrls.delete(k); }
  lookShown.clear();
}
function lookThumbs(it) {
  const names = [];
  for (const [, path, n] of String(it.output ?? '').matchAll(/^(.+): image (\d+),/gm)) names[n - 1] = path;
  return it.images.map((img, i) => {
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
function quietText(it) {
  if (it.status === 'stopped') return 'Stopped before it reported. Pouch is told at its next turn.';
  if (it.byMessage) return `Sent its findings to ${it.byMessage}${it.lastSent?.text ? `: "${it.lastSent.text.slice(0, 120)}${it.lastSent.text.length > 120 ? '...' : ''}"` : '.'}`;
  return 'Finished without a report.';
}
// Consecutive quiet reports and main's joins (G7): one summary line, the
// cards inside. "Joined 4 subagents: 3 reported to chair (a2), 1 quiet".
function quietGroup(items, nextCache) {
  const who = new Map(); // ref -> where it sent its work, or ''
  const rows = kids.get(String(sessions.current?.id)) ?? [];
  for (const it of items) {
    if (it.type === 'report') who.set(it.ref ?? it.name, it.byMessage || who.get(it.ref ?? it.name) || '');
    else for (const id of [].concat(it.args?.ids ?? it.args?.id ?? [])) {
      const c = rows.find((x) => x.ref === asRef(id) || x.name === String(id));
      const ref = c?.ref ?? String(id);
      if (!who.get(ref)) who.set(ref, c?.lastSent && c.sentIn === c.sub ? c.lastSent.to : '');
    }
  }
  const to = new Map();
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
const REPORT_VERB = { finished: 'finished', failed: 'failed', stopped: 'was stopped', interrupted: 'was interrupted' };
function reportCard(it, nextCache) {
  const kids_ = [el('div', { className: 'sa-report-head' }, el('span', { className: `sa-status ${it.status}`, textContent: it.status }), ` Subagent ${it.name} ${REPORT_VERB[it.status] ?? it.status}`)];
  // Not finished: its last words are work in progress, not a report (critique 49, 59).
  const LAST = { stopped: 'Last output before stop', failed: 'Last output before it failed', interrupted: 'Last output before the reload' };
  if (it.text && LAST[it.status]) kids_.push(el('p', { className: 'sa-last muted', textContent: LAST[it.status] + ':' }));
  if (it.text) kids_.push(replyBody(it.text, nextCache));
  else kids_.push(el('div', { className: 'body muted', textContent: quietText(it) }));
  return seeded(message({ ...it, type: 'report', text: it.text }, LAST[it.status] ? `${LAST[it.status]} from subagent ${it.name}` : `Report from subagent ${it.name}`, ...kids_), it.ref);
}

// "Pouch is editing..." in the editor header while a write or edit to the open
// file is being sent or carried out, by main or a subagent (critique 10).
function markEditing() {
  const at = (p) => (typeof p === 'string' && p ? normalize(p.startsWith('/') ? p : '/work/' + p) : null);
  const views = [view, ...childViews.values()].filter(Boolean);
  const on = !!openPath && views.some((v) => v.items.some((it) => it.type === 'tool' && it.status === 'running' && (it.name === 'write' || it.name === 'edit') && at(it.args?.path) === openPath));
  $('editor-busy').hidden = !on;
}
function renderLog() {
  const log = $('log');
  markEditing();
  // Before building: cached reply nodes move out of the live log while the
  // new one is built, and a layout read then would clamp its scroll to 0.
  const mark = follow.mark();
  log.classList.toggle('child-view', !!focus);
  // The frame (Batch D): the chat column, composer included, in the agent's hue.
  const fc = focus && focusedChild(), chat = $('chat');
  chat.classList.toggle('in-child', !!focus);
  chat.classList.toggle('child-ended', !!fc && fc.status !== 'running');
  if (fc?.ref) seeded(chat, fc.ref); else chat.style.removeProperty('--seed');
  if (focus) {
    log.replaceChildren(...childLog()); follow.restore(mark);
    sweepLooks();
    if (focus.pinTop) follow.top();
    else follow.stick();
    playArrivals(log);
    updateSend();
    composer?.renderTray();
    return;
  }
  const out = [];
  if (!view?.items.length) {
    out.push(el('p', { className: 'notice' + (attachError ? ' bad' : ''), textContent: attachError ? attachError : agent
      ? 'Ask Pouch to read, write or reorganize files in /work or a mounted folder. ' + (localhostPicked() ? 'Files stay in this browser; model requests go to your server on this computer.' : 'Everything stays in this browser; model requests are sealed.')
      : (agentError ?? 'Starting...') }));
  }
  const nextCache = new Map();
  finals = turnFinals(view);
  let quietRun = [];
  const flushQuiet = () => {
    const manyIds = quietRun.length === 1 && quietRun[0].type === 'tool' && [].concat(quietRun[0].args?.ids ?? []).length > 1;
    if (quietRun.length > 1 || manyIds) out.push(quietGroup(quietRun, nextCache));
    else for (const it of quietRun) out.push(it.type === 'report' ? reportCard(it, nextCache) : toolCard(it));
    quietRun = [];
  };
  for (const it of view?.items ?? []) {
    const quietItem = (it.type === 'report' && !it.text && it.status === 'finished') ||
      (it.type === 'tool' && it.name === 'subagent' && it.args?.action === 'join' && it.status === 'done');
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
      const m = message(it, 'Your steering message', el('span', { className: 'sa-who', textContent: STEER_LABEL }), el('div', { className: 'body', textContent: it.text }));
      m.classList.add('steer');
      out.push(m);
    } else if (it.type === 'user') {
      out.push(message(it, 'Your message', el('div', { className: 'body', textContent: it.text }),
        ...(it.attachments?.length ? [el('div', { className: 'attachment-refs' }, ...it.attachments.map((f) => el('span', { title: f.path, textContent: `${f.name} (${f.size.toLocaleString()} B) `, ariaLabel: `${f.name}, ${f.size} bytes, ${f.path}` })))] : [])));
    } else if (it.type === 'assistant') {
      const kids = [];
      if (it.thinking) kids.push(reasoningCard(it, view.items.indexOf(it)));
      if (it.text) kids.push(replyBody(it.text, nextCache));
      if (it.error) kids.push(el('div', { className: 'body bad', textContent: lostRuns.has(String(sessions.current?.id)) && it === view.items.findLast((i) => i.error) ? 'Connection lost: the network dropped during this turn. Nothing more was sent; send again when back online.' : it.error }));
      if (it.streaming) kids.push(el('span', { className: 'typing', role: 'img', ariaLabel: 'Pouch is replying', title: 'Replying' }, el('i'), el('i'), el('i')));
      out.push(message(it, 'Reply from Pouch', ...kids));
    } else if (it.type === 'tool') {
      const child = it.name === 'subagent' && it.args?.action === 'spawn' && it.status !== 'error' ? it.details?.child : null;
      const early = child == null && it.name === 'subagent' && it.args?.action === 'spawn' && it.status === 'running' ? spawnedAs(it) : null;
      out.push(child != null ? subagentCard(it, child) : early ? subagentCard(it, early.id) : startingSpawn(it) ? subagentCard(it, null) : toolCard(it));
      if (it.name === 'bash') out.push(...shownLines(it.output).map(shownCard));
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
  if (interrupted && view && !busy()) {
    const b = el('button', { type: 'button', className: 'primary', textContent: 'Resume' });
    b.onclick = () => { b.disabled = true; resumeRun(); };
    out.push(el('p', { className: 'notice reverted', role: 'status' }, 'The page reloaded while Pouch was working, so that run stopped.', b));
  }
  // "Reverted to <time>. Undo", where the conversation was cut.
  if (revertable && view) {
    const undo = el('button', { type: 'button', textContent: 'Undo', disabled: busy() });
    undo.onclick = () => undoRevert(sessions.current?.id).catch((e) => fail(e.message));
    const note = el('p', { className: 'notice reverted', role: 'status' }, `Reverted to ${shortTime(revertable.at)}. Files stay as they are.`, undo);
    const n = revertable.branch.length;
    const other = n ? el('details', { className: 'other-branch' },
      el('summary', { textContent: `Other branch: ${n} message${n === 1 ? '' : 's'} Pouch no longer sees` }),
      ...revertable.branch.map((b) => el('p', {}, el('b', { textContent: b.who + ': ' }), b.text))) : null;
    const at = out.findIndex((n) => n.dataset?.cut === String(revertable.cut));
    if (at < 0) out.push(...[note, other].filter(Boolean));
    else out.splice(at + 1, 0, ...[note, other].filter(Boolean));
  }
  mdCache = nextCache;
  // Rebuilding the log drops focus; give it back to the same message or button.
  const f = document.activeElement, fKey = log.contains(f) ? f.closest('.msg')?.dataset.key : null;
  const fAct = fKey && f.dataset.act;
  log.replaceChildren(...out); follow.restore(mark);
  localImages.sweep(); sweepLooks();
  if (fKey) log.querySelector(`.msg[data-key="${CSS.escape(fKey)}"]${fAct ? ` [data-act="${fAct}"]` : ''}`)?.focus({ preventScroll: true });
  follow.stick();
  // Scrolled up while something new arrived below: say so (critique 19).
  if (!follow.following && log.scrollHeight > (lastHeight ?? 0) + 4 && lastHeight != null) $('below').hidden = false;
  lastHeight = log.scrollHeight;
  playArrivals(log);
  composer?.renderTray();
}

// ── Message toolbar (D11) and revert to here (D12) ──────────────────
// Each settled message has a toolbar row under it: time, Copy, Revert to
// here. Its space is always reserved; it shows on hover, on focus within
// the message (messages are focusable), and after a tap (touch). A turn's
// final reply gets the turn footer instead: model, duration and time always
// visible, the actions (Copy, Revert to here, More) shown the same way.
const shortTime = (t) => t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'an earlier point';
let shownKey = null; // the message whose toolbar a tap revealed
let finals = new Map(); // final reply of a settled turn -> the item that started the turn
let turnTimes = {}; // turn-start entry -> duration measured in this browser (ms)
// A turn starts at a user message or a subagent report and ends at its last
// reply with text. The turn still running has no final reply yet.
function turnFinals(v) {
  const out = new Map();
  let start = null, last = null;
  const close = () => { if (start && last) out.set(last, start); };
  for (const it of v?.items ?? []) {
    if ((it.type === 'user' && !it.steer) || it.type === 'report') { close(); start = it; last = null; }
    else if (it.type === 'assistant' && !it.streaming && it.entry && (it.text || it.error)) last = it;
  }
  if (!v?.busy) close();
  return out;
}
// Remember how long the turn just settled took, under its start entry.
async function recordTurn(sid, v, ms) {
  const start = v?.items.findLast((i) => i.type === 'user' || i.type === 'report');
  if (!start?.entry) return;
  const all = { ...((await store.getSetting(turnsKey(sid))) ?? {}), [start.entry]: ms };
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete all[k]; // bounded
  await store.setSetting(turnsKey(sid), all);
  if (sameId(sid, sessions.current?.id)) { turnTimes = all; scheduleRender(); }
}
const modelName = (id) => models.find((m) => m.id === id)?.name ?? (LOCAL && id === LOCAL_ID ? `${LOCAL.label} (Transformers.js)` : isLocalhost(id) ? `${id.slice('localhost:'.length)} (Localhost)` : id);
function message(it, label, ...kids) {
  // A step that only thought before calling tools gets no toolbar: it has
  // nothing to copy, and its reply's toolbar reverts to after its tools.
  const bar = !it.streaming && it.entry && (it.type === 'user' || it.text || it.error);
  const m = el('div', { className: `msg ${it.type}${it.streaming ? ' streaming' : ''}${bar ? '' : ' bare'}`, role: 'article', ariaLabel: label }, ...kids);
  if (!bar) return m;
  m.tabIndex = 0;
  m.dataset.key = it.entry;
  m.dataset.cut = it.cut;
  if (shownKey === it.entry) m.classList.add('show');
  m.onclick = (e) => {
    if (e.target.closest('button, a, summary, input')) return;
    shownKey = shownKey === it.entry ? null : it.entry;
    for (const x of $('log').querySelectorAll('.msg.show')) x.classList.remove('show');
    if (shownKey) m.classList.add('show');
  };
  const start = finals.get(it);
  const row = el('div', { className: 'msg-bar' + (start ? ' footer' : '') });
  const when = it.at && el('time', { className: 'when', textContent: shortTime(it.at), title: new Date(it.at).toLocaleString(), dateTime: new Date(it.at).toISOString() });
  const ms = start && turnTimes[start.entry];
  if (start) {
    const parts = [it.model && modelName(it.model), ms != null && fmtDur(ms), when].filter(Boolean);
    const meta = el('span', { className: 'meta' });
    parts.forEach((x, i) => meta.append(...(i ? [el('span', { className: 'sep', ariaHidden: 'true', textContent: '·' })] : []), x));
    if (when) when.className = '';
    meta.title = [it.model && `Model: ${it.model}`, ms != null ? `Turn took ${fmtDur(ms)}` : 'Turn duration not recorded', it.at && new Date(it.at).toLocaleString()].filter(Boolean).join('\n');
    row.append(meta);
  } else if (when) row.append(when);
  const acts = start ? el('span', { className: 'acts' }) : row;
  const tool = (act, name, tip, fn, disabled = false) => {
    const b = el('button', { type: 'button', className: 'icon', ariaLabel: tip, title: tip, disabled }, icon(name));
    b.dataset.act = act;
    b.onclick = () => fn().catch((e) => fail(e.message));
    acts.append(b);
  };
  // The text as written: what the user typed, or the reply's markdown source.
  tool('copy', 'copy', it.type === 'user' ? 'Copy message' : 'Copy reply (markdown)', async () => {
    await navigator.clipboard.writeText(it.text ?? '');
    status('Copied.');
  }, !it.text);
  const why = busy() ? ' (not while Pouch is working)' : agent?.isLegacy(sessions.current?.id) ? ' (not for sessions saved before per-session storage)' : '';
  tool('revert', 'undo', 'Revert to here' + why, () => revertTo(it), !!why);
  if (start) {
    tool('more', 'ellipsis', 'More', async () => {
      const dl = el('dl', { className: 'reply-facts' });
      const fact = (k, v) => dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
      fact('Model', it.model ?? 'unknown');
      if (start.at) fact('Turn started', new Date(start.at).toLocaleString());
      fact('Turn took', ms != null ? fmtDur(ms) : 'not recorded (measured only for turns run in this browser since this feature)');
      if (it.at) fact('Reply began', new Date(it.at).toLocaleString());
      sheet('This reply', [['Copy as plain text', async () => {
        await navigator.clipboard.writeText(m.querySelector('.body')?.innerText ?? it.text ?? '');
        status('Copied.');
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
const branchOutline = (items) => items.filter((i) => i.type === 'user' || (i.type === 'assistant' && i.text)).slice(0, 40)
  .map((i) => ({ who: i.type === 'user' ? 'You' : 'Pouch', text: String(i.text ?? '').slice(0, 160) }));
async function revertTo(it) {
  const s = sessions.current;
  if (!s || busy() || !view) return;
  const sid = s.id;
  // Your own message: revert to just before it, and its text comes back into
  // the box to edit and send again (D12), never a message left without a reply.
  if (it.type === 'user' && !it.steer && !it.watch && !it.from?.ref) {
    const at = view.items.indexOf(it);
    const before = view.items.slice(0, at).findLast((i) => i.entry && !i.streaming && (i.type === 'user' || i.text || i.error));
    if (!before) return status('This is the first message, so there is nothing before it to revert to. Copy it into /new to start over.', 'bad');
    return revertTo({ ...before, draft: it.text, draftAt: at });
  }
  const idx = view.items.findIndex((i) => i.cut === it.cut && i.entry === it.entry && i.type === it.type);
  const later = view.items.slice(idx + 1).filter((i) => i.type === 'user' || (i.type === 'assistant' && (i.text || i.error))).length;
  const body = el('div', { className: 'revert-body' }, el('p', {
    textContent: `${it.draft != null ? 'Your message goes back into the box to edit and send again. ' : ''}${later ? `${later} later message${later > 1 ? 's' : ''} fold${later > 1 ? '' : 's'} into another branch, and Pouch will not see ${later > 1 ? 'them' : 'it'} again.` : 'Nothing comes after this message.'} Files stay as they are. You can undo this.`,
  }));
  sheet(it.draft != null ? 'Revert to before this message?' : 'Revert to here?', [['Revert', async () => {
    if (busy()) return;
    const branch = branchOutline(view.items.slice(idx + 1));
    const r = await agent.revert(sid, it.cut);
    await store.setSetting(revertKey(sid), { session: String(sid), from: r.from, to: r.to, at: it.at, cut: it.cut, branch });
    // Motion carries continuity: the leaving messages dim before they fold.
    const leaving = [...$('log').querySelectorAll('.msg, .tool, .notice')].filter((n) => n.compareDocumentPosition($('log').querySelector(`[data-cut="${CSS.escape(String(it.cut))}"]`) ?? n) & Node.DOCUMENT_POSITION_PRECEDING);
    for (const n of leaving) n.classList.add('leaving');
    if (leaving.length && !matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise((res) => setTimeout(res, 220));
    if (sameId(sid, sessions.current?.id)) await attach();
    status(`Reverted to ${shortTime(it.at)}. Files were not changed.${it.draft != null ? ' Your message is back in the box.' : ''}`);
    if (it.draft != null) putBack(it.draft);
  }]], body);
}

async function undoRevert(sid) {
  if (sid == null) return;
  if (!sameId(sid, sessions.current?.id)) await sessions.select(sid);
  const t = await store.getSetting(revertKey(sid));
  if (!t) return;
  if (busy()) return status('Stop Pouch before undoing the revert.', 'bad');
  // Turns sent since the revert stay behind in the abandoned branch.
  const items = view?.items ?? [], cut = items.findIndex((i) => String(i.cut) === String(t.cut));
  const since = cut < 0 ? 0 : items.slice(cut + 1).filter((i) => i.type === 'user').length;
  if (since && !(await ask(`Undo the revert? The ${since} message${since > 1 ? 's' : ''} you sent since leave${since > 1 ? '' : 's'} the view, and the branch from before the revert comes back.`, 'Undo the revert'))) return;
  await agent.point(sid, t.from);
  await store.setSetting(revertKey(sid), undefined);
  await attach();
  status('Revert undone.');
}

// ── Composer (composer.js) ──────────────────────────────────────────
const busy = () => !!view?.busy;
const PLACEHOLDER = 'Ask Pouch. @ for files, $ for skills, / for commands';
const attachments = createAttachments({ vfs, composer: $('composer'), input: $('input'), picker: $('attachment-picker'), button: $('attach-file'), chips: $('attachment-chips'), warning: $('attachment-warning'), status });
const submitting = new Set(); // per session: a send from Enter until its model turn ends (after-turn chores run on)
// While Pouch works (JOURNEYS D25), a message is a Steer or a Follow-up
// (LANGUAGE.md). A steer joins the running turn at its next step boundary: a
// pi-durable steer, tracked here so Stop can take it back. A follow-up is held
// here (one slot per session; queuing is the strategy, not the name) and starts
// the next turn once the model's turn ends, before any wake from an agent
// (subagents.js userFirst). Input is never dropped: it is steered, held as a
// follow-up, paused after Stop, or refused with a reason.
const followUps = new Map(); // session key -> { text, attached, turnModel, at, paused? }
const steers = new Map(); // session key -> [{ id, text, at, detach?, child?, name? }] (child: a subagent's)
const childFollowUps = new Map(); // child id -> { sid, text, name, at, paused? }
let holdingFollowUp = false;
const curKey = () => String(sessions.current?.id ?? 'new');
const noFiles = () => ({ files: [], images: [] });
const otherMode = (m) => (m === 'steer' ? 'followup' : 'steer');
const MODE_LABEL = { steer: 'Steer', followup: 'Follow-up' };
const MODE_VERB = { steer: 'steer', followup: 'send a follow-up' };
// Changes to pending input go to a polite live region; shown too when `seen`.
let liveTimer = 0;
function announce(text, seen = true) {
  const r = $('send-live');
  r.textContent = '';
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { r.textContent = text; }, 40);
  if (seen) status(text);
}
// The subagents main's running turn is blocked on (a foreground spawn, a join), by name.
function waitingOn(sid = sessions.current?.id) {
  if (sid == null || !agent?.subagents) return [];
  const l = kids.get(String(sid)) ?? [];
  return [...new Set(agent.subagents.blocked(sid).flatMap((h) => h.ids))].map((ref) => l.find((c) => refOf(l, c) === ref)?.name ?? ref);
}
const hasDraft = () => !!$('input').value.trim() || (!focus && attachments.files.length > 0);
// The accessible name starts with the visible label (WCAG 2.5.3), so "Stop"
// and "Stop all" name the same action here, in the tray and on a phone.
function setSend(kind, title, label = { stop: 'Stop', followup: 'Follow-up', send: 'Send' }[kind], name = null) {
  $('send-label').textContent = label;
  $('send').title = title;
  $('send').ariaLabel = kind === 'stop' ? name ?? label : null;
  if (kind === 'stop' && !focus) $('send').setAttribute('aria-keyshortcuts', 'Escape'); else $('send').removeAttribute('aria-keyshortcuts');
  $('send').classList.toggle('stop', kind === 'stop');
  $('send').classList.toggle('followup', kind === 'followup');
  $('send').querySelector('use').setAttribute('href', kind === 'stop' ? '#i-stop' : '#i-send');
}
// The split button (Steer or Follow-up, and a menu) beside Stop: shown while the
// agent in view works and the draft is not empty.
function showSplit(on, who) {
  const box = $('sendmode'), m = settings.sendMode(), other = otherMode(m);
  box.hidden = !on;
  if (!on) return closeSendMenu();
  const blocked = !focus ? waitingOn() : [];
  $('sendmode-label').textContent = MODE_LABEL[m];
  const what = m === 'steer' ? `Steer: send into ${who}'s current turn, read after its current step (Enter)` : `Follow-up: send after ${who}'s turn ends (Enter)`;
  $('sendmode-main').ariaLabel = `${what}. Alt+Enter to ${MODE_VERB[other]} instead.` + (m === 'steer' && blocked.length ? ` Steering will detach ${blocked.join(', ')}.` : '');
  $('sendmode-main').title = $('sendmode-main').ariaLabel;
  // One-shot sends are plain menu items (critique 4): the key that does the
  // same is said in text; the setting is its own item below a separator.
  const draft = hasDraft();
  $('sendmode-main').disabled = !draft;
  for (const b of $('sendmode-menu').querySelectorAll('[data-mode]')) {
    const keys = b.dataset.mode === m ? 'Enter' : b.dataset.mode === other ? 'Alt+Enter' : null;
    const k = b.querySelector('.sm-key');
    if (k) k.textContent = keys ? ` (${keys})` : '';
    b.title = b.firstElementChild.textContent + (keys ? ` (${keys})` : '');
    if (b.dataset.mode !== 'settings') b.ariaDisabled = String(!draft);
  }
  $('sendmode-enter').textContent = `Enter now ${m === 'steer' ? 'steers' : 'sends a follow-up'}.`;
  const note = $('sendmode-detach');
  note.hidden = !blocked.length;
  note.textContent = blocked.length ? `Steering will detach ${blocked.join(', ')}` : '';
  $('sendmode-menu').querySelector('[data-mode="stopsend"]').hidden = !!focus;
}
// The context meter (src/context.js): about how many tokens main's next request
// would carry, against the window of the model in the picker (where it goes).
// From the stored transcript only: computing it sends nothing. Hidden in a
// subagent's view and before the session holds anything.
function contextNow() {
  const id = $('model').value, c = !focus && contextFor(view?.context, isLocal(id));
  if (!c?.tokens) return null;
  const sealed = models.find((m) => m.id === id), host = isLocalhost(id) ? lh?.models?.find((m) => 'localhost:' + m.id === id) : null;
  const known = isLocal(id) ? null : host ? host.contextWindow ?? null : sealed?.windowReported ? sealed.contextWindow : null;
  // Where pi-durable compacts uses the window pi-ai was given, defaults included (src/agent.js, src/localhost.js).
  const used = isLocal(id) ? null : host ? host.contextWindow ?? 32_768 : sealed?.contextWindow ?? null;
  return { ctx: c, d: describeContext(c, { window: known, budget: isLocal(id) ? BUDGET : null, auto: used && autoCompactAt(used, compactionFor(used)) }) };
}
function renderCtx() {
  const b = $('composer-ctx');
  if (!b) return;
  const now = contextNow();
  b.hidden = !now;
  if (!now) { if ('ctx' in $('composer-usage').dataset) { delete $('composer-usage').dataset.ctx; labelComposer(); } return; }
  const { d, ctx } = now;
  b.dataset.level = d.level;
  b.style.setProperty('--fill', d.fill == null ? '0%' : `${Math.round(d.fill * 100)}%`);
  $('composer-ctx-num').textContent = d.count;
  $('composer-ctx-of').textContent = d.of ? ` / ${d.of}` : '';
  $('composer-ctx-trim').hidden = !ctx.trimmed;
  if ($('composer-usage').dataset.ctx !== d.label) { $('composer-usage').dataset.ctx = d.label; labelComposer(); }
}
function updateSend() {
  renderCtx();
  const input = $('input');
  if (focus) {
    // The subagent's view: steer or follow up while it works; once it is done
    // the composer says so and sends nothing (it never starts a new turn).
    const c = focusedChild(), live = c?.status === 'running';
    input.dataset.child = String(focus.id);
    input.disabled = !live;
    const ended = { stopped: 'was stopped', failed: 'failed', interrupted: 'was interrupted' }[c?.status] ?? 'has finished';
    input.placeholder = live ? `Steer ${c.name}: it reads this after its current step` : `${c?.name ?? 'This subagent'} ${ended}. Go back to ${parentName(sessions.current)} to continue.`;
    if (live) setSend('stop', `Stop ${c.name}`, 'Stop', `Stop ${c.name}`);
    else setSend('send', `The subagent ${ended}`);
    $('send').disabled = !live;
    showSplit(live, c?.name);
    return;
  }
  if (input.dataset.child) {
    delete input.dataset.child;
    input.disabled = false;
    input.placeholder = offline && !localPicked() ? 'Offline: keep typing; Send comes back with the network' : PLACEHOLDER;
  }
  const b = busy(), finishing = !b && submitting.has(curKey());
  // Stop here also stops this session's subagents: then it says Stop all, as the tray does.
  const others = b && (kids.get(String(sessions.current?.id)) ?? []).some((c) => c.status === 'running');
  if (b) setSend('stop', others ? 'Stop Pouch and its subagents (Esc)' : 'Stop Pouch (Esc)', others ? 'Stop all' : 'Stop');
  else if (finishing) setSend('followup', 'Pouch is starting the turn. Send this as a follow-up; it goes when Pouch is ready.');
  else setSend('send', 'Send');
  $('send').disabled = !b && !canSend();
  if (!b && offline && !localPicked()) $('send').title = OFFLINE;
  $('composer').classList.toggle('offline', offline);
  showSplit(b, 'Pouch');
  if (followUps.size) queueMicrotask(pump);
}
// Send the current session's follow-up once the model's turn is over.
function pump() {
  const key = curKey(), q = followUps.get(key);
  if (!q || q.paused || busy() || submitting.has(key) || holdingFollowUp || !(offSealed(q.turnModel) ? agent : agent && verified && !offline)) return;
  followUps.delete(key);
  announce('Follow-up sent: it starts the next turn.', false);
  dispatch(key, () => q);
}
// One send with its bookkeeping. prepare() -> { text, attached, turnModel }.
async function dispatch(key, prepare) {
  spend.delete('new'); spend.set(String(key), 0); // this session's "requests this turn" starts over
  changes.begin(key); // and so does /session/<sid>/changes
  submitting.add(key); updateSend(); composer.renderTray();
  let q = null, k = key;
  const runEnded = () => { submitting.delete(k); updateSend(); composer.renderTray(); };
  // A first message's session is made inside send(): from then on this send
  // belongs to it, so "new" is free for the next New (New, then Enter).
  const adopted = (id) => { submitting.delete(k); k = String(id); submitting.add(k); };
  try { q = await prepare(); if (q) await send(q.text, q.attached, q.turnModel, runEnded, adopted); }
  catch (e) {
    // The watched view can say idle a moment before pi-durable's run ends:
    // then the follow-up waits and goes on the next try.
    if (q && /still running/.test(e.message) && !followUps.has(key) && (q.tries = (q.tries ?? 0) + 1) <= 25) { followUps.set(key, q); setTimeout(pump, 400); }
    else {
      status(e.message, 'bad');
      if (q && !$('input').value.trim()) { $('input').value = q.text; autosize(); } // not sent: the text comes back
    }
  }
  finally { runEnded(); }
}
// Back into the composer, before what is typed there (Edit, Cancel, Alt+Up).
function putBack(text) {
  const now = $('input').value.trim();
  $('input').value = now ? `${text}\n\n${now}` : text;
  autosize(); updateSend();
  $('input').focus();
}
function cancelFollowUp(key, how = 'cancelled') {
  const q = followUps.get(key);
  if (!q) return;
  followUps.delete(key);
  putBack(q.text);
  announce(how === 'edit' ? 'Follow-up back in the box for editing.' : q.attached.files.length ? 'Follow-up cancelled and put back; its attachments are still in your files.' : 'Follow-up cancelled and put back in the box.');
  composer.renderTray(); updateSend();
}
// Hold the draft as the follow-up, or add it to the one follow-up (said so).
async function holdFollowUp(key, prepare) {
  if (key === 'new') return status('Wait a moment: the session is still starting. Your message stays here.', 'bad');
  if (holdingFollowUp) return status('Still holding the last follow-up. This one stays here.', 'bad');
  holdingFollowUp = true;
  try {
    const q = await prepare(), had = followUps.get(key);
    if (had) {
      followUps.set(key, { ...had, text: `${had.text}\n\n${q.text}`, attached: { files: [...had.attached.files, ...q.attached.files], images: [...had.attached.images, ...q.attached.images] } });
      announce(had.paused ? 'Added to the paused message.' : 'Added to the follow-up: both go together after this turn.');
    } else {
      followUps.set(key, q);
      announce('Follow-up: it goes after this turn.');
    }
  } catch (err) { status(err.message, 'bad'); }
  finally { holdingFollowUp = false; composer.renderTray(); updateSend(); }
}
// Steer main (the composer, Steer now): written to main's in file; the
// harness side (steerSession) detaches a subagent main waits on, tracks it in
// the tray and announces it, whoever wrote.
let promoteNext = false; // Steer now: the tray row morphs in place
async function steerMain(key, text, promoted = false) {
  $('input').value = ''; autosize();
  promoteNext = promoted;
  try { await ctl(agentFile(key, MAIN, 'in'), 'steer\n' + text); }
  catch (e) { putBack(text); status(why(e), 'bad'); }
  finally { promoteNext = false; }
}
// The composer's follow-up for main, text only, is a file write too; one
// with attachments is held directly, because attachments are page-held
// files and blobs a write to in cannot carry (README "Control plane").
async function followUpMain(key, text, prepare) {
  if (key === 'new' || attachments.files.length) return holdFollowUp(key, prepare);
  $('input').value = ''; autosize();
  try { await ctl(agentFile(key, MAIN, 'in'), 'followup\n' + text); }
  catch (e) { putBack(text); status(why(e), 'bad'); }
}
// Follow a steer until it is placed: delivered into the turn, or (it raced
// the turn's end) the start of the next turn, which runs like any other.
// Steer now keeps the row in place; only its label and edge change (morph).
function track(key, sid, s, placed, promoted = false) {
  steers.set(key, [...(steers.get(key) ?? []), s]);
  if (promoted) arm('morph:steer:' + s.id);
  composer.renderTray();
  placed.then(async (p) => {
    const list = steers.get(key) ?? [], i = list.indexOf(s);
    if (i < 0) return; // taken back (Cancel, Stop)
    // Delivered: the tray item travels into its place in the transcript (FLIP).
    const row = $('tray-list').querySelector(`[data-key="steer:${CSS.escape(String(s.id))}"]`);
    if (p && !p.late && row && !$('tray').classList.contains('collapsed')) { arrivals.set(s.id, { text: s.text, first: row.getBoundingClientRect() }); arm('arrive:' + s.id); arm('glow:' + s.id); }
    list.splice(i, 1);
    if (!list.length) steers.delete(key);
    composer.renderTray(); updateSend();
    if (/^Steering/.test($('status').textContent)) status(''); // critique 8: it was read
    if (!p && !s.withdrawing) return unplaced(key, s);
    if (!p) return;
    const who = s.child ? s.name : 'Pouch';
    if (!p.late) { scheduleRender(); return announce(`Steering delivered to ${who}.`, false); }
    announce(`${who} had finished its turn, so your steering message was sent as the next turn.`);
    if (!s.child) drive(sid, () => agent.waitFor(sid, s.id));
  }, () => {});
}
// A steer that raced the run's end and was never placed (nor withdrawn):
// it becomes the follow-up and goes as the next turn, never lost.
function unplaced(key, s) {
  if (s.child) { putBack(s.text); return status(`${s.name} ended before it read your message; it is back in the box.`, 'bad'); }
  const q = followUps.get(key);
  followUps.set(key, { attached: noFiles(), turnModel: $('model').value, at: Date.now(), ...q, text: [q?.text, s.text].filter(Boolean).join('\n\n'), paused: false });
  announce('Pouch had just finished, so your message is a follow-up and goes as the next turn.');
  composer.renderTray(); updateSend(); queueMicrotask(pump);
}
// Steering messages travelling from the tray into the transcript: id -> { text, first }.
const arrivals = new Map();
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
function playArrivals(log) {
  for (const [id, a] of arrivals) {
    if (!armed('arrive:' + id) && !armed('glow:' + id)) { arrivals.delete(id); continue; }
    const want = norm(a.text).slice(0, 80);
    const m = [...log.querySelectorAll('.msg')].findLast((n) => n.querySelector('.sa-who')?.textContent === STEER_LABEL && norm(n.querySelector('.body')?.textContent).startsWith(want));
    if (!m) continue;
    m.classList.add('arrived');
    m.dataset.arrival = String(id);
    a.kf ??= flipFrom(a.first)(m); // measured once, on the first node it lands in
    play(m, 'arrive:' + id, a.kf, 200);
    // No glow box: it drew a second border around the bubble mid-move (critique 9).
  }
}
// Detach (G10, G12): the foreground card folds into its tray row, keeping its hue.
function heldCards(sid) {
  const refs = new Set(agent?.subagents?.blocked(sid).flatMap((h) => h.ids) ?? []);
  const l = kids.get(String(sid)) ?? [];
  // Its card, or while a foreground spawn is still running, its spawn pill.
  const pill = (c) => [...$('log').querySelectorAll('details.tool')].findLast((d) => new RegExp(`spawn (one-shot )?${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(d.querySelector('.what')?.textContent ?? ''));
  return l.filter((c) => refs.has(refOf(l, c))).map((c) => ({ id: c.id, card: snapshot($('log').querySelector(`.subagent[data-child="${CSS.escape(String(c.id))}"]`) ?? pill(c)) }));
}
function foldIntoTray(held) {
  composer.renderTray();
  for (const h of held) {
    arm('fold:sa:' + h.id);
    const row = $('tray-list').querySelector(`[data-key="sa:${CSS.escape(String(h.id))}"]`);
    if (h.card && row) fold(h.card, row);
  }
  composer.renderTray();
}
// What a tray row carries over a rebuild: its fold or morph highlight.
function trayRowMotion(li, r) {
  play(li, 'fold:' + r.key, [{ opacity: 0.4, transform: 'scale(1.02)' }, { opacity: 1, transform: 'none' }], 900);
  if (r.kind === 'steer') play(li, 'morph:' + r.key, [{ opacity: 0.6 }, { opacity: 1 }], 600, { mark: 'morphed' });
}
// Take back steers that are not placed yet (Cancel, Stop); their texts.
async function withdrawSteers(key, sid, which = () => true) {
  const list = steers.get(key) ?? [], back = [];
  const mine = list.filter(which);
  for (const s of mine) s.withdrawing = true; // its placement may resolve null meanwhile: not lost
  for (const s of mine) {
    const r = await agent.withdraw(sid, s.id).catch(() => 'settled');
    list.splice(list.indexOf(s), 1);
    if (r === 'aborted') back.push(s.text);
  }
  if (!list.length) steers.delete(key);
  return back;
}
// Stop (button, Esc, Stop and send): never sends anything by itself. Steers
// not yet read and the follow-up become one paused item: Send or Cancel.
// Sealed requests sent since the user's last message (all sessions of the page:
// one at a time is the norm), for the tray header.
// Per session: sid -> requests since its user's last message. A request is
// counted for the session whose run is active (with its subagents); when
// several run at once, for the one in view if it is among them.
const spend = new Map();
const activeSids = () => {
  const out = new Set([...sessions.running].map(String));
  for (const [sid, l] of kids) if (l.some((c) => c.status === 'running')) out.add(String(sid));
  return [...out];
};
function countRequest() {
  const act = activeSids(), cur = sessions.current?.id != null ? String(sessions.current.id) : 'new';
  const sid = act.includes(cur) || !act.length ? cur : act[0];
  spend.set(sid, (spend.get(sid) ?? 0) + 1);
  ledger.add(sid, 'turn').then(meter);
  composer?.renderTray();
}
// A first message is dispatched as 'new' before its session exists.
const turnSpend = () => spend.get(String(sessions.current?.id ?? 'new')) ?? spend.get('new') ?? null;
// Keys of sessions whose Stop is still winding down (the abort not settled).
const stopping = new Set();
// Stop main (the button, Esc, Stop and send): Stop in a session stops its
// subagents too, so the Interface writes "stop all" to main's ctl.
async function stopMain(sid = sessions.current?.id) {
  if (sid == null) return;
  await ctl(agentFile(sid, MAIN, 'ctl'), 'stop all').catch((e) => status(why(e), 'bad'));
}
// ── Control plane: the harness side ───────────────────────────────
// What a write to /session does, whoever wrote it (the Interface, the
// terminal, the main agent). The only place the Interface calls the harness
// to act; test/controlplane-node.mjs checks that nothing outside does.
const busyIn = (sid) => (sameId(sid, sessions.current?.id) ? busy() : sessions.running.has(String(sid)));
const childByRef = (sid, ref) => { const l = kids.get(String(sid)) ?? []; return l.find((x) => refOf(l, x) === asRef(ref)) ?? l.find((x) => x.id === ref); };
const ctlErr = (msg) => Object.assign(new Error(msg), { code: 'EINVAL' });
async function stopSession(sid, all) {
  const key = String(sid);
  if (!sessions.running.has(key) && !busyIn(sid)) { if (all) await agent?.subagents?.stopAll?.(sid); return all ? 'stopped its subagents' : 'main (a1) is idle'; }
  stopping.add(key); updateSend();
  try {
    const back = await withdrawSteers(key, sid, (s) => !s.child);
    const q = followUps.get(key);
    if (back.length || q) {
      followUps.set(key, { attached: noFiles(), turnModel: $('model').value, at: Date.now(), ...q, text: [...back, q?.text].filter(Boolean).join('\n\n'), paused: true });
      announce('Stopped. Your unsent message is paused: Send it or Cancel it in the activity tray.');
    }
    composer.renderTray();
    // Stop in a session stops its subagents too (as Stop all does).
    await Promise.allSettled([agent.abort(sid), all ? agent?.subagents?.stopAll?.(sid) : null]);
    // A steer that slipped in while the run wound down (Enter right after
    // Stop) has no step left to be read after: it becomes the next turn.
    const late = await withdrawSteers(key, sid, (s) => !s.child);
    if (late.length) {
      const q2 = followUps.get(key);
      followUps.set(key, { attached: noFiles(), turnModel: $('model').value, at: Date.now(), ...q2, text: [q2?.text, ...late].filter(Boolean).join('\n\n'), paused: q2?.paused ?? false });
      announce(q2?.paused ? 'Pouch stopped before reading your message: it joined the paused message in the activity tray.' : 'Pouch stopped before reading your message, so it goes as the next turn.');
    }
  } finally { stopping.delete(key); composer.renderTray(); updateSend(); queueMicrotask(pump); }
}
// Stop one subagent: steers not yet read and its follow-up become one paused item.
async function stopChildOf(sid, id) {
  const c = childByRef(sid, id) ?? (kids.get(String(sid)) ?? []).find((x) => x.id === id);
  if (!c) throw ctlErr(`no agent ${id} in this session`);
  const key = String(sid);
  const back = await withdrawSteers(key, sid, (s) => s.child === c.id);
  const q = childFollowUps.get(c.id);
  if (back.length || q) {
    childFollowUps.set(c.id, { sid, name: c.name, at: Date.now(), ...q, text: [...back, q?.text].filter(Boolean).join('\n\n'), paused: true });
    announce(`Stopped ${c.name}. Your unsent message to it is paused in the activity tray.`);
  }
  composer.renderTray();
  const note = await agent.subagents.stop(sid, c.id);
  // A ctl write returns once it took effect: reading its status next says stopped.
  for (let i = 0; i < 60 && (await loadKids(sid)).find((x) => x.id === c.id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
  return note;
}
// Main's steer: detach a subagent it waits on (G10), then track it in the tray.
async function steerSession(sid, text) {
  const key = String(sid), names = waitingOn(sid);
  let s = names.length ? await agent.subagents.detach(sid, text) : null;
  if (!s || s === true) s = await agent.steer(sid, text);
  watches.userSpoke(sid);
  const held = names.length && sameId(sid, sessions.current?.id) ? heldCards(sid) : [];
  track(key, sid, { id: s.id, text, at: Date.now(), ...(names.length ? { detach: names.join(', ') } : {}) }, s.placed, promoteNext);
  if (held.length) foldIntoTray(held);
  announce(names.length ? `Steering: Pouch reads this after its current step. Main stopped waiting on ${names.join(', ')}; it keeps running.` : 'Steering: Pouch reads this after its current step.');
  return { id: s.id };
}
// A subagent's follow-up goes once its turn ends (it finished): the
// message wakes it, like Message on its card. Stopped or failed: paused.
function flushChildFollowUps(sid, list) {
  for (const [id, q] of childFollowUps) {
    if (q.paused || String(q.sid) !== String(sid)) continue;
    const c = list.find((x) => x.id === id);
    if (c?.status === 'running') continue;
    if (c?.status !== 'finished') { childFollowUps.set(id, { ...q, paused: true }); announce(`${q.name} ${c?.status ?? 'is gone'}; your follow-up to it is paused.`); continue; }
    childFollowUps.delete(id);
    agent.subagents.message(sid, id, q.text).then(() => announce(`Follow-up sent to ${q.name}; it works on it now.`, false), (e) => { childFollowUps.set(id, { ...q, paused: true }); status(e.message, 'bad'); });
  }
}
control.drive({
  async stop(sid, ref, { all }) {
    if (!agent) throw ctlErr('the agent is not available');
    if (asRef(ref) === MAIN) return stopSession(sid, all);
    return stopChildOf(sid, ref);
  },
  async detach(sid, ref) {
    const held = agent?.subagents?.blocked(sid).flatMap((h) => h.ids) ?? [];
    if (!held.length) throw ctlErr('main is not waiting on any subagent');
    if (asRef(ref) !== MAIN && !held.includes(asRef(ref))) throw ctlErr(`main is not waiting on ${asRef(ref)} (it waits on ${held.join(', ')})`);
    const cards = sameId(sid, sessions.current?.id) ? heldCards(sid) : [];
    await agent.subagents.detach(sid);
    foldIntoTray(cards);
    const names = held.map((r) => childByRef(sid, r)?.name ?? r);
    status(`${names.join(', ')} ${names.length > 1 ? 'continue' : 'continues'} in the background; main stopped waiting.`);
    return { detached: held };
  },
  async send(sid, ref, mode, text) {
    if (!agent) throw ctlErr('the agent is not available');
    const key = String(sid);
    if (asRef(ref) === MAIN) {
      const working = busyIn(sid) || submitting.has(key);
      if (mode === 'followup') { await holdFollowUp(key, async () => ({ text, attached: noFiles(), turnModel: $('model').value, at: Date.now() })); return { followup: true }; }
      if (working) return steerSession(sid, text);
      if (mode === 'steer') throw ctlErr('main (a1) is idle, so there is no turn to steer: write message to start one, or followup');
      if (!sameId(sid, sessions.current?.id)) throw ctlErr('a turn starts only in the session open in the Interface: open it, or write followup to queue this');
      dispatch(key, async () => ({ text, attached: noFiles(), turnModel: $('model').value, at: Date.now() }));
      return { started: true };
    }
    const c = childByRef(sid, ref);
    if (!c) throw ctlErr(`no agent ${ref} in this session`);
    if (mode === 'steer') {
      if (c.status !== 'running') throw ctlErr(`${c.name} (${asRef(ref)}) is not running (${c.status}): write message to start it again`);
      const s = await agent.subagents.steerTracked(sid, c.id, text);
      track(key, sid, { id: s.id, text, at: Date.now(), child: c.id, name: c.name }, s.placed);
      announce(`Steering ${c.name}: it reads this after its current step.`);
      return { id: s.id };
    }
    if (mode === 'followup' && c.status === 'running') {
      const had = childFollowUps.get(c.id);
      childFollowUps.set(c.id, { sid, name: c.name, at: Date.now(), ...had, text: had ? `${had.text}\n\n${text}` : text, paused: false });
      announce(had ? `Added to the follow-up for ${c.name}.` : `Follow-up for ${c.name}: it goes when its turn ends.`);
      composer.renderTray(); updateSend();
      return { followup: true };
    }
    if (c.oneshot) throw ctlErr(`${c.name} is a one-shot and takes no messages`);
    childFollowUps.delete(c.id);
    const note = await agent.subagents.message(sid, c.id, text);
    status(`Sent to ${c.name}.`);
    return { note };
  },
});
// ── End of the harness side ───────────────────────────────────────

// A paused message or follow-up goes now: as the next turn when idle, or into
// the running turn (Steer now).
async function sendNow(key, steer) {
  const q = followUps.get(key);
  if (!q) return;
  if (!busy() && !submitting.has(key)) { followUps.delete(key); return dispatch(key, () => q); }
  if (!steer) { followUps.set(key, { ...q, paused: false }); announce('Follow-up: it goes after this turn.'); return composer.renderTray(); }
  if (q.attached.files.length || q.attached.images.length) return status('This follow-up has attachments, which go only with a new turn; it stays a follow-up.', 'bad');
  followUps.delete(key);
  const keep = $('input').value;
  await steerMain(key, q.text, true);
  if (keep && !$('input').value) { $('input').value = keep; autosize(); }
  composer.renderTray(); updateSend();
}
const NOT_ADMITTED = /^Not connected|still running/;
// HTTP 429 or a quota message, from the relay or the model provider.
function quotaError(msg) { return /\b429\b|quota|rate.?limit|too many requests|allowance/i.test(msg ?? ''); }

// runEnded: called once the model's turn is over, before the after-turn
// chores (title, usage), so a follow-up need not wait for them.
async function send(text, attached = { files: [], images: [] }, turnModel = $('model').value, runEnded = () => {}, adopted = () => {}) {
  follow.pin();
  lastTouch = 0; // sending hands the turn over: the keys that sent it do not make the person busy
  const t0 = Date.now();
  if (!sessions.current) { await sessions.create(); ledger.adopt('new', sessions.current.id); adopted(sessions.current.id); }
  const s = sessions.current; // the run belongs to this session even if you switch away
  const sid = s.id;
  s.model = turnModel;
  // Until a real title comes: the prompt's start, cut at a word, without trailing / . , : (critique 6).
  if (!s.title) { const t = text.replace(/\s+/g, ' ').trim(); s.title = (t.length > 60 ? t.slice(0, 60).replace(/\s+\S*$/, '') || t.slice(0, 60) : t).replace(/[\s/.,:;-]+$/, ''); }
  s.updated = Date.now(); await sessions.save();
  if (interrupted && sameId(sid, sessions.current?.id)) interrupted = false;
  await store.setSetting(interruptedKey(sid), undefined);
  sessions.running.add(String(sid)); sessions.render();
  lostRuns.delete(String(sid));
  if (isLocal(turnModel)) { localRuns.add(String(sid)); clearHint(sid); }
  if (isLocalhost(turnModel)) lhRuns.add(String(sid));
  activeRun = String(sid);
  const notes = (await store.getSetting(notesKey(sid))) ?? [];
  const admitted = () => notes.length && store.setSetting(notesKey(sid), undefined);
  let ok = false, refused = null;
  watches.userSpoke(sid); // the user wrote: watches may wake it again
  try { await agent.send(sid, text, notes, attached, turnModel); admitted(); ok = true; }
  catch (e) {
    // Refused before admission: nothing entered the transcript. The caller
    // holds it as a follow-up or restores the text (dispatch), so it is never lost.
    if (NOT_ADMITTED.test(e.message)) refused = e;
    // Stopped before the message entered the transcript: it was never sent,
    // so it comes back to the box (dispatch) rather than vanishing.
    else if (e.message === 'Stopped.' && !(await agent.snapshot(sid).catch(() => null))?.items.some((i) => i.type === 'user' && i.text === text)) refused = new Error('Stopped before your message was sent; it is back in the box.');
    else admitted();
    // The run's own error (an assistant item) may carry the HTTP status the summary lost.
    const detail = e.message + ' ' + (view?.items.findLast?.((i) => i.error)?.error ?? '');
    if (isLocalhost(turnModel)) { if (!refused && e.message !== 'Stopped.') status('Localhost: ' + (explainMessage(detail, turnModel.slice('localhost:'.length)) ?? e.message), 'bad'); }
    else if (quotaError(detail)) status(exhaustedText(await usage.refresh()), 'bad');
    else if (!isLocal(turnModel) && (lostRuns.has(String(sid)) || isNetworkError(detail))) {
      lostRuns.add(String(sid));
      if (!navigator.onLine || !(await probe())) goOffline();
      else status('Connection lost during the turn; nothing more was sent. Send again to continue.', 'bad');
    }
    else if (!refused && e.message !== 'Stopped.') status('Request failed: ' + e.message, 'bad');
  }
  finally { sessions.running.delete(String(sid)); localRuns.delete(String(sid)); lhRuns.delete(String(sid)); activeRun = null; runEnded(); if (lhWaitShown) localhostWait('flowing'); }
  if (refused) throw refused;
  const ms = Date.now() - t0;
  const v = await agent.snapshot(sid).catch(() => null);
  await recordTurn(sid, v, ms);
  await sessions.afterTurn(sid, v, ok, turnModel);
}

// mode: 'default' (Enter, the setting), 'other' (Alt+Enter), or one of
// 'steer', 'followup', 'stopsend' (the split button and its menu).
let nextMode = 'default';
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const asked = nextMode; nextMode = 'default';
  const mode = asked === 'default' ? settings.sendMode() : asked === 'other' ? otherMode(settings.sendMode()) : asked;
  const raw = $('input').value;
  if (focus) return toChild(raw.trim(), mode);
  if (composer.runCommand(raw)) { $('input').value = ''; autosize(); return; }
  const key = curKey();
  const text = raw.trim() || (attachments.files.length ? 'Please examine the attached files.' : '');
  if (!text) return;
  const turnModel = $('model').value; // freeze before any asynchronous preparation
  if (isLocalhost(turnModel)) {
    // Localhost needs your server, not the internet or the enclave.
    if (!agent) return status(agentError ?? 'The agent is not available.', 'bad');
    if (!lhModels().some((m) => 'localhost:' + m.id === turnModel)) return status('That Localhost model is not set up in this browser: Settings > Providers > Localhost, Test connection. Your message stays here.', 'bad');
  } else if (isLocal(turnModel)) {
    // Transformers.js needs no network or enclave, only the model in this browser.
    if (!agent) return status(agentError ?? 'The agent is not available.', 'bad');
    if (!(await ensureLocal())) return; // the text stays in the composer
  } else {
    if (offline) return status(OFFLINE, 'offline'); // the text stays in the composer
    if (!agent || !verified) return status(agentError ?? 'Not ready yet: Pouch is still verifying the enclave. Your message stays here.', 'bad');
  }
  const prepare = async () => {
    const attached = await attachments.prepare(models.find((m) => m.id === turnModel) ?? { id: turnModel, multimodal: false });
    if (key !== curKey()) throw new Error('Session changed while preparing attachments. Review this message and press Send again. Nothing was sent.');
    $('input').value = ''; autosize(); attachments.clear(attached.files);
    return { text, attached, turnModel, at: Date.now() };
  };
  if (!busy() && !submitting.has(key)) { status(''); return dispatch(key, prepare); }
  if (busy() && mode === 'stopsend') {
    await stopMain();
    return dispatch(key, prepare);
  }
  // Stop is winding down: no step is left to read a steer, so the text
  // waits as a follow-up and goes as the next turn once the run has ended.
  if (stopping.has(key)) { announce('Pouch is stopping: your message goes as the next turn.'); return followUpMain(key, text, prepare); }
  // Steering carries text only; attachments go with a follow-up.
  if (busy() && mode === 'steer' && !attachments.files.length) return steerMain(key, text);
  if (busy() && mode === 'steer') announce('Attachments go only with a new turn, so this message is a follow-up for after this turn.');
  return followUpMain(key, text, prepare);
};
function blockedNow() { const sid = sessions.current?.id; return sid != null && !!agent?.subagents?.blocked(sid).length; }
// While the agent in view works, the round button is Stop.
$('send').onclick = (e) => {
  if (focus) {
    const c = focusedChild();
    if (c?.status === 'running') { e.preventDefault(); stopChild(c); }
    return;
  }
  if (busy()) { e.preventDefault(); stopMain(); }
};
// The subagent's view: steer joins its run at its next step boundary (S3);
// follow-up waits for its turn to end, then messages it. Both are writes to
// its in file; Stop writes its ctl. The harness side does the rest.
async function toChild(text, mode) {
  const c = focusedChild();
  if (!text || !c) return;
  $('input').value = ''; autosize();
  try { await ctl(agentFile(focus.sid, refOf(kids.get(String(focus.sid)) ?? [], c), 'in'), `${mode}\n${text}`); }
  catch (e) { putBack(text); status(why(e), 'bad'); updateSend(); }
}
async function stopChild(c) {
  const sid = focus?.sid ?? sessions.current?.id;
  await ctl(agentFile(sid, refOf(kids.get(String(sid)) ?? [], c), 'ctl'), 'stop').catch((e) => status(why(e), 'bad'));
}
// Keys (D25): Enter sends with the default mode, Alt/Option+Enter with the
// other, Shift+Enter is a new line, Esc stops, Alt+Up takes the follow-up
// message back. Ctrl+Alt is AltGr (a character), never Alt. On touch
// screens Enter is a new line and the buttons send.
const altOnly = (e) => e.altKey && !e.ctrlKey && !e.metaKey;
$('input').onkeydown = (e) => {
  if (e.isComposing || e.keyCode === 229) return; // an IME is composing: its Enter is not ours
  if (composer.onKeydown(e)) return;
  if (e.key === 'Escape' && $('sendmode-menu').hidden) {
    // In a subagent view Esc returns to the parent (the document handler);
    // its Stop is a button. In main, Esc stops the run.
    if (!focus && busy()) { e.preventDefault(); stopMain(); }
    return;
  }
  if (e.key === 'ArrowUp' && altOnly(e)) {
    const key = curKey();
    if (!focus && followUps.has(key)) { e.preventDefault(); cancelFollowUp(key, 'edit'); }
    else if (focus && childFollowUps.has(focus.id)) { e.preventDefault(); const q = childFollowUps.get(focus.id); childFollowUps.delete(focus.id); putBack(q.text); composer.renderTray(); }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    nextMode = e.altKey ? 'other' : 'default';
    $('composer').requestSubmit();
  }
};
// The split stays for the whole running turn (critique 5); its send actions wait for a draft.
$('input').addEventListener('input', () => { if ($('sendmode-main').disabled === hasDraft()) updateSend(); });
// The split button: its main part sends with the default mode; the chevron
// opens a menu (arrow keys move, Esc closes and returns focus).
function closeSendMenu(refocus) {
  const menu = $('sendmode-menu');
  if (menu.hidden) return;
  menu.hidden = true; $('sendmode-more').ariaExpanded = 'false';
  if (refocus) $('sendmode-more').focus();
}
function openSendMenu() {
  const menu = $('sendmode-menu');
  menu.hidden = false; $('sendmode-more').ariaExpanded = 'true';
  // Focus what Enter would do (or, with no draft yet, the setting).
  const enter = menu.querySelector(`[data-mode="${settings.sendMode()}"]`);
  (enter?.ariaDisabled === 'true' ? menu.querySelector('[data-mode="settings"]') : enter ?? menu.querySelector('button')).focus();
}
$('sendmode-main').onclick = () => { nextMode = 'default'; $('composer').requestSubmit(); };
$('sendmode-more').onclick = () => ($('sendmode-menu').hidden ? openSendMenu() : closeSendMenu(true));
$('sendmode-menu').onclick = (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b || b.ariaDisabled === 'true') return;
  closeSendMenu();
  if (b.dataset.mode === 'settings') return layout.open('settings');
  nextMode = b.dataset.mode;
  $('composer').requestSubmit();
  $('input').focus();
};
$('sendmode-menu').onkeydown = (e) => {
  const items = [...$('sendmode-menu').querySelectorAll('button:not([hidden])')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items.at(e.key === 'Home' ? 0 : -1).focus(); }
  else if (e.key === 'Tab') closeSendMenu();
};
dismissible({ isOpen: () => !$('sendmode-menu').hidden, inside: () => [$('sendmode')], close: (how) => closeSendMenu(how === 'esc') });
document.addEventListener('pouch-sendmode', () => updateSend());
function autosize() { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight + 2, innerHeight * 0.4) + 'px'; }
$('input').addEventListener('input', autosize);
$('composer-usage').onclick = () => layout.toggle('usage');
// Follow-ups and paused messages live in this page only: ask before a reload or close drops them.
addEventListener('beforeunload', (e) => { if (followUps.size || childFollowUps.size || steers.size) e.preventDefault(); });

// Slash commands: typed whole ("/rename Notes") or picked from the list.
async function revertLast() {
  if (busy()) return status('Stop Pouch before reverting.', 'bad');
  const items = view?.items ?? [], u = items.findLastIndex((i) => i.type === 'user');
  const target = u < 0 ? null : items.slice(0, u).findLast((i) => i.entry && !i.streaming && (i.type === 'user' || i.text || i.error));
  if (!target) return status(u < 0 ? 'Nothing to revert yet.' : 'The last turn is the first one; nothing earlier to revert to. Use /new for a fresh session.', 'bad');
  return revertTo(target);
}
const COMMANDS = [
  { name: 'new', hint: 'Start a new session', run: () => sessions.create() },
  { name: 'seed', hint: '<archive> stacks /work over a read-only .zip or .tar; /seed off removes it', run: async (arg) => {
    if (arg === 'off') { await vfs.unstack(); renderTree(); return status('Removed the seed layer; /work shows only your files.'); }
    if (!arg) return status(vfs.seedLayer ? `/work is stacked over ${vfs.seedLayer.name}. /seed off removes it.` : 'Give an archive: /seed /work/starter.zip', vfs.seedLayer ? '' : 'bad');
    await stackSeed(normalize(arg.startsWith('/') ? arg : CWD + '/' + arg));
  } },
  // Hints that name a cost are getters: worded for the current session's provider.
  { name: 'compact', get hint() { return `Summarize older turns (${sessions.costOf()})`; }, run: async () => {
    if (!sessions.current) return status('No session to compact yet.', 'bad');
    await sessions.compact(sessions.current.id);
  } },
  { name: 'rename', get hint() { return `Rename this session: /rename Title, or /rename alone to let the model suggest one (${sessions.costOf()})`; }, run: async (arg) => {
    if (!sessions.current) return status('No session to rename yet.', 'bad');
    if (!arg) {
      status(`Suggesting a title (${sessions.costOf()})...`);
      if (await sessions.renameAuto(sessions.current.id)) status('Renamed: ' + titleOf(sessions.current));
      return;
    }
    Object.assign(sessions.current, { title: arg.slice(0, 120), titleSource: 'user' });
    await sessions.save(); sessions.render();
    status('Renamed.');
  } },
  { name: 'revert', hint: 'Revert the last turn (asks first, can be undone)', run: revertLast },
  { name: 'usage', hint: 'Show today\'s allowance and tokens', run: () => layout.open('usage') },
  { name: 'files', hint: 'Show your files', run: () => layout.open('files') },
  { name: 'erase', hint: 'Erase all Pouch data in this browser (asks first)', run: () => eraseAll() },
  { name: 'help', hint: 'What you can type here', run: () => sheet('Typing in Pouch', [], el('div', {},
    el('p', { textContent: '@ inserts a path from your files. $ asks Pouch to use a skill. / runs a command instead of sending; a / followed by anything else is sent as text.' }),
    el('ul', {}, ...COMMANDS.map((c) => el('li', {}, el('code', { textContent: '/' + c.name }), ' ' + c.hint))),
    el('p', { textContent: 'Enter sends (on touch screens, tap Send). Shift+Enter is a new line. While Pouch works, Enter steers: Pouch reads your message after its current step. Alt+Enter (Option+Enter on a Mac) sends it as a follow-up, after the turn, instead; Settings can swap the two. Esc stops; Alt+Up takes a follow-up back to edit.' }))) },
];
const capEvents = new Map(); // session id -> message-cap refusals shown in the tray
// A spawn call still streaming or running, before its subagent exists.
// Once a subagent of that name runs, it has its own card and row instead.
const spawnedAs = (it) => (kids.get(String(sessions.current?.id)) ?? []).find((c) => c.name === it.args?.name && c.status === 'running' && (!it.at || c.started >= it.at - 1000));
const startingSpawn = (it) => it.type === 'tool' && it.name === 'subagent' && it.status === 'running' && it.details?.child == null && (it.args?.action === 'spawn' || (it.args?.action == null && it.args?.task != null)) && !spawnedAs(it);
const runSeen = new Map(); // running `run` call id -> first seen (ms), for the tray's elapsed time
const excerpt = (t, n = 90) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
function activity() {
  const sid = sessions.current?.id, key = curKey(), rows = [];
  // Subagents main is blocked on (a foreground spawn, a wait): Background detaches (G12).
  const held = new Set(sid != null && agent?.subagents ? agent.subagents.blocked(sid).flatMap((h) => h.ids) : []);
  const l = kids.get(String(sid)) ?? [];
  // A spawn the model is still writing (or starting): a row at once, so the
  // seconds before the subagent exists are not a dead zone (critique 48).
  if (!focus) for (const it of view?.items ?? []) if (startingSpawn(it)) {
    const since = runSeen.get(it.id) ?? Date.now(); runSeen.set(it.id, since);
    rows.push({ key: 'sa-start:' + it.id, kind: 'subagent', text: `${it.args?.name ?? 'subagent'}: starting`, title: it.args?.task ?? 'A subagent is starting', origin: 'starting', since });
  }
  for (const c of l) if (c.status === 'running') {
    const t = vfs.tasks.byKeyOf('sa:' + c.id), ref = refOf(l, c), waited = held.has(ref);
    rows.push({ key: 'sa:' + c.id, kind: 'subagent', seed: ref, text: `${c.name}: ${excerpt(c.task)}`, title: `Open ${c.name}: ` + c.task + (t ? `\n/task/${t.id} sees:\n${vfs.tasks.mounts(t).join('\n')}` : ''), origin: waited ? `main waits on ${ref}` : t ? `subagent ${ref}, /task/${t.id}` : `subagent ${ref}`, since: c.resumed ?? c.started,
      open: (e) => openChild(sid, c.id, e?.currentTarget), stop: () => ctl(agentFile(sid, ref, 'ctl'), 'stop').catch((e) => status(why(e), 'bad')),
      ...(waited ? { background: () => ctl(agentFile(sid, ref, 'ctl'), 'detach').catch((e) => status(why(e), 'bad')) } : {}) });
  }
  // A message refused at a cap (graph.js): visible until dismissed.
  for (const [i, e] of (capEvents.get(String(sid)) ?? []).entries()) {
    rows.push({ key: `cap:${e.at}:${i}`, kind: 'cap', text: `${e.from} to ${e.to}: not sent`, title: e.text, origin: 'message limit', stopLabel: 'Dismiss',
      stop: () => { const list = capEvents.get(String(sid)) ?? []; list.splice(list.indexOf(e), 1); composer.renderTray(); } });
  }
  const live = new Set();
  for (const t of view?.items ?? []) if (t.type === 'tool' && t.name === 'run' && t.status === 'running') {
    live.add(t.id);
    if (!runSeen.has(t.id)) runSeen.set(t.id, Date.now());
    const task = vfs.tasks.byKeyOf(t.id);
    rows.push({ key: 'run:' + t.id, kind: 'run', text: 'run ' + (t.args?.path ?? excerpt(t.args?.code?.split('\n').find((l) => l.trim()) ?? '', 70)),
      title: (t.args?.code ?? t.args?.path) + (task ? `\n/task/${task.id} sees:\n${vfs.tasks.mounts(task).join('\n')}` : ''),
      origin: task ? `run, /task/${task.id}` : 'run', since: runSeen.get(t.id), stop: () => (task ? ctl(`/task/${task.id}/ctl`, 'kill').catch((e) => status(why(e), 'bad')) : status('That run already finished.')) });
  }
  for (const id of runSeen.keys()) if (!live.has(id)) runSeen.delete(id);
  for (const p of egress.pending) {
    rows.push({ key: 'eg:' + p.id, kind: 'approval', text: p.command, origin: p.agentName ? `${p.agentName}: waiting for you` : 'waiting for you', since: p.since, open: () => egress.focus() });
  }
  // Pending input (D25): steers not yet read, the follow-up or paused message.
  for (const st of steers.get(key) ?? []) {
    rows.push({ key: 'steer:' + st.id, kind: 'steer', seed: st.child ? (kids.get(String(sid)) ?? []).find((c) => c.id === st.child)?.ref : undefined, text: excerpt(st.text), title: st.text,
      origin: (st.child ? `Steering ${st.name}` : 'Steering') + ' · after current step' + (st.detach ? ` · detaches ${st.detach}` : ''), since: st.at,
      stopLabel: 'Cancel', stopAria: 'Cancel steering message',
      stop: async () => {
        const back = await withdrawSteers(key, st.child ? focus?.sid ?? sid : sid, (x) => x === st);
        if (back.length) { putBack(back[0]); announce('Steering message cancelled and put back in the box.'); }
        else announce(`Already delivered to ${st.child ? st.name : 'Pouch'}.`);
        composer.renderTray();
      } });
  }
  const q = followUps.get(key);
  if (q) {
    const on = waitingOn(sid);
    rows.push({ key: 'followup', kind: 'followup', paused: q.paused, text: excerpt(q.text), title: q.text,
      origin: q.paused ? 'Paused after Stop' : busy() ? 'Follow-up · after this turn' + (on.length ? ` (main is waiting on ${on.join(', ')})` : '') : 'Follow-up · sends when ready',
      actions: q.paused ? [{ label: 'Send', act: 'send', ariaLabel: 'Send paused message', run: () => sendNow(key, false) }]
        : [{ label: 'Edit', act: 'edit', ariaLabel: 'Edit follow-up (Alt+Up)', run: () => cancelFollowUp(key, 'edit') },
          ...(busy() ? [{ label: 'Steer now', act: 'promote', ariaLabel: 'Steer now: send the follow-up into the current turn' + (on.length ? `; detaches ${on.join(', ')}` : ''), run: () => sendNow(key, true) }] : [])],
      stopLabel: 'Cancel', stopAria: q.paused ? 'Cancel paused message' : 'Cancel follow-up', stop: () => cancelFollowUp(key) });
  }
  if (sid != null) rows.push(...watchRows(sid));
  for (const [id, cq] of childFollowUps) if (sameId(cq.sid, sid)) {
    const c = (kids.get(String(sid)) ?? []).find((x) => x.id === id);
    rows.push({ key: 'cq:' + id, kind: 'followup', paused: cq.paused, text: excerpt(cq.text), title: cq.text,
      origin: cq.paused ? `Paused for ${cq.name}` : `Follow-up for ${cq.name} · after its turn`,
      actions: cq.paused ? [{ label: 'Send', act: 'send', ariaLabel: `Send paused message to ${cq.name}`, run: async () => { childFollowUps.delete(id); composer.renderTray(); await ctl(agentFile(sid, c ? refOf(kids.get(String(sid)) ?? [], c) : id, 'in'), 'message\n' + cq.text).catch((e) => status(why(e), 'bad')); } }]
        : c?.status === 'running' ? [{ label: 'Steer now', act: 'promote', ariaLabel: `Steer now: send to ${cq.name} after its current step`, run: async () => {
          childFollowUps.delete(id);
          await ctl(agentFile(sid, refOf(kids.get(String(sid)) ?? [], c), 'in'), 'steer\n' + cq.text).catch((e) => status(why(e), 'bad'));
        } }] : [],
      stopLabel: 'Cancel', stopAria: `Cancel follow-up for ${cq.name}`, stop: () => { childFollowUps.delete(id); putBack(cq.text); announce('Follow-up cancelled and put back in the box.'); composer.renderTray(); } });
  }
  return rows;
}
composer = createComposer({
  vfs, input: $('input'), fail,
  roots: () => ['/work', '/pouch', '/tmp', ...[...vfs.mounts].filter(([, m]) => m.live).map(([n]) => '/mnt/' + n)],
  skills: async () => (await loadContext(vfs)).skills,
  commands: COMMANDS,
  activity,
  turnSpend,
  mainBusy: () => busy(),
  // Stop all: main's run and every subagent and run of this session. Requests
  // in flight are aborted (the encrypted fetch carries the abort signal), and
  // stopped work starts no new request.
  stopAll: async () => {
    const sid = sessions.current?.id;
    if (sid != null) await ctl(`/session/${sid}/ctl`, 'stop').catch((e) => status(why(e), 'bad'));
    announce('Stopped everything in this session. Requests in flight were cancelled; one BayLeaf had already received may still count, and no new one starts.');
  },
  shield: async () => {
    const sid = sessions.current?.id;
    if (localhostPicked()) return {
      provider: 'Localhost: your machine runs the model', icon: 'laptop',
      detail: `${$('model').value.slice('localhost:'.length)} runs on your server at ${lh?.base ?? 'this computer'}. Pouch sends that server this session's messages, the files the model reads and tool results, in plain text over loopback; it never leaves this computer through Pouch. What your server does with them (logs, or forwarding them as a proxy) is your responsibility. No BayLeaf allowance is used, and it works with Wi-Fi off. Tools run here, in the page.`,
      grants: (await grantsFor(sid)).map((service) => ({ label: serviceName(service), revoke: async () => {
        await revoke(sid, service); status(`Pouch will ask again before ${serviceName(service)} in this session.`);
      } })),
      trust: () => layout.open('trust'),
    };
    if (localPicked()) return {
      provider: 'Transformers.js: in this browser, nothing sent',
      detail: `${LOCAL.label} runs in this browser on your GPU. Prompts, files and replies stay here; no request leaves for any model. Tools run here, in the page. Switch to a BayLeaf Sealed model in the picker for larger tasks.`,
      grants: (await grantsFor(sid)).map((service) => ({ label: serviceName(service), revoke: async () => {
        await revoke(sid, service); status(`Pouch will ask again before ${serviceName(service)} in this session.`);
      } })),
      trust: () => layout.open('trust'),
    };
    return {
      provider: verified ? 'BayLeaf Sealed: encrypted to the enclave' : offline ? 'BayLeaf Sealed: offline, nothing is sent' : 'BayLeaf Sealed: verifying the enclave',
      detail: verified ? 'This session\'s model requests are encrypted in this page to an attested enclave; BayLeaf relays ciphertext. Tools run here, in the page.'
        : 'Nothing is sent until the enclave verifies. There is no plaintext fallback.',
      grants: (await grantsFor(sid)).map((service) => ({ label: serviceName(service), revoke: async () => {
        await revoke(sid, service); status(`Pouch will ask again before ${serviceName(service)} in this session.`);
      } })),
      trust: () => layout.open('trust'),
    };
  },
  onRow: trayRowMotion,
  onTray: () => follow.stick(),
});

// ── File watches (JOURNEYS G13-G17, src/ns/watch.js) ────────────────
// Each watch belongs to a session and an owner in it (main s1 or a
// subagent). Events reach the owner through the same paths as messages
// (agent.subagents.notify); the tray shows every watch with Stop watching.
let agentReady;
const agentStarted = new Promise((r) => { agentReady = r; });
const refOfChild = (sid, id) => { const l = kids.get(String(sid)) ?? [], c = l.find((x) => x.id === id); return c ? { ref: refOf(l, c), name: c.name, c } : null; };
const watches = vfs.watches = createWatches({
  fs: vfs.fs,
  load: (sid) => store.getSetting(watchesKey(sid)),
  save: (sid, l) => store.setSetting(watchesKey(sid), l.length ? l : undefined),
  sessions: async () => (await sessions.all()).map((x) => x.id),
  // A subagent watches only inside its own mounts; main sees the whole tree.
  scopeOf: (sid, owner) => {
    if (asRef(owner) === MAIN) return null;
    const l = kids.get(String(sid)) ?? [], c = l.find((x) => refOf(l, x) === asRef(owner));
    return parseSpecs(c?.ns?.length ? c.ns : defaultSubagentNs(vfs)).map((x) => x.path);
  },
  followUpHeld: (sid) => { const q = followUps.get(String(sid)); return !!q && !q.paused; },
  userSending: (sid) => submitting.has(String(sid)),
  busy: (sid, owner) => agent?.subagents?.busyOf(sid, owner) ?? false,
  deliver: (sid, owner, { paths = [], ...ev }) => {
    for (const p of paths) arm('pulse:' + p);
    if (paths.length) renderTree();
    return agent.subagents.notify(sid, owner, ev);
  },
  ready: agentStarted,
  onChange: () => composer?.renderTray(),
});
async function watchCaller(caller) {
  const w = agent?.who(caller) ?? {};
  const sid = w.sid ?? caller;
  if (w.child != null) {
    const r = refOfChild(sid, w.child);
    if (!r) throw new Error('This subagent is not registered yet; try again.');
    return { sid, owner: r.ref, ownerName: r.name };
  }
  return { sid, owner: MAIN, ownerName: 'main' };
}
const watchByText = (w) => (w.by === 'user' ? 'by you' : w.by === 'agent' ? 'by agents' : 'by anyone');
const shortPath = (p) => (p.startsWith('/work/') ? p.slice(6) : p);
function watchRows(sid) {
  const rows = [];
  for (const w of watches.list(sid)) {
    const what = w.paths.map(shortPath).join(', ');
    const origin = `${w.id} · changes ${watchByText(w)}${w.owner !== MAIN ? ` · for ${w.ownerName} (${w.owner})` : ''} · /task/watch/${w.id}`;
    const title = `${w.note ? w.note + '\n' : ''}${w.paths.join('\n')}\n${w.once ? 'Removed after its first event.' : `Wakes the agent at most ${MAX_WAKES} times between your messages.`}`;
    const stop = () => ctl(`/task/watch/${w.id}/ctl`, 'stop').then(() => announce(`Stopped watching ${what}.`), (e) => status(why(e), 'bad'));
    if (w.held.length) {
      const files = [...new Set(w.held.map((h) => shortPath(h.path)))];
      rows.push({ key: 'watch:' + w.id, kind: 'watch', text: `${w.held.length} change${w.held.length === 1 ? '' : 's'} to ${files.join(', ')}, not delivered`, title, origin,
        actions: [{ label: 'Deliver', act: 'deliver', ariaLabel: `Deliver ${w.held.length} held changes to the agent`, run: () => ctl(`/task/watch/${w.id}/ctl`, 'deliver').catch((e) => status(why(e), 'bad')) }],
        stopLabel: 'Stop watching', stopAria: `Stop watching ${what}`, stop });
    } else if (w.once && w.paths.some(isGlob)) {
      rows.push({ key: 'watch:' + w.id, kind: 'watch', text: `Waiting for files in ${w.paths.map((p) => shortPath(baseOf(p))).join(', ')}${w.note ? ': ' + w.note : ''}`, title, origin, since: w.created,
        stopLabel: 'Cancel', stopAria: `Cancel waiting for files in ${what}`, stop });
    } else {
      rows.push({ key: 'watch:' + w.id, kind: 'watch', text: `Watching ${what}${w.note ? ': ' + w.note : ''}`, title, origin,
        stopLabel: 'Stop watching', stopAria: `Stop watching ${what}`, stop });
    }
  }
  return rows;
}

// ── Boot ────────────────────────────────────────────────────────────
// Files first, so the workspace is usable even if the network or the agent is not.
let agentError = null;
let toolList = []; // kept for Run script, which uses the run tool without the model
// The watch tool joins the page's tools (BayLeaf Sealed, main and subagents;
// the transformersjs profile keeps its four qualified tools).
const withWatch = (list) => { list.push(watchTool({ Type, watches, callerOf: watchCaller })); return list; };
(async () => {
  usage.subscribe(async (st) => { await ledger.observe(st.remaining); meter(); if (layout.current() === 'usage') renderUsagePanel(); if (!key && verified && /^Not signed in/.test($('status').textContent)) status(campusLine(st)); });
  if (location.hash === '#erased') { history.replaceState(null, '', location.pathname + location.search); $('erased').hidden = false; }
  navigator.storage.persist?.().catch(() => {});
  // Not awaited: the offline copy must never hold up files or the agent.
  shellCopy.start().then(() => shellCopy.supported && shellCopy.enabled() && navigator.onLine && checkUpdate(false))
    .catch((e) => renderCopy('Offline copy: ' + e.message, 'bad'));
  try { await vfs.init(); } catch (e) { status('Storage problem: ' + e.message, 'bad'); }
  offerDefaults();
  renderTree();
  $('welcome').hidden = !!(await store.getSetting('welcomed').catch(() => true));
  key = (await store.getSetting('key')) ?? null;
  lh = (await store.getSetting('localhost')) ?? null;
  renderLocalhostSettings();
  renderAuth();
  usage.refresh();
  localOk = await localSupport();
  await loadModels();
  renderLocalSettings();
  // Parts kept from pouch.bayleaf.dev before the gateway: reassembled, checked
  // against the pins and moved, so nobody downloads 1.1 GB again (src/models.js).
  if (LOCAL) modelStore.migrate().then((r) => {
    if (!r) return;
    if (r.migrated.length || r.partial.length) status(`Moved the Transformers.js model kept by an earlier Pouch (${mib(r.bytes)}, checked against this page's pins)${r.partial.length ? '; Download fetches the rest' : ''}. Nothing was downloaded again.`);
    else if (r.refused.length) status(`An earlier Pouch kept files that do not match this page's pins (${r.refused.join(', ')}); they were removed. Download fetches them from api.bayleaf.dev.`, 'bad');
    renderLocalSettings();
  }, (e) => status('Could not move the model kept by an earlier Pouch: ' + e.message, 'bad'));
  try {
    agent = await openAgent({
      local: LOCAL && localOk.ok ? { info: LOCAL, engine: localEngine, onHint: showHint } : null,
      localhost: { config: lhAgentConfig(), onWait: localhostWait },
      tools: toolList = withWatch(createTools(vfs, Type, {}, {
        // A subagent's writes carry its name for file watches.
        sourceOf: (caller) => { const w = agent?.who(caller); const r = w?.child != null && refOfChild(w.sid, w.child); return r ? `subagent ${r.name} (${r.ref})` : 'subagent'; },
        // A subagent's change is its own run; the main agent's joins the turn.
        // A subagent's namespace: what its spawn declared, or the default view.
        namespaceFor: (caller) => { const w = caller == null ? null : agent?.who(caller); return w?.child != null ? (w.ns?.length ? w.ns : defaultSubagentNs(vfs)) : null; },
        // Main's tools see its own session's control files at /session (src/ns/control.js).
        sessionOf: (caller) => (caller == null ? null : agent?.who(caller)?.sid ?? null),
        mainView: (caller, base) => { const w = caller == null ? null : agent?.who(caller); return w && w.child == null && w.sid != null ? mainNamespace(w.sid, base) : base; },
        // Every change an agent makes, for /session/<sid>/changes (subagents marked by their ref).
        onChange: (caller, op, path) => { const w = agent?.who(caller); if (w?.sid != null) changes.note(w.sid, op, path, w.child != null ? refOfChild(w.sid, w.child)?.ref ?? 'subagent' : MAIN); },
        ...egressHooks,
        models: modelService, modelsWho,
        show,
      })),
      systemPrompt: () => systemPrompt(vfs),
      getClient: async () => (verified ? client : null),
      onRequest: countRequest,
      models,
      pointer: { get: (id) => store.getSetting(convKey(id)), set: (id, c) => store.setSetting(convKey(id), c) },
      onInterrupted: async (sids) => {
        for (const sid of sids) if (sid != null) await store.setSetting(interruptedKey(sid), true);
        if (sids.some((x) => sameId(x, sessions.current?.id))) { interrupted = true; scheduleRender(); }
      },
      subagents: {
        reg: { get: (sid) => store.getSetting(subagentsKey(sid)), set: (sid, l) => store.setSetting(subagentsKey(sid), l) },
        onChange: onKids,
        onCap: (sid, e) => { const list = capEvents.get(String(sid)) ?? []; list.push(e); capEvents.set(String(sid), list.slice(-3)); if (sameId(sid, sessions.current?.id)) composer?.renderTray(); },
        onBlocked: (sid) => { if (sameId(sid, sessions.current?.id)) { composer?.renderTray(); updateSend(); } },
        onReport: (sid, sub) => drive(sid, () => sub.wait()),
        // The user's follow-up goes before agent wakes (D25).
        followUpHeld: (sid) => { const q = followUps.get(String(sid)); return (!!q && !q.paused) || submitting.has(String(sid)); },
        onSettle: async (sid, c) => { toolList.closeView?.(c.id); usage.refresh(); },
        lowAllowance,
        // A one-shot's attached files, read in main's namespace (paths relative to /work).
        readFile: async (f) => {
          const path = normalize(f.startsWith('/') ? f : CWD + '/' + f);
          const text = await vfs.fs.readFile(path).catch((e) => { throw new Error(`files: ${path} could not be read (${/ENOENT/.test(e.code ?? e.message) ? 'it does not exist' : e.message}).`); });
          return { path, text };
        },
        watchLines: (sid, ref) => { const l = watches.list(sid).filter((w) => ref === MAIN || w.owner === ref); return l.length ? 'Watches: ' + l.map((w) => `${w.id} ${w.paths.join(', ')}${w.note ? ` (${w.note})` : ''}`).join('; ') : ''; },
      },
    });
  } catch (e) {
    agentError = 'The agent could not start: ' + e.message;
    status(agentError, 'bad');
  }
  if (!(await sessions.boot())) renderLog();
  // Sessions whose subagents were running when the page went away: open them
  // so pi-durable resumes their runs and the reports still arrive.
  if (agent?.subagents) {
    const ids = [];
    for (const s of await sessions.all()) if ((await loadKids(s.id)).some((c) => c.status === 'running' || (c.sub && !c.foreground && c.reported !== c.sub))) ids.push(s.id);
    if (ids.length) { sessions.render(); agent.open(ids); }
  }
  // Watches come back after a reload; files changed meanwhile fire once.
  agentReady();
  watches.boot().catch((e) => console.warn('Pouch watches:', e));
  await connect();
})();
