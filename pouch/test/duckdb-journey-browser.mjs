// Story DB1-DB4 in the real page (JOURNEYS section 16), with the scripted fake in
// test/graph-fixture.js bundled in place of Tinfoil: no Sealed request is ever
// made. The DuckDB runtime is built into a scratch dir and served under the
// production headers; the person installs it in the terminal (`addons install
// duckdb`) and approves the sheet (an asked add-on). The
// person attaches a messy CSV export and asks in plain words; the fake agent
// inspects it with DESCRIBE and SUMMARIZE, writes region-month.sql (a COPY),
// runs it with duckdb -f and checks the CSV. Then: the CSV is in Files, its
// numbers match an independent computation (DB2), no request carried a raw row
// of the file (DB3), and the person reruns the .sql in the terminal and gets
// the same bytes (DB4).
// Run: node test/duckdb-journey-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { buildDuckdb } from '../build-duckdb.mjs';
import { messyExpected, parseCsv } from './duckdb-fixtures.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
export const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-duckdb-journey-'));
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });
process.chdir(root);
const duckdb = await buildDuckdb(scratch);

// The page as built (the DuckDB pin defined), with the fake model when asked.
export async function duckdbPage({ fake }) {
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
  const define = { LOCAL_MODEL: 'null', SW_SHA256: '"test"', POUCH_PDF_RUNTIME: 'null', POUCH_DUCKDB_RUNTIME: JSON.stringify(duckdb.pin) };
  const alias = { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') };
  const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.ts')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
  const bundled = await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, write: false, format: 'iife', define: { ...define, WORKER_SRC: JSON.stringify(worker) }, alias,
    plugins: fake ? [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js', resolveDir: root })); } }] : [] });
  let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
  html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
  const HEADERS = headersFile(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], viewerCsp(root));
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path.startsWith('/runtime/')) { try { res.writeHead(200, headersFor(HEADERS, path)); return res.end(readFileSync(join(scratch, path))); } catch { res.writeHead(404); return res.end(); } }
    const viewer = path === '/viewer.html';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, viewer ? '/viewer.html' : '/pouch.html') });
    res.end(viewer ? readFileSync(join(root, 'viewer.html')) : html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/pouch.html`, close: () => server.close() };
}
// The person installs the add-on: `addons install duckdb` in the terminal, then Install on the sheet.
export async function installDuckdb(page, T = { timeout: 60000 }) {
  if (!(await page.isVisible('#term-input'))) { await page.keyboard.press('Control+`'); await page.waitForSelector('#term-input', { state: 'visible', ...T }); }
  await page.fill('#term-input', 'addons install duckdb --wait'); await page.press('#term-input', 'Enter');
  await page.waitForSelector('#sheet[open]', T);
  const title = await page.$eval('#sheet-title', (e) => e.textContent);
  if (title !== 'Install DuckDB?') throw new Error(`sheet: ${title}`);
  await page.click('#sheet-actions button >> text=Install');
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('#term-log .term-block')].at(-1); return b && !b.querySelector('.term-live') && /installed DuckDB/.test(b.textContent); }, null, T);
}
// The person's terminal: one command, its block's text.
export async function term(page, cmd, T = { timeout: 60000 }) {
  if (!(await page.isVisible('#term-input'))) { await page.keyboard.press('Control+`'); await page.waitForSelector('#term-input', { state: 'visible', ...T }); }
  const n = await page.$$eval('#term-log .term-block', (l) => l.length);
  await page.fill('#term-input', cmd); await page.press('#term-input', 'Enter');
  await page.waitForFunction((n) => { const b = document.querySelectorAll('#term-log .term-block'); return b.length > n && !b[b.length - 1].querySelector('.term-live'); }, n, T);
  // The output only: the echoed command would run into the first line of it.
  return page.$eval('#term-log .term-block:last-child', (b) => [...b.querySelectorAll('pre, .term-exit')].map((x) => x.textContent).join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setTimeout(() => { console.error('FAIL: over 4 minutes'); process.exit(2); }, 240_000).unref();
  const app = await duckdbPage({ fake: true });
  let passed = 0;
  const ok = (name) => { passed++; console.log('ok', name); };
  const errors = [], outside = [], requests = [];
  const T = { timeout: 30000 };
  const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
  try {
    await context.route('https://**/*', (r) => {
      const u = new URL(r.request().url());
      if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
      if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
      outside.push(u.href); return r.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(app.url);
    await page.waitForSelector('#badge.ok');
    await page.click('#welcome button >> text=Got it').catch(() => {});
    await installDuckdb(page);
    ok('setup: `addons install duckdb` in the terminal, the sheet approved, installed');

    // DB1: the CSV comes in from the computer through the composer's picker.
    const csv = readFileSync(join(root, 'test/fixtures/duckdb/messy-sales.csv'));
    await page.locator('#attachment-picker').setInputFiles({ name: 'sales.csv', mimeType: 'text/csv', buffer: csv });
    const chip = page.locator('.attachment').first();
    await chip.waitFor(T);
    const src = await chip.getAttribute('title');
    assert.match(src, /^\/work\/\.attachments\/.+-sales\.csv$/);

    const sql = `COPY (
  SELECT upper(trim(region)) AS region, strftime(order_date, '%Y-%m') AS month,
         sum(TRY_CAST(replace(replace(amount, '$', ''), ',', '') AS DECIMAL(14,2))) AS total,
         median(TRY_CAST(replace(replace(amount, '$', ''), ',', '') AS DECIMAL(14,2))) AS median,
         count(*) AS orders
  FROM read_csv('${src}', nullstr=['n/a', ''])
  GROUP BY ALL ORDER BY ALL
) TO '/work/region-month.csv' (HEADER);
`;
    const rule = (r) => page.evaluate((r) => { window.fake.rule({ ...r, when: new Function('c', 'return ' + r.when) }); }, r);
    await rule({ who: 'main', when: '/median amount by region and month/.test(c.since)', reply: [['bash', { command: `duckdb -c "DESCRIBE FROM '${src}'"` }]] });
    await rule({ who: 'main', when: '/column_name[\\s\\S]*order_date/.test(c.since) && !/approx_unique/.test(c.since)', reply: [['bash', { command: `duckdb -c "SUMMARIZE FROM '${src}'"; duckdb -c "FROM '${src}' LIMIT 5"` }]] });
    await rule({ who: 'main', when: '/approx_unique/.test(c.since)', reply: [['write', { path: '/work/region-month.sql', content: sql }]] });
    await rule({ who: 'main', when: '/region-month\\.sql/.test(c.since) && !/wrote \\/work\\/region-month\\.csv/.test(c.since)', reply: [['bash', { command: "duckdb -f /work/region-month.sql && duckdb -c \"FROM '/work/region-month.csv'\"" }]] });
    await rule({ who: 'main', when: '/wrote \\/work\\/region-month\\.csv/.test(c.since)', reply: 'Wrote /work/region-month.csv (total and median amount by region and month) from /work/region-month.sql; rerun it with duckdb -f /work/region-month.sql.' });
    await page.fill('#input', 'total and median amount by region and month, as a CSV');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => window.fake.requests.main?.length >= 5, null, { timeout: 90000 });
    await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
    const reqs = await page.evaluate(() => window.fake.requests.main.map((b) => JSON.stringify(b.messages)));
    assert.match(reqs[1], /order_date[\s\S]*DATE[\s\S]*amount[\s\S]*VARCHAR/, 'DESCRIBE reached the agent');
    assert.match(reqs[2], /approx_unique/, 'SUMMARIZE reached the agent');
    assert.match(reqs[4], /wrote \/work\/region-month\.csv/);
    ok('DB1: attach, ask in plain words; the agent runs DESCRIBE, SUMMARIZE, writes region-month.sql, runs duckdb -f');

    await page.waitForSelector('#tree .name[title="/work/region-month.csv"]', { state: 'attached', ...T }); // a row in Files
    await page.screenshot({ path: join(shots, 'duckdb-journey.png') });
    const out = await term(page, 'cat /work/region-month.csv');
    const body = out.slice(out.indexOf('region,month'));
    const got = parseCsv(body.trim() + '\n').map((x) => [x.region, x.month, x.total === '' ? null : Number(x.total), x.median === '' ? null : Number(x.median), Number(x.orders)]);
    assert.deepEqual(got, messyExpected());
    ok('DB1/DB2: region-month.csv is in Files and matches the independent computation (quoted commas, doubled quotes, a line break, $85,000, n/a, mixed case)');

    const raw = csv.toString('utf8').split('\n').slice(1).filter((l) => l.length > 12);
    for (const line of raw) assert.ok(!reqs.some((r) => r.includes(JSON.stringify(line).slice(1, -1))), `a raw row reached the model: ${line}`);
    ok('DB3: no request carried a raw row of the CSV (the agent saw DESCRIBE, SUMMARIZE, 5 rows and the result)');

    const before = await term(page, 'sha256sum /work/region-month.csv');
    await term(page, 'rm /work/region-month.csv');
    const rerun = await term(page, 'duckdb -f /work/region-month.sql');
    assert.match(rerun, /wrote \/work\/region-month\.csv/);
    const after = await term(page, 'sha256sum /work/region-month.csv');
    assert.equal(after.match(/[0-9a-f]{64}/)[0], before.match(/[0-9a-f]{64}/)[0]);
    ok('DB4: the person reruns duckdb -f /work/region-month.sql in the terminal: the same bytes');

    assert.deepEqual(outside.filter((u) => u !== 'https://api.bayleaf.dev/campus-pass'), [], 'only the account plane\'s Campus Pass check (aborted here) went out');
    assert.ok(requests.filter((u) => u.includes('/runtime/')).every((u) => u.includes('/runtime/duckdb/')));
    assert.deepEqual(errors, []);
    ok('nothing but the account plane\'s Campus Pass check left this origin (the fake answers the model); no page error');
  } finally { await context.close(); app.close(); rmSync(scratch, { recursive: true, force: true }); }
  console.log(`duckdb-journey-browser: ${passed} passed`);
}
