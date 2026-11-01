// One live run of G16-G17 against BayLeaf Sealed in the real page: ask for
// help with CSV files that are not there yet, see whether the model watches
// for them instead of asking to be told, then drop them through the UI and
// see whether it continues. Spends real requests: hard stop at CAP.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/watch-sealed.mjs
// Prints an outline (tools called, event lines, final reply), not model internals.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 15);
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-watch-sealed-'));

const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.js')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') } });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
let n = 0;
const t0 = Date.now();
try {
  // Count model requests (chat completions through the sealed relay); refuse past CAP.
  await context.route('https://api.bayleaf.dev/**', (r) => {
    if (r.request().method() === 'POST' && /chat\/completions/.test(r.request().url())) {
      if (++n > CAP) { console.log(`ABORT: request ${n} over cap ${CAP}`); return r.abort(); }
    }
    return r.continue();
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? key : undefined));
  await page.goto(url);
  await page.click('#welcome button >> text=Got it').catch(() => {});
  await page.click('#auth');
  await page.click('text=Paste a key you already have');
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  const model = await page.inputValue('#model');
  const T = { timeout: 180000 };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  const tools = () => page.evaluate(() => [...document.querySelectorAll('#log details.tool summary .what')].map((s) => s.textContent));
  const replies = () => page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].map((b) => b.textContent));

  await page.fill('#input', 'I need to merge my monthly bank CSV exports into one file sorted by date. They are not in Pouch yet; I will add them to /work/data in a minute.');
  await page.press('#input', 'Enter');
  // The turn has really started (a model request went out), then ended.
  for (let i = 0; n < 1 && i < 300; i++) await page.waitForTimeout(100);
  await idle();
  await page.waitForTimeout(1500); await idle();
  const turn1 = { tools: await tools(), reply: (await replies()).at(-1), tray: await page.evaluate(() => [...document.querySelectorAll('.tray-row[data-kind="watch"] .tray-text')].map((x) => x.textContent)), requests: n };
  console.log('TURN 1', JSON.stringify(turn1, null, 1));

  // Drop three files onto /work/data (made by the model, or by us if it did not).
  if (!(await page.$('#tree .row[data-path="/work/data"]'))) {
    await page.evaluate(async () => { const d = await navigator.storage.getDirectory(); await d.getDirectoryHandle('data', { create: true }); });
    await page.click('#refresh').catch(() => {});
    await page.waitForSelector('#tree .row[data-path="/work/data"]', { timeout: 5000, state: 'attached' }).catch(() => {});
  }
  const before = n;
  await page.evaluate(() => {
    const dt = new DataTransfer();
    const f = { 'jan.csv': 'date,amount,memo\n2026-01-03,-12.50,coffee\n2026-01-15,1200.00,pay\n', 'feb.csv': 'date,amount,memo\n2026-02-01,-60.00,"groceries, weekly"\n2026-02-14,1200.00,pay\n', 'mar.csv': 'date,amount,memo\n2026-03-02,-8.25,bus\n2026-03-15,1200.00,pay\n' };
    for (const [name, t] of Object.entries(f)) dt.items.add(new File([t], name, { type: 'text/csv' }));
    const target = document.querySelector('#tree .row[data-path="/work/data"]') ?? document.getElementById('tree');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  for (let i = 0; n === before && i < 150; i++) await page.waitForTimeout(100);
  const woke = n > before;
  if (woke) { await page.waitForTimeout(500); await idle(); }
  await page.waitForTimeout(1500); await idle();
  const labels = await page.evaluate(() => [...document.querySelectorAll('#log .msg.from.watch')].map((m) => m.textContent.slice(0, 300)));
  const work = await page.evaluate(async () => { const out = []; const walk = async (d, p) => { for await (const [k, h] of d.entries()) { if (h.kind === 'directory') await walk(h, p + k + '/'); else out.push(p + k); } }; await walk(await navigator.storage.getDirectory(), ''); return out; });
  console.log('TURN 2', JSON.stringify({ woke, labels, tools: (await tools()).slice(turn1.tools.length), reply: (await replies()).at(-1)?.slice(0, 800), work, requests: n, requestsAfterDrop: n - before }, null, 1));
  console.log(`model ${model}; ${n} requests; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await page.screenshot({ path: '/tmp/pouch-qa/shots/watch-sealed-final.png' });
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
