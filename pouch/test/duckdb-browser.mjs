// The real DuckDB-Wasm runtime in a real page, under Pouch's production CSP
// and headers: built by build-duckdb.mjs into a scratch dir, installed
// with `addons install duckdb --wait` (an asked add-on: a command never downloads it), then
// driven through the shell's duckdb (src/duckdb.ts) over an in-memory
// filesystem. Stories DB1-DB6: CSV, a messy export against an independent
// computation, Parquet, JSON, COPY TO written back, -f and stdin reproducing a
// file byte for byte, a database file that persists, fresh databases between
// calls, caps, Stop through /task ctl, the network refused, offline reuse,
// that the only requests are this origin's runtime parts, and no CSP violation.
// Run: node test/duckdb-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { buildDuckdb } from '../build-duckdb.mjs';
import { messyExpected, parseCsv } from './duckdb-fixtures.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 4 minutes'); process.exit(2); }, 240_000).unref();
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-duckdb-'));
process.chdir(root);
const { pin } = await buildDuckdb(scratch);

const entry = `
import { InMemoryFs } from 'just-bash';
import { shellFor } from './src/tools.ts';
import { createDuckdbService } from './src/duckdb.ts';
import { createAddons } from './src/addons.ts';
import { REGISTRY } from './src/addons-registry.ts';
import { Tasks } from './src/ns/tasks.ts';
const fs = new InMemoryFs();
const tasks = new Tasks();
window.asked = [];
// The person's approval, as the sheet would give it (the sheet itself: test/duckdb-journey-browser.mjs).
const addons = createAddons({ entries: REGISTRY, tasks, approve: async (req) => { window.asked.push(req.items.map((i) => i.id).join(',')); return true; } });
const duckdb = createDuckdbService({ tasks, addons });
const shell = shellFor(fs, { duckdb, addons });
window.violations = [];
document.addEventListener('securitypolicyviolation', (e) => window.violations.push(e.violatedDirective + ' ' + e.blockedURI));
window.pouch = {
  put: async (p, b64) => { await fs.mkdir(p.replace(/\\/[^/]*$/, ''), { recursive: true }); await fs.writeFile(p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); },
  text: async (p) => fs.readFile(p).catch(() => null),
  b64: async (p) => { const b = await fs.readFileBuffer(p); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); },
  sh: async (cmd) => { const t = performance.now(); const r = await shell.exec(cmd, { cwd: '/work' }); return { out: r.stdout, err: r.stderr, code: r.exitCode, ms: Math.round(performance.now() - t) }; },
  start: (cmd) => { window.pending = shell.exec(cmd, { cwd: '/work' }); },
  finish: async () => { const r = await window.pending; return { out: r.stdout, err: r.stderr, code: r.exitCode }; },
  tasks: () => tasks.list().map((t) => ({ id: t.id, kind: t.kind, label: t.label, status: t.status })),
  kill: (id) => tasks.kill(tasks.get(id)),
};`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.ts')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const app = (await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, write: false, format: 'iife', minify: true,
  define: { WORKER_SRC: JSON.stringify(worker), POUCH_DUCKDB_RUNTIME: JSON.stringify(pin) },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts') }, logLevel: 'error' })).outputFiles[0].text;
