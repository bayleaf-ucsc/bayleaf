// Files journeys: I1 I2 I4 I5 O3 O4 R1 A1 A5 T1 T3 T4 L1 L3, plus the undo note to the agent.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { launch, instrument, rows, rowMore, sheetClick, waitRow, sleep, URL, newSession, waitSignedIn, ensurePanel } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const DIR = '/tmp/pouch-qa/files-profile';
const FIX = '/tmp/pouch-qa/files-fixtures';
const OUT = '/tmp/pouch-qa/files-out';
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const ok = (c, m) => { results.push([!!c, m]); log(c ? 'PASS' : 'FAIL', m); };
const step = async (name, fn) => { try { await fn(); } catch (e) { ok(false, `${name} threw: ${e.message.split('\n')[0]}`); } };

async function idle(page, timeout = 240_000) {
  const t = Date.now();
  await sleep(800);
  while (Date.now() - t < timeout) {
    if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return sleep(600);
    await sleep(500);
  }
  throw new Error('never idle');
}
async function say(page, text) { await page.fill('#input', text); await page.click('#send'); await idle(page); }
const lastReply = (page) => page.$$eval('.msg.assistant .body', (b) => b.at(-1)?.textContent ?? '');
// Read a /work file straight from OPFS, bypassing the app.
const readWork = (page, rel) => page.evaluate(async (rel) => {
  try {
    let d = await navigator.storage.getDirectory();
    const p = rel.split('/');
    for (const n of p.slice(0, -1)) d = await d.getDirectoryHandle(n);
    return await (await (await d.getFileHandle(p.at(-1))).getFile()).text();
  } catch { return null; }
}, rel);
async function upload(page, dir, files) {
  await rowMore(page, dir);
  const chooser = page.waitForEvent('filechooser');
  await sheetClick(page, 'Upload files here');
  await (await chooser).setFiles(files);
  await sleep(500);
}
const sheetTitle = (page) => page.textContent('#sheet-title');
const sheetOpen = (page) => page.$('#sheet[open]');
async function menu(page, path, label) { await rowMore(page, path); await sheetClick(page, label); }
async function saveDownload(page, path, label, name) {
  const dl = page.waitForEvent('download');
  await menu(page, path, label);
  const d = await dl;
  const to = `${OUT}/${name ?? d.suggestedFilename()}`;
  await d.saveAs(to);
  return { file: to, suggested: d.suggestedFilename() };
}
const py = (code, ...args) => execFileSync('python3', ['-I', '-c', code, ...args]).toString();
const txt = (name, s) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(s) });

const ctx = await launch({ fresh: true, userDataDir: DIR });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(URL).origin });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
const errors = instrument(page);
await page.goto(URL);
await page.waitForSelector('#tree .row');

// ── A5 first visit ──
await step('first visit', async () => {
  await page.waitForSelector('#welcome:not([hidden])', { timeout: 5000 });
  ok(/coding agent/.test(await page.textContent('#welcome')) && /Download all, then Erase all/.test(await page.textContent('#welcome')), 'A5 first-visit card shows, with borrowed-computer tip');
  await page.click('#welcome-where');
  ok(/Where your files are kept/.test(await sheetTitle(page)) && /tmp: memory/.test(await page.textContent('#sheet-body')), 'card links to the storage explanation');
  await page.keyboard.press('Escape');
  const tagTitle = await page.getAttribute('#tree .row[data-path="/work"] .tag', 'title');
  ok(/this browser/i.test(tagTitle ?? ''), `T4 root tag explains storage on hover: "${tagTitle}"`);
  await page.click('#welcome-dismiss'); await sleep(300);
  await page.reload(); await page.waitForSelector('#tree .row'); await sleep(800);
  ok(await page.$eval('#welcome', (w) => w.hidden), 'card stays dismissed after reload');
});

