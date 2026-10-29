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
import { createTools, systemPrompt, loadContext, CWD } from './tools.js';
import { openAgent, Type } from './agent.js';
import { createReview } from './review.js';
import { collect, packTar, packZip, unpackTar, unpackZip } from './archive.js';
import { $, el, icon } from './dom.js';
import { createLayout } from './layout.js';
import { createUsage, renderMeter, renderPanel, exhaustedText } from './usage.js';
import { createSessions, sameId, titleOf, notesKey, convKey, revertKey, subagentsKey, interruptedKey, turnsKey } from './sessions.js';
import { createComposer } from './composer.js';
import { createEgress, egressOf, grantsFor, revoke, serviceName } from './egress.js';
import { LOCAL, support as localSupport, stored as localStored, engine as localEngine, importFiles as localImport, remove as localRemove } from './local/engine.js';
import { isLocal, HINTS } from './local/provider.js';

const API = 'https://api.bayleaf.dev';
const SEALED = API + '/sealed';
const settings = createSettings();

Object.assign(DEFAULTS, defaults);
const vfs = new Vfs();
const localImages = createLocalImages(vfs);
const review = createReview(vfs, { currentSession: () => sessions.current?.id });

let key = null;        // sk-bayleaf-... or null for Campus Pass
let client = null;     // TinfoilAI, verified once per credential
let verified = false;
let agent = null;      // from openAgent, or null if it could not open
let models = [];       // Sealed chat models with tool calling
let view = null;       // last normalized view of the current session
let composer = null;   // composer.js: tray, autocomplete, shield popover (set below)
let unwatch = null;

function status(text, cls = '') { $('status').textContent = text; $('status').className = cls; }

// ── Frame: sidebar, rail and panels (layout.js) ─────────────────────
const usage = createUsage({ getKey: () => key });
// Deferred: the layout restores a remembered panel while this module is still loading.
const layout = createLayout({ onPanel: (p) => { if (p === 'usage') queueMicrotask(renderUsagePanel); } });

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
    b.onclick = async () => { $('sheet').close(); try { await fn(); } catch (e) { alert(e.message); } };
    return b;
  }), el('button', { type: 'button', textContent: 'Cancel', onclick: () => $('sheet').close() }));
  $('sheet').showModal();
}

// ── Editor ──────────────────────────────────────────────────────────
// The editor keeps a baseline: the text it last loaded or saved. When the
// file changes on disk under a dirty buffer, that is a conflict for the user
// to settle (story map R4), never a silent overwrite either way.
let openPath = null;
let dirty = false;
let conflict = null;   // disk text that arrived while the buffer was dirty
let reviewing = null;  // the change row whose diff is shown (read-only review)
let merging = false;   // the conflict diff (theirs vs mine) is shown
const editor = createEditor($('editor'), {
  onSave: () => saveFile(),
  onChange: (d) => { dirty = d; $('save').disabled = !d; $('editor-path').classList.toggle('dirty', d); markEditor(); },
  // A Revert button in a review undoes one chunk on disk.
  onRevert: (text) => vfs.fs.writeFile(openPath, text).then(() => { vfs.changed(); noteUserEdit(openPath, 'reverted part of your change to'); },
    (e) => alert('Could not revert: ' + e.message)),
});

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
  markEditor();
}
function setReviewBar(text, restore = false) {
  $('review-bar').hidden = text == null;
  $('review-text').textContent = text ?? '';
  $('review-restore').hidden = !restore;
}

async function openFile(path, line) {
  // Reopening the file you are editing only moves the cursor: no reload, no loss.
  if (path !== openPath || reviewing || merging) {
    if (dirty && !confirm(`Discard unsaved changes to ${openPath}?`)) return;
    const bytes = await vfs.fs.readFileBuffer(path);
    if (bytes.includes(0)) return sheet(path + ' looks binary', [
      ARCHIVE.test(path) && vfs.where(path) !== 'mount-ro' && ['Unpack here', () => unpackHere(path)],
      ARCHIVE.test(path) && ['List contents', () => listArchive(path)],
      ['Download', () => download(path)],
    ]);
    openPath = path; reviewing = null; merging = false;
    setReviewBar(null); setConflict(null);
    editor.load(path, new TextDecoder().decode(bytes));
  }
  review.unseen.delete(path);
  showEditor(path);
  if (line) editor.gotoLine(line);
  editor.focus();
}
async function saveFile() {
  if (!openPath || reviewing) return;
  try {
    // Compare-and-swap: never overwrite a version you have not seen.
    const disk = (await vfs.fs.exists(openPath)) ? await vfs.fs.readFile(openPath) : null;
    if (disk !== null && disk !== editor.baseline && disk !== editor.text()) {
      setConflict(disk);
      if (!confirm('Pouch changed this file while you were editing. Overwrite its version with yours?')) return;
    }
    if (merging) { merging = false; setReviewBar(null); editor.endDiff(); }
    await vfs.fs.writeFile(openPath, editor.text()); editor.markSaved(); setConflict(null); vfs.changed();
    noteUserEdit(openPath, 'edited');
  } catch (e) { alert('Could not save: ' + e.message); }
}
function closeFile() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  openPath = null; dirty = false; reviewing = null; merging = false;
  setReviewBar(null); setConflict(null);
  editor.load('', '');
  editorEmpty();
  layout.open('files');
  renderTree();
}
$('save').onclick = saveFile;
$('close-file').onclick = closeFile;
$('to-files').onclick = () => layout.open('files');

// Diff of one changed-file row against what was there before its turn (R3).
async function showDiff(row) {
  let t;
  try { t = await review.texts(row); } catch (e) { return alert(e.message); }
  if (dirty && !confirm(`Discard unsaved changes to ${openPath}?`)) return;
  openPath = t.path; reviewing = row; merging = false; dirty = false;
  setConflict(null); $('save').disabled = true; $('editor-path').classList.remove('dirty');
  const deleted = row.status === 'deleted';
  editor.diff(t.path, t.original, t.current, { buttons: !deleted });
  setReviewBar(deleted ? `${row.path} was deleted in that turn; this is what it held.`
    : row.status === 'created' ? `${t.path} was created in that turn.`
    : row.status === 'moved' ? `Changes to ${t.path} (moved from ${row.path}) since before that turn.`
    : `Changes to ${t.path} since before that turn.`, deleted);
  review.unseen.delete(t.path);
  showEditor(t.path);
  editor.focus();
}
async function refreshReview() {
  try {
    const t = await review.texts(reviewing);
    if (t.current !== editor.text()) editor.diff(t.path, t.original, t.current, { buttons: reviewing.status !== 'deleted' });
  } catch { /* the file became binary or vanished: leave the last view */ }
}
$('review-done').onclick = async () => {
  if (merging) {
    // Merged by hand: their version is now seen, the buffer is yours to save.
    merging = false; setReviewBar(null);
    editor.endDiff(); if (conflict != null) editor.setBaseline(conflict); setConflict(null);
    return editor.focus();
  }
  const path = openPath; reviewing = null; setReviewBar(null);
  if (await vfs.fs.exists(path)) { openPath = null; return openFile(path); }
  openPath = path; closeFile();
};
$('review-restore').onclick = async () => {
  const row = reviewing;
  if (row && (await undoRecs(row.recs))) { reviewing = null; setReviewBar(null); openPath = null; openFile(row.path); }
};
$('conflict-diff').onclick = () => {
  merging = true;
  editor.diff(openPath, conflict, editor.text(), { editable: true });
  setReviewBar('Struck lines are Pouch\'s version, the rest is yours. Keep or take each change, then Done (or Save).');
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
  if (!openPath) return;
  if (reviewing) return refreshReview();
  if (!(await vfs.fs.exists(openPath))) {
    if (dirty) { $('editor-path').textContent = openPath + ' (deleted)'; return; }
    openPath = null; editorEmpty();
    return;
  }
  const text = await vfs.fs.readFile(openPath);
  if (!dirty && !merging) { if (text !== editor.text()) editor.load(openPath, text); return; }
  if (text === editor.baseline || text === conflict) return;
  if (text === editor.text()) { editor.setBaseline(text); setConflict(null); return; } // same edit on both sides
  setConflict(text);
  if (merging) editor.diff(openPath, text, editor.text(), { editable: true });
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
  for (const d of dirs) await vfs.fs.mkdir(d, { recursive: true });
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
      else if ((await vfs.fs.stat(dest)).isDirectory) await vfs.fs.rm(dest, { recursive: true });
    }
    await vfs.fs.mkdir(normalize(dest + '/..'), { recursive: true });
    await vfs.fs.writeFile(dest, await it.data());
    written++; paths.push(dest);
  }
  return { written, skipped, paths };
}

