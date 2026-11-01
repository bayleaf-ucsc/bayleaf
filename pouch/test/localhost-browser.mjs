// The Localhost journey (JOURNEYS "Localhost provider", LH1-LH9) in the real page,
// against the loopback dummy (test/dummy-openai.mjs) for both transports. Sealed is
// the scripted fake from test/graph-fixture.js, so no BayLeaf request is ever made;
// the test counts them to show Localhost turns make none.
// Wi-Fi off is emulated by aborting every non-loopback request and firing the
// offline event (Playwright's setOffline would block loopback too).
// Run: node test/localhost-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
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
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-localhost-'));
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });

const stub = `
import { createFake } from './test/graph-fixture.js';
window.fake = createFake();
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Fake title' } }] }) } };
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
const dummy = await startDummy({ key: KEY, cors: ['https://chat.example'], loadMs: 0 });
let passed = 0;
const t0 = Date.now();
const ok = (name) => { passed++; console.log('ok', name, `(${((Date.now() - t0) / 1000).toFixed(0)} s)`); };
const errors = [];
const T = { timeout: 15000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wifiOff = false, usageHits = 0;

async function open(name) {
  const context = await browser.launchPersistentContext(join(scratch, name), { headless: true, viewport: { width: 1280, height: 800 } });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => {
    if (wifiOff) return r.abort('internetdisconnected');
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) { usageHits++; return r.fulfill({ json: {} }); }
    return r.abort();
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(url);
  await page.waitForSelector('#badge.ok', T);
  await page.click('#welcome button >> text=Got it', { timeout: 2000 }).catch(() => {});
  return { context, page };
}
const browser = pw.chromium;
const steps = (page) => page.$$eval('#lh-steps li', (l) => l.map((x) => (x.className === 'bad' ? 'x ' : 'v ') + x.textContent));
const sealedReqs = (page) => page.evaluate(() => window.fake.requests.main?.length ?? 0);
const genLog = () => dummy.log.filter((e) => e.model);
async function settings(page) { await page.click('[data-panel="settings"]'); await page.waitForSelector('#lh-settings', { state: 'visible', ...T }); }
async function test(page, { url: u, key, transport = 'auto' } = {}) {
  await page.fill('#lh-url', u ?? dummy.url);
  if (key !== undefined) await page.fill('#lh-key', key);
  await page.selectOption('#lh-transport', transport);
  await page.click('#lh-test');
  await page.waitForFunction(() => !document.getElementById('lh-test').disabled && !/Testing/.test(document.getElementById('lh-steps').textContent), null, T);
  return steps(page);
}
async function confirmSheet(page) { await page.waitForSelector('#sheet[open] #sheet-actions button', T); await page.click('#sheet[open] #sheet-actions button.danger, #sheet[open] #sheet-actions button.primary'); }
const idle = (page) => page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
const transcript = (page) => page.textContent('#messages').catch(() => page.textContent('main'));

let s;
try {
  s = await open('journey');
  const { page } = s;

  // LH1: find the setting; a non-loopback address is refused before any request.
  await settings(page);
  assert.match(await page.textContent('#lh-hint'), /oMLX 12348, Ollama 11434, LM Studio 1234/);
  let st = await test(page, { url: 'http://127.0.0.1.evil.com:12348' });
  assert.match(st.join('\n'), /x .*not this computer/);
  st = await test(page, { url: 'http://192.168.1.212:12348' });
  assert.match(st.join('\n'), /x .*not this computer/);
  assert.equal(dummy.log.length, 0);
  ok('LH1 find Settings > Providers > Localhost; lookalike and LAN addresses refused before any request');

  // LH2: CORS blocked, with a fix naming this page's origin; then allowed.
  st = await test(page, { key: KEY });
  assert.match(st.join('\n'), /x .*did not allow this page \(CORS\)/, st.join('\n'));
  const fix = await page.textContent('#lh-fix');
  assert.ok(fix.includes(url), `fix names ${url}: ${fix}`);
  assert.ok(dummy.log.some((e) => e.method === 'OPTIONS' || e.mode === 'no-cors'), 'probe reached the server');
  await page.screenshot({ path: join(shots, 'localhost-cors.png') });
  dummy.cfg.cors = ['https://chat.example', url];
  // LH3: key: none, wrong, right (the right key is stored masked).
  st = await test(page, { key: '' });
  assert.match(st.join('\n'), /x .*needs an API key/, st.join('\n'));
  st = await test(page, { key: 'wrong' });
  assert.match(st.join('\n'), /x .*refused the API key/);
  dummy.log.length = 0;
  st = await test(page, { key: KEY });
  assert.match(st.join('\n'), /v .*2 models: dummy-small, dummy-coder/, st.join('\n'));
  assert.match(st.join('\n'), /v OpenAI Responses \(detected\)/);
  assert.equal(genLog().length, 0, 'Test connection never generates');
  assert.equal(await page.inputValue('#lh-key'), '');
  const ph = await page.getAttribute('#lh-key', 'placeholder');
  assert.ok(ph.includes('6789') && !ph.includes(KEY), ph);
  assert.match(await page.textContent('#lh-key-state'), /never synced/);
  await page.screenshot({ path: join(shots, 'localhost-settings.png') });
  ok('LH2 CORS blocked: specific fix naming the page origin; after allowing it, the test passes');
  ok('LH3 key: missing and wrong keys explained, the right one saved masked; Test connection never generates');

  for (const transport of ['responses', 'completions']) {
    dummy.cfg.responses = transport === 'responses';
    st = await test(page, { key: '' }); // the saved key is reused for the same address
    assert.match(st.join('\n'), new RegExp(`v OpenAI ${transport === 'responses' ? 'Responses' : 'Chat Completions'} \\(detected\\)`), st.join('\n'));
    // LH4: pick a model; the shield says what this means.
    await page.selectOption('#model', 'localhost:dummy-coder');
    assert.ok(await page.$eval('.provider-model', (l) => l.classList.contains('provider-localhost')));
    await page.click('#shield-btn');
    const shield = await page.textContent('#shield-pop');
    assert.match(shield, /Localhost: your machine runs the model/); assert.match(shield, /your responsibility/); assert.match(shield, /No BayLeaf allowance/);
    await page.keyboard.press('Escape');
    // LH5: a coding turn with a tool, no Sealed request, no allowance.
    const sealed0 = await sealedReqs(page), usage0 = usageHits;
    dummy.log.length = 0;
    dummy.cfg.loadMs = transport === 'responses' ? 5000 : 0; dummy.log.length = 0;
    await fetch(dummy.url + '/__reset');
    await send(page, `Create the file [[call write {"path":"/work/${transport}.txt","content":"hello ${transport}\\n"}]]`);
    if (transport === 'responses') await page.waitForFunction(() => /Waiting for your server: it may be loading dummy-coder/.test(document.getElementById('status').textContent), null, T);
    await idle(page);
    await page.waitForFunction((t) => document.body.textContent.includes('Result seen: Wrote'), transport, T);
    const gen = genLog();
    assert.equal(gen.length, 2, JSON.stringify(gen.map((g) => g.path)));
    assert.ok(gen.every((g) => g.path === `/v1/${transport === 'responses' ? 'responses' : 'chat/completions'}` && g.auth === 'good' && g.origin === url));
    assert.ok(!gen[0].tools.includes('subagent') && !gen[0].tools.includes('agents') && gen[0].tools.includes('write'), gen[0].tools.join());
    assert.equal(await sealedReqs(page), sealed0, 'no BayLeaf Sealed request');
    assert.equal(usageHits, usage0, 'no allowance refresh');
    const has = await page.evaluate(async (p) => { const root = await navigator.storage.getDirectory(); const w = await root.getDirectoryHandle('work').catch(() => root); const f = await w.getFileHandle(p).catch(() => null); return f ? (await f.getFile()).text() : 'missing'; }, `${transport}.txt`);
    assert.equal(has, `hello ${transport}\n`);
    dummy.cfg.loadMs = 0;
    // LH6: Stop closes the server's stream.
    dummy.log.length = 0;
    await send(page, 'Tell me slowly [[slow 40]]');
    await page.waitForFunction(() => document.body.textContent.includes('chunk 3'), null, T);
    await page.click('#send');
    await idle(page);
    await sleep(300);
    assert.equal(genLog().at(-1)?.closedEarly, true, 'stream closed early');
    ok(`LH4-LH6 ${transport}: picker and shield, a tool turn writes /work with no Sealed request${transport === 'responses' ? ', "loading model" shown on a slow first token' : ''}, Stop closes the stream`);
  }

  // Usage: tokens counted, no requests from the allowance.
  await page.click('[data-panel="usage"]');
  await page.waitForFunction(() => /\d/.test(document.getElementById('usage').textContent), null, T).catch(() => {});
  const usageText = await page.textContent('#usage');
  const row = await page.$$eval('#usage tr', (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.trim())));
  const mine = row.find((r) => /Create the file/.test(r[0] ?? ''));
  assert.ok(mine, JSON.stringify(row));
  console.log('  usage row:', JSON.stringify(row[0]), JSON.stringify(mine));
  assert.match(usageText, /Today by session/);
  assert.match(mine[0], /[\d,]+ in, [\d,]+ out/); assert.equal(mine[1], '0');
  ok('LH-usage: Localhost turns count the tokens the server reports and use no allowance requests');
  await settings(page);

  // LH7: Wi-Fi off: BayLeaf is unreachable, Localhost keeps working.
  wifiOff = true;
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); dispatchEvent(new Event('offline')); });
  await page.waitForFunction(() => /Offline/.test(document.getElementById('status').textContent), null, T);
  assert.match(await page.textContent('#status'), /Localhost keeps working/);
  dummy.log.length = 0;
  await send(page, 'Offline question');
  await idle(page);
  await page.waitForFunction(() => document.body.textContent.includes('ok: Offline question'), null, T);
  assert.equal(genLog().length, 1);
  await page.selectOption('#model', 'fake');
  await send(page, 'to Sealed while offline');
  await sleep(300);
  assert.match(await page.textContent('#status'), /Offline/);
  assert.equal(await page.inputValue('#input'), 'to Sealed while offline', 'the draft stays');
  await page.fill('#input', '');
  wifiOff = false;
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); dispatchEvent(new Event('online')); });
  await page.waitForSelector('#badge.ok', T);
  ok('LH7 Wi-Fi off: a Localhost turn works, BayLeaf Sealed refuses with the draft kept');

  // LH8: switch back to BayLeaf Sealed explicitly: the next turn goes to Sealed, not the server.
  const sealed1 = await sealedReqs(page);
  dummy.log.length = 0;
  await send(page, 'back to Sealed');
  await idle(page);
  assert.ok((await sealedReqs(page)) > sealed1); assert.equal(genLog().length, 0);
  ok('LH8 switching back to BayLeaf Sealed is one explicit picker choice; the server gets nothing after it');

  // Errors in a turn: the server down, a model gone, the key revoked server-side.
  await page.selectOption('#model', 'localhost:dummy-coder');
  dummy.cfg.models = [['dummy-small', 32768]];
  await send(page, 'hi');
  await idle(page);
  await page.waitForFunction(() => /no model named dummy-coder/.test(document.getElementById('status').textContent), null, T);
  dummy.cfg.models = [['dummy-small', 32768], ['dummy-coder', 131072]];
  dummy.cfg.key = 'rotated';
  await send(page, 'hi again');
  await idle(page);
  await page.waitForFunction(() => /refused the API key/.test(document.getElementById('status').textContent), null, T);
  dummy.cfg.key = KEY;
  ok('turn errors are specific: missing model, refused key');

  console.log('  LH9 starting');
  // LH9: remove the key, then Erase all removes Localhost entirely.
  await settings(page);
  await page.click('#lh-key-remove');
  await confirmSheet(page);
  await page.waitForFunction(() => document.getElementById('lh-key-remove').hidden, null, T);
  assert.match(await page.getAttribute('#lh-key', 'placeholder'), /only if your server asks/);
  dummy.log.length = 0;
  await page.selectOption('#model', 'localhost:dummy-coder');
  await send(page, 'without a key');
  await idle(page);
  await page.waitForFunction(() => /needs an API key/.test(document.getElementById('status').textContent), null, T);
  assert.equal(dummy.log.at(-1).auth, 'none', 'no key sent after removal');
  console.log('  key removed; erasing');
  await page.click('#erase');
  await confirmSheet(page);
  await page.waitForSelector('#erased:not([hidden])', { timeout: 30000 }).catch(async (e) => { console.log('  status during erase:', await page.textContent('#status').catch(() => '?')); throw e; });
  await page.waitForSelector('#badge.ok', T);
  assert.equal(await page.$('#model optgroup[label="Localhost"]'), null);
  await settings(page);
  assert.equal(await page.inputValue('#lh-url'), '');
  assert.ok(await page.$eval('#lh-forget', (b) => b.hidden));
  ok('LH9 Remove key: the next request carries none; Erase all removes the address, key and models');

  assert.deepEqual(errors, []);
} finally {
  await s?.context.close().catch(() => {});
  await dummy.close(); server.close();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`localhost-browser: ${passed} passed`);