// ── I1 overwrite prompt on upload ──
await step('upload conflicts', async () => {
  await upload(page, '/work', [txt('a.txt', 'v1\n')]);
  await upload(page, '/work', [txt('a.txt', 'v2\n')]);
  ok(/a\.txt already exists in \/work/.test(await sheetTitle(page)), 'second upload asks: ' + await sheetTitle(page));
  await sheetClick(page, 'Keep both'); await sleep(500);
  ok((await readWork(page, 'a.txt')) === 'v1\n' && (await readWork(page, 'a (2).txt')) === 'v2\n', 'Keep both: a.txt kept, a (2).txt added');
  await upload(page, '/work', [txt('a.txt', 'v3\n')]);
  await sheetClick(page, 'Replace'); await sleep(500);
  ok((await readWork(page, 'a.txt')) === 'v3\n', 'Replace overwrites');
  await upload(page, '/work', [txt('a.txt', 'v4\n')]);
  await sheetClick(page, 'Skip'); await sleep(500);
  ok((await readWork(page, 'a.txt')) === 'v3\n', 'Skip leaves it');
  await upload(page, '/work', [txt('a.txt', 'v5\n'), txt('a (2).txt', 'v5\n'), txt('b.txt', 'b\n')]);
  ok(/2 of these already exist/.test(await sheetTitle(page)), 'batch asks once: ' + await sheetTitle(page));
  await sheetClick(page, 'Skip all 2'); await sleep(500);
  ok((await readWork(page, 'a.txt')) === 'v3\n' && (await readWork(page, 'b.txt')) === 'b\n', 'Skip all: conflicts kept, new file added');
  ok(/Added 1 file in \/work \(2 skipped\)/.test(await page.textContent('#status')), 'status reports: ' + await page.textContent('#status'));
});

// ── R1 rename refusal ──
await step('rename', async () => {
  page.dialogQueue.push('a.txt');
  await menu(page, '/work/b.txt', 'Rename'); await sleep(500);
  ok(page.dialogLog.at(-1)?.includes('a.txt already exists') && (await readWork(page, 'b.txt')) === 'b\n' && (await readWork(page, 'a.txt')) === 'v3\n', 'rename onto existing is refused: ' + page.dialogLog.at(-1));
});

// ── I2 folder drop (fallback path) and folder upload ──
await step('drop', async () => {
  const drop = (rel, text) => page.evaluate(([rel, text]) => {
    const dt = new DataTransfer();
    const f = new File([text], rel.split('/').pop());
    Object.defineProperty(f, 'webkitRelativePath', { value: rel });
    dt.items.add(f);
    const same = dt.files[0] === f || dt.files[0].webkitRelativePath === rel;
    const r = document.querySelector('#tree .row[data-path="/work"]');
    r.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return same;
  }, [rel, text]);
  const same = await drop('assignment/src/lib/util.js', 'export const u = 1;\n');
  await sleep(800);
  log('synthetic DataTransfer keeps webkitRelativePath:', same);
  ok((await readWork(page, 'assignment/src/lib/util.js')) === 'export const u = 1;\n', 'drop fallback keeps folder structure (webkitRelativePath)');
  await drop('assignment/src/lib/util.js', 'changed\n'); await sleep(500);
  ok(await sheetOpen(page) && /util\.js already exists/.test(await sheetTitle(page)), 'drop conflict asks');
  await sheetClick(page, 'Replace'); await sleep(500);
  ok((await readWork(page, 'assignment/src/lib/util.js')) === 'changed\n', 'drop Replace');
  // A real folder picker (webkitdirectory) through Playwright's directory upload.
  await rowMore(page, '/work');
  const chooser = page.waitForEvent('filechooser');
  await sheetClick(page, 'Upload a folder here');
  await (await chooser).setFiles(`${FIX}/dirup/assignment`);
  await sleep(800);
  if (await sheetOpen(page)) { log('folder upload asked:', await sheetTitle(page)); await sheetClick(page, 'Keep both'); await sleep(600); }
  ok((await readWork(page, 'assignment/readme.md')) === 'a\n' && (await readWork(page, 'assignment/src/lib/util (2).js')) === 'export const u = 1;\n',
    'folder upload keeps structure; conflict kept both');
});

