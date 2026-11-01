// Batch C live check against BayLeaf Sealed (at most CAP requests): the
// files-waiting journey as the play-test hit it (ask before the CSVs exist,
// make /work/data and upload three in one picker through the UI; it must wake
// and merge all three unprompted), then one background subagent that must use
// `run` on a small CSV (the play-test's four harness errors).
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/batchC-sealed.mjs
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
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchC-sealed-'));

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
  page.on('dialog', (d) => { console.log('NATIVE DIALOG', d.message()); d.dismiss(); });
  await page.goto(url);
  await page.click('#welcome button >> text=Got it').catch(() => {});
  await page.click('#auth');
  await page.click('text=Paste a key you already have').catch(() => {});
  await page.waitForSelector('#sheet[open] #key-input', { timeout: 10000 });
  await page.fill('#key-input', key);
  await page.click('#sheet .key-form button[type=submit]');
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  const model = await page.inputValue('#model');
  const T = { timeout: 240000 };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  const settle = async () => { await idle(); await page.waitForTimeout(2000); await idle(); };
  const tools = () => page.evaluate(() => [...document.querySelectorAll('#log details.tool summary .what, #log .subagent .sa-name')].map((s) => s.textContent));
  const replies = () => page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].map((b) => b.textContent));
  const files = (p) => page.evaluate(async (p) => { let d = await navigator.storage.getDirectory(); for (const k of p.split('/').filter(Boolean)) d = await d.getDirectoryHandle(k).catch(() => null); if (!d) return null; const out = []; for await (const [k] of d.entries()) out.push(k); return out.sort(); }, p);
  const read = (p) => page.evaluate(async (p) => { const parts = p.split('/').filter(Boolean); let d = await navigator.storage.getDirectory(); for (const k of parts.slice(0, -1)) d = await d.getDirectoryHandle(k); return (await (await d.getFileHandle(parts.at(-1))).getFile()).text(); }, p).catch(() => null);

  // ── 1. Files waiting ──
  await page.fill('#input', 'I need to merge my monthly spending CSVs (jan, feb, mar) into one /work/data/all.csv with a month column. They are not uploaded yet; I will put them in /work/data in a minute.');
  await page.press('#input', 'Enter');
  for (let i = 0; n < 1 && i < 300; i++) await page.waitForTimeout(100);
  await settle();
  const turn1 = { tools: await tools(), reply: (await replies()).at(-1)?.slice(0, 300), watch: await page.evaluate(() => [...document.querySelectorAll('.tray-row[data-kind="watch"]')].map((x) => x.textContent)), requests: n };
  console.log('TURN 1', JSON.stringify(turn1, null, 1));
  // Make /work/data in Files (if Pouch did not) and upload three in one picker.
  if ((await page.getAttribute('#app', 'data-panel')) !== 'files') await page.click('#rail [data-panel="files"]');
  if (!(await page.$('#tree .row[data-path="/work/data"]'))) {
    await page.locator('[aria-label="Actions for work"]').dispatchEvent('click');
    await page.click('#sheet-actions button >> text=New folder here');
    await page.fill('#name-input', 'data'); await page.press('#name-input', 'Enter');
    await page.waitForSelector('#tree .row[data-path="/work/data"]', { timeout: 5000, state: 'attached' });
  }
  const before = n;
  await page.locator('[aria-label="Actions for data"]').dispatchEvent('click');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#sheet-actions button >> text=Upload files here')]);
  const csv = { jan: 'date,amount\n2026-01-03,12.50\n2026-01-15,40.00\n2026-01-20,7.25\n', feb: 'date,amount\n2026-02-01,60.00\n2026-02-14,9.99\n', mar: 'date,amount\n2026-03-02,8.25\n2026-03-15,30.00\n2026-03-28,4.75\n' };
  await chooser.setFiles(Object.entries(csv).map(([m, t]) => ({ name: m + '.csv', mimeType: 'text/csv', buffer: Buffer.from(t) })));
  for (let i = 0; n === before && i < 200; i++) await page.waitForTimeout(100);
  const woke = n > before;
  if (woke) await settle();
  const all = await read('data/all.csv');
  const labels = await page.evaluate(() => [...document.querySelectorAll('#log .msg.from.watch, #log .msg.user')].map((m) => m.textContent.slice(0, 200)).slice(-2));
  console.log('TURN 2', JSON.stringify({ woke, labels, tools: (await tools()).slice(turn1.tools.length), reply: (await replies()).at(-1)?.slice(0, 400), all, requests: n, requestsAfterUpload: n - before }, null, 1));
  const merged = !!all && ['jan', 'feb', 'mar'].every((m) => all.includes(m) || all.includes(`2026-0${{ jan: 1, feb: 2, mar: 3 }[m]}`)) && all.trim().split('\n').length >= 9;

  // ── 2. A background subagent that must use run ──
  const b2 = n;
  await page.fill('#input', 'Start one background subagent (do not wait for it) that uses the run tool (JavaScript) to sum the amount column of /work/data/feb.csv and writes the total to /work/data/feb-total.txt. Do not do it yourself.');
  await page.press('#input', 'Enter');
  for (let i = 0; i < 1500; i++) {
    await page.waitForTimeout(200);
    if (n > CAP) break;
    const st = await page.evaluate(() => document.querySelector('#log .subagent .sa-status')?.textContent ?? '');
    if (/finished|failed|stopped/.test(st) && document) break;
  }
  await settle().catch(() => {});
  const card = await page.evaluate(() => [...document.querySelectorAll('#log .subagent')].map((c) => c.querySelector('.sa-head')?.textContent).join(' | '));
  const total = await read('data/feb-total.txt');
  console.log('PART 2', JSON.stringify({ card, total, requests: n - b2 }, null, 1));
  console.log(`model ${model}; ${n} requests; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`RESULT files-waiting: woke=${woke} merged=${merged}; subagent run: total=${JSON.stringify(total)} (expect 69.99) toolErrors in card: ${/tool error/.test(card)}`);
  await page.screenshot({ path: '/tmp/pouch-qa/shots/batchC-sealed-final.png' });
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
