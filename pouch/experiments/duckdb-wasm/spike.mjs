// Spike: does DuckDB-Wasm's eh bundle run in a blob: module worker under
// Pouch's production CSP, with its network APIs removed? Run from pouch/:
//   node experiments/duckdb-wasm/spike.mjs
// Prints sizes, cold-start timings, and each probe's answer as JSON lines.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { assertNoCdn } from '../../build-runtime.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');

const dir = import.meta.dirname;
const PKG = process.env.DUCKDB_PKG || 'node_modules/@duckdb/duckdb-wasm';
const worker = (await build({ entryPoints: [dir + '/worker.mjs'], bundle: true, minify: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'error', nodePaths: [process.cwd() + '/node_modules'], alias: { DUCKDB_BLOCKING: `${process.cwd()}/${PKG}/dist/duckdb-browser-blocking.mjs` } })).outputFiles[0].text;
let cdn = 'none';
try { assertNoCdn(worker, 'worker'); } catch (e) { cdn = e.message; }
const wasm = readFileSync(`${PKG}/dist/duckdb-eh.wasm`);
const MiB = (n) => +(n / 2 ** 20).toFixed(2);
console.log(JSON.stringify({ workerMiB: MiB(worker.length), workerGzMiB: MiB(gzipSync(worker).length), wasmMiB: MiB(wasm.length), wasmGzMiB: MiB(gzipSync(wasm).length), cdnInBundle: cdn }));

