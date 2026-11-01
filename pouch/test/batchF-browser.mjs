// Batch F in a real page (fake Sealed model, test/graph-fixture.js): the
// control plane. The Interface's Stop writes a ctl file (the events file
// says so), the terminal stops a background subagent and steers main by
// writing files while the tray follows, the main agent reads /session and
// writes its subagent's ctl (in is refused), and New then Enter right away
// sends into the new session, not the previous one.
// Run: node test/batchF-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchF-'));
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
let passed = 0;
const t0 = Date.now();
const ok = (name) => { passed++; console.log('ok', name, `(${((Date.now() - t0) / 1000).toFixed(0)} s)`); };
const errors = [];
const T = { timeout: 15000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(name) {
  const context = await pw.chromium.launchPersistentContext(join(scratch, name), { headless: true, viewport: { width: 1280, height: 800 } });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
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
const trayRows = (page) => page.$$eval('#tray-list li', (l) => l.map((x) => x.dataset.key + ' ' + x.textContent.replace(/\s+/g, ' ').trim()));
const mainSaw = (page, re) => page.waitForFunction((src) => (window.fake.requests.main ?? []).some((b) => new RegExp(src).test(JSON.stringify(b.messages.slice(-3)))), re.source, T);

let s;
try {
  s = await open('f');
  const { page } = s;

  // 1. New then Enter at once: the message goes to the new session.
  await rule(page, { who: 'main', when: '/first session/.test(c.since)', reply: 'One.' });
  await rule(page, { who: 'title', reply: 'First', sticky: false });
  await send(page, 'This is the first session');
  await idle(page);
  const firstId = await page.evaluate(() => localStorage.length >= 0 && document.querySelector('#session-list li.session[aria-current="true"]')?.dataset.id);
  await rule(page, { who: 'main', when: '/second message/.test(c.since)', reply: 'Two.' });
  await page.evaluate(() => { document.getElementById('new').click(); const i = document.getElementById('input'); i.value = 'The second message'; document.getElementById('composer').requestSubmit(); });
  await page.waitForFunction(() => (window.fake.requests.main ?? []).some((b) => /second message/.test(JSON.stringify(b.messages))), null, T)
    .catch(async (e) => { console.log('status:', await page.textContent('#status'), '| input:', await page.inputValue('#input'), '| main requests:', await page.evaluate(() => window.fake.requests.main.length)); throw e; });
  const into = await page.evaluate(() => JSON.stringify(window.fake.requests.main.find((b) => /second message/.test(JSON.stringify(b.messages))).messages));
  assert.doesNotMatch(into, /first session/, 'the second message went into the previous session');
  await idle(page);
  await page.waitForFunction(() => /Two\./.test(document.getElementById('log').textContent), null, T);
  const secondId = await page.evaluate(() => document.querySelector('#session-list li.session[aria-current="true"]')?.dataset.id);
  assert.notEqual(secondId, firstId, 'a new session is current');
  const mains = await page.evaluate(() => window.fake.requests.main.map((b) => JSON.stringify(b.messages)));
  assert.ok(!mains.some((m) => /first session/.test(m) && /second message/.test(m)), 'the second message did not join the first session');
  ok('New, then Enter at once: the message starts the new session, not the previous one');

  // 2. The tray's Stop writes the subagent's ctl file (events say so), and the tray follows.
  await rule(page, { who: 'main', when: '/survey/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'scout', task: 'Survey the files.' }]] });
  await rule(page, { who: 'main', when: '/Started subagent "scout"/.test(c.since)', reply: 'Scout is on it.' });
  await rule(page, { who: 'scout', gate: 'never', reply: 'done' });
  await send(page, 'Start a survey in the background');
  await idle(page);
  await page.waitForFunction(() => [...document.querySelectorAll('#tray-list li')].some((l) => l.dataset.key?.startsWith('sa:')), null, T);
  let out = await term(page, 'cat /session/current/status; cat /session/current/agents/a2/status');
  assert.match(out, /idle agents=2 running=1/);
  assert.match(out, /running [\d.]+s subagent scout: Survey the files\./);
  await page.click('#tray-list li[data-key^="sa:"] button.tray-stop, #tray-list li[data-key^="sa:"] button[aria-label^="Stop"]');
  await page.waitForFunction(() => ![...document.querySelectorAll('#tray-list li')].some((l) => l.dataset.key?.startsWith('sa:')), null, T);
  out = await term(page, 'cat /session/events');
  assert.match(out, /a2 ctl stop by you(?! \(terminal\))/);
  assert.match(out, /a2 state stopped/);
  ok('tray Stop on a subagent is a write to /session/<sid>/agents/a2/ctl; the events file and the tray agree');

  // 3. The terminal stops a background subagent; the tray reflects it and says so.
  await rule(page, { who: 'main', when: '/second survey/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'reader', task: 'Read everything.' }]] });
  await rule(page, { who: 'main', when: '/Started subagent "reader"/.test(c.since)', reply: 'Reader is on it.' });
  await rule(page, { who: 'reader', gate: 'never2', reply: 'done' });
  await send(page, 'Start a second survey');
  await idle(page);
  await page.waitForFunction(() => [...document.querySelectorAll('#tray-list li')].some((l) => /reader/.test(l.textContent)), null, T);
  out = await term(page, 'echo stop > /session/current/agents/a3/ctl && cat /session/current/agents/a3/status');
  assert.match(out, /stopped [\d.]+s subagent reader/);
  await page.waitForFunction(() => ![...document.querySelectorAll('#tray-list li')].some((l) => /reader/.test(l.textContent)), null, T);
  await page.waitForFunction(() => /From the terminal: stop reader \(a3\)/.test(document.getElementById('send-live').textContent), null, T)
    .catch(async (e) => { console.log('live:', await page.textContent('#send-live'), '| status:', await page.textContent('#status')); throw e; });
  assert.match(await term(page, 'echo explode > /session/current/agents/a3/ctl'), /EINVAL: ctl accepts: stop, detach \(got "explode"\)/);
  ok('terminal: echo stop > /session/current/agents/a3/ctl stops a background subagent; tray row goes, the live region says who');

  // 4. A steer written to main's in file from the terminal reaches main.
  await rule(page, { who: 'main', when: '/long task/.test(c.since)', gate: 'step1', reply: [['bash', { command: 'echo step one' }]] });
  await rule(page, { who: 'main', when: '/use tabs/.test(c.since)', reply: 'Using tabs.' });
  await send(page, 'Do a long task');
  await page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Stop', null, T);
  out = await term(page, "printf 'steer\\nuse tabs' > /session/current/agents/a1/in; cat /session/current/agents/a1/status");
  assert.match(out, /working [\d.]+s main main/);
  await page.waitForFunction(() => [...document.querySelectorAll('#tray-list li')].some((l) => l.dataset.key?.startsWith('steer:') && /use tabs/.test(l.textContent)), null, T);
  await gate(page, 'step1');
  await idle(page);
  await page.waitForFunction(() => /Using tabs\./.test(document.getElementById('log').textContent), null, T);
  assert.match(await term(page, 'echo steer late > /session/current/agents/a1/in'), /main \(a1\) is idle/);
  ok('terminal: a steer written to /session/current/agents/a1/in shows in the tray and reaches main after its step');

  // 5. The main agent reads /session and writes its subagent's ctl; in is refused.
  await rule(page, { who: 'main', when: '/third survey/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'mapper', task: 'Map the folders.' }]] });
  await rule(page, { who: 'mapper', gate: 'never3', reply: 'done' });
  await rule(page, { who: 'main', when: '/Started subagent "mapper"/.test(c.since)', reply: [['bash', { command: 'cat /session/current/status; ls /session; echo stop > /session/current/agents/a4/ctl; cat /session/current/agents/a4/status' }], ['bash', { command: 'echo hi > /session/current/agents/a4/in' }]] });
  await rule(page, { who: 'main', when: '/stopped/.test(c.since)', reply: 'Stopped mapper.' });
  await send(page, 'Start a third survey and then stop it');
  await idle(page);
  const body = await page.evaluate(() => JSON.stringify(window.fake.requests.main.at(-1).messages.slice(-3)));
  assert.match(body, /working agents=4 running=1/);
  assert.match(body, /EPERM: agents message each other with the agents tool.*write '\/session\/current\/agents\/a4\/in'/);
  assert.match(body, /stopped [\d.]+s subagent mapper/);
  assert.doesNotMatch(body, /events\\n\d/, 'its own session only');
  ok('main agent: reads /session/current/status, writes its subagent\'s ctl (stopped), and gets EPERM writing in');

  await page.screenshot({ path: join(shots, 'batchF-tray-terminal.png') });
  assert.deepEqual(errors, []);
} finally {
  await s?.context.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${passed} passed`);
