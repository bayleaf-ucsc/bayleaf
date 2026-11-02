// Batch H in a real page: the LFM3 add-on's weights from the BayLeaf HF gateway
// (stubbed by route interception with byte ranges; a small fake model, 1 MiB
// chunks) and its code from this origin, the `addons` command's consent (deny
// and approve, terminal and agent), install as a /task with Stop through ctl
// and resume after reload, tamper detection, older builds' model files
// discarded, offline re-verification, removal, Settings > Add-ons sharing the
// same install, the
// WebGPU capability check (a stubbed adapter: headless Chromium's lacks shader-f16),
// and the phone and tablet refusal (an emulated Pixel user agent).
// Run: node test/batchH-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { writeRuntime } from '../build-runtime.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 5 minutes'); process.exit(2); }, 300_000).unref();
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchH-'));
const H = (b) => createHash('sha256').update(b).digest('hex');
const MiB = 2 ** 20, CHUNK = MiB;

// The fake model: two files at a fake pinned revision; weights span 6 chunks.
const files = { 'config.json': Buffer.from('{"model_type":"fake"}'), 'onnx/model_q4f16.onnx_data': randomBytes(6 * MiB + 4321) };
const REPO = 'onnx-community/Fake-ONNX', REV = 'f'.repeat(40);
// A fake runtime: the worker answers load and generate (no WebGPU work).
const fakeWorker = Buffer.from(`self.onmessage=({data})=>{const{id,action}=data;if(action==='interrupt')return;let result;if(action==='load')result={load_ms:1,refused:[],sizes:Object.fromEntries(Object.entries(data.files).map(([k,v])=>[k,v.size]))};else if(action==='generate')result={text:'Fake local reply.',input_tokens:5,output_tokens:3,trimmed:0,interrupted:false,length:false,ttft_ms:1,ms:2};else result='disposed';postMessage({id,result})};`);
const rt = writeRuntime(scratch, 'fake', [{ name: 'worker.js', role: 'worker', bytes: fakeWorker }, { name: 'ort.wasm', role: 'wasm', bytes: Buffer.from('\0asm-fake') }]);
const LOCAL = { id: 'fake-q4', label: 'Fake 1M', repo: REPO, revision: REV, dtype: 'q4f16', license: 'Apache-2.0 (test)',
  files: Object.entries(files).map(([name, b]) => ({ name, bytes: b.length, sha256: H(b) })), runtime: rt.pin };
LOCAL.bytes = LOCAL.files.reduce((n, f) => n + f.bytes, 0);
// The old (pre-gateway) part cache: a manifest and content-hash parts of 1.5 MiB.
const oldParts = [];
const oldManifest = { format: 1, id: 'fake-q4', revision: REV, files: Object.entries(files).map(([name, b]) => {
  const parts = [];
  for (let at = 0; at < b.length; at += 1.5 * MiB) { const p = b.subarray(at, at + 1.5 * MiB); oldParts.push([H(p) + '.bin', p]); parts.push({ path: H(p) + '.bin', bytes: p.length, sha256: H(p) }); }
  return { name, bytes: b.length, sha256: H(b), parts };
}) };
const oldManifestBytes = Buffer.from(JSON.stringify(oldManifest));
oldParts.push([`manifest.${H(oldManifestBytes).slice(0, 16)}.json`, oldManifestBytes]);

const stub = `
import { createFake } from './test/graph-fixture.js';
window.fake = createFake();
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' }; this.chat = { completions: { create: async () => { throw new Error('plaintext'); } } };
    this.secureClient = { fetch: (u, i) => window.fake.fetch(u, i) }; }
  async ready() {} async getVerificationDocument() { return { securityVerified: true }; }
}`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.ts')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: JSON.stringify(LOCAL), SW_SHA256: '"test"', POUCH_CHUNK: String(CHUNK) },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') },
  plugins: [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js', resolveDir: root })); } }] });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const HEADERS = headersFile(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], viewerCsp(root));
const old = new Map(oldParts);
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/runtime/')) { try { res.writeHead(200, headersFor(HEADERS, path)); return res.end(readFileSync(join(scratch, path))); } catch { res.writeHead(404); return res.end(); } }
  if (path.startsWith('/old/')) { const b = old.get(path.slice(5)); res.writeHead(b ? 200 : 404); return res.end(b); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, '/pouch.html') });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
