// The DuckDB-Wasm runtime's build inputs (build.mjs runs this): Pouch's third
// heavy tool, under dist/runtime/duckdb/ by the build-runtime.mjs convention.
// experiments/duckdb-wasm/README.md is the spike behind each choice here.
//
// Four files, each checked against the manifest the page is built with:
// - worker.js: src/duckdb/worker.ts bundled with DuckDB-Wasm's synchronous
//   browser bindings (dist/duckdb-browser-blocking.mjs, not in the package's
//   exports, so aliased) and apache-arrow.
// - duckdb-eh.wasm: the engine, the exception-handling build only (every
//   browser Pouch supports has Wasm exceptions); about 33 MiB, so two parts.
//   One string in its data is rewritten (WASM_REWRITES): no CDN, even in output.
// - extensions.pack: the parquet and json extensions for this engine version,
//   signed side modules from extensions.duckdb.org, fetched once at build into
//   a gitignored cache and pinned by SHA-256. Only DuckDB's core_functions is
//   statically linked in the published builds; the worker serves these two from
//   memory and nothing else.
// - NOTICE.txt: DuckDB's and Apache Arrow's licenses.
// Not shipped: the mvp and coi builds, the library's own async worker.
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertNoCdn, bundleWorker, writeRuntime } from './build-runtime.mjs';
import { pack } from './build-pdf.mjs';

const DIR = 'node_modules/@duckdb/duckdb-wasm/';
const sha = (b) => createHash('sha256').update(b).digest('hex');
// The pin: package.json says 1.32.0 exactly (the newest real release; npm's
// `latest` tag is a dev build); PRAGMA version answers v1.4.3 (d1dc88f950).
export const DUCKDB = { version: '1.32.0', engine: 'v1.4.3', sha256: {
  'dist/duckdb-eh.wasm': '4c221bfa59c11f24dbd750e70c90b9252eca6eec5633936e6a2ec766e55fd879',
  'dist/duckdb-browser-blocking.mjs': 'ad9fce671ad42dce96a9b2410efc44d6d8fc54f34f44450fe4ffbd9094759bbb',
} };
export const EXTENSIONS = [
  ['parquet', `https://extensions.duckdb.org/${DUCKDB.engine}/wasm_eh/parquet.duckdb_extension.wasm`, '22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55'],
  ['json', `https://extensions.duckdb.org/${DUCKDB.engine}/wasm_eh/json.duckdb_extension.wasm`, 'b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9'],
];
// Fetched once into the gitignored node_modules cache, then checked on every build.
const CACHE = 'node_modules/.cache/pouch-duckdb-ext/';

// The library's unused getJsDelivrBundles() names the CDN; assertNoCdn would refuse it.
const REWRITES = [[/"https:\/\/cdn\.jsdelivr\.net\/npm\/"/g, '"pouch:no-cdn/"', 1]];
// The engine's EXPLAIN (FORMAT html) template links a stylesheet on unpkg; it
// becomes an empty data: stylesheet of the same length (wasm data, so lengths must match).
const TREEFLEX = 'https://unpkg.com/treeflex/dist/css/treeflex.css';
export const WASM_REWRITES = [[TREEFLEX, 'data:text/css,/*' + '-'.repeat(TREEFLEX.length - 18) + '*/', 1]];
export function rewriteBytes(buf, rewrites, name) {
  const out = Buffer.from(buf);
  for (const [from, to, count] of rewrites) {
    if (from.length !== to.length) throw new Error(`${name}: a rewrite must keep the length (${from} -> ${to})`);
    const hits = [];
    for (let at = out.indexOf(from, 0, 'latin1'); at >= 0; at = out.indexOf(from, at + 1, 'latin1')) hits.push(at);
    if (hits.length !== count) throw new Error(`${name}: rewrite of ${from} matched ${hits.length} times, expected ${count} (did a dependency change?)`);
    for (const at of hits) out.write(to, at, 'latin1');
  }
  return out;
}

function extension([name, url, hash]) {
  const p = `${CACHE}${name}.wasm`;
  if (!existsSync(p)) {
    mkdirSync(CACHE, { recursive: true });
    console.log(`fetching ${url} (DuckDB extension, once)`);
    // --compressed: the repository serves them Brotli-encoded; the pin is of the decoded bytes.
    writeFileSync(p, execFileSync('curl', ['-sSfL', '--compressed', url], { maxBuffer: 2 ** 26 }));
  }
  const bytes = readFileSync(p);
  if (sha(bytes) !== hash) throw new Error(`${p} differs from its pinned SHA-256; delete it to fetch again, or update build-duckdb.mjs EXTENSIONS after checking`);
  return [name, bytes];
}

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

export async function buildDuckdb(out) {
  const v = JSON.parse(readFileSync(DIR + 'package.json', 'utf8')).version;
  if (v !== DUCKDB.version) throw new Error(`@duckdb/duckdb-wasm ${v} in node_modules; build-duckdb.mjs pins ${DUCKDB.version}`);
  for (const [f, h] of Object.entries(DUCKDB.sha256)) if (sha(readFileSync(DIR + f)) !== h) throw new Error(`${DIR}${f} differs from its pinned SHA-256`);
  const worker = await bundleWorker('src/duckdb/worker.ts', REWRITES, { alias: { 'duckdb-wasm-blocking': `./${DIR}dist/duckdb-browser-blocking.mjs` } });
  const exts = EXTENSIONS.map(extension);
  const wasm = rewriteBytes(readFileSync(DIR + 'dist/duckdb-eh.wasm'), WASM_REWRITES, 'duckdb-eh.wasm');
  assertNoCdn(wasm.toString('latin1'), 'duckdb-eh.wasm');
  for (const [name, b] of exts) assertNoCdn(b.toString('latin1'), `${name} extension`);
  const notice = Buffer.from(`BayLeaf Pouch's duckdb runtime: @duckdb/duckdb-wasm ${DUCKDB.version} (https://github.com/duckdb/duckdb-wasm),
DuckDB ${DUCKDB.engine}, and its parquet and json extensions (https://github.com/duckdb/duckdb), MIT.
The npm package ships no license file; DuckDB's LICENSE reads:

Copyright 2018-2025 Stichting DuckDB Foundation

${MIT}

DuckDB vendors third-party components under their own licenses (listed in its
source tree, third_party/); see https://github.com/duckdb/duckdb/tree/${DUCKDB.engine}/third_party.

==> apache-arrow (bundled in worker.js) <==
${readFileSync('node_modules/apache-arrow/LICENSE.txt', 'utf8').trim()}

${readFileSync('node_modules/apache-arrow/NOTICE.txt', 'utf8').trim()}
`);
  return writeRuntime(out, 'duckdb', [
    { name: 'worker.js', role: 'worker', bytes: worker },
    { name: 'duckdb-eh.wasm', role: 'wasm', bytes: wasm },
    { name: 'extensions.pack', role: 'data', bytes: pack(exts) },
    { name: 'NOTICE.txt', role: 'license', bytes: notice },
  ]);
}