async function addFiles(where, items, dirs, verb = 'Added') {
  try {
    const r = await writeBatch(where, items, dirs);
    if (r) { expanded.add(where); status(`${verb} ${r.written} file${r.written === 1 ? '' : 's'} in ${where}${r.skipped ? ` (${r.skipped} skipped)` : ''}.`); }
    return r;
  } catch (e) { alert('Could not add files: ' + e.message); }
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
  } catch (e) { return alert('Could not read the dropped files: ' + e.message); }
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
  if (bytes.includes(0)) return alert(`${path} looks binary. Download it instead.`);
  try { await navigator.clipboard.writeText(new TextDecoder().decode(bytes)); status(`Copied the text of ${path}.`); }
  catch (e) { alert(`This browser did not allow copying (${e.message}). Open the file, select all in the editor and copy from there.`); }
}
async function newFromClipboard(dir) {
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch (e) { return alert(`This browser did not allow reading the clipboard (${e.message}). Make a new file and paste into the editor instead.`); }
  if (!text) return alert('The clipboard holds no text.');
  const name = prompt(`Name for the new file (${text.length} characters from the clipboard)`, 'pasted.txt')?.trim();
  if (!name) return;
  const path = normalize(dir + '/' + name);
  const r = await addFiles(dir, [{ path, data: async () => new TextEncoder().encode(text) }]);
  if (r?.paths.length) openFile(r.paths[0]).catch((e) => alert(e.message));
}

async function newEntry(dir, kind) {
  const name = prompt(kind === 'dir' ? 'New folder name' : 'New file name');
  if (!name) return;
  const p = normalize(dir + '/' + name);
  if (kind === 'dir') await vfs.fs.mkdir(p, { recursive: true });
  else { await vfs.fs.mkdir(normalize(p + '/..'), { recursive: true }); if (!(await vfs.fs.exists(p))) await vfs.fs.writeFile(p, ''); }
  // "a/b/c" makes several folders at once: open the way down to the new entry.
  for (let q = normalize(p + '/..'); q.length >= dir.length && q !== '/'; q = normalize(q + '/..')) expanded.add(q);
  vfs.changed();
  if (kind !== 'dir') openFile(p);
}

async function rename(path) {
  const name = prompt('Rename to', path.split('/').pop());
  if (!name || name.includes('/')) return;
  const dest = normalize(path + '/../' + name);
  if (dest === path) return;
  // mv is copy-then-delete, so renaming onto a name in use would destroy it (R1).
  if (await vfs.fs.exists(dest)) return alert(`${name} already exists in ${normalize(path + '/..')}. Pick another name, or delete that one first.`);
  await vfs.fs.mv(path, dest);
  // The open file may be the renamed entry or inside a renamed folder.
  if (openPath === path || openPath?.startsWith(path + '/')) { openPath = dest + openPath.slice(path.length); $('editor-path').textContent = openPath; }
  if (focusPath === path) focusPath = dest;
  vfs.changed();
}

async function remove(path, isDir) {
  if (!confirm(`Delete ${path}${isDir ? ' and everything in it' : ''}?`)) return;
  await vfs.fs.rm(path, { recursive: true, force: true });
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
    ['Download as .zip', () => downloadDir(path, 'zip'), 'primary'],
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
  // A dot until you open what the agent changed (in a closed folder: on the folder).
  if (review.unseen.has(path) || (isDir && !expanded.has(path) && [...review.unseen].some((p) => p.startsWith(path + '/')))) {
    r.append(el('span', { className: 'changed-dot', role: 'img', ariaLabel: 'changed by Pouch', title: 'Changed by Pouch' }));
  }
  if (locked) {
    r.onclick = () => vfs.reconnect(mountName, { ask: true }).catch((e) => alert(e.message));
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
  changeTimer = setTimeout(() => { renderTree(); syncEditor(); refreshChanges(); pathGen++; linkVer++; scheduleRender(); }, 150);
});
$('refresh').onclick = () => vfs.changed();
// Everything in /work in one file: the "export before I leave" button (O3, L3).
$('download-all').onclick = () => downloadDir('/work', 'zip', `pouch-work-${new Date().toISOString().slice(0, 10)}.zip`).catch((e) => alert(e.message));
function mountFolder() {
  if (!window.showDirectoryPicker) return alert($('mount').title);
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
// Its changes are recorded under the current session's latest message, so
// they get Diff and Undo like the agent's. Works offline.
async function runScript(path) {
  const tool = toolList.find((t) => t.name === 'run');
  if (!tool) return alert('The run engine is not available.');
  if (busy() || review.active) return alert('Wait for the current turn to finish, then run the script.');
  const sid = sessions.current?.id;
  if (sid != null) review.begin(sid, view?.items.filter((i) => i.type === 'user').length ?? 0);
  let text;
  status('Running ' + path);
  // A script saved in /work sees all of /work, as the agent's run of it most likely did.
  try { text = await tool.execute({ path, ...(path.startsWith(CWD + '/') ? { files: [CWD] } : {}) }); } catch (e) { text = e.message.replace(/^<harness>|<\/harness>$/g, '').trim(); }
  finally { if (sid != null) await review.end().catch(() => {}); refreshChanges(); status(''); }
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
    fact('Enclave', doc.enclaveHost ?? '?');
    fact('Code repo', doc.configRepo ?? '?');
    fact('Release', (doc.releaseTag ? doc.releaseTag + ' ' : '') + (doc.releaseDigest ?? '?'));
    // Equal fingerprints mean the running enclave is the published release.
    fact('Published code', doc.codeFingerprint ?? '?');
    fact('Running enclave', doc.enclaveFingerprint ?? '?', doc.codeFingerprint === doc.enclaveFingerprint ? 'ok' : 'bad');
    fact('Verified at', doc.verifiedAt ?? '?');
    for (const [step, state] of Object.entries(doc.steps ?? {})) {
      fact('Step: ' + step, state.status + (state.error ? ' – ' + state.error : ''), state.status === 'success' ? 'ok' : 'bad');
    }
    fact('Credential', key ? 'personal key (stored in this browser)' : 'Campus Pass (no account; campus network only)');
    if (!ok) throw new Error('attestation did not verify');
    client = c; verified = true;
    setBadge('ok', 'Sealed: enclave verified');
    status(key ? '' : 'Not signed in: using Campus Pass, which works only on the UCSC network.');
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
const OFFLINE = 'Offline: the model is unreachable. Files, the editor, review, archives and run keep working; sending comes back when the network does.';
const LOCAL_OFFLINE = 'Offline: Sealed is unreachable. The Local lane keeps working; it needs no network.';
function isNetworkError(msg) { return /failed to fetch|networkerror|network ?error|load failed|connection (error|lost)|ERR_INTERNET|ERR_NETWORK|fetch failed/i.test(msg ?? ''); }
function goOffline() {
  const was = offline;
  offline = true; verified = false; client = null;
  setBadge('offline', 'Offline: the model is unreachable');
  status(localPicked() ? LOCAL_OFFLINE : OFFLINE, 'offline');
  $('input').placeholder = localPicked() ? PLACEHOLDER : 'Offline: keep typing; Send comes back with the network';
  // A turn waiting on a dead stream would otherwise hang until the socket times out.
  for (const sid of sessions.running) { if (localRuns.has(sid)) continue; lostRuns.add(sid); agent?.abort(sid).catch(() => {}); }
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
  // The composer's shield shows the same state; it opens the lane popover.
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
      .map((m) => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.context_window ?? 131072, reasoning: !!m.reasoning, multimodal: m.multimodal === true,
        cost: m.pricing && { input: m.pricing.inputTokenPricePer1M ?? 0, output: m.pricing.outputTokenPricePer1M ?? 0, cacheRead: 0 } }));
  } catch (e) {
    status('Could not load the Sealed model list: ' + e.message, 'bad');
  }
  const saved = (await store.getSetting('model')) ?? 'glm-5-3';
  // Local is never the default: without a Sealed list, a placeholder holds the place.
  const none = !models.length && saved !== LOCAL_ID ? [Object.assign(new Option('Sealed: model list unavailable', '', true, true), { disabled: true })] : [];
  $('model').replaceChildren(...none, ...models.map((m) => new Option(m.name + (m.multimodal ? ' · images' : ''), m.id, false, m.id === saved)), ...localOption(saved));
  agent?.setModels?.(models);
  pickerLane();
}
let lastPick = null;
$('model').onfocus = () => { lastPick = $('model').value; };
$('model').onchange = async () => {
  // Switching lanes is always this explicit choice; Pouch never switches by itself.
  if (localPicked() && !(await ensureLocal())) { $('model').value = lastPick ?? models[0]?.id ?? ''; pickerLane(); return; }
  await store.setSetting('model', $('model').value);
  if (!localPicked()) await store.setSetting('sealedModel', $('model').value);
  pickerLane(); updateSend();
  status(localPicked() ? 'Local selected for your next user turn: it runs on this device and sends nothing.' : 'Model selected for your next user turn. Running work is unchanged.');
};

