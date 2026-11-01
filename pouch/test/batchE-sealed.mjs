// Batch E live check against BayLeaf Sealed, at most CAP (default 5) model
// requests: one session's automatic title, the sparkle's suggestion and
// /compact, each a request through the encrypting fetch, counted at the route.
// Turn 1 pastes a long document so compaction has older turns to summarize.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/batchE-sealed.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 5);
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchE-sealed-'));

const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.ts')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') } });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
let n = 0;
const log = [];
try {
  await context.route('https://api.bayleaf.dev/**', (r) => {
    if (r.request().method() === 'POST' && /chat\/completions/.test(r.request().url())) {
      if (++n > CAP) { console.log(`ABORT: request ${n} over cap ${CAP}`); return r.abort(); }
    }
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
  const T = { timeout: 240000 };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  const model = await page.inputValue('#model');
  const doc = Array.from({ length: 900 }, (_, i) => `Note ${i + 1}: the Santa Cruz wharf walk passes the sea lions, the Dream Inn and Lighthouse Point; tide pools at Natural Bridges are best at low tide.`).join('\n');
  await page.fill('#input', 'Here are my walking notes. Do not use any tools. Reply with one short sentence only.\n\n' + doc);
  await page.press('#input', 'Enter');
  await idle();
  await page.waitForFunction(() => { const t = document.getElementById('title').textContent; return t && t !== 'New session' && !/^Here are my walking/.test(t); }, null, T).catch(() => {});
  log.push(['auto title', await page.textContent('#title'), n]);
  await page.fill('#input', 'More notes. Do not use any tools. One more short sentence about Lighthouse Point.\n\n' + doc.replaceAll('Note', 'Entry')); await page.press('#input', 'Enter');
  await idle();
  log.push(['turn 2', n]);
  await page.click('#title'); await page.waitForSelector('.title-edit .spark');
  const tip = await page.getAttribute('.title-edit .spark', 'title');
  await page.click('.title-edit .spark');
  await page.waitForFunction(() => !document.querySelector('.title-edit .spark.working'), null, T);
  log.push(['sparkle', await page.inputValue('.title-input'), tip, n]);
  await page.keyboard.press('Enter');
  const hint = await page.evaluate(() => { const i = document.getElementById('input'); i.value = '/compact'; i.dispatchEvent(new Event('input', { bubbles: true })); return null; });
  await page.waitForTimeout(300);
  const detail = await page.evaluate(() => document.querySelector('[role="listbox"]')?.textContent ?? '');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => /summarized|Nothing to compact|ompaction/.test(document.getElementById('status').textContent) && !/Compacting/.test(document.getElementById('status').textContent), null, T);
  log.push(['compact', await page.textContent('#status'), detail.slice(0, 140), n]);
  void hint;
  console.log(JSON.stringify({ model, log, requests: n }, null, 1));
  assert.ok(n <= CAP);
} finally {
  await context.close(); server.close();
  rmSync(scratch, { recursive: true, force: true });
}
