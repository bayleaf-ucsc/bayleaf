// File browser: the tree, uploads, archives, clipboard, first visit and Run script.

import * as store from '../store.ts';
import { normalize } from '../vfs.ts';
import { CWD } from '../tools.ts';
import { collect, packTar, packZip, unpackTar, unpackZip } from '../archive.ts';
import { $, blobOf, el, icon } from '../dom.ts';
import { play } from '../motion.ts';
import type { App } from './app.ts';
import type { ArchiveEntry } from '../archive.ts';
import type { runTool } from '../run.ts';

// An incoming file: its destination and a reader for its bytes.
export interface IncomingFile { path: string; data(): Promise<Uint8Array | string> }
export interface BatchResult { written: number; skipped: number; paths: string[] }
// A tree row, with its place in the tree kept on the element for keyboard moves.
export type TreeRow = HTMLDivElement & { meta: { path: string; depth: number; isDir: boolean; locked?: boolean } };
type Sheet = App['state']['sheet'];
type SheetItem = Parameters<Sheet>[1][number];
type SheetBody = Parameters<Sheet>[2];
type Root = [path: string, name: string, tag: string, mountName?: string, locked?: boolean];
type ChoiceOption = [value: string, label: string, cls?: string];
type RunTool = ReturnType<typeof runTool>;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
// The entry API's isFile and isDirectory say which kind an entry is; its types do not.
const isFileEntry = (e: FileSystemEntry): e is FileSystemFileEntry => e.isFile;
const isDirEntry = (e: FileSystemEntry): e is FileSystemDirectoryEntry => e.isDirectory;

export interface TreeRegion {
  ARCHIVE: RegExp;
  // A yes/no question in the sheet; resolves true only on the verb.
  ask(text: string | Node, verb?: string, cls?: string, title?: string): Promise<boolean>;
  download(path: string, bytes?: Blob | Uint8Array): void | Promise<void>;
  expanded: Set<string>;
  fail(m: string): void;
  // The row holding the roving tab stop.
  get focusPath(): string; set focusPath(v: string);
  listArchive(path: string): Promise<void>;
  offerDefaults(): void;
  renderNamespaces(): void;
  renderTree(): Promise<void>;
  stackSeed(path: string): Promise<void>;
  treeRows(): TreeRow[];
  unpackHere(path: string): Promise<void>;
}

