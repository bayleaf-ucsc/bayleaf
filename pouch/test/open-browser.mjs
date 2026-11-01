// `open` and `cat` in the terminal, in a real page (fake Sealed model,
// test/graph-fixture.js): Markdown opens Preview, HTML Preview and Static
// (its script does not run) unless --interactive, --raw shows text, code opens
// Raw, an image previews, a folder opens Files expanded, misuse stays in the
// terminal, unsaved edits are asked about, the remembered per-kind mode is
// untouched, `cat` of a binary shows a note, and an agent's `open` is refused.
// Nothing leaves the page. Run: node test/open-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 4 minutes'); process.exit(2); }, 240_000).unref();
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-open-'));
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });
const stub = `
import { createFake } from './test/graph-fixture.js';
window.fake = createFake();
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => { throw new Error('the old plaintext title path was used'); } } };
    this.secureClient = { fetch: (u, i) => window.fake.fetch(u, i) };
  }
  async ready() {} async getVerificationDocument() { return { securityVerified: true }; }
}`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.js')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') },
  plugins: [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js', resolveDir: root })); } }] });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
// The deploy's headers (headers.mjs): the page's CSP as a header too, the viewer its own.
const HEADERS = headersFile(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], viewerCsp(root));
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const viewer = path === '/viewer.html';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, viewer ? path : '/pouch.html') });
  res.end(viewer ? readFileSync(join(root, 'viewer.html')) : html);
});
await new Promise((r) => server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
let passed = 0;
const t0 = Date.now();
const ok = (name) => { passed++; console.log('ok', name, `(${((Date.now() - t0) / 1000).toFixed(0)} s)`); };
const errors = [], outbound = [];
const T = { timeout: 15000 };

async function open(name) {
  const context = await pw.chromium.launchPersistentContext(join(scratch, name), { headless: true, viewport: { width: 1280, height: 800 } });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    if (u.hostname !== 'api.bayleaf.dev') outbound.push(r.request().url());
    return r.abort();
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.DEBUG) page.on('console', (m) => console.log('console:', m.text().slice(0, 300)));
  await page.goto(url);
  await page.waitForSelector('#badge.ok', T);
  await page.click('#welcome button >> text=Got it', { timeout: 2000 }).catch(() => {});
  return { context, page };
}
const rule = (page, r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r);
const gate = (page, g) => page.evaluate((g) => { window.fake.gates[g] = true; }, g);
const idle = (page) => page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
async function term(page, cmd) {
  if (!(await page.isVisible('#term-input'))) { await page.keyboard.press('Control+`'); await page.waitForSelector('#term-input', { state: 'visible', ...T }); }
  const n = await page.$$eval('#term-log .term-block', (l) => l.length);
  await page.fill('#term-input', cmd); await page.press('#term-input', 'Enter');
  await page.waitForFunction((n) => { const b = document.querySelectorAll('#term-log .term-block'); return b.length > n && !b[b.length - 1].querySelector('.term-live'); }, n, T);
  return page.$eval('#term-log .term-block:last-child', (b) => b.textContent);
}
// Files dropped onto the tree, as a person would (bytes made in the page).
const drop = (page, files) => page.evaluate((files) => {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
  document.getElementById('tree').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, files);
const b64 = (s) => Buffer.from(s).toString('base64');
const viewerFrame = (page) => page.frames().find((f) => f.url().endsWith('/viewer.html'));
const reportFrame = (page) => page.frames().find((f) => f.parentFrame() === viewerFrame(page) && f.url() === 'about:srcdoc');
const pressed = (page, sel) => page.$eval(`${sel} [aria-pressed="true"]`, (b) => b.textContent);


const REPORT = '<!doctype html><h1>Sales</h1><p id="js">scripts did not run</p><script>document.getElementById("js").textContent = "scripts ran";</script>';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const editorPath = (page, p) => page.waitForFunction((p) => document.getElementById('editor-path').textContent === p, p, T);
const panel = (page) => page.evaluate(() => document.getElementById('app').dataset.panel);
const remembered = (page) => page.evaluate(() => localStorage.getItem('pouch.view'));

let s;
try {
  s = await open('open');
  const { page } = s;

  // Files: a report with a script and an image dropped on the tree; the rest from the terminal.
  if (!(await page.isVisible('#tree'))) await page.click('#rail [data-panel="files"]');
  await drop(page, [{ name: 'report.html', type: 'text/html', b64: b64(REPORT) }, { name: 'pic.png', type: 'image/png', b64: PNG }]);
  await page.waitForSelector('#tree .row[data-path="/work/pic.png"]', T);
  let out = await term(page, "mkdir -p /work/site/deep && printf '# Notes\\n\\nHello.\\n' > /work/site/notes.md && printf 'export const x = 1;\\n' > /work/app.js && printf 'a\\0b' > /work/blob.bin && echo made");
  assert.match(out, /made/);
  const view0 = await remembered(page);

  // 1. Markdown opens in Preview (the editor's click default is Raw); the terminal's line says so.
  out = await term(page, 'cd site && open notes.md');
  assert.match(out, /opened \/work\/site\/notes\.md \(Preview\)/);
  await editorPath(page, '/work/site/notes.md');
  assert.equal(await panel(page), 'editor', 'the editor replaces the terminal (one panel at a time)');
  assert.equal(await pressed(page, '#view-mode'), 'Preview');
  await page.waitForSelector('#preview .md-preview h1', T);
  assert.equal(await page.textContent('#preview .md-preview h1'), 'Notes');
  ok('open notes.md (relative to the cwd): the editor in Preview, rendered by Pouch; the terminal says what it opened');

  // 2. HTML opens Preview, Static (no script); --interactive runs it; plain open goes back to Static.
  out = await term(page, 'open /work/report.html');
  assert.match(out, /\(Preview, Static\)/);
  await editorPath(page, '/work/report.html');
  assert.equal(await pressed(page, '#view-mode'), 'Preview');
  assert.equal(await pressed(page, '#script-mode'), 'Static');
  await page.waitForFunction(() => document.querySelector('#preview iframe.viewer'), null, T);
  await page.waitForTimeout(600);
  assert.equal(await reportFrame(page).textContent('#js'), 'scripts did not run');
  out = await term(page, 'open --interactive /work/report.html');
  assert.match(out, /\(Preview, Interactive\)/);
  await page.waitForFunction(() => /WebRTC/.test(document.getElementById('preview-note').textContent), null, T);
  await page.waitForTimeout(600);
  assert.equal(await pressed(page, '#script-mode'), 'Interactive');
  assert.equal(await reportFrame(page).textContent('#js'), 'scripts ran');
  await term(page, 'open /work/report.html');
  await page.waitForFunction(() => document.querySelector('#script-mode [aria-pressed="true"]')?.textContent === 'Static', null, T);
  await page.waitForTimeout(600);
  assert.equal(await reportFrame(page).textContent('#js'), 'scripts did not run');
  await page.screenshot({ path: join(shots, 'open-report-static.png') });
  ok('open report.html: Preview, Static (script did not run); --interactive runs it; a plain open of the same file returns to Static');

  // 3. --raw, code, and the remembered per-kind mode left alone.
  out = await term(page, 'open --raw /work/report.html');
  assert.match(out, /\(Raw\)/);
  await page.waitForFunction(() => !document.getElementById('editor').hidden && /Sales/.test(document.querySelector('#editor .cm-content').textContent), null, T);
  assert.equal(await pressed(page, '#view-mode'), 'Raw');
  await term(page, 'open /work/app.js');
  await editorPath(page, '/work/app.js');
  assert.equal(await page.isHidden('#view-mode'), true, 'code has no Raw | Preview');
  assert.match(await page.textContent('#editor .cm-content'), /export const x = 1;/);
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.cm-editor')), true, 'Raw focuses the editor');
  assert.equal(await remembered(page), view0, 'open does not change the remembered mode (pouch.view)');
  ok('open --raw shows the text; code opens Raw and focused; pouch.view is untouched');

  // 4. An image opens as a preview with no Save.
  out = await term(page, 'open /work/pic.png');
  assert.match(out, /\(Preview\)/);
  await page.waitForSelector('#preview img.preview-image', T);
  assert.match(await page.getAttribute('#preview img.preview-image', 'src'), /^blob:/);
  assert.equal(await page.isHidden('#save'), true);
  ok('open pic.png: an image preview from a blob, no Save');

  // 5. A folder opens Files at that folder, expanded and in view.
  out = await term(page, 'open /work/site');
  assert.match(out, /showing \/work\/site in Files/);
  assert.equal(await panel(page), 'files');
  await page.waitForSelector('#tree .row[data-path="/work/site/deep"]', T);
  assert.equal(await page.isVisible('#tree .row[data-path="/work/site/notes.md"]'), true, 'the folder is expanded');
  ok('open /work/site: the Files panel, with the folder expanded and its children visible');

  // 6. Misuse stays in the terminal and leaves the editor alone.
  const before = await page.textContent('#editor-path');
  for (const [cmd, re, code] of [
    ['open /work/nope.md', /no such file/, 1],
    ['open --static /work/site/notes.md', /--static is for HTML reports/, 1],
    ['open --raw /work/pic.png', /no Raw view/, 1],
    ['open /work/blob.bin', /looks binary and has no preview/, 1],
    ['open --raw /work/site', /--raw is for files/, 2],
    ['open a b', /one path, got 2/, 2],
  ]) {
    out = await term(page, cmd);
    assert.match(out, re, cmd); assert.match(out, new RegExp(`exit ${code}`), cmd);
  }
  assert.equal(await page.textContent('#editor-path'), before);
  assert.equal(await panel(page), 'terminal');
  ok('misuse (missing, wrong flag, binary, flag on a folder, two paths): an error and exit 1 or 2 in the terminal; nothing else opens');

  // 7. Unsaved edits: open asks; keeping them is exit 1 and nothing opens.
  await term(page, 'open /work/app.js');
  await editorPath(page, '/work/app.js');
  await page.click('#editor .cm-content'); await page.keyboard.press('End'); await page.keyboard.type(' // edited');
  await page.waitForFunction(() => document.getElementById('editor-path').classList.contains('dirty'), null, T);
  await page.keyboard.press('Control+Backquote');
  await page.waitForSelector('#term-input', { state: 'visible', ...T });
  const n = await page.$$eval('#term-log .term-block', (l) => l.length);
  await page.fill('#term-input', 'open /work/site/notes.md'); await page.press('#term-input', 'Enter');
  await page.waitForSelector('#sheet[open]', T);
  assert.match(await page.textContent('#sheet[open]'), /Discard unsaved changes to \/work\/app\.js\?/);
  await page.keyboard.press('Escape');
  await page.waitForFunction((n) => { const b = document.querySelectorAll('#term-log .term-block'); return b.length > n && !b[b.length - 1].querySelector('.term-live'); }, n, T);
  out = await page.$eval('#term-log .term-block:last-child', (b) => b.textContent);
  assert.match(out, /kept your unsaved changes; \/work\/site\/notes\.md was not opened/); assert.match(out, /exit 1/);
  assert.equal(await page.textContent('#editor-path'), '/work/app.js');
  ok('with unsaved edits, open asks first; Escape keeps them, and the terminal says so (exit 1)');

  // 8. cat of a binary file: a note on screen instead of control bytes.
  out = await term(page, 'cat /work/pic.png');
  assert.match(out, /\[binary output: \d+ bytes not shown/);
  assert.doesNotMatch(out, /IHDR/);
  out = await term(page, 'cat /work/pic.png >&2');
  assert.match(out, /\[binary output: \d+ bytes not shown/);
  assert.doesNotMatch(out, /IHDR/);
  out = await term(page, 'cat /work/pic.png | od -c | head -1');
  assert.match(out, /211\s+P\s+N\s+G/);
  ok('cat on a binary file shows a note, not bytes (stdout or stderr); piping keeps the bytes');

  // 9. The agent's open is refused and opens nothing; the agent is pointed to show.
  await rule(page, { who: 'main', when: '/show me the report/.test(c.since)', reply: [['bash', { command: 'open --interactive /work/report.html' }]] });
  await rule(page, { who: 'main', when: '/open is the person/.test(c.since)', reply: 'Here it is: [the report](/work/report.html).' });
  await rule(page, { who: 'title', reply: 'Report', sticky: false });
  await send(page, 'show me the report');
  // The refusal reaches main's next request (idle alone can resolve before the turn starts).
  await page.waitForFunction(() => /open is the person's; use `show <path>`/.test(window.fake.seen('main')), null, T)
    .catch(async (e) => { console.log('DEBUG requests:', await page.evaluate(() => JSON.stringify(Object.keys(window.fake.requests))), '| status:', await page.textContent('#status')); throw e; });
  await idle(page);
  assert.equal(await page.textContent('#editor-path'), '/work/app.js', 'the agent opened nothing');
  ok('an agent\'s `open` (bash tool) is refused with a pointer to show; the editor is untouched');

  // Show (LANGUAGE.md): an agent's bash `show`, opened when the person is idle, offered when busy.
  const shown = (page) => page.$$eval('#log .shown', (l) => l.map((n) => n.dataset.shown));
  async function agentShows(page, cmd, ask, extra = {}) {
    const n = (await shown(page)).length;
    await rule(page, { who: 'main', when: `/${ask}/.test(c.since)`, reply: [['bash', { command: cmd }]], ...extra });
    await rule(page, { who: 'main', when: '/shown: /.test(c.since)', reply: 'There.' });
    await send(page, ask);
    return n;
  }
  const seenShown = (page, re) => page.waitForFunction((re) => new RegExp(re).test(window.fake.seen('main')), re, T);

  // 10. Unsaved edits (app.js from step 7): offered, not opened; the agent's line says why.
  let n0 = await agentShows(page, 'show /work/site/notes.md', 'show the notes while dirty');
  await seenShown(page, 'shown: offered /work/site/notes\\.md \\(Preview\\); not opened \\(user busy: unsaved edits\\)');
  await idle(page);
  await page.waitForFunction((n) => document.querySelectorAll('#log .shown').length > n, n0, T);
  assert.deepEqual((await shown(page)).slice(n0), ['offered']);
  assert.equal(await page.textContent('#editor-path'), '/work/app.js', 'nothing opened over the unsaved edits');
  assert.equal(await page.isVisible('#sheet[open]'), false, 'no Discard question either');
  assert.match(await page.textContent('#log .shown:last-of-type'), /Pouch wants to show you \/work\/site\/notes\.md \(Preview\); not opened while you were busy \(unsaved edits\)/);
  ok('agent show with unsaved edits: offered in the transcript (a "shown" card), nothing opens, no Discard question; the agent reads "offered ... unsaved edits"');

  // 11. The card's Open button opens it in its mode (after saving the edits).
  await page.click('#rail [data-panel="editor"]').catch(() => {});
  await page.click('#save');
  await page.waitForFunction(() => !document.getElementById('editor-path').classList.contains('dirty'), null, T);
  await page.click('#log .shown[data-shown="offered"] button');
  await editorPath(page, '/work/site/notes.md');
  assert.equal(await pressed(page, '#view-mode'), 'Preview');
  ok('the shown card\'s Open button opens the file in the mode show chose (Preview)');

  // 12. Idle: show opens at once (sending does not count as being busy); HTML is Static.
  await page.waitForTimeout(4200);
  n0 = await agentShows(page, 'show /work/report.html', 'show the report now');
  await seenShown(page, 'shown: opened /work/report\\.html \\(Preview, Static\\)');
  await idle(page);
  await editorPath(page, '/work/report.html');
  assert.equal(await pressed(page, '#script-mode'), 'Static');
  await page.waitForFunction((n) => document.querySelectorAll('#log .shown').length > n, n0, T);
  assert.deepEqual((await shown(page)).slice(n0), ['opened']);
  ok('agent show when the person is idle: opens at once in Preview, Static; the transcript records "Shown"');

  // 13. The person typed a moment ago: offered.
  await agentShows(page, 'show /work/app.js', 'show the code', { gate: 'typed' });
  await page.waitForFunction(() => window.fake.requests.main?.length && document.getElementById('send-label')?.textContent !== 'Send', null, T);
  await page.click('#input'); await page.keyboard.type('hm');
  await gate(page, 'typed');
  await seenShown(page, 'shown: offered /work/app\\.js \\(Raw\\); not opened \\(user busy: typing or pointing just now\\)');
  await idle(page);
  assert.equal(await page.textContent('#editor-path'), '/work/report.html', 'still the report');
  await page.fill('#input', '');
  ok('agent show while the person was just typing: offered, not opened');

  // 14. A folder, idle: Files at that folder.
  await page.waitForTimeout(4200);
  await agentShows(page, 'show /work/site', 'show the folder');
  await seenShown(page, 'shown: opened /work/site \\(Files\\)');
  await idle(page);
  assert.equal(await panel(page), 'files');
  assert.equal(await page.isVisible('#tree .row[data-path="/work/site/notes.md"]'), true);
  ok('agent show of a folder when idle: the Files panel with it expanded');

  // 15. --interactive is refused before the page; the editor stays.
  await page.waitForTimeout(4200);
  await agentShows(page, 'show --interactive /work/report.html', 'show it running');
  await page.waitForFunction(() => /--interactive is the person's choice/.test(window.fake.seen('main')), null, T);
  await idle(page);
  assert.equal(await page.textContent('#editor-path'), '/work/report.html');
  assert.equal(await pressed(page, '#script-mode'), 'Static');
  ok('agent show --interactive: refused (exit 1), nothing runs');

  // 16. From a subagent: always offered, in its own thread; Open there reveals the folder.
  await page.waitForTimeout(4200);
  await rule(page, { who: 'main', when: '/ask a subagent to show/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'scout', task: 'Show /work/site.' }]] });
  await rule(page, { who: 'scout', reply: [['bash', { command: 'show /work/site' }]] });
  await rule(page, { who: 'scout', when: '/shown: /.test(c.since)', reply: 'Showed it.' });
  await send(page, 'ask a subagent to show the folder');
  await page.waitForFunction(() => /shown: offered \/work\/site \(Files\); not opened \(user busy: a subagent asked\)/.test(window.fake.seen('scout')), null, T);
  await page.click('#rail [data-panel="editor"]');
  await page.click('.subagent .sa-acts button[aria-label="Open subagent scout"]');
  await page.waitForSelector('#log.child-view .shown[data-shown="offered"]', T);
  await page.click('#log.child-view .shown button');
  await page.waitForFunction(() => document.getElementById('app').dataset.panel === 'files', null, T);
  ok('agent show from a subagent: offered, never opened; its thread has the card, and Open reveals the folder');

  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(outbound, [], 'nothing outbound');
  console.log(`open-browser: ${passed} passed`);
} catch (e) {
  await s?.page.screenshot({ path: join(shots, 'open-fail.png') }).catch(() => {});
  console.log('editor-path:', await s?.page.textContent('#editor-path').catch(() => '?'), '| panel:', await s?.page.evaluate(() => document.getElementById('app').dataset.panel).catch(() => '?'), '| errors:', errors);
  throw e;
} finally {
  await s?.context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