// ── I4 Unpack an Info-ZIP zip, list contents, unpack conflicts ──
await step('unpack zip', async () => {
  await upload(page, '/work', [`${FIX}/proj.zip`, `${FIX}/loose.zip`]);
  await menu(page, '/work/proj.zip', 'List contents'); await sleep(400);
  const listing = await page.textContent('#sheet-body');
  ok(/proj\/src\/main\.py/.test(listing) && /2 files in proj\.zip/.test(await sheetTitle(page)), 'List contents shows the Info-ZIP entries');
  await sheetClick(page, 'Unpack here'); await sleep(800);
  ok((await readWork(page, 'proj/src/main.py')) === 'print("hi")\n' && (await readWork(page, 'proj/README.md')) === '# Proj\n', 'Unpack here: single-folder zip becomes /work/proj');
  await menu(page, '/work/loose.zip', 'Unpack here'); await sleep(800);
  ok((await readWork(page, 'loose/l1.txt')) === 'one\n', 'loose zip unpacks into /work/loose');
  await menu(page, '/work/proj.zip', 'Unpack here'); await sleep(500);
  ok(/2 of these already exist/.test(await sheetTitle(page)), 'unpacking again asks');
  await sheetClick(page, 'Skip all'); await sleep(400);
  // Opening a zip offers unpacking too.
  await ensurePanel(page, 'files');
  await page.click('#tree .row[data-path="/work/proj.zip"]'); await sleep(400);
  ok(/looks binary/.test(await sheetTitle(page)) && await page.$('#sheet-actions button:text("Unpack here")'), 'opening a zip offers Unpack here');
  await page.keyboard.press('Escape');
});

// ── O3 zip export, O2 tar with a long path, Download all ──
await step('export', async () => {
  const { file } = await saveDownload(page, '/work/assignment', 'Download as .zip');
  const out = py('import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(sorted(z.namelist()))); print(z.read("assignment/src/lib/util.js").decode())', file);
  ok(/assignment\/src\/lib\/util\.js/.test(out) && /changed/.test(out), 'zip export verified by python zipfile');
  const uz = execFileSync('/usr/bin/unzip', ['-t', file]).toString();
  ok(/No errors detected/.test(uz), 'Info-ZIP unzip -t accepts the zip');
  // A 120-char name in a 3-deep folder: too long for plain ustar.
  const long = 'L'.repeat(120) + '.txt';
  page.dialogQueue.push('deep/x/y'); await menu(page, '/work', 'New folder here'); await sleep(400);
  await upload(page, '/work/deep/x/y', [txt(long, 'long name\n')]);
  const tar = await saveDownload(page, '/work/deep', 'Download as .tar');
  const names = py('import tarfile,sys; t=tarfile.open(sys.argv[1]); print("\\n".join(t.getnames())); print(t.extractfile([m for m in t.getmembers() if m.isfile()][0]).read().decode())', tar.file);
  ok(names.includes(`deep/x/y/${long}`) && names.includes('long name'), 'tar with a >100-char path reads in python tarfile');
  // Round trip: upload the tar elsewhere and unpack it in the page.
  page.dialogQueue.push('rt'); await menu(page, '/work', 'New folder here'); await sleep(300);
  await upload(page, '/work/rt', [tar.file]);
  await menu(page, '/work/rt/deep.tar', 'Unpack here'); await sleep(800);
  ok((await readWork(page, `rt/deep/x/y/${long}`)) === 'long name\n', 'tar long path round trip through Unpack here');
  const dl = page.waitForEvent('download');
  await ensurePanel(page, 'files');
  await page.click('#download-all');
  const d = await dl; const to = `${OUT}/${d.suggestedFilename()}`; await d.saveAs(to);
  const all = py('import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist())); print("\\n".join(z.namelist()))', to);
  ok(/^pouch-work-\d{4}-\d\d-\d\d\.zip$/.test(d.suggestedFilename()) && all.includes('work/a.txt') && all.includes('work/proj/src/main.py'), `Download all: ${d.suggestedFilename()} (${all.split('\n')[0]} entries)`);
});

// ── O4, I5 clipboard ──
await step('clipboard', async () => {
  await menu(page, '/work/a.txt', 'Copy text'); await sleep(300);
  ok((await page.evaluate(() => navigator.clipboard.readText())) === 'v3\n', 'Copy text puts the file on the clipboard');
  await page.evaluate(() => navigator.clipboard.writeText('pasted on a lab machine\n'));
  page.dialogQueue.push('clip.md');
  await menu(page, '/work', 'New file from clipboard'); await sleep(800);
  ok((await readWork(page, 'clip.md')) === 'pasted on a lab machine\n' && (await page.textContent('#editor-path')).includes('/work/clip.md'), 'New file from clipboard writes and opens it');
});

