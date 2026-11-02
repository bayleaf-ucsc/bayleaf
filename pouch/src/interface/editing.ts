// Editor and previews: the open file, its conflicts and diffs, and show (the agent putting a file in front of the person).

import { normalize } from '../vfs.ts';
import { createEditor } from '../editor.ts';
import { renderMarkdown } from '../markdown.ts';
import { MEDIA_MAX, createPreview, previewOf, rememberMode, rememberedMode } from '../preview.ts';
import { $, el } from '../dom.ts';
import type { App } from './app.ts';
import type { ViewMode } from '../preview.ts';
import type { ShowRequest, ShownLine } from '../open-cli.ts';
import type { Caller } from '../tools-types.ts';

export interface OpenFileOptions {
  link?: boolean; // opened from a reply: an HTML report opens in Preview
  mode?: ViewMode | null; interactive?: boolean; // the terminal's `open` names both, remembering neither
  recheck?: (() => string | null) | null; // show: a reason to stop after the read
}
// true when opened, false when the user kept unsaved changes, or why it was not: 'binary' or recheck()'s.
export type OpenFileResult = boolean | string;
export interface ShowResult { opened: boolean; reason?: string }
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isViewMode = (m: string | undefined): m is ViewMode => m === 'raw' || m === 'preview';
// The button an event in a segmented control landed on.
const buttonOf = (e: Event) => (e.target instanceof Element ? e.target.closest('button') : null);

export interface EditingRegion {
  // Sending hands the turn over: the keys that sent it do not make the person busy (show).
  handOver(): void;
  openFile(path: string, line?: number, opts?: OpenFileOptions): Promise<OpenFileResult>;
  readonly openPath: string | null;
  // A rename moved from to to: the open file follows if it was there or inside.
  renamed(from: string, to: string): void;
  // Show (LANGUAGE.md): an agent puts a file or folder in front of the person.
  show(req: Pick<ShowRequest, 'path' | 'dir' | 'mode'>, caller: Caller): Promise<ShowResult>;
  shownCard(line: ShownLine): HTMLParagraphElement;
  syncEditor(): Promise<void>;
}

