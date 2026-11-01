// Batch E in the real page: titles and compaction on the session's provider
// (BayLeaf Sealed = the scripted fake, test/graph-fixture.js; Localhost = the
// loopback dummy, test/dummy-openai.mjs), cost labels per provider, /rename bare
// and with a title, and the terminal (commands, history, Tab, user attribution
// firing a watch, Ctrl+C through /task ctl for a long command and for an agent's
// run, the bayleaf approval sheet, phone layout). Transformers.js routing is
// covered in node (test/batchE-node.mjs): the test build has no local model.
// Nothing reaches api.bayleaf.dev: every non-loopback request is routed here.
// Run: node test/batchE-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { startDummy } from './dummy-openai.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchE-'));
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
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const KEY = 'dummy-key-0123456789';
const dummy = await startDummy({ key: KEY, cors: ['*'], loadMs: 0 });
let passed = 0;
const t0 = Date.now();
const ok = (name) => { passed++; console.log('ok', name, `(${((Date.now() - t0) / 1000).toFixed(0)} s)`); };
const errors = [];
const T = { timeout: 15000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bayleafHits = 0; // requests that would have reached api.bayleaf.dev, other than start-up checks (models, usage, attestation, campus pass)

async function open(name, viewport = { width: 1280, height: 800 }) {
  const context = await pw.chromium.launchPersistentContext(join(scratch, name), { headless: true, viewport });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    if (!/\/sealed\/attestation|\/campus-pass/.test(u.pathname)) { bayleafHits++; console.log('  bayleaf request:', r.request().method(), u.pathname); }
    return r.abort();
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('#badge.ok', T);
  await page.click('#welcome button >> text=Got it', { timeout: 2000 }).catch(() => {});
  return { context, page };
}
const rule = (page, r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r);
const sealedTitles = (page) => page.evaluate(() => (window.fake.requests.title ?? []).length);
const sealedAll = (page) => page.evaluate(() => window.fake.total());
const gens = () => dummy.log.filter((e) => e.model);
const idle = (page) => page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
const title = (page) => page.textContent('#title');
async function slash(page, cmd) { await page.fill('#input', cmd); await page.press('#input', 'Enter'); }
async function hintFor(page, name) {
  await page.fill('#input', '/' + name);
  await page.waitForSelector('#ac:not([hidden]), .ac-list, [role="listbox"]', T).catch(() => {});
  const t = await page.evaluate(() => document.querySelector('[role="listbox"]')?.textContent ?? '');
  await page.fill('#input', '');
  return t;
}
async function menuText(page) {
  await page.$eval('#session-list li.session[aria-current="true"] .s-more', (b) => b.click());
  await page.waitForSelector('#sheet[open]', T);
  const t = await page.textContent('#sheet[open]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#sheet[open]', { state: 'detached', timeout: 3000 }).catch(() => {});
  return t;
}
// The terminal.
async function term(page, cmd, { wait = true } = {}) {
  const n = await page.$$eval('#term-log .term-block', (l) => l.length);
  await page.fill('#term-input', cmd); await page.press('#term-input', 'Enter');
  if (!wait) return null;
  await page.waitForFunction((n) => { const b = document.querySelectorAll('#term-log .term-block'); return b.length > n && !b[b.length - 1].querySelector('.term-live'); }, n, T);
  return page.$eval('#term-log .term-block:last-child', (b) => b.textContent);
}

let s;
try {
  s = await open('journey');
  const { page } = s;

  // 1. A Sealed session: the automatic title is one Sealed request through the encrypting fetch.
  await rule(page, { who: 'main', when: '/walking tour/.test(c.since)', reply: 'Start at the wharf.' });
  await rule(page, { who: 'title', reply: 'Walking Tour Plan' });
  await send(page, 'Plan a walking tour of Santa Cruz');
  await idle(page);
  await page.waitForFunction(() => document.getElementById('title').textContent === 'Walking Tour Plan', null, T);
  assert.equal(await sealedTitles(page), 1);
  let m = await menuText(page);
  assert.match(m, /Suggest a title \(1 request from today's BayLeaf Sealed allowance\)/);
  assert.match(m, /Compact now \(summarize older turns; 1 request from today's BayLeaf Sealed allowance\)/);
  assert.match(await hintFor(page, 'compact'), /Summarize older turns \(1 request from today's BayLeaf Sealed allowance\)/);
  assert.match(await hintFor(page, 'renam'), /\/rename alone to let the model suggest one \(1 request from today's BayLeaf Sealed allowance\)/);
  await page.click('#title'); await page.waitForSelector('.title-edit .spark', T);
  assert.match(await page.getAttribute('.title-edit .spark', 'title'), /1 request from today's BayLeaf Sealed allowance/);
  await page.keyboard.press('Escape');
  ok('Sealed session: automatic title via the encrypting fetch (1 request); menu, slash hints and sparkle tooltip state the Sealed cost');

  // 2. /rename with a title, then bare (the model suggests one).
  await slash(page, '/rename Tour notes');
  await page.waitForFunction(() => document.getElementById('title').textContent === 'Tour notes', null, T);
  const t1 = await sealedTitles(page);
  assert.equal(t1, 1, '/rename Title asks no model');
  await rule(page, { who: 'title', reply: 'Santa Cruz Walk' });
  await slash(page, '/rename');
  await page.waitForFunction(() => document.getElementById('title').textContent === 'Santa Cruz Walk', null, T);
  assert.equal(await sealedTitles(page), 2);
  ok('/rename Title sets it with no request; /rename alone asks the session\'s model (one Sealed request)');

  // 3. A Localhost session: title, sparkle, menu and /compact on the dummy; zero BayLeaf requests.
  await page.click('[data-panel="settings"]'); await page.waitForSelector('#lh-settings', { state: 'visible', ...T });
  await page.fill('#lh-url', dummy.url); await page.fill('#lh-key', KEY); await page.selectOption('#lh-transport', 'completions');
  await page.click('#lh-test');
  await page.waitForFunction(() => /2 models/.test(document.getElementById('lh-steps').textContent), null, T);
  await page.click('#new-top');
  await page.waitForFunction(() => document.getElementById('title').textContent === 'New session', null, T);
  await page.selectOption('#model', 'localhost:dummy-small');
  const sealed0 = await sealedAll(page), hits0 = bayleafHits;
  dummy.log.length = 0;
  await send(page, 'Name the tide pools near Natural Bridges');
  await idle(page);
  await page.waitForFunction(() => /Summary: the user asked/.test(document.getElementById('title').textContent), null, T).catch(async (e) => { console.log('DEBUG', await title(page), (await page.textContent('#log')).slice(-400), '|', await page.textContent('#status'), JSON.stringify(gens().map((g) => [g.path, g.tools?.length]))); throw e; });
  const lhGen = gens();
  assert.equal(lhGen.length, 2, 'one turn plus one title on the dummy: ' + JSON.stringify(lhGen.map((g) => g.tools?.length)));
  m = await menuText(page);
  assert.match(m, /Suggest a title \(runs on your machine \(Localhost\), no allowance\)/);
  assert.match(await hintFor(page, 'compact'), /runs on your machine \(Localhost\), no allowance/);
  await page.click('#title'); await page.waitForSelector('.title-edit .spark', T);
  assert.match(await page.getAttribute('.title-edit .spark', 'title'), /runs on your machine \(Localhost\)/);
  await page.click('.title-edit .spark');
  await sleep(800); await page.keyboard.press('Escape');
  assert.equal(gens().length, 3, 'the sparkle asked the dummy');
  await slash(page, '/compact');
  await page.waitForFunction(() => /summarized|Nothing to compact/.test(document.getElementById('status').textContent), null, T);
  assert.match(await page.textContent('#status'), /summarized|Nothing to compact yet/);
  assert.equal(await sealedAll(page), sealed0, 'no BayLeaf Sealed request');
  assert.equal(bayleafHits, hits0, 'nothing else to api.bayleaf.dev');
  ok('Localhost session: automatic title, sparkle and /compact run on the dummy; labels say "runs on your machine (Localhost), no allowance"; zero BayLeaf requests');

  // 4. Provider unavailable: say so, ask no other provider.
  const sealed1 = await sealedAll(page);
  dummy.cfg.key = 'rotated'; // the server now refuses: the Localhost provider fails, Sealed must not be asked
  await slash(page, '/rename');
  await page.waitForFunction(() => /Could not suggest a title \(Localhost\)|not set up/.test(document.getElementById('status').textContent), null, T);
  assert.equal(await sealedAll(page), sealed1);
  dummy.cfg.key = KEY;
  ok('Localhost refusing: /rename says "Could not suggest a title (Localhost)" and BayLeaf Sealed is not asked');

  // 5. Terminal: Ctrl+` opens it; commands, cwd, history, Tab.
  await page.click('#input'); await page.keyboard.press('Control+Backquote');
  await page.waitForSelector('#terminal-pane', { state: 'visible', ...T });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'term-input');
  assert.equal(await page.getAttribute('#term-log', 'role'), 'log');
  let out = await term(page, 'mkdir -p /work/data && echo hello > /work/data/t.txt && cat /work/data/t.txt');
  assert.match(out, /hello/);
  out = await term(page, 'cd /work/data && pwd');
  assert.match(out, /\/work\/data/);
  assert.match(await page.textContent('#term-prompt'), /~\/data \$/);
  out = await term(page, 'false');
  assert.match(out, /exit 1/);
  await page.press('#term-input', 'ArrowUp'); assert.equal(await page.inputValue('#term-input'), 'false');
  await page.press('#term-input', 'ArrowUp'); assert.equal(await page.inputValue('#term-input'), 'cd /work/data && pwd');
  await page.press('#term-input', 'ArrowDown'); await page.press('#term-input', 'ArrowDown'); assert.equal(await page.inputValue('#term-input'), '');
  await page.fill('#term-input', 'cat t.t'); await page.press('#term-input', 'Tab');
  await page.waitForFunction(() => document.getElementById('term-input').value === 'cat t.txt ', null, { timeout: 3000 }).catch(() => {});
  assert.equal(await page.inputValue('#term-input'), 'cat t.txt ');
  await page.fill('#term-input', '');
  const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('pouch.terminal.history')));
  assert.ok(hist.includes('false') && hist.length <= 200);
  out = await term(page, 'seq 1 3000');
  assert.match(out, /output capped: 1000 more lines not shown/);
  out = await term(page, 'ls /task');
  ok('terminal: Ctrl+` opens and focuses it; commands over /work, cd persists in the prompt, exit codes shown, history (persisted, capped), Tab completion, long output capped');

  // 6. A watch fires on a terminal write, attributed to the user.
  await page.click('#new-top');
  await page.waitForFunction(() => document.getElementById('title').textContent === 'New session', null, T);
  await page.selectOption('#model', 'fake');
  await rule(page, { who: 'main', when: '/watch the inbox/.test(c.since)', reply: [['watch', { action: 'watch', paths: ['/work/inbox/*.txt'], note: 'summarize new notes' }]] });
  await rule(page, { who: 'main', when: '/Watching/.test(c.since)', reply: 'Watching.' });
  await rule(page, { who: 'main', when: '/inbox\\/n1\\.txt/.test(c.since)', reply: 'Saw your note.' });
  await send(page, 'Please watch the inbox');
  await idle(page);
  await term(page, 'mkdir -p /work/inbox && echo first > /work/inbox/n1.txt');
  await page.waitForFunction(() => document.getElementById('messages')?.textContent.includes('Saw your note.') || document.body.textContent.includes('Saw your note.'), null, { timeout: 20000 });
  const seen = await page.evaluate(() => window.fake.seen('main'));
  assert.match(seen, /n1\.txt[\s\S]{0,200}(by|from) (the )?user|user[\s\S]{0,200}n1\.txt/i, seen.slice(-600));
  ok('a terminal write fires the agent\'s watch, attributed to the user');

  // 7. Ctrl+C on a long command goes through /task/<id>/ctl.
  await term(page, 'sleep 30', { wait: false });
  await page.waitForSelector('#term-log .term-live', T);
  const tid = await page.$eval('#term-log .term-live', (e) => /\/task\/(\d+)/.exec(e.textContent)[1]);
  const k0 = Date.now();
  await page.press('#term-input', 'Control+c');
  await page.waitForFunction(() => !document.querySelector('#term-log .term-live'), null, { timeout: 3000 });
  assert.ok(Date.now() - k0 < 2000, 'ended promptly');
  assert.match(await page.$eval('#term-log .term-block:last-child', (b) => b.textContent), new RegExp(`killed through /task/${tid}/ctl[\\s\\S]*exit 130`));
  out = await term(page, `cat /task/${tid}/status`);
  assert.match(out, /^.*killed [\d.]+s terminal sleep 30/m);
  ok(`Ctrl+C writes kill to /task/${tid}/ctl; the command ends within 2 s and its status reads killed`);

  // 8. Kill an agent's run task from the terminal.
  await rule(page, { who: 'main', when: '/spin forever/.test(c.since)', reply: [['run', { code: 'while (true) {}' }]] });
  await rule(page, { who: 'main', when: '/Killed through/.test(c.since)', reply: 'The run was killed.' });
  await send(page, 'Please spin forever');
  await page.waitForFunction(() => document.body.textContent.includes('run while'), null, T).catch(() => {});
  let runId = null;
  for (let i = 0; i < 50 && !runId; i++) {
    const st = await term(page, 'for d in /task/*/; do echo "$d $(cat $d/status)"; done');
    runId = /\/task\/(\d+)\/? running [\d.]+s run/.exec(st)?.[1] ?? null;
    if (!runId) await sleep(200);
  }
  if (!runId) console.log('DEBUG', (await page.textContent('#log')).slice(-300), await page.evaluate(() => JSON.stringify(window.fake.unmatched.slice(-3))));
  assert.ok(runId, 'found the agent run in /task');
  await term(page, `echo kill > /task/${runId}/ctl`);
  await idle(page);
  await page.waitForFunction(() => document.body.textContent.includes('The run was killed.'), null, T);
  ok(`the agent's run task (/task/${runId}) is killed from the terminal with echo kill > ctl`);

  // 9. bayleaf asks on the approval sheet, every use, naming the terminal.
  const h0 = bayleafHits;
  await term(page, 'bayleaf web search tide pools', { wait: false });
  await page.waitForSelector('#egress[open]', T);
  assert.match(await page.textContent('#egress-h'), /from the terminal/);
  assert.match(await page.textContent('#egress-meta'), /you, in the terminal/);
  assert.equal(await page.isVisible('#egress-session'), false, 'no session grant for the terminal');
  await page.screenshot({ path: join(shots, 'batchE-terminal-egress.png') });
  await page.click('#egress-deny');
  await page.waitForFunction(() => !document.querySelector('#term-log .term-live'), null, T);
  assert.equal(bayleafHits, h0, 'denied: nothing sent');
  ok('bayleaf in the terminal opens the approval sheet ("from the terminal", no session grant); Deny sends nothing');
  await page.screenshot({ path: join(shots, 'batchE-terminal.png') });
  await s.context.close(); s = null;

  // 10. Phone width.
  s = await open('phone', { width: 390, height: 844 });
  await s.page.click('#rail [data-panel="terminal"]');
  await s.page.waitForSelector('#term-input', { state: 'visible', ...T });
  const box = await s.page.$eval('#term-input', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, bottom: r.bottom, vh: innerHeight, fs: getComputedStyle(e).fontSize }; });
  assert.ok(box.w >= 200 && box.h >= 40 && box.bottom <= box.vh, JSON.stringify(box));
  assert.equal(box.fs, '16px', 'no zoom-on-focus');
  await s.page.fill('#term-input', 'echo phone'); await s.page.press('#term-input', 'Enter');
  await s.page.waitForFunction(() => document.getElementById('term-log').textContent.includes('phone'), null, T);
  const sw = await s.page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(sw <= 390, 'no horizontal scroll: ' + sw);
  await s.page.screenshot({ path: join(shots, 'batchE-terminal-phone.png') });
  ok('phone (390 px): terminal from the bottom bar, input 16 px and at least 200 px wide, no horizontal scroll');

  assert.deepEqual(errors, []);
} finally {
  await s?.context.close().catch(() => {});
  server.close(); await dummy.close?.().catch?.(() => {});
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${passed} passed`);
process.exit(0);
