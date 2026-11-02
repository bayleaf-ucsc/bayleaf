// Batch H in a real page: model weights from the BayLeaf HF gateway (stubbed
// by route interception with byte ranges; a small fake model, 1 MiB chunks),
// the `models` command's consent (deny and approve, terminal and agent),
// download as a /task with Stop through ctl and resume after reload, tamper
// detection, migration from the old pouch.bayleaf.dev part cache, offline
// re-verification, removal, and Settings sharing the same download, the
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
  const list = await term(page, 'models list');
  assert.match(list, /fake-q4 .*Apache-2\.0.*not downloaded.*BayLeaf Pouch: test/);
  assert.match(list, /parakeet.*not in this build \(no pin\)/);
  ok('models list: pinned model with the catalog license and qualification, unpinned releases marked');
  gw.log.length = 0;
  const denied = await term(page, 'models get fake-q4', { answer: 'Cancel' });
  assert.match(sheet.last.title, /Download Fake 1M\?/);
  for (const re of [/Size/, /Kept in.*Cache Storage/, /License.*Apache-2\.0/, /Attribution.*onnx-community\/Fake-ONNX/, /From.*api\.bayleaf\.dev/, /Asked by you, in terminal/]) assert.match(sheet.last.body, re);
  assert.match(denied, /denied by the user/);
  assert.equal(gw.log.length, 0);
  ok('models get: the sheet names size, storage, license, attribution and origin; Cancel fetches nothing');
  gw.delay = 2500; // two rounds of 4 ranges: Stop lands in the second
  const started = await term(page, 'models get fake-q4', { answer: 'Download' });
  const id = started.match(/\/task\/(\d+)/)[1];
  await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('downloading from api.bayleaf.dev'), null, T);
  await new Promise((r) => setTimeout(r, 6200)); // config (one round), then the first 4 weight ranges
  const stoppedOut = await term(page, `echo stop > /task/${id}/ctl; sleep 0.3; cat /task/${id}/status`);
  assert.match(stoppedOut, /stopped .* download models get fake-q4/);
  const partial = await term(page, 'models status fake-q4');
  assert.match(partial, /partial: .* `models get fake-q4` resumes/);
  ok('download is a /task entry: progress in the status line; echo stop > ctl stops it and keeps the verified prefix');
  gw.delay = 0;
  await page.reload(); await page.waitForSelector('#badge.ok', T);
  const keptBefore = ranges().length;
  const kept = Number((await term(page, 'models status fake-q4')).match(/partial: ([\d.]+) MB/)[1]);
  const done = await term(page, 'models get fake-q4 --wait', { answer: 'Download' });
  assert.match(done, /downloaded and verified fake-q4/);
  const resumedAt = ranges()[keptBefore];
  if (process.env.DEBUG_RANGES) console.log(ranges(), keptBefore);
  assert.ok(resumedAt >= CHUNK && Math.abs(resumedAt / 1e6 - kept) < 1.1, `resumed at ${resumedAt}, kept ${kept} MB`);
  assert.match(sheet.last.body, /the rest is already kept/);
  ok(`resume after reload: continued at byte ${resumedAt}, not from 0; the sheet counted only what was left`);

  // 2. Offline: the gateway is unreachable; every chunk re-verified from storage.
  gw.down = true;
  await page.reload(); await page.waitForSelector('#badge.ok', T);
  assert.match(await term(page, 'models verify fake-q4'), /verified 2 files of fake-q4 .*no network used/);
  assert.match(await term(page, 'models list'), /gateway catalog unavailable.*\n?|fake-q4 .*downloaded/);
  gw.down = false;
  ok('offline reload: models verify re-checks every kept chunk with no network');

  // 3. Settings shares the store: Download hidden when complete; Remove frees.
  await page.click('#rail [data-panel="settings"]').catch(() => {});
  const settingsText = await page.$eval('#local-state', (e) => e.textContent).catch(() => '');
  assert.match(settingsText, /kept in this browser/);
  ok('Settings reads the same store');

  // 4. Agent request vs user approval (the fake Sealed model drives main).
  await rule(page, { who: 'title', reply: 'Models', sticky: true });
  await rule(page, { who: 'main', when: '/clean up the model/.test(c.since)', reply: [['bash', { command: 'models remove fake-q4' }]] });
  await rule(page, { who: 'main', when: '/denied by the user: Fake 1M was kept/.test(c.since)', reply: 'The user kept it.' });
  await page.fill('#input', 'clean up the model'); await page.press('#input', 'Enter');
  await sheet(page, 'Cancel');
  assert.match(sheet.last.title, /main \(a1\) asks to remove Fake 1M/);
  assert.match(sheet.last.body, /Asked by .*main \(a1\)\. Only you can approve/);
  await page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
  assert.match(await term(page, 'models status fake-q4'), /downloaded, verified/);
  ok('an agent\'s models remove asks the user; Cancel keeps the model and the agent reads "denied by the user"');
  const removed = await term(page, 'models remove fake-q4');
  assert.match(removed, /removed fake-q4: freed/);
  assert.equal(await page.evaluate(() => document.querySelector('#sheet[open]') !== null), false);
  await rule(page, { who: 'main', when: '/fetch the model/.test(c.since)', reply: [['bash', { command: 'models get fake-q4 --wait' }]] });
  await rule(page, { who: 'main', when: '/downloaded and verified|denied/.test(c.since)', reply: 'Done.' });
  gw.log.length = 0;
  await page.fill('#input', 'fetch the model'); await page.press('#input', 'Enter');
  await sheet(page, 'Download');
  assert.match(sheet.last.title, /main \(a1\) asks to download Fake 1M/);
  await page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
  assert.match(await term(page, 'models status fake-q4'), /downloaded, verified/);
  assert.match(await term(page, 'ls /task; cat /task/*/status'), /done .* download models get fake-q4/);
  ok('the user removes with no sheet; an agent\'s models get waits for the user\'s click, then downloads as a /task');
  await context.close();

  // 5. Tamper: one byte flipped in one range refuses the file and keeps nothing of it.
  ({ context, page } = await open('b'));
  gw.corrupt = (name, from) => name.endsWith('onnx_data') && from === 3 * CHUNK;
  const bad = await term(page, 'models get fake-q4 --wait', { answer: 'Download' });
  assert.match(bad, /onnx\/model_q4f16\.onnx_data: SHA-256 differs from the pin .*discarded/);
  assert.match(await term(page, 'models status fake-q4'), /-\s+6\.3 MB onnx\/model_q4f16\.onnx_data|- .*onnx_data/);
  gw.corrupt = null;
  ok('a tampered range: the download fails naming the file, and nothing of it is kept');
  await context.close();

  // 6. Migration from the old pouch.bayleaf.dev part cache: nothing fetched again.
  ({ context, page } = await open('c'));
  await page.evaluate(async (names) => {
    const c = await caches.open('pouch-local-models');
    for (const n of names) await c.put(`https://pouch-local.invalid/models/fake-q4/${n}`, await fetch('/old/' + n));
  }, [...old.keys()]);
  gw.log.length = 0;
  await page.reload(); await page.waitForSelector('#badge.ok', T);
  await page.waitForFunction(() => /Moved the Transformers\.js model kept by an earlier Pouch/.test(document.getElementById('status')?.textContent), null, T);
  assert.match(await term(page, 'models verify fake-q4'), /verified 2 files/);
  assert.equal(gw.log.length, 0, 'no gateway request');
  assert.equal(await page.evaluate(() => caches.has('pouch-local-models')), false);
  ok('migration: old parts reassembled, checked against the lock, moved; the old cache deleted; 0 bytes downloaded');
  await context.close();

  // 7. Settings: the same approval and /task download; Stop is the task's ctl; Resume; the runtime loads.
  ({ context, page } = await open('d'));
  await page.click('button[data-panel="settings"]');
  await page.waitForSelector('#local-download:not([hidden])', T);
  gw.delay = 2500;
  await page.click('#local-download');
  await sheet(page, 'Download');
  assert.match(sheet.last.body, /Asked by you, in Settings/);
  await page.waitForSelector('#local-stop:not([hidden])', T);
  assert.match(await page.$eval('#local-state', (e) => e.textContent), /Downloading from api\.bayleaf\.dev as \/task\/\d+/);
  await new Promise((r) => setTimeout(r, 6200));
  await page.click('#local-stop');
  await page.waitForFunction(() => document.getElementById('local-download').textContent === 'Resume download' && !document.getElementById('local-download').hidden, null, T);
  assert.match(await term(page, 'cat /task/*/status'), /stopped .* download models get fake-q4/);
  gw.delay = 0;
  await page.click('button[data-panel="settings"]'); // the terminal took the panel
  await page.click('#local-download');
  await sheet(page, 'Download');
  await page.waitForFunction(() => /Fake 1M is ready in this browser/.test(document.getElementById('status')?.textContent), null, T);
  assert.match(await page.$eval('#local-state', (e) => e.textContent), /kept in this browser/);
  ok('Settings Download asks on the same sheet, runs as a /task, Stop writes its ctl, Resume continues, the verified runtime and weights load');
  await context.close();

  // 5. An adapter below the storage-buffer limit (Firefox on an M3 Max reported 9):
  // the option is unavailable with the reason; models get and Settings start nothing.
  ({ context, page } = await open('e', { gpu: { f16: true, buffers: 9 } }));
  const why = "This browser's WebGPU allows 9 storage buffers per shader; LFM3 needs 10. Use Chrome or Edge, or a BayLeaf Sealed model.";
  const opt = await page.$eval('#model option[value^="local:"]', (o) => ({ disabled: o.disabled, text: o.textContent, title: o.title }));
  assert.equal(opt.disabled, true); assert.equal(opt.title, why); assert.ok(opt.text.includes(`(unavailable: ${why})`), opt.text);
  gw.log.length = 0;
  const sheets = sheet.last;
  const refused = await term(page, 'models get fake-q4');
  assert.ok(refused.includes(`Fake 1M cannot run in this browser, so it was not downloaded (nothing was fetched). ${why}`), refused);
  assert.equal(sheet.last, sheets, 'no approval sheet'); assert.equal(gw.log.length, 0);
  await page.click('button[data-panel="settings"]');
  assert.equal(await page.$eval('#local-state', (e) => e.textContent), `Not available here: ${why}`);
  assert.equal(await page.$eval('#local-download', (e) => e.hidden), true);
  ok('low storage-buffer limit: the option is disabled with the reason; models get refuses before the sheet; Settings offers no Download');
  await context.close();

  // 6. A phone with the weights already kept and Transformers.js still chosen
  // (downloaded on a desktop profile, reopened as a Pixel): nothing runs, Remove still frees.
  ({ context, page } = await open('m'));
  assert.match(await term(page, 'models get fake-q4 --wait', { answer: 'Download' }), /downloaded and verified fake-q4/);
  const localId = await page.$eval('#model option[value^="local:"]', (o) => o.value);
  await page.selectOption('#model', localId);
  await page.waitForFunction(() => /^Transformers\.js selected/.test(document.getElementById('status')?.textContent), null, T);
  await context.close();
  ({ context, page } = await open('m', { mobile: true }));
  const phone = 'In-browser models are turned off on phones and tablets: on a Pixel test the first request froze the whole phone for about a minute. Use a BayLeaf Sealed model here.';
  const popt = await page.$eval('#model option[value^="local:"]', (o) => ({ disabled: o.disabled, text: o.textContent, title: o.title, value: o.parentElement.closest('select').value === o.value }));
  assert.equal(popt.disabled, true); assert.equal(popt.title, phone); assert.ok(popt.text.includes(`(unavailable: ${phone})`), popt.text);
  assert.equal(popt.value, true, 'the saved choice stays visible, not silently switched to Sealed');
  const psheets = sheet.last;
  gw.log.length = 0;
  const pget = await term(page, 'models get fake-q4');
  assert.ok(pget.includes(`Fake 1M is downloaded, but cannot run in this browser. ${phone}`), pget);
  assert.equal(sheet.last, psheets, 'no approval sheet'); assert.equal(gw.log.length, 0);
  await page.fill('#input', 'hello from a phone'); await page.press('#input', 'Enter');
  await page.waitForFunction((r) => document.getElementById('status')?.textContent === `Transformers.js is not available: ${r}`, phone, T);
  assert.equal(await page.inputValue('#input'), 'hello from a phone');
  assert.equal(await page.$eval('#log', (e) => e.textContent.includes('hello from a phone')), false, 'no turn started');
  await page.click('button[data-panel="settings"]');
  assert.match(await page.$eval('#local-state', (e) => e.textContent), /^Not available here: In-browser models are turned off on phones and tablets.*A downloaded copy \(\d+ MB\) is kept in this browser; Remove frees the space\.$/);
  assert.equal(await page.$eval('#local-download', (e) => e.hidden), true);
  assert.equal(await page.$eval('#local-remove', (e) => e.hidden), false);
  await page.click('#local-remove'); await sheet(page, 'Remove');
  await page.waitForFunction(() => /Transformers\.js model removed/.test(document.getElementById('status')?.textContent), null, T);
  assert.match(await term(page, 'models status fake-q4'), /not downloaded/);
  ok('phone: the option is disabled with the reason; models get refuses before the sheet; Send refuses before any inference; Settings offers Remove, not Download');
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