const script = app.replaceAll('</script', '<\\/script');
const csp = readFileSync(join(root, 'pouch.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
  .replace('__SCRIPT_HASHES__', `'sha256-${createHash('sha256').update(script).digest('base64')}'`);
const HEADERS = headersFile(csp, viewerCsp(root));
const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>duckdb test</title><script>${script}</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/runtime/')) { try { res.writeHead(200, headersFor(HEADERS, path)); return res.end(readFileSync(join(scratch, path))); } catch { res.writeHead(404); return res.end(); } }
  if (path === '/pouch.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, '/pouch.html') }); return res.end(html); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
const ok = (name) => { pass++; console.log('ok', name); };
const browser = await pw.chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [], errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await context.route('https://**/*', (r) => r.abort());
  await page.goto(origin + '/pouch.html');
  const put = (p, bytes) => page.evaluate(([p, b]) => window.pouch.put(p, b), [p, Buffer.from(bytes).toString('base64')]);
  const sh = (cmd) => page.evaluate((c) => window.pouch.sh(c), cmd);
  const text = (p) => page.evaluate((p) => window.pouch.text(p), p);
  const fx = (f) => readFileSync(join(root, 'test/fixtures/duckdb', f));

  // Not installed: refused, nothing downloaded.
  let r = await sh(`duckdb -c "SELECT 1"`);
  assert.equal(r.code, 1, r.err);
  assert.equal(r.err, 'duckdb: not installed: DuckDB (38 MiB). Run `addons install duckdb`; the user will be asked.\n');
  assert.ok(!requests.some((u) => u.includes('/runtime/')), 'a command must not download the add-on');
  assert.deepEqual(await page.evaluate(() => window.asked), [], 'and asks nobody');
  ok('before install: the standard "not installed ... addons install duckdb" sentence, no runtime request, no question (asked tier)');

  r = await sh('addons install duckdb --wait');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /installed DuckDB \(38 MiB\) .* checked against this page.s hashes/);
  assert.deepEqual(await page.evaluate(() => window.asked), ['duckdb']);
  console.log(`  addons install duckdb (${(pin.bytes / 2 ** 20).toFixed(1)} MiB from this origin): ${r.ms} ms`);
  ok('addons install duckdb: asked once, installed and verified');
  await put('/work/people.csv', fx('people.csv'));
  await put('/work/trees.parquet', fx('trees.parquet'));
  await put('/work/sales.csv', fx('messy-sales.csv'));
  await put('/work/items.json', Buffer.from('[{"sku":"a1","qty":2},{"sku":"b2","qty":5},{"sku":"a1","qty":1}]'));

  r = await sh(`duckdb -c "PRAGMA version; SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY 1"`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /v1\.4\.3/); assert.match(r.out, /core_functions[\s\S]*json[\s\S]*parquet/);
  console.log(`  first command (worker start, compile, fresh database): ${r.ms} ms`);
  ok('engine v1.4.3 with parquet and json loaded, nothing else');

  r = await sh(`duckdb -c "SELECT dept, sum(count) AS n FROM 'people.csv' GROUP BY dept ORDER BY dept"`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /┌[\s\S]*│ CM\s+│\s+10 │[\s\S]*│ LIT\s+│\s+1 │[\s\S]*└/);
  console.log(`  warm query: ${r.ms} ms`);
  ok('CSV by relative path, box output (default)');

  r = await sh(`duckdb -csv -c "SELECT name, dept FROM '/work/people.csv' WHERE dept <> 'CSE' ORDER BY name"`);
  assert.equal(r.out, 'name,dept\nAda,CM\nCy,CM\n"Di, Jr",LIT\n');
  r = await sh(`duckdb -json -c "SELECT sku, sum(qty) AS qty FROM read_json('/work/items.json') GROUP BY sku ORDER BY sku"`);
  assert.deepEqual(JSON.parse(r.out), [{ sku: 'a1', qty: 3 }, { sku: 'b2', qty: 5 }]);
  r = await sh(`duckdb -markdown -c "SELECT species, height_m, planted FROM '/work/trees.parquet' ORDER BY id"`);
  assert.match(r.out, /\| species \| height_m \| planted \|\n\|---\|---:\|---\|\n\| oak \| 12\.5 \| 2001-03-04 \|\n\| bay laurel \| 8 \|  \|/);
  ok('-csv quoting, -json (JSON input), -markdown (Parquet input with a date and a null)');

  // DB1/DB2: inspect, then COPY a summary of a messy export; check against an independent computation.
  r = await sh(`duckdb -c "DESCRIBE FROM '/work/sales.csv'"`);
  assert.match(r.out, /order_date\s+│ DATE/); assert.match(r.out, /amount\s+│ VARCHAR/);
  r = await sh(`duckdb -c "SUMMARIZE FROM '/work/sales.csv'"`);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /column_name/);
  const summary = `COPY (
  SELECT upper(trim(region)) AS region, strftime(order_date, '%Y-%m') AS month,
         sum(TRY_CAST(replace(replace(amount, '$', ''), ',', '') AS DECIMAL(14,2))) AS total,
         median(TRY_CAST(replace(replace(amount, '$', ''), ',', '') AS DECIMAL(14,2))) AS median,
         count(*) AS orders
  FROM read_csv('/work/sales.csv', nullstr=['n/a', ''])
  GROUP BY ALL ORDER BY ALL
) TO '/work/summary.csv' (HEADER);
`;
  await put('/work/summary.sql', Buffer.from(summary));
  r = await sh('duckdb -f /work/summary.sql');
  assert.equal(r.code, 0, r.err); assert.equal(r.out, ''); assert.match(r.err, /^wrote \/work\/summary\.csv \(\d+ bytes\)\n$/);
  const first = await text('/work/summary.csv');
  const got = parseCsv(first);
  assert.deepEqual(got.map((x) => [x.region, x.month, x.total === '' ? null : Number(x.total), x.median === '' ? null : Number(x.median), Number(x.orders)]), messyExpected());
  ok('DB1/DB2: DESCRIBE, SUMMARIZE, then -f summary.sql COPY: totals and medians match an independent computation');

  // DB4: rerun from the file and from stdin: the same bytes.
  await sh('rm /work/summary.csv');
  r = await sh('duckdb -f /work/summary.sql'); assert.equal(r.code, 0, r.err);
  assert.equal(await text('/work/summary.csv'), first);
  r = await sh('duckdb < /work/summary.sql'); assert.equal(r.code, 0, r.err);
  assert.equal(await text('/work/summary.csv'), first);
  ok('DB4: duckdb -f and duckdb < file.sql reproduce summary.csv byte for byte');

  r = await sh(`duckdb -c "COPY (FROM '/work/people.csv') TO '/work/out/people.parquet' (FORMAT parquet)"; duckdb -csv -c "SELECT count(*) AS n FROM '/work/out/*.parquet'"`);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /n\n4\n/);
  ok('COPY TO Parquet into a new folder, then read back through a glob');

  // DB5: a file of tens of MB stays within the caps.
  r = await sh(`duckdb -c "COPY (SELECT i AS id, 'region-' || (i % 7) AS region, (i % 1000) / 10 AS amount, DATE '2026-01-01' + (i % 365)::INT AS day FROM range(800000) t(i)) TO '/work/big.csv' (HEADER)"`);
  assert.equal(r.code, 0, r.err);
  const bigBytes = Number(/\(([\d,]+) bytes\)/.exec(r.err)[1].replaceAll(',', ''));
  assert.ok(bigBytes > 20 * 2 ** 20, `big.csv is ${bigBytes} bytes`);
  r = await sh(`duckdb -csv -c "SELECT region, count(*) AS n, round(sum(amount), 1) AS total FROM '/work/big.csv' GROUP BY ALL ORDER BY ALL"`);
  assert.equal(r.code, 0, r.err); assert.equal(r.out.trim().split('\n').length, 8);
  console.log(`  ${(bigBytes / 2 ** 20).toFixed(1)} MiB CSV (800,000 rows): group-by in ${r.ms} ms, handed over and queried`);
  ok('DB5: a 20+ MiB CSV written by COPY and aggregated, within the caps');

  // Every command starts with an empty database; database files are refused with the Parquet recipe.
  r = await sh(`duckdb -c "CREATE TABLE scratch AS SELECT 1 AS x"; duckdb -c "FROM scratch"`);
  assert.equal(r.code, 1); assert.match(r.err, /Table with name scratch does not exist/);
  r = await sh(`duckdb /work/t.duckdb -c "SELECT 1"`);
  assert.equal(r.code, 1); assert.match(r.err, /database files are not supported here[\s\S]*FORMAT parquet/);
  ok('every command starts with an empty database; a database file is refused with the Parquet recipe');

  // Caps and errors the agent can act on.
  r = await sh(`duckdb -c "SELECT * FROM range(100)"`);
  assert.match(r.out, /40 rows shown; there are more\. Raise -maxrows/);
  r = await sh(`duckdb -csv -maxrows 5 -c "SELECT * FROM range(100)"`);
  assert.equal(r.out.split('\n').length - 1, 6); assert.match(r.err, /5 rows shown/);
  r = await sh(`duckdb -c "SELECT * FROM '/work/nope.csv'"`);
  assert.equal(r.code, 1); assert.match(r.err, /\/work\/nope\.csv: no such file in your files \(ls \/work\/ to check/);
  r = await sh(`duckdb -c "SELEC 1"`);
  assert.match(r.err, /Parser Error/);
  r = await sh(`duckdb -c "SELECT 1 AS a; SELECT nope; SELECT 3"`);
  assert.equal(r.code, 1); assert.match(r.out, /│\s+1 │/); assert.match(r.err, /statement 2 of 3/); assert.doesNotMatch(r.out, /│\s+3 │/);
  ok('caps (-maxrows, the more note) and errors with hints; the first error stops the rest');

  // DB6: no network, from SQL.
  for (const [sql, re] of [['INSTALL httpfs; LOAD httpfs', /Loading external extensions is disabled|no network/],
    ["SELECT * FROM read_csv('https://example.com/x.csv')", /Permission Error[\s\S]*no network/],
    ["COPY (SELECT 1) TO 'https://example.com/x.csv'", /Permission Error|no network/],
    ['SET enable_external_access=true', /locked/], ["SELECT * FROM read_text('/etc/passwd')", /etc\/passwd: no such file in your files/]]) {
    r = await sh(`duckdb -c "${sql}"`);
    assert.equal(r.code, 1, sql); assert.match(r.err, re, sql);
  }
  r = await sh(`duckdb -c "SELECT 42 AS still"`); assert.match(r.out, /42/);
  ok('DB6: INSTALL/LOAD httpfs, https:// reads and writes, unlocking, /etc/passwd: refused, and the engine carries on');

  // Stop through /task ctl ends the worker; the next command starts a new one.
  await page.evaluate(() => window.pouch.start(`duckdb -c "SELECT sum(i) FROM range(20000000000) t(i)"`));
  await page.waitForFunction(() => window.pouch.tasks().some((t) => t.kind === 'job' && t.status === 'running' && t.label.startsWith('duckdb')), null, { timeout: 30000 });
  const job = (await page.evaluate(() => window.pouch.tasks())).find((t) => t.status === 'running');
  await page.evaluate((id) => window.pouch.kill(id), job.id);
  r = await page.evaluate(() => window.pouch.finish());
  assert.equal(r.code, 130); assert.match(r.err, /stopped/);
  r = await sh(`duckdb -csv -noheader -c "SELECT 6 * 7"`); assert.equal(r.out, '42\n');
  ok('Stop through /task ctl: 130, then a fresh worker answers');

  // Offline: the stored copy is enough.
  await context.setOffline(true);
  r = await sh(`duckdb -csv -noheader -c "SELECT count(*) FROM '/work/trees.parquet'"`);
  assert.equal(r.out, '4\n', r.err);
  await context.setOffline(false);
  ok('offline after install: works from the stored copy');

  const outside = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:'));
  assert.deepEqual(outside, []);
  assert.ok(requests.filter((u) => u.includes('/runtime/')).every((u) => u.startsWith(origin + '/runtime/duckdb/')));
  assert.deepEqual(await page.evaluate(() => window.violations), []);
  assert.deepEqual(errors, []);
  ok('only this origin\'s runtime parts were requested; no CSP violation; no page error');
} finally { await browser.close(); server.close(); rmSync(scratch, { recursive: true, force: true }); }
console.log(`duckdb-browser: ${pass} passed`);
