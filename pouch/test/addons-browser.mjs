// Add-ons in a real page, the asked tier from a tool: a build whose pdf.js pin
// claims 40 MiB (over the 10 MiB quiet limit, so the tier rule makes it
// asked). The agent's pdfinfo returns the not-installed string at once and no
// sheet opens; the agent's `addons install pdfjs` opens the approval sheet
// naming who asks, and Cancel returns the denial string; nothing is fetched.
// Settings > Add-ons shows the row and Make available offline asks once.
// Run: node test/addons-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { buildPdf } from '../build-pdf.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 3 minutes'); process.exit(2); }, 180_000).unref();
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-addons-'));
process.chdir(root);
const { pin } = await buildPdf(scratch);
const PIN = { ...pin, bytes: 40 * 2 ** 20 }; // the claim the tier rule reads

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
  define: { WORKER_SRC: JSON.stringify(worker), SW_SHA256: '"test"', POUCH_PDF_RUNTIME: JSON.stringify(PIN) },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') },
  plugins: [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js', resolveDir: root })); } }] });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const HEADERS = headersFile(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], viewerCsp(root));
const runtimeHits = [];
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/runtime/')) { runtimeHits.push(path); try { res.writeHead(200, headersFor(HEADERS, path)); return res.end(readFileSync(join(scratch, path))); } catch { res.writeHead(404); return res.end(); } }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, '/pouch.html') });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };
const errors = [], T = { timeout: 20000 };
const browser = await pw.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => {
  const u = new URL(r.request().url());
  if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
  if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
  return r.abort();
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const rule = (r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r);
const sheetOpen = () => page.evaluate(() => document.querySelector('#sheet[open]') !== null);
const idle = () => page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
const toolOut = () => page.evaluate(() => [...document.querySelectorAll('#log .tool')].map((e) => e.textContent).join('\n'));

try {
  await page.goto(url);
  await page.waitForSelector('#badge.ok', T);
  await page.click('#welcome button >> text=Got it', { timeout: 2000 }).catch(() => {});

  // 1. A tool whose add-on asks first: the tool returns at once, no sheet.
  await rule({ who: 'title', reply: 'Add-ons', sticky: true });
  await rule({ who: 'main', when: '/read the pdf/.test(c.since)', reply: [['bash', { command: 'printf "%%PDF-1.4\\n" > /work/a.pdf; pdfinfo /work/a.pdf' }]] });
  await rule({ who: 'main', when: '/not installed: pdf\\.js/.test(c.since)', reply: 'pdf.js is not installed.' });
  await page.fill('#input', 'read the pdf'); await page.press('#input', 'Enter');
  await idle();
  assert.equal(await sheetOpen(), false, 'a tool never opens a sheet');
  const out1 = await toolOut();
  assert.ok(out1.includes('pdfinfo: not installed: pdf.js (40 MiB). Run `addons install pdfjs`; the user will be asked.'), out1);
  assert.deepEqual(runtimeHits, [], 'nothing fetched');
  ok('asked tier: the agent\'s pdfinfo returns "not installed: pdf.js (40 MiB). Run `addons install pdfjs`; the user will be asked." with no sheet and no fetch');

  // 2. The agent asks to install: the sheet names who asks; Cancel returns the denial string.
  await rule({ who: 'main', when: '/install it/.test(c.since)', reply: [['bash', { command: 'addons install pdfjs --wait' }]] });
  await rule({ who: 'main', when: '/denied by the user/.test(c.since)', reply: 'The user said no.' });
  await page.fill('#input', 'install it'); await page.press('#input', 'Enter');
  await page.waitForSelector('#sheet[open]', T);
  const seen = await page.evaluate(() => ({ title: document.getElementById('sheet-title').textContent, body: document.getElementById('sheet-body').textContent }));
  assert.equal(seen.title, 'main (a1) asks to install pdf.js');
  for (const re of [/Only you can approve/, /Size40 MiB/, /License.*Apache-2\.0/, /From.*runtime\/pdf\/ \(Pouch's own origin\)/, /Kept in.*pouch-runtime/]) assert.match(seen.body, re);
  await page.click('#sheet-actions button >> text=Cancel');
  await idle();
  assert.ok((await toolOut()).includes('addons: denied by the user: nothing was installed (pdf.js).'));
  assert.deepEqual(runtimeHits, [], 'nothing fetched on deny');
  ok('addons install from an agent opens the sheet ("main (a1) asks to install pdf.js", size, source, license, "Only you can approve"); Cancel returns "denied by the user: nothing was installed (pdf.js)."');

  // 3. Settings > Add-ons: the row, and Make available offline asks once for the asked ones.
  await page.click('button[data-panel="settings"]');
  const row = '[data-addon="pdfjs"]';
  await page.waitForSelector(`${row}[data-state="not installed"]`, T);
  assert.match(await page.$eval(row, (e) => e.textContent), /pdf\.js 40 MiB, used by pdfinfo, pdftotext, pdftoppm.*not installed \(asks first\).*Install/);
  assert.equal(await page.$eval('#addons-offline', (e) => e.textContent), 'Make available offline (40 MiB)');
  await page.click('#addons-offline');
  await page.waitForSelector('#sheet[open]', T);
  assert.equal(await page.$eval('#sheet-title', (e) => e.textContent), 'Install pdf.js?');
  await page.click('#sheet-actions button >> text=Install');
  await page.waitForSelector(`${row}[data-state="installed"]`, T);
  assert.ok(runtimeHits.length && runtimeHits.every((p) => p.startsWith('/runtime/pdf/')), runtimeHits.join(', '));
  ok('Settings > Add-ons: a row with label, size, used by, state; Make available offline (40 MiB) asks once and installs');

  // 4. Parts no entry of this build names (an older build's) are offered to free, then gone; pdf.js stays.
  // Seed only after boot's own sweep (4 s after boot, src/interface/boot.ts) has run, or it may take the key first.
  await page.waitForFunction(() => performance.now() > 8000, null, T);
  await page.evaluate(async () => { const c = await caches.open('pouch-runtime'); await c.put('https://pouch-runtime.invalid/' + encodeURIComponent('runtime/old/' + 'a'.repeat(64) + '.bin'), new Response(new Uint8Array(300000))); });
  await page.evaluate(() => document.getElementById('addons-offline').click()); // Settings is still open from 3 // any action re-renders; Make available offline has nothing left
  await page.waitForFunction(() => /^Free 0\.3 MiB from older versions$/.test(document.getElementById('addons-sweep')?.textContent) && !document.getElementById('addons-sweep').hidden, null, T);
  await page.click('#addons-sweep');
  await page.waitForFunction(() => /Freed 0\.3 MiB from older versions of add-ons/.test(document.getElementById('status')?.textContent), null, T);
  assert.equal(await page.evaluate(async () => (await (await caches.open('pouch-runtime')).keys()).some((r) => r.url.includes('old'))), false);
  await page.waitForSelector('[data-addon="pdfjs"][data-state="installed"]', T);
  await page.waitForSelector('#addons-sweep[hidden]', { state: 'attached', ...T });
  ok('Settings > Add-ons: "Free 0.3 MiB from older versions" deletes only what no entry names; pdf.js stays installed');

  assert.deepEqual(errors, []);
  console.log(`\naddons-browser: ${passed} passed`);
} catch (e) {
  console.error('FAIL', e.stack ?? e);
  process.exitCode = 1;
} finally {
  await browser.close(); server.close(); rmSync(scratch, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