export function createEditingRegion(app: App): EditingRegion {
  // ── Editor ──────────────────────────────────────────────────────────
  // The editor keeps a baseline: the text it last loaded or saved. When the
  // file changes on disk under a dirty buffer, that is a conflict for the user
  // to settle (story map R4), never a silent overwrite either way.
  let openPath: string | null = null;
  let dirty = false;
  let conflict: string | null = null;   // disk text that arrived while the buffer was dirty
  let merging = false;   // the conflict diff (theirs vs mine) is shown
  const editor = createEditor($('editor'), {
    onSave: () => saveFile(),
    onChange: (d) => { dirty = d; $<HTMLButtonElement>('save').disabled = !d; $('editor-path').classList.toggle('dirty', d); markEditor(); },
  });

  // Previews (src/preview.ts, README "Previews"): Raw | Preview for markdown,
  // HTML and SVG; images, audio and video open as a preview only (viewOnly:
  // there is no text to edit, so nothing can be saved over them). A preview
  // shows the saved file. HTML reports start Static every time: Interactive is
  // never remembered, because its scripts keep a way out (WebRTC).
  let fileView: ViewMode = 'raw', viewOnly = false, scripts = false, shown: string | null = null;
  const preview = createPreview($('preview'), { markdown: (text, path) => renderMarkdown(text, { ...app.transcript.mdCtx, cwd: normalize(path + '/..') }) });
  function setView(mode: ViewMode) {
    const p = openPath ? previewOf(openPath) : null;
    fileView = p ? mode : 'raw';
    $('view-mode').hidden = !p?.raw;
    for (const b of $('view-mode').querySelectorAll<HTMLElement>(':scope > *')) b.setAttribute('aria-pressed', String(b.dataset.mode === fileView));
    $('editor').hidden = fileView === 'preview';
    $('preview').hidden = fileView !== 'preview';
    $('save').hidden = viewOnly;
    shown = null;
    if (fileView === 'preview') renderPreview();
    else { preview.clear(); $('preview-bar').hidden = true; }
  }
  // Draws the saved file; on a file change, only if its bytes changed.
  async function renderPreview() {
    // Called with a file open that has a preview (setView, syncEditor).
    const path = openPath, p = path && previewOf(path);
    if (!path || !p) return;
    const html = p.kind === 'html';
    $('script-mode').hidden = !html;
    for (const b of $('script-mode').querySelectorAll<HTMLElement>(':scope > *')) b.setAttribute('aria-pressed', String((b.dataset.scripts === 'on') === scripts));
    $('preview-note').textContent = [
      dirty && 'Showing the saved version: save to preview your edits.',
      html && (scripts
        ? 'Interactive: scripts run. They cannot read Pouch or your files, and web requests are blocked, but a script can still reach the network over WebRTC (and in Safari, a link preconnect), so a hostile report could send out what it shows. Only for reports you trust.'
        : 'Static: no scripts run, and nothing in this report can reach the network.'),
    ].filter(Boolean).join(' ');
    $('preview-bar').hidden = !$('preview-note').textContent;
    try {
      const st = await app.state.vfs.fs.stat(path);
      if (!p.raw && st.size > MEDIA_MAX) return preview.notice(`This file is ${(st.size / 2 ** 20).toFixed(0)} MB; Preview shows files up to 50 MB. Download it instead.`);
      const bytes = await app.state.vfs.fs.readFileBuffer(path);
      // digest takes only ArrayBuffer-backed views: other bytes (a SharedArrayBuffer's) are copied.
      const view = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) : bytes.slice();
      const sig = [scripts, ...new Uint8Array(await crypto.subtle.digest('SHA-256', view))].join();
      if (path !== openPath || fileView !== 'preview' || sig === shown) return;
      shown = sig;
      preview.render(path, bytes, { scripts });
    } catch (e) { preview.notice('Could not preview this file: ' + messageOf(e)); }
  }
  $('view-mode').onclick = (e) => {
    const m = buttonOf(e)?.dataset.mode, p = openPath && previewOf(openPath);
    if (!isViewMode(m) || m === fileView || !p) return;
    rememberMode(p.kind, m);
    setView(m);
    if (m === 'raw') editor.focus();
  };
  $('script-mode').onclick = (e) => {
    const on = buttonOf(e)?.dataset.scripts;
    if (!on || (on === 'on') === scripts) return;
    scripts = on === 'on';
    renderPreview();
  };

  function showEditor(path: string) {
    $('editor-path').textContent = path;
    $('editor-pane').classList.remove('empty');
    app.state.layout.open('editor');
    app.tree.renderTree();
  }
  // No file open: the Editor panel says how to open one.
  function editorEmpty() {
    $('editor-path').textContent = 'No file open';
    $('editor-pane').classList.add('empty');
    markEditor();
  }
  // A dot on the Editor rail icon while the buffer holds unsaved or conflicting edits.
  function markEditor() {
    $('rail').querySelector('[data-panel="editor"]')?.classList.toggle('dot', !!openPath && (dirty || conflict != null));
  }
  function setConflict(theirs: string | null) {
    conflict = theirs;
    $('conflict-bar').hidden = theirs == null;
    $('conflict-diff').hidden = merging; // the diff is already open (critique 3)
    if (theirs == null) editorStatus(null);
    markEditor();
  }
  // Save and conflict feedback, in the editor pane rather than under the chat
  // composer, and cleared once the conflict is settled (critique 2).
  function editorStatus(text: string | null, kind = '') {
    const n = $('editor-status');
    n.hidden = !text; n.textContent = text ?? ''; n.className = kind;
  }
  function setReviewBar(text: string | null) {
    $('review-bar').hidden = text == null;
    $('review-mine').hidden = $('review-theirs').hidden = true;
    $('review-text').textContent = text ?? '';
  }

  // link: opened from a reply, where an HTML report opens in Preview; a line
  // number always opens Raw. Otherwise each kind opens in its last mode.
  // mode, interactive: the terminal's `open` (src/open-cli.ts) names both, and
  // remembers neither. Returns true when opened, false when the user kept
  // unsaved changes, or a reason it was not: 'binary', or recheck()'s (show).
  async function openFile(path: string, line?: number, { link = false, mode = null, interactive = false, recheck = null }: OpenFileOptions = {}): Promise<OpenFileResult> {
    const p = previewOf(path);
    const want: ViewMode | null = mode ?? (line ? 'raw' : link && p?.kind === 'html' ? 'preview' : null);
    const wantScripts = !!mode && p?.kind === 'html' && interactive;
    // Reopening the file you are editing only moves the cursor: no reload, no loss.
    if (path !== openPath || merging) {
      if (dirty && !(await app.tree.ask(`Discard unsaved changes to ${openPath}?`, 'Discard', 'danger'))) return false;
      if (p && !p.raw) { // image, audio, video: a preview only
        await app.state.vfs.fs.stat(path);
        const why = recheck?.(); if (why) return why;
        openPath = path; merging = false; viewOnly = true; scripts = false;
        setReviewBar(null); setConflict(null);
        editor.load(path, '');
        setView('preview');
        showEditor(path);
        return true;
      }
      const bytes = await app.state.vfs.fs.readFileBuffer(path);
      // The person's edits or activity during the read win over show (src/open-cli.ts).
      const why = recheck?.(); if (why) return why;
      if (bytes.includes(0)) {
        app.state.sheet(path + ' looks binary', [
          app.tree.ARCHIVE.test(path) && app.state.vfs.where(path) !== 'mount-ro' && ['Unpack here', () => app.tree.unpackHere(path)],
          app.tree.ARCHIVE.test(path) && ['List contents', () => app.tree.listArchive(path)],
          app.tree.ARCHIVE.test(path) && ['Layer under /work (read-only seed)', () => app.tree.stackSeed(path)],
          ['Download', () => app.tree.download(path)],
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
  // (bash `show`, src/open-cli.ts). For now it opens at once only when that
  // would not get in their way; otherwise the transcript offers it (shownCard).
  // Provisional, pending experience with it.
  const SHOW_QUIET_MS = 4000; // a touch of the page this recent means the person is busy
  let lastTouch = 0;
  for (const ev of ['keydown', 'pointerdown', 'wheel']) document.addEventListener(ev, () => { lastTouch = performance.now(); }, { capture: true, passive: true });
  function showBusy(caller: Caller) {
    if (caller != null && app.state.agent?.who(caller)?.child != null) return 'a subagent asked';
    if (dirty) return 'unsaved edits';
    if (document.querySelector('dialog[open]')) return 'a dialog is open';
    if (performance.now() - lastTouch < SHOW_QUIET_MS) return 'typing or pointing just now';
    return null;
  }
  async function show({ path, dir, mode }: Pick<ShowRequest, 'path' | 'dir' | 'mode'>, caller: Caller): Promise<ShowResult> {
    const reason = showBusy(caller);
    if (reason) return { opened: false, reason };
    if (dir) await app.transcript.revealDir(path);
    else {
      const r = await openFile(path, undefined, { mode, recheck: () => showBusy(caller) });
      if (r === 'binary') throw new Error('looks binary; not opened (the person was offered Download)');
      if (r !== true) return { opened: false, reason: r || 'unsaved edits' };
    }
    return { opened: true };
  }
  // A bash result's `shown:` lines, read back so the card survives reload.
  function shownCard({ how, path, label, reason }: ShownLine) {
    const b = el('button', { type: 'button', textContent: 'Open', title: `Open ${path} (${label})` });
    b.onclick = () => (label === 'Files' ? app.transcript.revealDir(path) : openFile(path, undefined, { mode: label === 'Raw' ? 'raw' : 'preview' })).catch((e: Error) => app.tree.fail(e.message));
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
      const disk = (await app.state.vfs.fs.exists(openPath)) ? await app.state.vfs.fs.readFile(openPath) : null;
      if (disk !== null && disk !== editor.baseline && disk !== editor.text()) {
        setConflict(disk);
        editorStatus('Not saved: Pouch changed this file meanwhile. Show diff, Keep mine or Take theirs, then Save.', 'bad');
        return;
      }
      await app.state.userFs.writeFile(openPath, editor.text()); editor.markSaved(); setConflict(null); app.state.vfs.changed();
      editorStatus(null);
    } catch (e) { editorStatus('Could not save: ' + messageOf(e), 'bad'); }
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
    if (dirty && !(await app.tree.ask(`Discard unsaved changes to ${openPath}?`, 'Discard', 'danger'))) return;
    openPath = null; dirty = false; merging = false; viewOnly = false; scripts = false;
    setReviewBar(null); setConflict(null);
    editor.load('', '');
    setView('raw');
    editorEmpty();
    app.state.layout.open('files');
    app.tree.renderTree();
  }
  $('save').onclick = saveFile;
  $('close-file').onclick = closeFile;
  $('to-files').onclick = () => app.state.layout.open('files');

  // Merged by hand: their version is now seen, the buffer is yours to save.
  $('review-done').onclick = () => { settleDiff(); editor.focus(); };
  $('review-mine').onclick = () => { editor.settleAll(true); settleDiff(); editor.focus(); };
  $('review-theirs').onclick = () => { editor.settleAll(false); settleDiff(); editor.focus(); };
  // The conflict bar shows only while a file is open with a conflict.
  $('conflict-diff').onclick = () => {
    if (openPath == null || conflict == null) return;
    merging = true; $('conflict-diff').hidden = true;
    editor.diff(openPath, conflict, editor.text());
    setReviewBar('Each change shows Pouch\'s version struck through, then your version. Keep mine or Take theirs on each, then Done (or Save).');
    editor.focus();
  };
  $('conflict-mine').onclick = () => { if (conflict == null) return; editor.setBaseline(conflict); setConflict(null); editor.focus(); };
  $('conflict-theirs').onclick = () => {
    if (openPath == null || conflict == null) return;
    merging = false; setReviewBar(null);
    editor.load(openPath, conflict); setConflict(null); editor.focus();
  };

  // When the agent changes the open file and you have no edits, follow it;
  // with edits, raise a conflict. If it was deleted: close a clean buffer; keep
  // a dirty one and say so (Save would re-create the file, deliberately).
  async function syncEditor() {
    if (openPath && viewOnly && !(await app.state.vfs.fs.exists(openPath))) { openPath = null; viewOnly = false; setView('raw'); editorEmpty(); return; }
    if (openPath && !viewOnly) await syncText();
    if (!openPath && fileView !== 'raw') setView('raw'); // a deleted file closed
    if (openPath && fileView === 'preview' && (await app.state.vfs.fs.exists(openPath))) renderPreview();
  }
  async function syncText() {
    if (!openPath) return;
    if (!(await app.state.vfs.fs.exists(openPath))) {
      if (dirty) { $('editor-path').textContent = openPath + ' (deleted)'; return; }
      openPath = null; editorEmpty();
      return;
    }
    const text = await app.state.vfs.fs.readFile(openPath);
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

  return {
    handOver: () => { lastTouch = 0; },
    openFile,
    get openPath() { return openPath; },
    renamed: (from, to) => {
      if (openPath !== from && !openPath?.startsWith(from + '/')) return;
      openPath = to + openPath.slice(from.length); $('editor-path').textContent = openPath;
    },
    show,
    shownCard,
    syncEditor,
  };
}