// ── A1, R1 keyboard tree ──
await step('keyboard', async () => {
  await page.click('#close-file').catch(() => {});
  await ensurePanel(page, 'files');
  await page.focus('#files .panel-close'); // the bar's last button; Tab goes on into the tree
  await page.keyboard.press('Tab');
  const at = () => page.evaluate(() => ({ path: document.activeElement?.dataset?.path, role: document.activeElement?.getAttribute('role'),
    exp: document.activeElement?.getAttribute('aria-expanded'), level: document.activeElement?.getAttribute('aria-level') }));
  let a = await at();
  ok(a.role === 'treeitem', `Tab enters the tree at ${a.path}`);
  ok((await page.$$eval('#tree [role=treeitem]', (r) => r.filter((x) => x.tabIndex === 0).length)) === 1, 'exactly one row is tabbable (roving tabindex)');
  await page.keyboard.press('Home');
  a = await at(); ok(a.path === '/work' && a.exp === 'true' && a.level === '1', 'Home: /work, expanded, level 1');
  await page.keyboard.press('ArrowDown');
  a = await at(); ok(a.path === '/work/assignment' && a.level === '2', 'Down: ' + a.path);
  await page.keyboard.press('ArrowRight'); await sleep(400);
  a = await at(); ok(a.path === '/work/assignment' && a.exp === 'true', 'Right expands, focus stays');
  await page.keyboard.press('ArrowRight');
  a = await at(); ok(a.path === '/work/assignment/src' && a.level === '3', 'Right again moves to first child');
  await page.keyboard.press('ArrowLeft');
  a = await at(); ok(a.path === '/work/assignment', 'Left goes to parent');
  await page.keyboard.press('ArrowLeft'); await sleep(400);
  a = await at(); ok(a.path === '/work/assignment' && a.exp === 'false', 'Left collapses');
  await page.keyboard.press('Enter'); await sleep(400);
  a = await at(); ok(a.exp === 'true', 'Enter toggles a folder');
  // Down to readme.md, Enter opens it.
  for (let i = 0; i < 6 && (await at()).path !== '/work/assignment/readme.md'; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); await sleep(600);
  ok((await page.textContent('#editor-path')).includes('/work/assignment/readme.md'), 'Enter opens the file in the editor');
  ok(await page.$eval('#tree .row[data-path="/work/assignment/readme.md"]', (r) => r.getAttribute('aria-selected') === 'true'), 'open file row is aria-selected');
  await ensurePanel(page, 'files'); // Enter opened the Editor panel
  await page.focus('#files .panel-close'); await page.keyboard.press('Tab'); // from the bar's last button into the tree
  a = await at(); ok(a.path === '/work/assignment/readme.md', 'Tab returns to the last focused row');
  await page.keyboard.press('Shift+F10'); await sleep(300);
  ok(await sheetOpen(page) && (await sheetTitle(page)) === '/work/assignment/readme.md', 'Shift+F10 opens the row sheet');
  await page.keyboard.press('Escape'); await sleep(200);
  a = await at(); ok(a.path === '/work/assignment/readme.md', 'Escape returns focus to the row');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  a = await at();
  await page.keyboard.press('ContextMenu'); await sleep(300);
  ok(await sheetOpen(page), `menu key opens the sheet (${a.path})`);
  if (await sheetOpen(page)) {
    const labels = await page.$$eval('#sheet-actions button', (b) => b.map((x) => x.textContent));
    ok(labels.includes('Collapse') || labels.includes('Expand'), 'folder sheet has Expand/Collapse: ' + labels.slice(0, 3).join(', '));
    await page.keyboard.press('Escape');
  }
  const ring = await page.$eval('#tree .row[tabindex="0"]', (r) => { r.focus(); return getComputedStyle(r).outlineStyle; });
  ok(ring !== 'none', 'focused row has a visible outline: ' + ring);
});

// ── T1, T3 trust dialog ──
await step('trust', async () => {
  await page.click('#badge'); await sleep(300);
  const t = await page.textContent('#trust');
  const build = await page.textContent('#build-id');
  const a = await page.$eval('#source-link', (x) => [x.href, x.rel, x.target]);
  ok(/^[0-9a-f]{7,}(\+dirty)? \d{4}-\d\d-\d\d$/.test(build), 'trust dialog shows build id: ' + build);
  ok(/talks only to api\.bayleaf\.dev/.test(t) && /shasum -a 256 pouch\.html/.test(t), 'peer statement and hash recipe');
  ok(a[0] === 'https://github.com/bayleaf-ucsc/bayleaf/tree/pouch/pouch' && /noopener/.test(a[1]) && /noreferrer/.test(a[1]) && a[2] === '_blank', 'source link: ' + a.join(' '));
  await page.click('#trust-close');
});

