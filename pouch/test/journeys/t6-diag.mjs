// Review journey: R2 changed files, R3 diff, R4 conflicts, R5 undo, R6 phone + tappable paths.
import { launch, instrument, rowMore, sheetClick, sleep, URL, newSession, waitSignedIn, ensurePanel } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const DIR = '/tmp/pouch-qa/review-profile';
const log = (...a) => console.log(...a);
const results = [];
const ok = (c, m) => { results.push([!!c, m]); log(c ? 'PASS' : 'FAIL', m); };

async function idle(page, timeout = 240_000) {
  const t = Date.now();
  await sleep(800);
  while (Date.now() - t < timeout) {
    if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant .who:text("Pouch ...")'))) return sleep(600);
    await sleep(500);
  }
  throw new Error('never idle');
}
async function say(page, text) { await page.fill('#input', text); await page.click('#send'); await idle(page); }
// /work is the OPFS root: read it directly, bypassing the app.
const readWork = (page, name) => page.evaluate(async (n) => {
  try { const d = await navigator.storage.getDirectory(); return await (await (await d.getFileHandle(n)).getFile()).text(); } catch { return null; }
}, name);
async function upload(page, dir, name, text) {
  await rowMore(page, dir);
  const chooser = page.waitForEvent('filechooser');
  await sheetClick(page, 'Upload files here');
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await sleep(600);
  // Uploading over an existing file asks first (t7); these re-uploads mean Replace.
  if (await page.$('#sheet[open]')) { await sheetClick(page, 'Replace'); await sleep(500); }
}
const changeRows = (page) => page.$$eval('.changes .change', (rs) => rs.map((r) => [r.querySelector('.st').textContent, r.querySelector('.p').textContent]));
const rowBtn = (page, path, label) => page.locator(`.changes .change:has(.p[title="${path}"]) button`, { hasText: label }).last();

const APP = 'const x = 1;\nconst keep = 2;\n';
const OLD = 'old file, exact bytes\n\twith a tab\n';

const ctx = await launch({ fresh: true, userDataDir: DIR });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
const errors = instrument(page);
await page.goto(URL);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
await page.click('#auth'); page.dialogQueue.push(KEY); await sheetClick(page, 'Paste a key');
await waitSignedIn(page);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });

const chatW = await page.$eval('#chat', (c) => c.getBoundingClientRect().width);
ok(chatW > 300, `desktop 1280x800, no file open: #chat is ${Math.round(chatW)}px`);

await upload(page, '/work', 'app.js', APP);
await upload(page, '/work', 'old.txt', OLD);
ok((await readWork(page, 'app.js')) === APP && (await readWork(page, 'old.txt')) === OLD, 'seeded app.js and old.txt');

// One turn: create, edit, delete.
await newSession(page); await sleep(500);
await say(page, 'Do all three with tools, then stop: (1) write /work/new.txt with exactly the text "hello new" (2) edit /work/app.js, replacing "const x = 1;" with "const x = 42;" (3) run bash: rm /work/old.txt. Finally reply in one sentence that names /work/app.js:1 exactly like that.');
let rowsNow = await changeRows(page);
log('changes:', JSON.stringify(rowsNow));
ok(rowsNow.some(([s, p]) => s === 'created' && p === '/work/new.txt'), 'changes block: new.txt created');
ok(rowsNow.some(([s, p]) => s === 'modified' && p === '/work/app.js'), 'changes block: app.js modified');
ok(rowsNow.some(([s, p]) => s === 'deleted' && p === '/work/old.txt'), 'changes block: old.txt deleted');
ok(/Changed 3 files/.test(await page.textContent('.changes .head')), 'header says Changed 3 files');
ok(await page.$('#tree .row:has(.name[title="/work/app.js"]) .changed-dot'), 'tree dot on app.js');

// Readable tool calls.
const toolText = await page.$$eval('details.tool', (ds) => ds.map((d) => d.querySelector('summary').textContent + ' || ' + [...d.querySelectorAll('pre')].map((p) => p.className).join(',')));
log('tools:', JSON.stringify(toolText));
ok(toolText.some((t) => /^write: \/work\/new.txt \|\| content/.test(t)), 'write renders path + content');
ok(toolText.some((t) => /^edit: \/work\/app.js \|\| mini-diff/.test(t)), 'edit renders a mini diff');
ok(toolText.some((t) => /^bash: rm/.test(t) && /cmd/.test(t)), 'bash renders the command');
ok(!(await page.textContent('#log')).includes('\\n'), 'no escaped \\n in the transcript');
{ const L = await page.textContent('#log'); const i = L.indexOf('\\n'); console.log('CTX', i, JSON.stringify(L.slice(Math.max(0, i - 150), i + 60))); }

// Tappable path.
const pathBtn = page.locator('.msg.assistant .body button.path').first();
if (await pathBtn.count()) {
  log('path button:', await pathBtn.textContent());
  await pathBtn.click(); await sleep(400);
  ok((await page.textContent('#editor-path')).startsWith('/work/'), 'tappable path opens the file');
  ok(await page.evaluate(() => document.activeElement?.classList.contains('cm-content')), 'focus moves to the editor');
  ok(!(await page.$('#tree .row:has(.name[title="/work/app.js"]) .changed-dot')) || !(await page.textContent('#editor-path')).includes('app.js'), 'tree dot clears after open');
} else ok(false, 'tappable path: the reply had no matching path (' + (await page.textContent('.msg.assistant:last-child')).slice(0, 120) + ')');
ok((await page.getAttribute('.cm-content', 'aria-label'))?.startsWith('Contents of'), 'editor has an accessible name');

