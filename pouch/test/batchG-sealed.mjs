// Batch G live check against BayLeaf Sealed, at most CAP (default 5) model
// requests, counted at the route (titles included): main is asked for a small
// self-contained HTML report summarizing a CSV in /work; the report opens
// from the link in its reply, in Preview, Static; a screenshot is saved.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/batchG-sealed.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 5);
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchG-sealed-'));

const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.js')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') } });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const HEADERS = headersFile(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], viewerCsp(root));
const server = createServer((req, res) => {
  const viewer = new URL(req.url, 'http://x').pathname === '/viewer.html';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, viewer ? '/viewer.html' : '/pouch.html') });
  res.end(viewer ? readFileSync(join(root, 'viewer.html')) : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
let n = 0, sent = 0; // n: attempts (the one over the cap is aborted), sent: reached BayLeaf
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const outside = [];
try {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => {
    const u = r.request().url();
    if (!u.startsWith('https://api.bayleaf.dev/')) { outside.push(u); return r.abort(); }
    if (r.request().method() === 'POST' && /chat\/completions/.test(u) && ++n > CAP) { console.log(`ABORT: request ${n} over cap ${CAP}`); return r.abort(); }
    if (r.request().method() === 'POST' && /chat\/completions/.test(u)) sent++;
    return r.continue();
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss());
  await page.goto(url);
  await page.click('#welcome button >> text=Got it').catch(() => {});
  await page.click('#auth');
  await page.waitForSelector('#sheet[open] #key-input', { timeout: 10000 });
  await page.fill('#key-input', 'BAYLEAF_API_KEY=' + key);
  await page.click('#sheet .key-form button[type=submit]');
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  const model = await page.$eval('#model', (s) => s.value);
  await page.keyboard.press('Control+`'); await page.waitForSelector('#term-input', { state: 'visible', timeout: 5000 });
  await page.fill('#term-input', `printf 'region,quarter,sales\\nNorth,Q1,120\\nNorth,Q2,135\\nSouth,Q1,90\\nSouth,Q2,110\\nEast,Q1,75\\nEast,Q2,95\\n' > /work/sales.csv`);
  await page.press('#term-input', 'Enter');
  await page.waitForTimeout(500);
  await page.fill('#input', 'Write a small self-contained HTML report summarizing /work/sales.csv (totals per region, a simple bar chart) to /work/sales-report.html, then give me the link. Keep it short.');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send' && /sales-report\.html/.test(document.getElementById('log').textContent), null, { timeout: 240000 });
  console.log(`${at()} reply done; ${n} request(s); model ${model}`);
  const link = page.locator('#log .md button.path:has-text("sales-report"), #log .md button:has-text("sales-report")').last();
  await link.click();
  await page.waitForFunction(() => document.getElementById('editor-path').textContent === '/work/sales-report.html', null, { timeout: 10000 });
  await page.waitForSelector('#preview iframe.viewer', { timeout: 10000 });
  await page.waitForTimeout(1500);
  const mode = [await page.$eval('#view-mode [aria-pressed="true"]', (b) => b.textContent), await page.$eval('#script-mode [aria-pressed="true"]', (b) => b.textContent)];
  await page.screenshot({ path: join(shots, 'batchG-sealed-report.png') });
  const raw = await page.evaluate(async () => { document.querySelector('#view-mode [data-mode="raw"]').click(); await new Promise((r) => setTimeout(r, 300)); return document.querySelector('#editor .cm-content').textContent; });
  const remote = raw.match(/(src|href)\s*=\s*["']?https?:[^"' >]+/gi) ?? [];
  console.log(JSON.stringify({ requests: sent, attempts: n, mode, bytes: raw.length, hasScript: /<script/i.test(raw), remote, outside }, null, 1));
  assert.deepEqual(mode, ['Preview', 'Static']);
  assert.ok(sent <= CAP, 'request cap');
  console.log(`PASS (${at()}): screenshot ${join(shots, 'batchG-sealed-report.png')}`);
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