const page = `
const w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })), { type: 'module' });
let seq = 0; const waiting = new Map();
w.onmessage = ({ data }) => { const p = waiting.get(data.id); waiting.delete(data.id); data.error ? p.rej(new Error(data.error)) : p.res(data.result); };
w.onerror = (e) => { for (const p of waiting.values()) p.rej(new Error('worker error: ' + e.message)); };
window.violations = [];
document.addEventListener('securitypolicyviolation', (e) => window.violations.push(e.violatedDirective + ' ' + e.blockedURI));
window.call = (msg, transfer = []) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); w.postMessage({ ...msg, id }, transfer); });
window.loadWasm = async () => { const b = await (await fetch('/duckdb-eh.wasm')).arrayBuffer(); const ext = {}; for (const n of ['parquet', 'json']) ext[n] = new Uint8Array(await (await fetch('/ext/' + n + '.wasm')).arrayBuffer()); const t = performance.now(); const r = await call({ action: 'load', wasm: b, ext }, [b]); return { ...r, pageMs: Math.round(performance.now() - t) }; };
`;
const script = `const WORKER = ${JSON.stringify(worker)};\n${page}`.replaceAll('</script', '<\\/script');
const csp = readFileSync('pouch.html', 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
  .replace('__SCRIPT_HASHES__', `'sha256-${createHash('sha256').update(script).digest('base64')}'`);
const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>duckdb spike</title><script>${script}</script>`;
const server = createServer((req, res) => {
  if (req.url === '/duckdb-eh.wasm') { res.writeHead(200, { 'content-type': 'application/wasm' }); return res.end(wasm); }
  if (req.url.startsWith('/ext/')) { res.writeHead(200, { 'content-type': 'application/wasm' }); return res.end(readFileSync('/tmp/ddb-ext/' + req.url.slice(5))); }
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch();
const out = (k, v) => console.log(JSON.stringify({ [k]: v }));
try {
  const p = await browser.newPage();
  const requests = [];
  p.on('request', (r) => requests.push(r.url()));
  p.on('console', (m) => out('console', m.type() + ': ' + m.text()));
  await p.goto(origin + '/');
  out('load', await p.evaluate(() => window.loadWasm()));
  const q = (sql) => p.evaluate((s) => window.call({ action: 'query', sql: s }).catch((e) => ({ error: e.message })), sql);
  const reg = (name, file) => p.evaluate(([n, b]) => window.call({ action: 'register', name: n, bytes: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }), [name, readFileSync(file).toString('base64')]);
  out('globals', await p.evaluate(() => window.call({ action: 'globals' })));
  out('version', await q('PRAGMA version'));
  out('extensions', await q("SELECT extension_name, loaded, installed, install_mode FROM duckdb_extensions() WHERE loaded OR installed"));
  out('allExtensions', await q('SELECT list(extension_name) FROM duckdb_extensions()'));
  await reg('/work/people.csv', 'test/fixtures/duckdb/people.csv');
  await reg('/work/trees.parquet', 'test/fixtures/duckdb/trees.parquet');
  out('preload', await q('LOAD parquet'));
  out('preloadJson', await q('LOAD json'));
  out('loadedNow', await q("SELECT extension_name, loaded, install_mode FROM duckdb_extensions() WHERE loaded"));
  out('csv', await q("SELECT dept, sum(count) AS n FROM '/work/people.csv' GROUP BY dept ORDER BY dept"));
  out('csvQuoted', await q("SELECT name FROM read_csv('/work/people.csv') WHERE dept = 'LIT'"));
  out('parquet', await q("SELECT * FROM '/work/trees.parquet' ORDER BY id"));
  out('unregistered', await q("SELECT * FROM '/work/missing.csv'"));
  out('copyTo', await q("COPY (SELECT * FROM '/work/trees.parquet') TO '/work/out.csv' (HEADER)"));
  out('copyOut', await p.evaluate(() => window.call({ action: 'copyOut', name: '/work/out.csv' }).then((r) => new TextDecoder().decode(r.bytes)).catch((e) => ({ error: e.message }))));
  out('copyParquet', await q("COPY (SELECT 42 AS answer) TO '/work/answer.parquet' (FORMAT parquet)"));
  out('copyParquetBytes', await p.evaluate(() => window.call({ action: 'copyOut', name: '/work/answer.parquet' }).then((r) => r.bytes.length).catch((e) => ({ error: e.message }))));
  await p.evaluate(() => window.call({ action: 'register', name: '/work/a.json', bytes: new TextEncoder().encode('[{"x":1,"y":"a"},{"x":2,"y":"b"}]') }));
  out('json', await q("SELECT sum(x) AS s, string_agg(y, '') AS ys FROM read_json_auto('/work/a.json')"));
  // Lockdown: settings first, then the attempts that must fail.
  for (const s of ['SET autoinstall_known_extensions=false', 'SET autoload_known_extensions=false', 'SET allow_community_extensions=false', "SET custom_extension_repository='https://invalid.invalid'", 'SET lock_configuration=true']) out(s, await q(s));
  out('afterLock', await q('SET autoload_known_extensions=true'));
  out('installHttpfs', await q('INSTALL httpfs'));
  out('loadHttpfs', await q('LOAD httpfs'));
  out('httpRead', await q("SELECT * FROM 'https://example.com/x.csv'"));
  out('stillAlive', await q('SELECT 1 + 1 AS two'));
  out('memoryLimit', await q("SELECT current_setting('memory_limit') AS m, current_setting('threads') AS t"));
  await q('CREATE TABLE junk AS SELECT 1'); const big = await q('SELECT count(*) FROM range(10000000)');
  out('range10M', big);
  const setup = ['LOAD parquet', 'LOAD json', 'SET autoinstall_known_extensions=false', 'SET autoload_known_extensions=false', 'SET allow_community_extensions=false', "SET memory_limit='1GB'", "SET allowed_directories=['/work/', '/tmp/']", 'SET enable_external_access=false', 'SET lock_configuration=true'];
  const fresh = [];
  for (let i = 0; i < 20; i++) fresh.push(await p.evaluate((s) => window.call({ action: 'fresh', setup: s }).catch((e) => ({ error: e.message })), setup));
  out('fresh20', fresh.map((f) => f.error ?? `${f.ms}ms/${f.heapMiB}MiB`).join(' '));
  out('tablesGone', await q('SELECT count(*) FROM duckdb_tables()'));
  await reg('/work/people.csv', 'test/fixtures/duckdb/people.csv');
  out('csvNoExternal', await q("SELECT count(*) FROM '/work/people.csv'"));
  out('copyNoExternal', await q("COPY (SELECT 1 AS a) TO '/work/b.csv'"));
  out('ldNoExternal', await q('LOAD httpfs'));
  out('httpNoExternal', await q("SELECT * FROM read_csv('https://example.com/x.csv')"));
  out('outsideDir', await q("SELECT * FROM read_csv('/etc/passwd')"));
  out('installNoExternal', await q('INSTALL httpfs'));
  out('attachNoExternal', await q("ATTACH '/work/x.duckdb' AS x"));
  out('fresh-after', await p.evaluate((s) => window.call({ action: 'fresh', setup: s }).catch((e) => ({ error: e.message })), setup));
  out('xhrAsked', await p.evaluate(() => window.call({ action: 'requested' })));
  out('nonNetworkRequests', requests.filter((u) => !u.startsWith(origin)));
  out('requests', requests.map((u) => u.replace(origin, '')));
  out('violations', await p.evaluate(() => window.violations));
} finally { await browser.close(); server.close(); }