// Diff.
await rowBtn(page, '/work/app.js', 'Diff').click(); await sleep(500);
ok(await page.isVisible('#review-bar') && /Changes to \/work\/app.js/.test(await page.textContent('#review-text')), 'diff bar names the file');
ok(/const x = 1;/.test(await page.textContent('#editor')) && /const x = 42;/.test(await page.textContent('#editor')), 'diff shows old and new lines');
await page.click('#review-done'); await sleep(300);
ok(!(await page.isVisible('#review-bar')), 'Done leaves the diff');
await rowBtn(page, '/work/old.txt', 'Diff').click(); await sleep(400);
ok(await page.isVisible('#review-restore'), 'deleted file diff offers Restore');
await page.click('#review-done'); await sleep(300);

// Reload keeps the block.
await page.reload();
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
await page.waitForSelector('.changes .change', { timeout: 15_000 }).catch(() => {});
ok(JSON.stringify(await changeRows(page)) === JSON.stringify(rowsNow), 'reload keeps the changes block');

// Undo one, then all.
await rowBtn(page, '/work/app.js', 'Undo').click(); await sleep(800);
ok((await readWork(page, 'app.js')) === APP, 'undo one file restores exact bytes');
await page.locator('.changes .head button', { hasText: 'Undo all' }).last().click(); await sleep(1000);
ok((await readWork(page, 'old.txt')) === OLD && (await readWork(page, 'new.txt')) === null, 'undo all: old.txt back byte-exact, new.txt gone');
ok((await changeRows(page)).every(([s]) => s === 'undone'), 'rows show undone');
log('dialogs so far:', page.dialogLog);

// Conflict: dirty buffer, then the agent edits the same file.
await ensurePanel(page, 'files');
await page.click('#tree .row:has(.name[title="/work/app.js"])'); await sleep(300);
await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('// mine\n');
await say(page, 'Use the edit tool on /work/app.js: replace "const keep = 2;" with "const keep = 3;". Reply "done".');
await sleep(500);
ok(await page.isVisible('#conflict-bar'), 'conflict bar appears for a dirty buffer');
const theirs = await readWork(page, 'app.js');
ok(theirs?.includes('const keep = 3;'), 'agent edit is on disk');
page.dialogQueue.push(false);
const nd = page.dialogLog.length;
await page.click('#save'); await sleep(400);
ok(page.dialogLog.length > nd && /Overwrite/.test(page.dialogLog.at(-1)), 'Save asks before overwriting');
ok((await readWork(page, 'app.js')) === theirs, 'declined Save leaves their version');
await page.click('#conflict-diff'); await sleep(300);
ok(await page.isVisible('#review-bar') && (await page.$$('.cm-chunkButtons button')).length > 0, 'Show diff gives a merge view with chunk buttons');
await page.click('#review-done'); await sleep(200);
// Done acknowledged theirs: Keep-merged buffer remains dirty. Reset with Take theirs on a fresh conflict.
await upload(page, '/work', 'app.js', theirs + '// upload\n'); await sleep(400);
await ensurePanel(page, 'editor'); // uploading went through Files; the open buffer waits in Editor
ok(await page.isVisible('#conflict-bar'), 'second outside change raises the conflict again');
await page.click('#conflict-theirs'); await sleep(300);
ok(!(await page.isVisible('#conflict-bar')) && (await page.isDisabled('#save')), 'Take theirs: clean buffer, no conflict');
ok((await page.textContent('.cm-content')).includes('// upload'), 'Take theirs loads the disk version');
await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('// mine2\n');
await upload(page, '/work', 'app.js', 'replaced\n'); await sleep(400);
await ensurePanel(page, 'editor');
ok(await page.isVisible('#conflict-bar'), 'conflict again');
await page.click('#conflict-mine'); await sleep(200);
const nd2 = page.dialogLog.length;
await page.click('#save'); await sleep(500);
const saved = await readWork(page, 'app.js');
ok(page.dialogLog.length === nd2 && saved.includes('// mine2') && !saved.includes('replaced'), 'Keep mine: Save writes mine without asking');
log('errors:', errors.filter((e) => !/401|Failed to load resource/.test(e)));
await ctx.close();

// Phone, same profile: the changes persist.
const m = await launch({ mobile: true, userDataDir: DIR });
const mp = m.pages()[0] ?? await m.newPage();
const me = instrument(mp, 'm ');
await mp.goto(URL);
await mp.waitForSelector('#badge.ok', { timeout: 60_000 });
await mp.waitForSelector('.changes .change', { timeout: 15_000 }).catch(() => {});
for (const tab of ['files', 'editor', 'usage', 'chat']) {
  await mp.click(`#rail button[data-panel=${tab}]`); await sleep(300);
  const over = await mp.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
  ok(over <= 0, `mobile ${tab}: no horizontal overflow (${over})`);
}
await mp.screenshot({ path: '/tmp/pouch-qa/shots/t6-mobile-chat.png' });
// The last turn changed app.js (not undone): Open it from the chat.
const open = mp.locator('.changes .change:has(.p[title="/work/app.js"]) button', { hasText: 'Open' }).last();
await open.click(); await sleep(500);
ok((await mp.getAttribute('#app', 'data-panel')) === 'editor' && (await mp.textContent('#editor-path')).includes('/work/app.js'), 'phone: Open switches to the editor tab');
const over = await mp.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
ok(over <= 0, `mobile editor with file: no horizontal overflow (${over})`);
await mp.screenshot({ path: '/tmp/pouch-qa/shots/t6-mobile-editor.png' });
log('mobile errors:', me.filter((e) => !/401|Failed to load resource/.test(e)));
await m.close();
log(`\n${results.filter(([c]) => c).length}/${results.length} PASS`);