let passed = 0;
const t0 = Date.now();
const ok = (name) => { passed++; console.log('ok', name, `(${((Date.now() - t0) / 1000).toFixed(0)} s)`); };
const errors = [], outbound = [], contexts = [], T = { timeout: 20000 };

// The gateway stub: Hub-shaped resolve URLs with single byte ranges, plus a catalog.
const gw = { log: [], delay: 0, corrupt: null, down: false };
async function gateway(route) {
  const req = route.request(), u = new URL(req.url());
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, etag', 'access-control-allow-headers': 'range' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (gw.down) return route.abort();
  if (u.pathname === '/hf/catalog') return route.fulfill({ headers: cors, json: { releases: [{ repo: REPO, revision: REV, title: 'Fake', base_model: 'org/Fake', license: { name: 'Apache-2.0', url: 'https://example.invalid/LICENSE' }, distribution: { basis: 'Apache-2.0 permits redistribution.' }, qualification: [{ client: 'BayLeaf Pouch', status: 'test' }], files: LOCAL.files.map((f) => ({ path: f.name, bytes: f.bytes, sha256: f.sha256 })) },
    { repo: 'istupakov/parakeet-tdt-0.6b-v3-onnx', revision: 'c'.repeat(40), license: { name: 'CC-BY-4.0' }, qualification: [], files: [{ path: 'x', bytes: 1 }] }] } });
  const m = u.pathname.match(/^\/hf\/(.+?)\/resolve\/([0-9a-f]{40})\/(.+)$/);
  const name = m && m[1] === REPO && m[2] === REV ? decodeURIComponent(m[3]) : null;
  if (!name || !files[name]) return route.fulfill({ status: 404, headers: cors, body: 'not approved' });
  const r = /^bytes=(\d+)-(\d+)$/.exec(req.headers().range ?? '');
  const b = files[name], from = r ? +r[1] : 0, to = r ? Math.min(+r[2] + 1, b.length) : b.length;
  gw.log.push([name, from]);
  if (gw.delay) await new Promise((res) => setTimeout(res, gw.delay));
  let body = Buffer.from(b.subarray(from, to));
  if (gw.corrupt?.(name, from)) { body = Buffer.from(body); body[0] ^= 0xff; }
  return route.fulfill({ status: r ? 206 : 200, headers: { ...cors, 'content-type': 'application/octet-stream', ...(r ? { 'content-range': `bytes ${from}-${to - 1}/${b.length}` } : {}) }, body });
}
// gpu: the adapter navigator.gpu reports (the fake worker never touches it).
// mobile: report a Pixel through navigator.userAgentData and navigator.userAgent.
async function open(name, { gpu = { f16: true, buffers: 10 }, mobile = false } = {}) {
  const context = await pw.chromium.launchPersistentContext(join(scratch, name), { headless: true, viewport: { width: 1280, height: 800 }, args: ['--enable-unsafe-webgpu'] });
  contexts.push(context);
  await context.addInitScript(({ f16, buffers }) => {
    const adapter = { features: new Set(f16 ? ['shader-f16'] : []), limits: { maxStorageBuffersPerShaderStage: buffers }, info: { vendor: 'fake' } };
    Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter: async () => adapter }) });
  }, gpu);
  if (mobile) await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => ({ mobile: true, platform: 'Android', brands: [] }) });
    Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' });
  });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => {
    const u = new URL(r.request().url());
    if (u.hostname === 'api.bayleaf.dev' && u.pathname.startsWith('/hf/')) return gateway(r);
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
async function term(page, cmd, { answer } = {}) {
  if (!(await page.isVisible('#term-input'))) { await page.keyboard.press('Control+`'); await page.waitForSelector('#term-input', { state: 'visible', ...T }); }
  const n = await page.$$eval('#term-log .term-block', (l) => l.length);
  await page.fill('#term-input', cmd); await page.press('#term-input', 'Enter');
  if (answer) await sheet(page, answer);
  await page.waitForFunction((n) => { const b = document.querySelectorAll('#term-log .term-block'); return b.length > n && !b[b.length - 1].querySelector('.term-live'); }, n, T);
  return page.$eval('#term-log .term-block:last-child', (b) => b.textContent);
}
// Answer the approval sheet; returns its title and text.
async function sheet(page, answer) {
  await page.waitForSelector('#sheet[open]', T);
  const seen = await page.evaluate(() => ({ title: document.getElementById('sheet-title').textContent, body: document.getElementById('sheet-body').textContent }));
  await page.click(`#sheet-actions button >> text=${answer}`);
  sheet.last = seen;
  return seen;
}
const ranges = () => gw.log.filter(([n]) => n.endsWith('onnx_data')).map(([, f]) => f);

try {
  // 1. list, deny, approve, stop through ctl, resume after reload.
  let { context, page } = await open('a');
  const list = await term(page, 'addons list');
  assert.match(list, /fake-q4\s+model\s+\S+ MiB\s+not installed \(asks first\)\s+Transformers\.js provider/);
  assert.doesNotMatch(list, /transformersjs/, 'the Transformers.js code is part of the model, not listed alone');
  const info = await term(page, 'addons info fake-q4');
  assert.match(info, /license: Apache-2\.0[\s\S]*source: onnx-community\/Fake-ONNX@ffffffffffff[\s\S]*qualification: BayLeaf Pouch test[\s\S]*transformersjs|Transformers\.js \(needed\)/);
  ok('addons list and info: the model with its size, state, provider, the catalog license and qualification, and the code it needs');
  gw.log.length = 0;
  const denied = await term(page, 'addons install fake-q4', { answer: 'Cancel' });
  assert.match(sheet.last.title, /^Install Fake 1M\?$/);
  for (const re of [/Size/, /Kept in.*Cache Storage/, /License.*Apache-2\.0/, /Attribution.*onnx-community\/Fake-ONNX/, /From.*api\.bayleaf\.dev/, /Asked by you, in terminal/]) assert.match(sheet.last.body, re);
  assert.match(denied, /denied by the user: nothing was installed \(Fake 1M\)/);
  assert.equal(gw.log.length, 0);
  ok('addons install: the sheet names size, storage, license, attribution and origin; Cancel fetches nothing');
  gw.delay = 2500; // two rounds of 4 ranges: Stop lands in the second
  const started = await term(page, 'addons install fake-q4', { answer: 'Install' });
  const id = started.match(/\/task\/(\d+)/)[1];
  await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('installing LFM3 and checking') || document.getElementById('status')?.textContent.includes('Transformers.js: installing'), null, T);
  await new Promise((r) => setTimeout(r, 6200)); // config (one round), then the first 4 weight ranges
  const stoppedOut = await term(page, `echo stop > /task/${id}/ctl; sleep 0.3; cat /task/${id}/status`);
  assert.match(stoppedOut, /stopped .* install addons install fake-q4/);
  const partial = await term(page, 'addons info fake-q4');
  assert.match(partial, /partly installed: .* `addons install fake-q4` resumes/);
  ok('install is a /task entry: progress in the status line; echo stop > ctl stops it and keeps the verified prefix');
  gw.delay = 0;
  await page.reload(); await page.waitForSelector('#badge.ok', T);
  const keptBefore = ranges().length;
  const kept = Number((await term(page, 'addons info fake-q4')).match(/partly installed: ([\d.]+) MiB/)[1]);
  const done = await term(page, 'addons install fake-q4 --wait', { answer: 'Install' });
  assert.match(done, /installed Fake 1M .* checked against this page's hashes/);
  const resumedAt = ranges()[keptBefore];
  if (process.env.DEBUG_RANGES) console.log(ranges(), keptBefore);
  assert.ok(resumedAt >= CHUNK && Math.abs(resumedAt / MiB - kept) < 1.1, `resumed at ${resumedAt}, kept ${kept} MiB`);
  assert.match(sheet.last.body, /the rest is already kept/);
  ok(`resume after reload: continued at byte ${resumedAt}, not from 0; the sheet counted only what was left`);

  // 2. Offline: the gateway is unreachable; every chunk re-verified from storage.
  gw.down = true;
  await page.reload(); await page.waitForSelector('#badge.ok', T);
  assert.match(await term(page, 'addons verify fake-q4'), /verified 4 files of fake-q4 .*no network used/);
  assert.match(await term(page, 'addons list'), /fake-q4 .*installed/);
  gw.down = false;
  ok('offline reload: addons verify re-checks every kept chunk and part with no network');

  // 3. Settings > Add-ons reads the same service.
  await page.click('#rail [data-panel="settings"]').catch(() => {});
  await page.waitForSelector('[data-addon="fake-q4"][data-state="installed"]', T);
  assert.equal(await page.$('[data-addon="fake-q4"] [data-act="install"]'), null);
  ok('Settings > Add-ons reads the same service');

  // 4. Agent request vs user approval (the fake Sealed model drives main).
  await rule(page, { who: 'title', reply: 'Add-ons', sticky: true });
  await rule(page, { who: 'main', when: '/clean up the model/.test(c.since)', reply: [['bash', { command: 'addons remove fake-q4' }]] });
  await rule(page, { who: 'main', when: '/denied by the user: Fake 1M was kept/.test(c.since)', reply: 'The user kept it.' });
  await page.fill('#input', 'clean up the model'); await page.press('#input', 'Enter');
  await sheet(page, 'Cancel');
  assert.match(sheet.last.title, /main \(a1\) asks to remove Fake 1M/);
  assert.match(sheet.last.body, /Asked by .*main \(a1\)\. Only you can approve/);
  await page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
  assert.match(await term(page, 'addons info fake-q4'), /state: installed/);
  ok('an agent\'s addons remove asks the user; Cancel keeps the model and the agent reads "denied by the user"');
  const removed = await term(page, 'addons remove fake-q4');
  assert.match(removed, /removed Fake 1M: freed/);
  assert.equal(await page.evaluate(() => document.querySelector('#sheet[open]') !== null), false);
  await rule(page, { who: 'main', when: '/fetch the model/.test(c.since)', reply: [['bash', { command: 'addons install fake-q4 --wait' }]] });
  await rule(page, { who: 'main', when: '/installed Fake|denied/.test(c.since)', reply: 'Done.' });
  gw.log.length = 0;
  await page.fill('#input', 'fetch the model'); await page.press('#input', 'Enter');
  await sheet(page, 'Install');
  assert.match(sheet.last.title, /main \(a1\) asks to install Fake 1M/);
  await page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
  assert.match(await term(page, 'addons info fake-q4'), /state: installed/);
  assert.match(await term(page, 'ls /task; cat /task/*/status'), /done .* install addons install fake-q4/);
  ok('the user removes with no sheet; an agent\'s addons install waits for the user\'s click, then installs as a /task');
  await context.close();

  // 5. Tamper: one byte flipped in one range refuses the file and keeps nothing of it.
  ({ context, page } = await open('b'));
  gw.corrupt = (name, from) => name.endsWith('onnx_data') && from === 3 * CHUNK;
  const bad = await term(page, 'addons install fake-q4 --wait', { answer: 'Install' });
  assert.match(bad, /onnx\/model_q4f16\.onnx_data: SHA-256 differs from the pin .*discarded/);
  assert.doesNotMatch(await term(page, 'addons info fake-q4'), /state: installed/);
  gw.corrupt = null;
  ok('a tampered range: the install fails naming the file, and nothing of it is kept');
  await context.close();

  // 6. Model files kept by builds before add-ons (pouch-local-models) are discarded, with one line.
  ({ context, page } = await open('c'));
  await page.evaluate(async (names) => {
    const c = await caches.open('pouch-local-models');
    for (const n of names) await c.put(`https://pouch-local.invalid/models/fake-q4/${n}`, await fetch('/old/' + n));
  }, [...old.keys()]);
  gw.log.length = 0;
  await page.reload(); await page.waitForSelector('#badge.ok', T);
  await page.click('button[data-panel="settings"]');
  await page.waitForFunction(() => /^Removed model files kept by an older build of Pouch; Install LFM3 again here\./.test(document.getElementById('addons-storage')?.textContent), null, T);
  assert.equal(await page.evaluate(() => caches.has('pouch-local-models')), false);
  assert.match(await term(page, 'addons info fake-q4'), /not installed/);
  assert.equal(gw.log.length, 0, 'no gateway request');
  ok('older builds\' model files: discarded on boot with a one-line notice (no migration)');
  await context.close();

  // 7. Settings: the same approval and /task install; Stop is the task's ctl; Resume; the model starts.
  ({ context, page } = await open('d'));
  await page.click('button[data-panel="settings"]');
  const row = '[data-addon="fake-q4"]';
  await page.waitForSelector(`${row} [data-act="install"]`, T);
  assert.match(await page.$eval(row, (e) => e.textContent), /Fake 1M \(for Transformers\.js\).*used by Transformers\.js provider/);
  gw.delay = 2500;
  await page.click(`${row} [data-act="install"]`);
  await sheet(page, 'Install');
  assert.match(sheet.last.body, /Asked by you, in Settings/);
  await page.waitForSelector(`${row} [data-act="stop"]`, T);
  assert.match(await page.$eval(`${row} .addon-state`, (e) => e.textContent), /Installing as \/task\/\d+/);
  await new Promise((r) => setTimeout(r, 6200));
  await page.click(`${row} [data-act="stop"]`);
  await page.waitForFunction((r) => document.querySelector(`${r} [data-act="install"]`)?.textContent === 'Resume install', row, T);
  assert.match(await term(page, 'cat /task/*/status'), /stopped .* install addons install fake-q4/);
  gw.delay = 0;
  await page.click('button[data-panel="settings"]'); // the terminal took the panel
  await page.click(`${row} [data-act="install"]`);
  await sheet(page, 'Install');
  await page.waitForFunction(() => /Fake 1M is ready in this browser/.test(document.getElementById('status')?.textContent), null, T);
  await page.waitForSelector(`${row}[data-state="installed"]`, T);
  assert.match(await page.$eval('#addons-storage', (e) => e.textContent), /This site uses .* of storage.*Erase all removes every add-on/);
  ok('Settings Install asks on the same sheet, runs as a /task, Stop writes its ctl, Resume continues, the verified code and weights start');
  await context.close();

  // 8. An adapter below the storage-buffer limit (Firefox on an M3 Max reported 9):
  // the option is unavailable with the reason; addons install and Settings start nothing.
  ({ context, page } = await open('e', { gpu: { f16: true, buffers: 9 } }));
  const why = "This browser's WebGPU allows 9 storage buffers per shader; LFM3 needs 10. Use Chrome or Edge, or a BayLeaf Sealed model.";
  const opt = await page.$eval('#model option[value^="local:"]', (o) => ({ disabled: o.disabled, text: o.textContent, title: o.title }));
  assert.equal(opt.disabled, true); assert.equal(opt.title, why); assert.ok(opt.text.includes(`(unavailable: ${why})`), opt.text);
  gw.log.length = 0;
  const sheets = sheet.last;
  const refused = await term(page, 'addons install fake-q4');
  assert.ok(refused.includes(`addons: not available here: ${why}; nothing was fetched (Fake 1M).`), refused);
  assert.equal(sheet.last, sheets, 'no approval sheet'); assert.equal(gw.log.length, 0);
  await page.click('button[data-panel="settings"]');
  await page.waitForSelector('[data-addon="fake-q4"][data-state="not available here"]', T);
  assert.equal(await page.$eval('[data-addon="fake-q4"] .addon-state', (e) => e.textContent), `not available here: ${why}`);
  assert.equal(await page.$('[data-addon="fake-q4"] [data-act="install"]'), null);
  ok('low storage-buffer limit: the option is disabled with the reason; addons install refuses before the sheet; Settings offers no Install');
  await context.close();

  // 9. A phone with the weights already kept and Transformers.js still chosen
  // (installed on a desktop profile, reopened as a Pixel): nothing runs, Remove still frees.
  ({ context, page } = await open('m'));
  assert.match(await term(page, 'addons install fake-q4 --wait', { answer: 'Install' }), /installed Fake 1M/);
  const localId = await page.$eval('#model option[value^="local:"]', (o) => o.value);
  await page.selectOption('#model', localId);
  await page.waitForFunction(() => /^Transformers\.js selected/.test(document.getElementById('status')?.textContent), null, T);
  await context.close();
  ({ context, page } = await open('m', { mobile: true }));
  const phone = 'Transformers.js is turned off on phones and tablets: on a Pixel test the first request froze the whole phone for about a minute. Use a BayLeaf Sealed model here.';
  const popt = await page.$eval('#model option[value^="local:"]', (o) => ({ disabled: o.disabled, text: o.textContent, title: o.title, value: o.parentElement.closest('select').value === o.value }));
  assert.equal(popt.disabled, true); assert.equal(popt.title, phone); assert.ok(popt.text.includes(`(unavailable: ${phone})`), popt.text);
  assert.equal(popt.value, true, 'the saved choice stays visible, not silently switched to Sealed');
  const psheets = sheet.last;
  gw.log.length = 0;
  const pget = await term(page, 'addons install fake-q4');
  assert.ok(pget.includes(`addons: not available here: ${phone} (Fake 1M is installed; \`addons remove fake-q4\` frees the space).`), pget);
  assert.equal(sheet.last, psheets, 'no approval sheet'); assert.equal(gw.log.length, 0);
  await page.fill('#input', 'hello from a phone'); await page.press('#input', 'Enter');
  await page.waitForFunction((r) => document.getElementById('status')?.textContent === `Transformers.js is not available: ${r}`, phone, T);
  assert.equal(await page.inputValue('#input'), 'hello from a phone');
  assert.equal(await page.$eval('#log', (e) => e.textContent.includes('hello from a phone')), false, 'no turn started');
  await page.click('button[data-panel="settings"]');
  const prow = '[data-addon="fake-q4"]';
  await page.waitForSelector(`${prow}[data-state="not available here"]`, T);
  assert.equal(await page.$eval(`${prow} .addon-state`, (e) => e.textContent), `not available here: ${phone}`);
  assert.equal(await page.$(`${prow} [data-act="install"]`), null);
  await page.click(`${prow} [data-act="remove"]`); await sheet(page, 'Remove');
  await page.waitForFunction(() => /Fake 1M removed/.test(document.getElementById('status')?.textContent), null, T);
  assert.doesNotMatch(await term(page, 'addons info fake-q4'), /installed$/m);
  assert.match(await term(page, 'addons info fake-q4'), /not available here/);
  ok('phone: the option is disabled with the reason; addons install refuses before the sheet; Send refuses before any inference; Settings offers Remove, not Install');
  await context.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  console.log(`\n${passed} passed`);
} catch (e) {
  console.error('FAIL', e.stack ?? e);
  if (sheet.last) console.error('last sheet:', JSON.stringify(sheet.last));
  process.exitCode = 1;
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