// ── Local lane (src/local/): a model on this device, chosen explicitly ─
// The picker offers it when this build carries it and WebGPU works; otherwise
// it is listed disabled with the reason. Nothing is downloaded without asking.
let localOk = { ok: false, reason: '' };
const localRuns = new Set(); // sessions whose current turn runs on the Local lane
const LOCAL_ID = LOCAL && 'local:' + LOCAL.id;
const localPicked = () => isLocal($('model').value);
const canSend = () => !!agent && (localPicked() || (verified && !offline));
const mib = (n) => `${(n / 2 ** 20).toLocaleString(undefined, { maximumFractionDigits: 0 })} MB`;
function localOption(saved) {
  if (!LOCAL) return [];
  const o = new Option(localOk.ok ? `Local: ${LOCAL.label} (on this device)` : `Local: ${LOCAL.label} (unavailable: ${localOk.reason})`, LOCAL_ID, false, localOk.ok && saved === LOCAL_ID);
  o.disabled = !localOk.ok;
  o.title = localOk.ok ? 'Runs in this browser on your GPU. Nothing is sent.' : localOk.reason;
  return [o];
}
function pickerLane() {
  const local = localPicked(), label = $('model').closest('.lane-model');
  label.querySelector('use').setAttribute('href', local ? '#i-chip' : '#i-lock');
  if (offline) $('input').placeholder = local ? PLACEHOLDER : 'Offline: keep typing; Send comes back with the network';
  label.title = local ? 'Local lane: the model runs on this device; nothing is sent. The model applies when you next send.' : 'Sealed lane: requests are encrypted to the enclave. The model applies when you next send; running work keeps its model.';
  composer?.refreshShield();
}
// Downloading is a choice (about 1.1 GB); progress shows in the status line and Settings.
let localLoading = null;
async function ensureLocal() {
  if (!localOk.ok) { status(`Local is not available: ${localOk.reason}`, 'bad'); return false; }
  if (localEngine.loaded()) return true;
  const st = await localStored();
  if (!st.complete) {
    if (!navigator.onLine) { status('The Local model is not on this device yet, and you are offline. Settings can load a saved copy from a folder.', 'bad'); return false; }
    if (!confirm(`Download the Local model (${LOCAL.label}, about ${mib(LOCAL.bytes - st.bytes)}) from pouch.bayleaf.dev into this browser? Each part is checked against this page's manifest. Afterwards Local works offline, and nothing you type is ever sent. Remove it any time in Settings.`)) return false;
  }
  return startLocal();
}
function startLocal() {
  const box = $('local-settings');
  box.dataset.state = 'loading';
  localLoading ??= localEngine.start({ onProgress: localProgress, network: navigator.onLine })
    .then(() => { box.dataset.state = 'ready'; status(`Local ${LOCAL.label} is ready on this device.`); return true; },
      (e) => { box.dataset.state = 'error'; box.dataset.error = e.message; status('Local model: ' + e.message, 'bad'); return false; })
    .finally(() => { localLoading = null; renderLocalSettings(); });
  return localLoading;
}
let progressAt = 0;
function localProgress(p) {
  if (p.phase !== 'loading' && p.done < p.total && Date.now() - progressAt < 150) return; // a few updates a second
  progressAt = Date.now();
  const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
  const text = p.phase === 'loading' ? `Local: verified ${mib(p.total)}; starting the model on your GPU...`
    : `Local: ${p.fetched || p.repaired ? 'downloading and checking' : 'checking'} ${mib(p.done)} of ${mib(p.total)} (${pct}%)${p.repaired ? `, ${p.repaired} damaged part${p.repaired > 1 ? 's' : ''} fetched again` : ''}`;
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
  $('local-hint-text').textContent = kinds.map((k) => HINTS[k]).join(' ') + ' Sealed (a larger model, encrypted to the enclave) may do better.';
}
$('local-hint-switch').onclick = async () => {
  const to = (await store.getSetting('sealedModel')) ?? models[0]?.id;
  if (!to || !models.some((m) => m.id === to)) return status('No Sealed model is available right now.', 'bad');
  $('model').value = to; await store.setSetting('model', to); pickerLane(); updateSend();
  clearHint(sessions.current?.id);
  status(`Switched the picker to Sealed (${modelName(to)}) for your next message. Nothing was sent.`);
};
$('local-hint-dismiss').onclick = () => clearHint(sessions.current?.id);
async function renderLocalSettings() {
  const box = $('local-settings');
  if (!box) return;
  if (!LOCAL) { $('local-state').textContent = 'This build of Pouch does not include a local model.'; box.querySelectorAll('button').forEach((b) => { b.hidden = true; }); return; }
  const st = await localStored();
  $('local-state').textContent = !localOk.ok ? `Not available here: ${localOk.reason}`
    : st.complete ? `${LOCAL.label} is kept in this browser (${mib(st.bytes)}${st.persistent ? '' : ', for this page load only'}). Local works offline.`
    : st.bytes ? `${mib(st.bytes)} of ${mib(st.total)} downloaded.` : `Not downloaded (about ${mib(LOCAL.bytes)}).`;
  $('local-download').hidden = !localOk.ok || st.complete;
  $('local-remove').hidden = !st.bytes;
  if (!localLoading) $('local-progress').hidden = true;
}
$('local-download').onclick = async () => { if (await ensureLocal()) renderLocalSettings(); };
$('local-remove').onclick = async () => {
  if (localRuns.size) return status('Stop the Local turn before removing the model.', 'bad');
  if (!confirm('Remove the Local model from this browser? Conversations and files stay. Downloading it again takes about 1.1 GB.')) return;
  await localRemove();
  if (localPicked()) { $('model').value = (await store.getSetting('sealedModel')) ?? models[0]?.id ?? ''; await store.setSetting('model', $('model').value); pickerLane(); updateSend(); }
  const est = await navigator.storage?.estimate?.().catch(() => null);
  status(`Local model removed.${est ? ` This site now uses ${mib(est.usage)} of storage.` : ''}`);
  renderLocalSettings();
};
for (const id of ['local-folder', 'local-files']) {
  $(id + '-btn').onclick = () => $(id).click();
  $(id).onchange = async () => {
    const files = $(id).files;
    if (!files?.length) return;
    status('Checking the picked files against this page\'s manifest...');
    try {
      const r = await localImport(files);
      $(id).value = '';
      status(r.complete ? `Local model loaded from your files (${r.added} parts verified${r.bad ? `, ${r.bad} refused` : ''}).`
        : `${r.added} parts verified${r.bad ? `, ${r.bad} refused (wrong bytes)` : ''}; ${mib(r.total - r.bytes)} still missing.`, r.bad ? 'bad' : '');
    } catch (e) { status(e.message, 'bad'); }
    renderLocalSettings();
  };
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
async function useKey(k) {
  key = k; await store.setSetting('key', key); renderAuth(); usage.refresh(); await connect();
}
$('auth').onclick = async () => {
  if (!key) return sheet('Sign in to BayLeaf', [
    ['Approve on a device where you are signed in (recommended)', claim],
    ['Paste a key you already have', async () => {
      const k = prompt('Your sk-bayleaf- key (stored only in this browser)')?.trim();
      if (k && /^sk-bayleaf-\S+$/.test(k)) await useKey(k); else if (k) alert('That does not look like an sk-bayleaf- key.');
    }],
  ]);
  if (!confirm('Remove your BayLeaf key from this browser? Files and conversations stay.')) return;
  key = null; await store.setSetting('key', undefined); renderAuth(); usage.refresh(); connect();
};

// ── Erase everything ────────────────────────────────────────────────
async function eraseAll() {
  if (!confirm('Erase ALL Pouch data in this browser: files in /work, /pouch, conversations, your key and folder permissions? Folders you mounted from this device are not touched. This cannot be undone. (To keep /work, press Cancel, then Download all.)')) return;
  status('Erasing...');
  try { await agent?.close(); } catch {}
  agent = null;
  await localEngine.dispose().catch(() => {});
  await store.eraseEverything(); // includes the Local model's Cache Storage
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

// ── Sessions (sessions.js) ──────────────────────────────────────────
const sessions = createSessions({
  agent: () => agent, view: () => view, connected: () => (agent && verified ? client : null),
  model: () => $('model').value, setModel: (id) => { $('model').value = id; pickerLane(); }, hasModel: (id) => models.some((m) => m.id === id) || (localOk.ok && id === LOCAL_ID), isLocal,
  attach: () => attach(), status, sheet, layout, review, usage, quotaError, exhaustedText,
  agentError: () => agentError,
  runningChildren: (sid) => (kids.get(String(sid)) ?? []).filter((c) => c.status === 'running').length,
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
const runSession = () => review.active?.session ?? (sessions.current ? String(sessions.current.id) : null);
const egress = createEgress({ sessionTitle: async (sid) => titleOf(await sessions.find(sid)), onPending: () => composer?.renderTray(), onGrant: () => composer?.refreshShield() });
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
function onKids(sid, list) {
  kids.set(String(sid), list);
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
  const mine = !review.active;
  if (mine) review.begin(sid, null);
  try { await wait(); } catch {}
  finally {
    sessions.running.delete(String(sid));
    if (mine) await review.end().catch(() => {});
    refreshChanges();
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
const fmtDur = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`; };
function messageChild(c) {
  const box = el('textarea', { className: 'sa-input', rows: 3, placeholder: `What should ${c.name} do or know?`, ariaLabel: `Message to subagent ${c.name}` });
  sheet(`Message subagent ${c.name}`, [[c.status === 'running' ? 'Send (joins its work)' : 'Send (it starts again)', async () => {
    const t = box.value.trim();
    if (!t) return;
    await agent.subagents.message(sessions.current.id, c.id, t);
    status(`Sent to ${c.name}.`);
  }]], el('div', {}, el('p', { textContent: c.status === 'running' ? 'It reads this after its current step. Its report will reflect it.' : 'It continues from where it ended and posts a new report.' }), box));
  setTimeout(() => box.focus(), 0);
}
// The card at the spawn point (D16): status, time, requests, Stop, Message,
// the live transcript (read-only), and the files it changed.
function subagentCard(it, childId) {
  const c = (kids.get(String(sessions.current?.id)) ?? []).find((x) => x.id === childId);
  const v = childViews.get(childId);
  const name = c?.name ?? it.details?.name ?? it.args?.name ?? 'subagent';
  const st = c?.status ?? (it.status === 'running' ? 'starting' : 'unknown');
  const box = el('section', { className: `subagent ${st}`, ariaLabel: `Subagent ${name}: ${st}` });
  const meta = [];
  if (c) meta.push(fmtDur((c.status === 'running' ? Date.now() : c.ended ?? Date.now()) - (c.resumed ?? c.started)));
  const steps = v?.steps ?? c?.requests;
  if (steps != null) meta.push(`${steps} request${steps === 1 ? '' : 's'}`);
  const head = el('div', { className: 'sa-head' },
    el('span', { className: 'sa-name', textContent: name }),
    el('span', { className: `sa-status ${st}`, textContent: st }),
    el('span', { className: 'sa-meta', textContent: meta.join(' · ') }));
  const acts = el('span', { className: 'sa-acts' });
  if (c) {
    const msg = el('button', { type: 'button', textContent: 'Message', ariaLabel: `Message subagent ${name}` });
    msg.onclick = () => messageChild(c);
    acts.append(msg);
  }
  if (c?.status === 'interrupted') {
    const res = el('button', { type: 'button', className: 'primary', textContent: 'Resume', ariaLabel: `Resume subagent ${name}` });
    res.onclick = () => { res.disabled = true; agent.subagents.message(sessions.current.id, c.id, 'Continue your task where you left off: a page reload interrupted you.').catch((e) => alert(e.message)); };
    acts.append(res);
  }
  if (c?.status === 'running') {
    const stop = el('button', { type: 'button', className: 'danger', textContent: 'Stop', ariaLabel: `Stop subagent ${name}` });
    stop.onclick = () => { stop.disabled = true; agent.subagents.stop(sessions.current.id, c.id).catch((e) => alert(e.message)); };
    acts.append(stop);
  }
  head.append(acts);
  box.append(head, el('p', { className: 'sa-task', textContent: c?.task ?? it.args?.task ?? '', title: c?.task ?? '' }));
  if (c?.error && st === 'failed') box.append(el('p', { className: 'sa-err', textContent: c.error }));
  const key = 'sa:' + childId;
  const d = el('details', { className: 'sa-log', open: openTools.has(key) });
  d.ontoggle = () => (d.open ? openTools.add(key) : openTools.delete(key));
  const n = v?.items.length ?? 0;
  d.append(el('summary', { textContent: v ? `Transcript (${n} item${n === 1 ? '' : 's'})` : 'Transcript' }));
  if (d.open) {
    const nextCache = new Map();
    const body = el('div', { className: 'sa-items' });
    for (const x of v?.items ?? []) {
      if (x.type === 'user') body.append(el('div', { className: 'msg user bare', role: 'article', ariaLabel: 'Task or message' }, el('div', { className: 'body', textContent: x.text })));
      else if (x.type === 'assistant') body.append(el('div', { className: 'msg assistant bare', role: 'article', ariaLabel: `Reply from ${name}` },
        ...(x.thinking ? [reasoningCard(x, `child:${childId}:${v.items.indexOf(x)}`)] : []),
        ...(x.text ? [replyBody(x.text, nextCache)] : []),
        ...(x.error ? [el('div', { className: 'body bad', textContent: x.error })] : [])));
      else if (x.type === 'tool') body.append(toolCard(x, 'sa:'));
      else if (x.type === 'notice') body.append(el('p', { className: 'notice', textContent: x.text }));
    }
    if (!v?.items.length) body.append(el('p', { className: 'notice', textContent: v ? 'Nothing yet.' : 'Loading...' }));
    d.append(body);
  }
  box.append(d);
  for (const run of changeRuns.values()) if (run.sub === String(childId)) { const b = changesBlock(run); if (b) box.append(b); }
  return box;
}

// Token totals per session (Usage panel): the live view for the current
// session, otherwise what was recorded when its last run settled.
async function renderUsagePanel(list) {
  list ??= await sessions.all();
  renderPanel($('usage-body'), usage.state, list.map((s) => {
    const current = sameId(s.id, sessions.current?.id);
    const u = (current && view?.usage) || s.usage || {};
    return { title: titleOf(s), input: u.input, output: u.output, cost: u.cost, current };
  }));
  if (LOCAL) $('usage-body').querySelector('.quota')?.after(el('p', { className: 'local-usage muted', textContent:
    `Local turns (${LOCAL.label}, on this device) use none of this allowance: they send no requests.` }));
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
  unwatch?.(); unwatch = null; view = null; attachError = null; changeRuns = new Map(); turnTimes = {}; dropKidWatches(); renderLog(); updateSend();
  const session = sessions.current;
  if (!session || !agent) return;
  await review.load(session.id);
  await loadKids(session.id);
  if (gen !== attachGen) return;
  watchKids();
  const token = await store.getSetting(revertKey(session.id));
  if (gen !== attachGen) return;
  revertable = token ? { at: token.at, cut: token.cut } : null;
  interrupted = !!(await store.getSetting(interruptedKey(session.id)));
  turnTimes = (await store.getSetting(turnsKey(session.id))) ?? {};
  if (gen !== attachGen) return;
  refreshChanges();
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
  const d = el('details', { className: 'reasoning' }, el('summary', { textContent: it.streaming ? 'Reasoning (in progress)' : 'Reasoning' }), el('div', { className: 'thinking', textContent: it.thinking }));
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
  open: (t) => (t.kind === 'dir' ? revealDir(t.path) : openFile(t.path, t.line)).catch((e) => alert(e.message)),
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
    b.onclick = () => openFile(abs, line ? Number(line) : undefined).catch((e) => alert(e.message));
    out.push(b);
    last = m.index + tok.length;
  }
  out.push(text.slice(last));
  return out;
}

// "Changed N files" under each turn (R2, R5). Runs are placed by afterItem:
// how many user messages the transcript held when the run was sent.
let changeRuns = new Map();
async function refreshChanges() {
  const gen = attachGen;
  const runs = await review.describe();
  if (gen === attachGen) { changeRuns = runs; scheduleRender(); }
}
async function undoRecs(recs) {
  try {
    const done = await review.undo(recs, async (paths) => confirm(
      `${paths.join(', ')} changed again after that turn (by a later turn or your own edit). Undo anyway and lose those later changes?`));
    if (done) {
      status('Undone.');
      for (const r of recs) noteForAgent(r.session, r.before.kind === 'none'
        ? `the user undid your creation of ${r.path} (it no longer exists)`
        : `the user undid your changes to ${r.path} (restored the version from before that turn)`);
    }
    return done;
  } catch (e) { alert(e.message); return false; }
}
const VERB = { created: 'created', modified: 'modified', deleted: 'deleted', moved: 'moved', undone: 'undone' };
function changesBlock(run) {
  if (!run.rows.length) return null;
  const n = run.rows.length;
  const box = el('div', { className: 'changes', role: 'group', ariaLabel: `Files changed in this turn` });
  const head = el('div', { className: 'head' }, el('span', { textContent: `Changed ${n} file${n > 1 ? 's' : ''}` }));
  const live = run.rows.filter((r) => !r.undone);
  if (live.length) {
    const all = el('button', { type: 'button', textContent: run.sub ? 'Undo all by this subagent' : 'Undo all from this turn' });
    all.onclick = () => undoRecs(live.flatMap((r) => r.recs));
    head.append(all);
  }
  box.append(head);
  for (const r of run.rows) {
    const target = r.to ?? r.path;
    const name = r.to ? `${r.path} -> ${r.to}` : r.path;
    const row = el('div', { className: 'change' },
      el('span', { className: 'st ' + r.status, textContent: VERB[r.status] }),
      el('span', { className: 'p', textContent: name, title: name }));
    const btn = (label, aria, fn, disabled = false) => {
      const b = el('button', { type: 'button', textContent: label, ariaLabel: aria, disabled });
      b.onclick = () => fn().catch?.((e) => alert(e.message));
      row.append(b);
    };
    const gone = r.status === 'deleted' || (r.undone && r.recs[0].before.kind === 'none');
    btn('Open', 'Open ' + target, () => openFile(target), r.dir || gone);
    btn('Diff', 'Show changes to ' + target, () => showDiff(r), r.dir || r.undone);
    if (!r.undone) btn('Undo', 'Undo changes to ' + target, () => undoRecs(r.recs));
    box.append(row);
  }
  return box;
}

function toolCard(it, prefix = '') {
  const k = prefix + it.id;
  const d = settings.bind(el('details', { className: 'tool' + (it.status === 'error' ? ' error' : '') }), `tool:${sessions.current?.id}:${k}`, 'tools');
  const mark = it.status === 'running' ? '... ' : it.status === 'error' ? '! ' : '';
  const sum = el('summary', {}, el('span', { className: 'what', textContent: `${mark}${it.name}: ${it.name === 'subagent' ? `${it.args?.action ?? ''} ${it.args?.name ?? it.args?.id ?? ''}`.trim() : argSummary(it.name, it.args)}` }));
  const eg = it.name === 'bash' ? (egressOf(it.output) ?? liveEgress.get(it.id)) : null;
  if (eg) {
    const who = eg.audiences.length ? eg.audiences.join('\n') : 'see the bayleaf-cli skill';
    sum.prepend(el('span', { className: 'egress', title: `Sent outside the pouch (${eg.commands.join(', ')}) to:\n${who}` }, icon('egress'), el('span', { textContent: 'left the pouch' })));
  }
  d.append(sum, ...toolDetail(it));
  return d;
}
// A subagent's report, where it joined the parent (the model saw it as a message).
const REPORT_VERB = { finished: 'finished', failed: 'failed', stopped: 'was stopped', interrupted: 'was interrupted' };
function reportCard(it, nextCache) {
  const kids_ = [el('div', { className: 'sa-report-head' }, el('span', { className: `sa-status ${it.status}`, textContent: it.status }), ` Subagent ${it.name} ${REPORT_VERB[it.status] ?? it.status}`)];
  if (it.text) kids_.push(replyBody(it.text, nextCache));
  else kids_.push(el('div', { className: 'body muted', textContent: it.status === 'stopped' ? 'Stopped before it reported. Pouch is told at its next turn.' : 'No report.' }));
  for (const run of changeRuns.values()) if (run.sub === String(it.child)) { const b = changesBlock(run); if (b) kids_.push(b); }
  return message({ ...it, type: 'report', text: it.text }, `Report from subagent ${it.name}`, ...kids_);
}

function renderLog() {
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const out = [];
  if (!view?.items.length) {
    out.push(el('p', { className: 'notice' + (attachError ? ' bad' : ''), textContent: attachError ? attachError : agent
      ? 'Ask Pouch to read, write or reorganize files in /work or a mounted folder. Everything stays in this browser; model requests are sealed.'
      : (agentError ?? 'Starting...') }));
  }
  // Change blocks by the user-message ordinal they follow; resumed runs go last.
  const users = view?.items.filter((i) => i.type === 'user').length ?? 0;
  const blocks = new Map();
  for (const run of changeRuns.values()) {
    if (run.sub) continue; // shown on the subagent's card and report
    const k = run.afterItem ?? users - 1;
    blocks.set(k, [...(blocks.get(k) ?? []), run]);
  }
  const flush = (k) => { for (const run of blocks.get(k) ?? []) { const b = changesBlock(run); if (b) out.push(b); } blocks.delete(k); };
  let ordinal = -1;
  const nextCache = new Map();
  finals = turnFinals(view);
  for (const it of view?.items ?? []) {
    if (it.type === 'user') {
      flush(ordinal); ordinal++;
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
      out.push(child != null ? subagentCard(it, child) : toolCard(it));
    } else if (it.type === 'report') {
      out.push(reportCard(it, nextCache));
    } else if (it.type === 'compaction') {
      out.push(el('details', { className: 'tool' }, el('summary', { textContent: 'Earlier turns were summarized' }), el('pre', { textContent: it.summary ?? '' })));
    } else if (it.type === 'notice') {
      out.push(el('p', { className: 'notice', textContent: it.text }));
    }
  }
  for (const k of [...blocks.keys()].sort((a, b) => a - b)) flush(k);
  // A reload cut off the last run; nothing resumes without a click (no request spent).
  if (interrupted && view && !busy()) {
    const b = el('button', { type: 'button', className: 'primary', textContent: 'Resume' });
    b.onclick = () => { b.disabled = true; resumeRun(); };
    out.push(el('p', { className: 'notice reverted', role: 'status' }, 'The page reloaded while Pouch was working, so that run stopped.', b));
  }
  // "Reverted to <time>. Undo", where the conversation was cut.
  if (revertable && view) {
    const undo = el('button', { type: 'button', textContent: 'Undo', disabled: busy() });
    undo.onclick = () => undoRevert(sessions.current?.id).catch((e) => alert(e.message));
    const note = el('p', { className: 'notice reverted', role: 'status' }, `Reverted to ${shortTime(revertable.at)}.`, undo);
    const at = out.findIndex((n) => n.dataset?.cut === String(revertable.cut));
    if (at < 0) out.push(note);
    else { let i = at + 1; while (out[i]?.classList?.contains('changes')) i++; out.splice(i, 0, note); }
  }
  mdCache = nextCache;
  // Rebuilding the log drops focus; give it back to the same message or button.
  const f = document.activeElement, fKey = log.contains(f) ? f.closest('.msg')?.dataset.key : null;
  const fAct = fKey && f.dataset.act;
  log.replaceChildren(...out);
  localImages.sweep();
  if (fKey) log.querySelector(`.msg[data-key="${CSS.escape(fKey)}"]${fAct ? ` [data-act="${fAct}"]` : ''}`)?.focus({ preventScroll: true });
  if (atBottom) log.scrollTop = log.scrollHeight;
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
    if (it.type === 'user' || it.type === 'report') { close(); start = it; last = null; }
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
const modelName = (id) => models.find((m) => m.id === id)?.name ?? (LOCAL && id === LOCAL_ID ? `Local: ${LOCAL.label}` : id);
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
    b.onclick = () => fn().catch((e) => alert(e.message));
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

// Fork the conversation just after `it` (agent.revert) and, if asked, undo
// the agent's file changes made after it. Kept for undoRevert: the previous
// conversation id and the bytes those files held (store, revertKey).
async function revertTo(it) {
  const s = sessions.current;
  if (!s || busy() || !view) return;
  const sid = s.id;
  const idx = view.items.indexOf(it);
  const later = view.items.slice(idx + 1).filter((i) => i.type === 'user' || (i.type === 'assistant' && (i.text || i.error))).length;
  const { recs, rows } = await review.since(it.cutAt ?? it.at ?? 0);
  const n = rows.length;
  const body = el('div', { className: 'revert-body' }, el('p', {
    textContent: `${later ? `${later} later message${later > 1 ? 's' : ''} leave${later > 1 ? '' : 's'} the view, and Pouch will not see ${later > 1 ? 'them' : 'it'} again.` : 'Nothing comes after this message.'} You can undo this.`,
  }));
  let box = null;
  if (n) {
    box = el('input', { type: 'checkbox', checked: true, id: 'revert-files' });
    body.append(
      el('label', { className: 'check' }, box, ` Also undo changes to ${n} file${n > 1 ? 's' : ''} made after this message`),
      el('ul', { className: 'revert-files' }, ...rows.map((r) => el('li', { textContent: `${r.to ? `${r.path} -> ${r.to}` : r.path} (${r.statuses.map((x) => VERB[x]).join(', ')})` }))));
  }
  sheet('Revert to here?', [['Revert', async () => {
    if (busy()) return;
    const undoFiles = !!box?.checked;
    const r = await agent.revert(sid, it.cut);
    const token = await review.hide(recs, undoFiles, async (paths) => confirm(
      `${paths.join(', ')} changed again after this message (by a later turn or your own edit). Undo anyway and lose those later changes?`));
    if (!token) { await agent.point(sid, r.from); await attach(); return; } // cancelled: back as it was
    await store.setSetting(revertKey(sid), { ...token, session: String(sid), from: r.from, to: r.to, at: it.at, cut: it.cut });
    if (sameId(sid, sessions.current?.id)) await attach();
    status(`Reverted to ${shortTime(it.at)}.`);
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
  if (since && !confirm(`Undo the revert? The ${since} message${since > 1 ? 's' : ''} you sent since leave${since > 1 ? '' : 's'} the view, and the conversation from before the revert comes back.`)) return;
  const ok = await review.unhide(t, async (paths) => confirm(
    `${paths.join(', ')} changed after the revert. Put back the versions from before the revert anyway and lose those changes?`));
  if (!ok) return;
  await agent.point(sid, t.from);
  await store.setSetting(revertKey(sid), undefined);
  await attach();
  status('Revert undone.');
}

// ── Notes for the agent ─────────────────────────────────────────────
// What the user did to the agent's work between turns (undo, revert, their
// own edits). The model reads them ahead of the next message; the transcript
// shows only what the user typed. Kept in settings, so a reload loses none.
async function noteForAgent(sid, text) {
  if (sid == null || sid === '') return;
  const list = (await store.getSetting(notesKey(sid))) ?? [];
  if (!list.includes(text)) await store.setSetting(notesKey(sid), [...list, text]);
}
// After the user saves or reverts part of a file the agent changed in this session.
function noteUserEdit(path, what) {
  const touched = [...changeRuns.values()].some((run) => run.rows.some((r) => !r.undone && (r.to ?? r.path) === path));
  if (touched) noteForAgent(sessions.current?.id, `the user ${what} ${path} after you changed it (read it again before editing it)`);
}

// ── Composer (composer.js) ──────────────────────────────────────────
const busy = () => !!view?.busy;
const PLACEHOLDER = 'Ask Pouch. @ for files, $ for skills, / for commands';
const attachments = createAttachments({ vfs, composer: $('composer'), input: $('input'), picker: $('attachment-picker'), button: $('attach-file'), chips: $('attachment-chips'), warning: $('attachment-warning'), status });
const submitting = new Set(); // per session: a send from Enter until its after-turn work (title, usage) is done
// A message sent while Pouch works, or while it finishes the last turn, waits
// here (one per session, shown in the tray) and goes when Pouch is ready.
// Input is never dropped: it is queued, or refused with a visible reason.
const queued = new Map(); // session id -> { text, attached, turnModel, at }
let queueing = false;
const curKey = () => String(sessions.current?.id ?? 'new');
function updateSend() {
  const b = busy(), finishing = !b && submitting.has(curKey());
  const label = b ? 'Stop' : finishing ? 'Queue' : 'Send';
  $('send-label').textContent = label;
  $('send').title = b ? 'Stop (Enter queues what you type)' : finishing ? 'Pouch is finishing the last turn. Queue this message; it sends when Pouch is ready.' : 'Send';
  $('send').classList.toggle('stop', b);
  $('send').classList.toggle('queue', finishing);
  $('send').querySelector('use').setAttribute('href', b ? '#i-stop' : '#i-send');
  $('send').disabled = !b && !canSend();
  if (!b && offline && !localPicked()) $('send').title = OFFLINE;
  $('composer').classList.toggle('offline', offline);
  if (queued.size) queueMicrotask(pump);
}
// Send the current session's queued message once nothing is in the way.
function pump() {
  const key = curKey(), q = queued.get(key);
  if (!q || busy() || submitting.has(key) || queueing || !(isLocal(q.turnModel) ? agent : agent && verified && !offline)) return;
  queued.delete(key);
  dispatch(key, () => q);
}
// One send with its bookkeeping. prepare() -> { text, attached, turnModel }.
async function dispatch(key, prepare) {
  submitting.add(key); updateSend(); composer.renderTray();
  let q = null;
  try { q = await prepare(); if (q) await send(q.text, q.attached, q.turnModel); }
  catch (e) {
    // The watched view can say idle a moment before pi-durable's run ends:
    // then the message waits in the queue and goes on the next try.
    if (q && /still running/.test(e.message) && !queued.has(key) && (q.tries = (q.tries ?? 0) + 1) <= 25) { queued.set(key, q); setTimeout(pump, 400); status('Queued: it sends when Pouch is ready.'); }
    else {
      status(e.message, 'bad');
      if (q && !$('input').value.trim()) { $('input').value = q.text; autosize(); } // not sent: the text comes back
    }
  }
  finally { submitting.delete(key); updateSend(); composer.renderTray(); }
}
function cancelQueued(key) {
  const q = queued.get(key);
  if (!q) return;
  queued.delete(key);
  if (!$('input').value.trim()) { $('input').value = q.text; autosize(); }
  status(q.attached.files.length ? 'Queued message cancelled and put back; its attachments are still in your files.' : 'Queued message cancelled and put back in the box.');
  composer.renderTray(); updateSend();
}
// agent.send's refusals before it admits input (agent.js).
const NOT_ADMITTED = /^Not connected|still running/;
// HTTP 429 or a quota message, from the relay or the model provider.
function quotaError(msg) { return /\b429\b|quota|rate.?limit|too many requests|allowance/i.test(msg ?? ''); }

async function send(text, attached = { files: [], images: [] }, turnModel = $('model').value) {
  const t0 = Date.now();
  if (!sessions.current) await sessions.create();
  const s = sessions.current; // the run belongs to this session even if you switch away
  const sid = s.id;
  s.model = turnModel;
  if (!s.title) { s.title = text.slice(0, 60); }
  s.updated = Date.now(); await sessions.save();
  if (interrupted && sameId(sid, sessions.current?.id)) interrupted = false;
  await store.setSetting(interruptedKey(sid), undefined);
  sessions.running.add(String(sid)); sessions.render();
  lostRuns.delete(String(sid));
  if (isLocal(turnModel)) { localRuns.add(String(sid)); clearHint(sid); }
  // A run: what its tools change is recorded under it, placed after this message.
  review.begin(sid, view?.items.filter((i) => i.type === 'user').length ?? 0);
  const notes = (await store.getSetting(notesKey(sid))) ?? [];
  const admitted = () => notes.length && store.setSetting(notesKey(sid), undefined);
  let ok = false, refused = null;
  try { await agent.send(sid, text, notes, attached, turnModel); admitted(); ok = true; }
  catch (e) {
    // Refused before admission: nothing entered the transcript. The caller
    // queues or restores the text (dispatch), so it is never lost.
    if (NOT_ADMITTED.test(e.message)) refused = e;
    else admitted();
    // The run's own error (an assistant item) may carry the HTTP status the summary lost.
    const detail = e.message + ' ' + (view?.items.findLast?.((i) => i.error)?.error ?? '');
    if (quotaError(detail)) status(exhaustedText(await usage.refresh()), 'bad');
    else if (!isLocal(turnModel) && (lostRuns.has(String(sid)) || isNetworkError(detail))) {
      lostRuns.add(String(sid));
      if (!navigator.onLine || !(await probe())) goOffline();
      else status('Connection lost during the turn; nothing more was sent. Send again to continue.', 'bad');
    }
    else if (!refused && e.message !== 'Stopped.') status('Request failed: ' + e.message, 'bad');
  }
  finally { sessions.running.delete(String(sid)); localRuns.delete(String(sid)); await review.end().catch(() => {}); refreshChanges(); }
  if (refused) throw refused;
  const ms = Date.now() - t0;
  const v = await agent.snapshot(sid).catch(() => null);
  await recordTurn(sid, v, ms);
  await sessions.afterTurn(sid, v, ok, turnModel);
}

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const raw = $('input').value;
  if (composer.runCommand(raw)) { $('input').value = ''; autosize(); return; }
  const key = curKey();
  const text = raw.trim() || (attachments.files.length ? 'Please examine the attached files.' : '');
  if (!text) return;
  const turnModel = $('model').value; // freeze before any asynchronous preparation
  if (isLocal(turnModel)) {
    // The Local lane needs no network or enclave, only the model on this device.
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
  // Pouch is working or finishing up: queue, or say why not.
  if (key === 'new') return status('Wait a moment: the session is still starting. Your message stays here.', 'bad');
  if (queued.has(key) || queueing) return status('A message is already queued. It sends when Pouch is ready; cancel it in the tray to change it. This one stays here.', 'bad');
  queueing = true;
  try { queued.set(key, await prepare()); status('Queued: it sends when Pouch is ready.'); }
  catch (err) { status(err.message, 'bad'); }
  finally { queueing = false; composer.renderTray(); updateSend(); }
};
$('send').onclick = (e) => { if (busy()) { e.preventDefault(); agent.abort(sessions.current.id); } };
// Enter sends with a keyboard; on touch screens Enter is a newline and Send sends.
$('input').onkeydown = (e) => {
  if (composer.onKeydown(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault(); $('composer').requestSubmit();
  }
};
function autosize() { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight + 2, innerHeight * 0.4) + 'px'; }
$('input').addEventListener('input', autosize);
$('composer-usage').onclick = () => layout.toggle('usage');
// A queued message lives in this page only: ask before a reload or close drops it.
addEventListener('beforeunload', (e) => { if (queued.size) e.preventDefault(); });

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
  { name: 'compact', hint: 'Summarize older turns (1 Sealed request)', run: async () => {
    if (!sessions.current) return status('No session to compact yet.', 'bad');
    status('Compacting...');
    try { await agent.compact(sessions.current.id); status('Older turns summarized.'); } catch (e) { status(e.message, 'bad'); }
  } },
  { name: 'rename', hint: 'Rename this session (/rename New title)', run: async (arg) => {
    if (!sessions.current) return status('No session to rename yet.', 'bad');
    if (!arg) return $('title').click();
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
    el('p', { textContent: 'Enter sends (on touch screens, tap Send). Shift+Enter is a new line. While Pouch works, Enter queues your message; it goes when Pouch is ready.' }))) },
];
const runSeen = new Map(); // running `run` call id -> first seen (ms), for the tray's elapsed time
const excerpt = (t, n = 90) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
function activity() {
  const sid = sessions.current?.id, key = curKey(), rows = [];
  for (const c of kids.get(String(sid)) ?? []) if (c.status === 'running') {
    rows.push({ key: 'sa:' + c.id, kind: 'subagent', text: `${c.name}: ${excerpt(c.task)}`, title: c.task, origin: 'subagent', since: c.resumed ?? c.started,
      stop: () => agent.subagents.stop(sid, c.id) });
  }
  const live = new Set();
  for (const t of view?.items ?? []) if (t.type === 'tool' && t.name === 'run' && t.status === 'running') {
    live.add(t.id);
    if (!runSeen.has(t.id)) runSeen.set(t.id, Date.now());
    rows.push({ key: 'run:' + t.id, kind: 'run', text: 'run ' + (t.args?.path ?? excerpt(t.args?.code?.split('\n').find((l) => l.trim()) ?? '', 70)), title: t.args?.code ?? t.args?.path,
      origin: 'run', since: runSeen.get(t.id), stop: () => { if (!agent.stopCall(t.id)) status('That run already finished.'); } });
  }
  for (const id of runSeen.keys()) if (!live.has(id)) runSeen.delete(id);
  for (const p of egress.pending) {
    rows.push({ key: 'eg:' + p.id, kind: 'approval', text: p.command, origin: p.agentName ? `${p.agentName}: waiting for you` : 'waiting for you', since: p.since, open: () => egress.focus() });
  }
  const q = queued.get(key);
  if (q) rows.push({ key: 'queued', kind: 'queued', text: excerpt(q.text), title: q.text, origin: busy() ? 'queued' : 'queued: sends when ready', stopLabel: 'Cancel', stop: () => cancelQueued(key) });
  return rows;
}
composer = createComposer({
  vfs, input: $('input'),
  roots: () => ['/work', '/pouch', '/tmp', ...[...vfs.mounts].filter(([, m]) => m.live).map(([n]) => '/mnt/' + n)],
  skills: async () => (await loadContext(vfs)).skills,
  commands: COMMANDS,
  activity,
  stopAll: async () => { for (const r of activity()) if (r.kind === 'subagent' || r.kind === 'run') await r.stop(); },
  shield: async () => {
    const sid = sessions.current?.id;
    if (localPicked()) return {
      lane: 'On this device: nothing sent',
      detail: `${LOCAL.label} runs in this browser on your GPU. Prompts, files and replies stay here; no request leaves for any model. Tools run here, in the page. Switch to a Sealed model in the picker for larger tasks.`,
      grants: (await grantsFor(sid)).map((service) => ({ label: serviceName(service), revoke: async () => {
        await revoke(sid, service); status(`Pouch will ask again before ${serviceName(service)} in this session.`);
      } })),
      trust: () => layout.open('trust'),
    };
    return {
      lane: verified ? 'Sealed: encrypted to the enclave' : offline ? 'Sealed: offline, nothing is sent' : 'Sealed: verifying the enclave',
      detail: verified ? 'This session\'s model requests are encrypted in this page to an attested enclave; BayLeaf relays ciphertext. Tools run here, in the page.'
        : 'Nothing is sent until the enclave verifies. There is no plaintext fallback.',
      grants: (await grantsFor(sid)).map((service) => ({ label: serviceName(service), revoke: async () => {
        await revoke(sid, service); status(`Pouch will ask again before ${serviceName(service)} in this session.`);
      } })),
      trust: () => layout.open('trust'),
    };
  },
  onTray: () => { const log = $('log'); if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight; },
});

// ── Boot ────────────────────────────────────────────────────────────
// Files first, so the workspace is usable even if the network or the agent is not.
let agentError = null;
let toolList = []; // kept for Run script, which uses the run tool without the model
(async () => {
  usage.subscribe((st) => { renderMeter(st); if (layout.current() === 'usage') renderUsagePanel(); });
  if (location.hash === '#erased') { history.replaceState(null, '', location.pathname + location.search); $('erased').hidden = false; }
  navigator.storage.persist?.().catch(() => {});
  try { await vfs.init(); } catch (e) { status('Storage problem: ' + e.message, 'bad'); }
  renderTree();
  $('welcome').hidden = !!(await store.getSetting('welcomed').catch(() => true));
  key = (await store.getSetting('key')) ?? null;
  renderAuth();
  usage.refresh();
  localOk = await localSupport();
  await loadModels();
  renderLocalSettings();
  try {
    agent = await openAgent({
      local: LOCAL && localOk.ok ? { info: LOCAL, engine: localEngine, onHint: showHint } : null,
      tools: toolList = createTools(vfs, Type, {}, {
        // A subagent's change is its own run; the main agent's joins the turn.
        beforeChange: (p, op, caller) => { const c = childOf(caller); return review.beforeChange(p, op, c ? { session: c.sid, sub: c.id } : undefined); },
        ...egressHooks,
      }),
      systemPrompt: () => systemPrompt(vfs),
      getClient: async () => (verified ? client : null),
      models,
      pointer: { get: (id) => store.getSetting(convKey(id)), set: (id, c) => store.setSetting(convKey(id), c) },
      onInterrupted: async (sids) => {
        for (const sid of sids) if (sid != null) await store.setSetting(interruptedKey(sid), true);
        if (sids.some((x) => sameId(x, sessions.current?.id))) { interrupted = true; scheduleRender(); }
      },
      subagents: {
        reg: { get: (sid) => store.getSetting(subagentsKey(sid)), set: (sid, l) => store.setSetting(subagentsKey(sid), l) },
        onChange: onKids,
        onReport: (sid, sub) => drive(sid, () => sub.wait()),
        onSettle: async (sid, c) => { await review.endSub(c.id).catch(() => {}); if (sameId(sid, sessions.current?.id)) refreshChanges(); usage.refresh(); },
        lowAllowance,
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
  await connect();
})();
