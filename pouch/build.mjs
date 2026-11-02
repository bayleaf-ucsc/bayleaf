// Build dist/pouch.html: one self-contained file you can save and open.
//
//   cd pouch && npm ci && node build.mjs [--watch] [--walkthrough]
//
// Bundles src/main.ts (the app, the pinned Tinfoil SDK, just-bash, pi-durable
// and CodeMirror; package-lock.json is the supply-chain pin) into the one
// inline script, stamps the CSP with the SHA-256 of each inline script so
// nothing else can run, and prints the file's SHA-256 for a release.
import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assertArchitecture, checkArchitecture, checkMetafile, checkNoCdn, loadTree } from './arch.mjs';

const sha256 = (s, enc) => createHash('sha256').update(s).digest(enc);
const watch = process.argv.includes('--watch');
const OUT = process.env.POUCH_OUT ?? 'dist'; // a scratch directory, to test a build before it replaces dist/

// Shown in the trust dialog: the commit this was built from (marked +dirty if
// pouch/ had uncommitted changes) and the UTC date. Outside the script, so the
// CSP hashes do not depend on it; the file hash does.
function buildId() {
  const git = (args) => { try { return execSync('git ' + args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const commit = git('rev-parse --short HEAD') || 'unknown';
  const dirty = git("status --porcelain -- . ':!dist'") ? '+dirty' : '';
  return `${commit}${dirty} ${new Date().toISOString().slice(0, 10)}`;
}
const BUILD_ID = buildId();

// The installable app shell around pouch.html, copied as is (viewer.html is
// the report viewer, README "HTML reports") (icons/make-icons.py
// regenerates the PNGs). sw.js does not depend on the page, so its hash can be
// built into the page, which shows whether the served worker is this one.
const STATIC = ['sw.js', 'viewer.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
const SW_SHA256 = sha256(readFileSync('sw.js'), 'hex');

// The trust boundaries and module structure (arch.mjs, README "Architecture"):
// checked on the sources before anything is built, and on the bundle below.
assertArchitecture(checkArchitecture(loadTree()));

// The types (tsc --noEmit, strict): esbuild only strips them, so this is where
// they are checked. The page and the workers have different globals, hence
// two projects. --watch skips it (run `npm run typecheck` alongside).
if (!watch) {
  const tsc = (p) => spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', p], { stdio: 'inherit' }).status;
  if (tsc('tsconfig.json') || tsc('tsconfig.worker.json')) { console.error('Pouch type check failed (tsc)'); process.exit(1); }
}

function assemble(code) {
  // An inline script ends at the first "</script", wherever it appears.
  const app = code.replaceAll('</script', '<\\/script');
  let html = readFileSync('pouch.html', 'utf8').replace('<script>/*APP*/</script>', () => `<script>${app}</script>`);
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(([, body]) => `'sha256-${sha256(body, 'base64')}'`);
  html = html.replace('__SCRIPT_HASHES__', hashes.join(' ')).replaceAll('__BUILD_ID__', BUILD_ID);
  const cdn = checkNoCdn(html, 'pouch.html');
  if (cdn.length) { console.error(cdn.join('\n')); process.exitCode = 1; return; }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/pouch.html`, html);
  mkdirSync(`${OUT}/icons`, { recursive: true });
  for (const f of STATIC) copyFileSync(f, `${OUT}/${f}`);
  // The whole deployable artifact is the files SHA256SUMS lists: pouch.html
  // (first), the app shell, plus dist/runtime/** (deploy.mjs uploads exactly
  // these). Model weights are not in it: they come from the BayLeaf HF gateway. sha256sum -c SHA256SUMS checks a downloaded or
  // served copy against the build; the offline copy checks itself against it.
  const sums = [[sha256(html, 'hex'), 'pouch.html'], ...STATIC.map((f) => [sha256(readFileSync(f), 'hex'), f]), ...(models?.sums ?? []), ...(parakeet?.sums ?? []), ...pdf.sums, ...libav.sums, ...duckdb.sums];
  writeFileSync(`${OUT}/SHA256SUMS`, sums.map(([h, p]) => `${h}  ${p}\n`).join(''));
  console.log(`${OUT}/pouch.html  ${(html.length / 1024).toFixed(0)} KiB  ${hashes.length} inline script(s)`);
  console.log(`sha256 ${sha256(html, 'hex')}  build ${BUILD_ID}`);
}

// The `run` tool's worker (QuickJS with its wasm inline) is bundled first and
// becomes a string constant in the app, so the page keeps one inline script.
// Rebuilt only at start: restart --watch after editing src/run/worker*.js.
// Its metafile is checked like the app's: every first-party input was scanned.
const worker = await build({ entryPoints: ['src/run/worker-browser.ts'], bundle: true, minify: true, write: false, metafile: true,
  format: 'iife', platform: 'browser', target: 'es2022', legalComments: 'inline', logLevel: 'warning' });
assertArchitecture(checkMetafile(worker.metafile));
const WORKER_SRC = worker.outputFiles[0].text;

// The Transformers.js provider: its runtime under dist/runtime/transformers/
// and the model's pins (build-models.mjs; weights come from the BayLeaf HF
// gateway at run time, so the build needs none). --no-models builds without
// it: LOCAL_MODEL null, no Transformers.js provider. (--with-models, which
// once put 1.1 GB of weights in dist/, is accepted and does nothing more.)
const models = process.argv.includes('--no-models') ? null : await (await import('./build-models.mjs')).buildModels(OUT);

// The speech-to-text runtime (build-parakeet.mjs) under dist/runtime/parakeet/ and
// the Parakeet model's pins; --no-models leaves it out too (POUCH_PARAKEET null).
const parakeet = process.argv.includes('--no-models') ? null : await (await import('./build-parakeet.mjs')).buildParakeet(OUT);

// The pdf.js runtime (build-pdf.mjs) under dist/runtime/pdf/: the page embeds
// its manifest's SHA-256 and fetches it only when a pdf command first runs.
const pdf = await (await import('./build-pdf.mjs')).buildPdf(OUT);

// The libav.js runtime (build-libav.mjs) under dist/runtime/libav/, the same way; and
// its LGPL corresponding source under dist/runtime/libav-source/, which the page names but never fetches.
const libav = await (await import('./build-libav.mjs')).buildLibav(OUT);

// The DuckDB-Wasm runtime (build-duckdb.mjs) under dist/runtime/duckdb/: the asked
// add-on, so the page fetches it only when the person installs it.
const duckdb = await (await import('./build-duckdb.mjs')).buildDuckdb(OUT);

const ctx = await context({
  entryPoints: ['src/main.ts'],
  bundle: true, minify: !watch, write: false, metafile: true,
  define: { WORKER_SRC: JSON.stringify(WORKER_SRC), LOCAL_MODEL: JSON.stringify(models?.local ?? null), SW_SHA256: JSON.stringify(SW_SHA256), POUCH_PDF_RUNTIME: JSON.stringify(pdf.pin),
    POUCH_LIBAV_RUNTIME: JSON.stringify(libav.pin), POUCH_LIBAV_SOURCE: JSON.stringify(libav.source), POUCH_PARAKEET: JSON.stringify(parakeet?.pin ?? null),
    POUCH_DUCKDB_RUNTIME: JSON.stringify(duckdb.pin) },
  format: 'iife', platform: 'browser', target: 'es2022',
  // just-bash's browser build imports node:zlib for gzip/tar -z; those commands
  // fail at call time instead. Other Node-only paths are behind dynamic imports.
  // decode-named-character-reference's browser build decodes entities via
  // innerHTML; the table-based build keeps reply text out of the HTML parser.
  alias: { 'node:zlib': './src/shims/zlib.ts', zlib: './src/shims/zlib.ts',
    'decode-named-character-reference': './node_modules/decode-named-character-reference/index.js' },
  legalComments: 'inline',
  logLevel: 'warning',
  plugins: [{ name: 'assemble', setup(b) { b.onEnd((r) => {
    if (r.errors.length) return;
    // Watching, the sources may have changed since the first check.
    const errors = [...(watch ? checkArchitecture(loadTree()) : []), ...checkMetafile(r.metafile)];
    if (errors.length) { console.error(`Pouch architecture check failed (arch.mjs):\n  ${errors.join('\n  ')}`); process.exitCode = 1; return; }
    assemble(r.outputFiles[0].text);
  }); } }],
});
if (watch) { await ctx.watch(); console.log('watching src/ and pouch.html (reload the page after each build)'); }
else { await ctx.rebuild(); await ctx.dispose(); }

// --walkthrough: then refresh WALKTHROUGH.md's screenshots and statuses
// (walkthrough.mjs bundles its own copy of src/ with a scripted fake model).
if (process.argv.includes('--walkthrough') && !watch) {
  process.exitCode = spawnSync(process.execPath, ['walkthrough.mjs'], { stdio: 'inherit' }).status ?? 1;
}