export function createTreeRegion(app: App): TreeRegion {
  // ── File browser ────────────────────────────────────────────────────
  const expanded = new Set(['/work']);
  const ROOTS: Root[] = [['/work', 'work', 'this browser'], ['/pouch', 'pouch', 'shared'], ['/tmp', 'tmp', 'memory']];
  // What each storage tag means: the tag's title on hover, the storage sheet on tap (T4).
  const STORAGE: Record<string, string> = {
    'this browser': 'Kept in this browser (its private file system) until you press Erase all. Nothing is uploaded.',
    shared: 'Instructions (AGENTS.md) and skills the agent reads in every session, kept in this browser.',
    memory: 'Memory only: gone when you reload the page.',
    'memory only': 'This browser gives Pouch no private file system, so /work is memory only and is lost on reload.',
    device: 'A folder on your device, mounted read-write: changes, including the agent\'s, go straight to your disk.',
    'read-only': 'A folder on your device, mounted read-only: Pouch can read it but not change it.',
    'tap to reconnect': 'A device folder mounted earlier. Tap to grant access again; browsers ask after each reload.',
  };
  function storageInfo() {
    app.state.sheet('Where your files are kept', [['Upload files into /work', () => uploadTo('/work')]], [
      'work: this browser only, kept until you press Erase all. Nothing is uploaded.',
      'pouch: shared instructions (AGENTS.md) and skills the agent reads in every session, also in this browser.',
      'tmp: memory, gone when you reload.',
      'Mounted folders (Mount): real folders on your device. A read-write mount lets the agent change your files.',
      'What leaves this page: your messages and the files the agent reads, encrypted to the attested enclave.',
      'On a borrowed computer: Download all, then Erase all before you leave.',
    ].join('\n\n'));
  }

  function download(path: string, bytes?: Blob | Uint8Array) {
    const go = (b: Blob | Uint8Array) => {
      const url = URL.createObjectURL(b instanceof Blob ? b : blobOf(b, ''));
      const a = el('a', { href: url, download: path.split('/').pop() });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    return bytes ? go(bytes) : app.state.vfs.fs.readFileBuffer(path).then(go);
  }

  // Folders leave as .zip (opens natively on Windows, macOS and phones) or .tar.
  async function downloadDir(path: string, format = 'zip', fileName?: string) {
    const name = path.split('/').pop() || 'folder';
    const entries = await collect(app.state.vfs.fs, normalize(path + '/..'), name);
    download(fileName ?? `${name}.${format}`, format === 'zip' ? await packZip(entries) : packTar(entries));
    app.state.status(`Downloaded ${path} as .${format} (${entries.filter((e) => !e.dir).length} files).`);
  }

  // "file.txt" -> "file (2).txt", the first name not taken.
  async function freeName(path: string) {
    const dir = normalize(path + '/..'), base = path.slice(dir.length).replace(/^\//, '');
    const [, stem = base, ext = ''] = /^(.+?)(\.[^.]*)?$/.exec(base) ?? [];
    for (let i = 2; ; i++) {
      const p = normalize(`${dir}/${stem} (${i})${ext}`);
      if (!(await app.state.vfs.fs.exists(p))) return p;
    }
  }

  // Ask with the sheet; resolves to the chosen value, or null if dismissed.
  function choose(title: string, options: (ChoiceOption | false)[], body?: SheetBody) {
    return new Promise<string | null>((resolve) => {
      $<HTMLDialogElement>('sheet').addEventListener('close', () => resolve(null), { once: true });
      app.state.sheet(title, options.map((o): SheetItem => o && [o[1], () => resolve(o[0]), o[2]]), body);
    });
  }

  // Write a batch of incoming files, [{ path, data: async () => bytes }], never
  // overwriting silently (I1, I2): one question per batch, answered for all
  // conflicts at once or one by one. Returns null if cancelled before writing.
  async function writeBatch(where: string, items: IncomingFile[], dirs: string[] = []): Promise<BatchResult | null> {
    const clashes = new Set<IncomingFile>();
    for (const it of items) if (await app.state.vfs.fs.exists(it.path)) clashes.add(it);
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
    for (const d of dirs) await app.state.userFs.mkdir(d, { recursive: true });
    let written = 0, skipped = 0;
    const paths: string[] = [];
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
        else if ((await app.state.vfs.fs.stat(dest)).isDirectory) await app.state.userFs.rm(dest, { recursive: true });
      }
      await app.state.vfs.fs.mkdir(normalize(dest + '/..'), { recursive: true });
      await app.state.userFs.writeFile(dest, await it.data());
      written++; paths.push(dest);
    }
    return { written, skipped, paths };
  }

  async function addFiles(where: string, items: IncomingFile[], dirs?: string[], verb = 'Added') {
    try {
      const r = await writeBatch(where, items, dirs);
      if (r) { expanded.add(where); app.state.status(`${verb} ${r.written} file${r.written === 1 ? '' : 's'} in ${where}${r.skipped ? ` (${r.skipped} skipped)` : ''}.`); }
      return r;
    } catch (e) { fail('Could not add files: ' + messageOf(e)); }
    finally { app.state.vfs.changed(); }
  }
  const fileItem = (path: string, file: File): IncomingFile => ({ path, data: async () => new Uint8Array(await file.arrayBuffer()) });

  // Dropped items may be folders: walk them with the (widely supported) entry API.
  // Where that is missing (and for folder pickers), files carry their folder in
  // webkitRelativePath. Both lists must be read before the first await: the
  // browser empties a DataTransfer once the drop event returns.
  async function dropInto(dir: string, dataTransfer: DataTransfer) {
    const entries = [...dataTransfer.items].flatMap((i) => i.webkitGetAsEntry?.() ?? []);
    const files = [...dataTransfer.files];
    const items: IncomingFile[] = [], dirs: string[] = [];
    const walk = async (entry: FileSystemEntry, rel: string): Promise<number | undefined> => {
      const path = normalize(dir + '/' + rel);
      if (isFileEntry(entry)) return items.push(fileItem(path, await new Promise<File>((res, rej) => entry.file(res, rej))));
      if (!isDirEntry(entry)) return;
      dirs.push(path);
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, rel + '/' + e.name);
      }
    };
    try {
      if (entries.length) for (const e of entries) await walk(e, e.name);
      else for (const f of files) items.push(fileItem(normalize(dir + '/' + (f.webkitRelativePath || f.name)), f));
    } catch (e) { return fail('Could not read the dropped files: ' + messageOf(e)); }
    await addFiles(dir, items, dirs);
  }

  const canPickFolder = 'webkitdirectory' in HTMLInputElement.prototype;
  function uploadTo(dir: string, folder = false) {
    const input = $<HTMLInputElement>(folder ? 'upload-dir' : 'upload');
    input.onchange = async () => {
      const files = [...(input.files ?? [])]; input.value = '';
      await addFiles(dir, files.map((f) => fileItem(normalize(dir + '/' + (f.webkitRelativePath || f.name)), f)));
      app.state.layout.open('files');
    };
    input.click();
  }

  // ── Archives: unpack and list (I4) ──
  const ARCHIVE = /\.(zip|tar)$/i;
  async function readArchive(path: string): Promise<ArchiveEntry[]> {
    const bytes = await app.state.vfs.fs.readFileBuffer(path);
    const entries = /\.zip$/i.test(path) ? await unpackZip(bytes) : unpackTar(bytes);
    // Same zip-slip rule as extract(); macOS's __MACOSX resource forks are noise.
    return entries.filter((e) => !e.path.split('/').includes('..') && !/^__MACOSX(\/|$)/.test(e.path))
      .map((e) => ({ ...e, path: normalize('/' + e.path).slice(1) })).filter((e) => e.path);
  }
  // Stack /work over an archive (src/ns/seed.ts): its files show under /work
  // until you change or remove them; your own files win.
  async function stackSeed(path: string) {
    try {
      const n = await app.state.vfs.stack(path.split('/').pop() ?? path, await app.state.vfs.fs.readFileBuffer(path));
      app.state.status(`/work is now stacked over ${path.split('/').pop()} (${n} files, read-only). Your files win; remove the layer under What can BayLeaf see?`);
      renderTree(); renderNamespaces(); app.state.vfs.watches?.rescan('seed');
    } catch (e) { app.state.status('Could not use it as a seed layer: ' + messageOf(e), 'bad'); }
  }
  // The trust panel's mount tables: the agent's, then each task's.
  function renderNamespaces() {
    const f = $('ns-facts');
    if (!f) return;
    f.replaceChildren(el('dt', { textContent: 'Agent' }), el('dd', {}, el('pre', { textContent: app.state.vfs.describe().join('\n') })));
    for (const t of app.state.vfs.tasks.list().slice().reverse()) {
      f.append(el('dt', { textContent: `/task/${t.id}: ${t.kind} ${t.label ?? ''} (${t.status})` }), el('dd', {}, el('pre', { textContent: app.state.vfs.tasks.mounts(t).join('\n') })));
    }
    $('seed-row').hidden = !app.state.vfs.seedLayer;
  }
  $('seed-remove').onclick = async () => { await app.state.vfs.unstack(); app.state.vfs.watches?.rescan('seed'); renderTree(); renderNamespaces(); app.state.status('Removed the seed layer; /work shows only your files.'); };
  app.state.vfs.tasks.addEventListener('change', () => { if (app.state.layout.current() === 'trust') renderNamespaces(); });
  // A bundled default (a skill) changed and the user's copy differs: ask once.
  function offerDefaults() {
    const path = app.state.vfs.defaultUpdates?.[0];
    $('default-update').hidden = !path;
    if (!path) return;
    $('default-update-text').textContent = `A newer ${path.replace(/^\/skills\/|\/SKILL\.md$/g, '')} skill ships with this build, and your /pouch${path} differs from the one Pouch gave you. Take the new one (yours is replaced), or keep yours?`;
    $('default-take').onclick = () => app.state.vfs.resolveDefault(path, true).then(() => { app.state.status(`Updated /pouch${path}.`); offerDefaults(); });
    $('default-keep').onclick = () => app.state.vfs.resolveDefault(path, false).then(offerDefaults);
  }

  async function unpackHere(path: string) {
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
  async function listArchive(path: string) {
    const entries = await readArchive(path);
    const n = entries.filter((e) => !e.dir).length;
    app.state.sheet(`${n} file${n === 1 ? '' : 's'} in ${path.split('/').pop()}`, [['Unpack here', () => unpackHere(path)]],
      el('pre', { textContent: entries.map((e) => (e.dir ? `${e.path}/` : `${e.path}  (${e.data.length} bytes)`)).join('\n') }));
  }

  // ── Clipboard, for borrowed computers (O4, I5) ──
  async function copyText(path: string) {
    const bytes = await app.state.vfs.fs.readFileBuffer(path);
    if (bytes.includes(0)) return fail(`${path} looks binary. Download it instead.`);
    try { await navigator.clipboard.writeText(new TextDecoder().decode(bytes)); app.state.status(`Copied the text of ${path}.`); }
    catch (e) { fail(`This browser did not allow copying (${messageOf(e)}). Open the file, select all in the editor and copy from there.`); }
  }
  async function newFromClipboard(dir: string) {
    let text: string;
    try { text = await navigator.clipboard.readText(); }
    catch (e) { return fail(`This browser did not allow reading the clipboard (${messageOf(e)}). Make a new file and paste into the editor instead.`); }
    if (!text) return fail('The clipboard holds no text.');
    const name = (await askName('New file from clipboard', `Name for the new file (${text.length} characters from the clipboard)`, 'pasted.txt'))?.trim();
    if (!name) return;
    const path = normalize(dir + '/' + name);
    const r = await addFiles(dir, [{ path, data: async () => new TextEncoder().encode(text) }]);
    if (r?.paths.length) app.editing.openFile(r.paths[0]).catch((e) => fail(e.message));
  }

  // A name asked inline in the sheet (no native prompt); null when cancelled.
  function askName(title: string, label: string, value = '', verb = 'Create') {
    return new Promise<string | null>((resolve) => {
      const input = el('input', { id: 'name-input', className: 'key-input', value, spellcheck: false, autocomplete: 'off' });
      const form = el('form', { className: 'key-form' }, el('label', { htmlFor: 'name-input', textContent: label }), el('div', { className: 'key-row' }, input, el('button', { type: 'submit', className: 'primary', textContent: verb })));
      let done = false;
      // The sheet that opened this one closes just before: its close event must not count.
      const onClose = () => { if ($<HTMLDialogElement>('sheet').open) return; $<HTMLDialogElement>('sheet').removeEventListener('close', onClose); if (!done) resolve(null); };
      form.onsubmit = (e) => { e.preventDefault(); const v = input.value.trim(); if (!v) return input.focus(); done = true; $<HTMLDialogElement>('sheet').close(); resolve(v); };
      app.state.sheet(title, [], form);
      $<HTMLDialogElement>('sheet').addEventListener('close', onClose);
      input.focus();
    });
  }
  // A yes/no question in the sheet (never a native confirm, which blocks the
  // page and is easy to dismiss by reflex). Resolves true only on the verb.
  function ask(text: string | Node, verb = 'OK', cls = 'primary', title = 'Are you sure?') {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const onClose = () => { if ($<HTMLDialogElement>('sheet').open) return; $<HTMLDialogElement>('sheet').removeEventListener('close', onClose); if (!done) resolve(false); };
      app.state.sheet(title, [[verb, () => { done = true; resolve(true); }, cls]], text);
      $<HTMLDialogElement>('sheet').addEventListener('close', onClose);
    });
  }
  const fail = (m: string) => app.state.status(m, 'bad');
  async function newEntry(dir: string, kind: 'dir' | 'file') {
    const name = await askName(kind === 'dir' ? 'New folder' : 'New file', `${kind === 'dir' ? 'Folder' : 'File'} name in ${dir}`);
    if (!name) return;
    const p = normalize(dir + '/' + name);
    if (kind === 'dir') await app.state.vfs.fs.mkdir(p, { recursive: true });
    else { await app.state.vfs.fs.mkdir(normalize(p + '/..'), { recursive: true }); if (!(await app.state.vfs.fs.exists(p))) await app.state.userFs.writeFile(p, ''); }
    // "a/b/c" makes several folders at once: open the way down to the new entry.
    for (let q = normalize(p + '/..'); q.length >= dir.length && q !== '/'; q = normalize(q + '/..')) expanded.add(q);
    app.state.vfs.changed();
    if (kind !== 'dir') app.editing.openFile(p);
  }

  async function rename(path: string) {
    const name = await askName('Rename', 'Rename to', path.split('/').pop(), 'Rename');
    if (!name || name.includes('/')) return;
    const dest = normalize(path + '/../' + name);
    if (dest === path) return;
    // mv is copy-then-delete, so renaming onto a name in use would destroy it (R1).
    if (await app.state.vfs.fs.exists(dest)) return fail(`${name} already exists in ${normalize(path + '/..')}. Pick another name, or delete that one first.`);
    await app.state.userFs.mv(path, dest);
    // The open file may be the renamed entry or inside a renamed folder.
    if (app.editing.openPath === path || app.editing.openPath?.startsWith(path + '/')) { app.editing.openPath = dest + app.editing.openPath.slice(path.length); $('editor-path').textContent = app.editing.openPath; }
    if (focusPath === path) focusPath = dest;
    app.state.vfs.changed();
  }

  async function remove(path: string, isDir: boolean) {
    if (!(await ask(`Delete ${path}${isDir ? ' and everything in it' : ''}?`, 'Delete', 'danger'))) return;
    await app.state.userFs.rm(path, { recursive: true, force: true });
    app.state.vfs.changed();
  }

  function mention(path: string) {
    const i = $<HTMLTextAreaElement>('input');
    i.value = (i.value ? i.value.replace(/\s*$/, ' ') : '') + path + ' ';
    if (app.state.layout.narrow()) app.state.layout.close();
    i.focus();
  }

  function toggle(path: string) { expanded.has(path) ? expanded.delete(path) : expanded.add(path); renderTree(); }

  function entryActions(path: string, isDir: boolean, mountName?: string): SheetItem[] {
    const ro = app.state.vfs.where(path) === 'mount-ro';
    const isRoot = ROOTS.some(([r]) => r === path);
    if (isDir) return ([
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
      mountName && ['Unmount (the folder itself is untouched)', () => app.state.vfs.unmount(mountName), 'danger'],
    ] satisfies SheetItem[]).filter((a) => !a || !(ro && /^(New|Upload|Rename|Delete)/.test(a[0])));
    return [
      ['Open in editor', () => app.editing.openFile(path)],
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
  function row(depth: number, { path, name, isDir, tag, mountName, locked }: { path: string; name: string; isDir: boolean; tag?: string; mountName?: string; locked?: boolean }) {
    const r: TreeRow = Object.assign(el('div', { className: 'row' + (path === app.editing.openPath ? ' current' : ''), role: 'treeitem', tabIndex: -1,
      ariaLabel: name + (tag ? ', ' + tag : ''), ariaLevel: String(depth + 1), ariaSelected: String(path === app.editing.openPath) }), { meta: { path, depth, isDir, locked } });
    r.dataset.path = path;
    // A watched file that just woke the agent pulses once (G14, G17).
    play(r, 'pulse:' + path, [{ opacity: 0.45 }, { opacity: 1 }, { opacity: 0.6 }, { opacity: 1 }], 1100, { mark: 'pulsed' });
    if (isDir && !locked) r.ariaExpanded = String(expanded.has(path));
    r.style.setProperty('--depth', String(depth));
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
      if (mountName) r.onclick = () => app.state.vfs.reconnect(mountName, { ask: true }).catch((e: unknown) => fail(messageOf(e)));
      return r;
    }
    const more = el('button', { type: 'button', className: 'more', ariaLabel: 'Actions for ' + name, title: 'Actions', tabIndex: -1 }, icon('ellipsis'));
    more.onclick = (e) => { e.stopPropagation(); focusPath = path; app.state.sheet(path, entryActions(path, isDir, mountName)); };
    r.append(more);
    r.onclick = () => {
      focusPath = path;
      if (!isDir) return app.editing.openFile(path);
      toggle(path);
    };
    // Drop onto a folder puts files in it; onto a file, next to it.
    const target = isDir ? path : normalize(path + '/..');
    r.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); r.classList.add('drop'); };
    r.ondragleave = () => r.classList.remove('drop');
    r.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); r.classList.remove('drop'); if (e.dataTransfer) dropInto(target, e.dataTransfer); };
    return r;
  }

  const treeRows = () => [...$('tree').querySelectorAll<TreeRow>('.row[data-path]')];
  function focusRow(r: TreeRow | undefined) {
    if (!r) return;
    for (const x of treeRows()) x.tabIndex = -1;
    r.tabIndex = 0; focusPath = r.meta.path; r.focus();
  }
  function rowMenu(r: TreeRow) {
    // click() returns undefined, so `more?.click() ?? r.click()` would click both.
    if (!$<HTMLDialogElement>('sheet').open) (r.querySelector<HTMLElement>('.more') ?? r).click();
  }
  const rowOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<TreeRow>('.row[data-path]') : null);
  $('tree').onkeydown = (e) => {
    const r = rowOf(e.target);
    if (!r || e.target !== r) return;
    const list = treeRows(), i = list.indexOf(r), { path, depth, isDir, locked } = r.meta;
    const go = (n: number) => { e.preventDefault(); focusRow(list[Math.max(0, Math.min(n, list.length - 1))]); };
    if (e.key === 'ArrowDown') return go(i + 1);
    if (e.key === 'ArrowUp') return go(i - 1);
    if (e.key === 'Home') return go(0);
    if (e.key === 'End') return go(list.length - 1);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (!isDir || locked) return;
      if (!expanded.has(path)) return toggle(path);
      if ((list[i + 1]?.meta.depth ?? -1) > depth) focusRow(list[i + 1]);
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
    const r = rowOf(e.target);
    if (!r) return;
    e.preventDefault(); focusPath = r.meta.path; rowMenu(r);
  };

  async function children(path: string, depth: number, out: HTMLDivElement[]) {
    let list;
    try { list = await app.state.vfs.list(path); } catch (e) {
      out.push(el('div', { className: 'row muted', textContent: messageOf(e), style: `--depth:${depth}` })); return;
    }
    list.sort((a, b) => (Number(b.isDirectory) - Number(a.isDirectory)) || a.name.localeCompare(b.name));
    for (const d of list) {
      const p = normalize(path + '/' + d.name);
      out.push(row(depth, { path: p, name: d.name, isDir: d.isDirectory }));
      if (d.isDirectory && expanded.has(p)) await children(p, depth + 1, out);
    }
  }

  let treeGen = 0;
  async function renderTree() {
    const gen = ++treeGen;
    const out: HTMLDivElement[] = [];
    const roots = [...ROOTS];
    for (const [name, m] of app.state.vfs.mounts) roots.push(['/mnt/' + name, name, m.live ? (m.readOnly ? 'read-only' : 'device') : 'tap to reconnect', name, !m.live]);
    for (const [path, name, tag, mountName, locked] of roots) {
      out.push(row(0, { path, name, isDir: true, tag: path === '/work' && app.state.vfs.opfsMissing ? 'memory only' : tag, mountName, locked }));
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
  $('tree').ondrop = (e) => { e.preventDefault(); if (e.dataTransfer) dropInto(CWD, e.dataTransfer); };

  let changeTimer: ReturnType<typeof setTimeout> | 0 = 0;
  app.state.vfs.addEventListener('change', () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { renderTree(); app.editing.syncEditor(); app.transcript.pathGen++; app.transcript.linkVer++; app.transcript.scheduleRender(); }, 150);
  });
  $('refresh').onclick = () => app.state.vfs.changed();
  // Everything in /work in one file: the "export before I leave" button (O3, L3).
  $('download-all').onclick = () => downloadDir('/work', 'zip', `pouch-work-${new Date().toISOString().slice(0, 10)}.zip`).catch((e: unknown) => fail(messageOf(e)));
  const canMount = 'showDirectoryPicker' in window; // Chromium only
  function mountFolder() {
    if (!canMount) return fail($('mount').title);
    app.state.sheet('Mount a folder from this device', [
      ['Read and write', () => app.state.vfs.pick(false).then((p) => { expanded.add(p); app.state.vfs.changed(); })],
      ['Read only', () => app.state.vfs.pick(true).then((p) => { expanded.add(p); app.state.vfs.changed(); })],
    ]);
  }
  if (!canMount) $('mount').title = 'This browser cannot mount device folders (Chromium only). Use upload and download instead.';
  $('mount').onclick = mountFolder;

  // ── First visit (A5, T4, L3) and the after-erase notice (L1) ──────────
  $('welcome-where').onclick = storageInfo;
  $('welcome-upload').onclick = () => uploadTo('/work');
  if (canMount) $('welcome-mount').onclick = mountFolder; else $('welcome-mount').hidden = true;
  $('welcome-dismiss').onclick = () => { $('welcome').hidden = true; store.setSetting('welcomed', true); };
  $('erased-dismiss').onclick = () => { $('erased').hidden = true; };

  // ── Run script (D18, D19): the run tool without the model ────────────
  // Its writes are attributed to the current session's run (egress, watches). Works offline.
  async function runScript(path: string) {
    const tools: App['boot']['toolList'][number][] = app.boot.toolList;
    const tool = tools.find((t): t is RunTool => t.name === 'run');
    if (!tool) return fail('The run engine is not available.');
    if (app.queues.busy() || app.sessionList.activeRun) return fail('Wait for the current turn to finish, then run the script.');
    const sid = app.sessionList.sessions.current?.id;
    if (sid != null) app.sessionList.activeRun = String(sid);
    let text: string;
    app.state.status('Running ' + path);
    // A script saved in /work sees all of /work, as the agent's run of it most likely did.
    try { text = await tool.execute({ path, ...(path.startsWith(CWD + '/') ? { files: [CWD] } : {}) }); } catch (e) { text = messageOf(e).replace(/^<harness>|<\/harness>$/g, '').trim(); }
    finally { app.sessionList.activeRun = null; app.state.status(''); }
    app.state.sheet('Ran ' + path.split('/').pop(), [], el('pre', { className: 'run-out', textContent: text }));
  }

  return {
    ARCHIVE,
    ask,
    download,
    expanded,
    fail,
    get focusPath() { return focusPath; }, set focusPath(v) { focusPath = v; },
    listArchive,
    offerDefaults,
    renderNamespaces,
    renderTree,
    stackSeed,
    treeRows,
    unpackHere,
  };
}