// ── Undo note reaches the model ──
let requests = 0;
await step('undo note', async () => {
  if (!KEY) return ok(false, 'no BAYLEAF_API_KEY');
  page.on('request', (r) => { if (r.url().includes('/sealed/v1/chat/completions')) requests++; });
  await page.waitForSelector('#badge.ok', { timeout: 60_000 });
  await page.click('#auth'); page.dialogQueue.push(KEY); await sheetClick(page, 'Paste a key');
  await waitSignedIn(page);
  await page.waitForSelector('#badge.ok', { timeout: 60_000 });
  await upload(page, '/work', [txt('note.txt', 'v1\n')]);
  await page.selectOption('#model', 'glm-5-3').catch(() => {});
  await newSession(page); await sleep(500);
  await say(page, 'Use the write tool once to set /work/note.txt to exactly "v2" (one line), then reply "done". Nothing else.');
  ok((await readWork(page, 'note.txt'))?.startsWith('v2'), 'agent wrote note.txt');
  await page.locator('.changes .change:has(.p[title="/work/note.txt"]) button', { hasText: 'Undo' }).last().click(); await sleep(800);
  ok((await readWork(page, 'note.txt')) === 'v1\n', 'user undid it');
  const q = 'Did anything change since your last turn? Answer in one sentence without using tools.';
  await say(page, q);
  const reply = await lastReply(page);
  log('reply:', reply.slice(0, 300));
  ok(/undo|undid|undone|restor|revert/i.test(reply) && /note\.txt/.test(reply), 'reply mentions the undo of note.txt');
  const users = await page.$$eval('.msg.user .body', (b) => b.map((x) => x.textContent));
  ok(users.at(-1) === q && !users.some((u) => /Note from Pouch/.test(u)), 'transcript shows only the typed text');
  await page.reload(); await page.waitForSelector('.msg.user'); await sleep(1500);
  const users2 = await page.$$eval('.msg.user .body', (b) => b.map((x) => x.textContent));
  ok(users2.at(-1) === q, 'after reload, the user message still shows only the typed text');
  ok(requests < 15, `model requests: ${requests}`);
});

// ── L1 Erase all notice ──
await step('erase', async () => {
  page.dialogQueue.push(true);
  await page.click('#erase');
  await page.waitForSelector('#erased:not([hidden])', { timeout: 20_000 });
  ok(/was erased/.test(await page.textContent('#erased')) && (await page.evaluate(() => location.hash)) === '', 'Erase all: notice shown, hash cleared');
  ok((await readWork(page, 'a.txt')) === null, 'files gone after erase');
  await page.reload(); await page.waitForSelector('#tree .row'); await sleep(500);
  ok(await page.$eval('#erased', (e) => e.hidden), 'notice does not return on a plain reload');
});

// ── Touch targets on a phone ──
await step('touch', async () => {
  const m = await launch({ mobile: true, fresh: true, userDataDir: DIR + '-m' });
  const p = m.pages()[0] ?? await m.newPage();
  await p.goto(URL); await p.waitForSelector('#tree .row', { state: 'attached' }); await sleep(800);
  await p.click('#rail button[data-panel="files"]');
  const sz = await p.$$eval('#tree .row', (rs) => rs.map((r) => [r.getBoundingClientRect().height, r.querySelector('.more')?.getBoundingClientRect().height ?? 99, r.querySelector('.more')?.getBoundingClientRect().width ?? 99]));
  ok(sz.every(([h, mh, mw]) => h >= 44 && mh >= 44 && mw >= 44), 'phone: rows and ... buttons >= 44px: ' + JSON.stringify(sz[0]));
  await p.click('#rail button[data-panel="chat"]');
  ok(await p.isVisible('#welcome'), 'phone: first-visit card visible in chat');
  const over = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  ok(!over, 'phone: no horizontal overflow');
  await m.close();
});

log('errors:', errors.filter((e) => !/favicon/.test(e)).slice(0, 10));
const failed = results.filter(([c]) => !c);
log(`\n${results.length - failed.length}/${results.length} PASS`);
await ctx.close();
process.exit(failed.length ? 1 : 0);
