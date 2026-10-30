// Build dist/pouch.html: one self-contained file you can save and open.
//
//   cd pouch && npm ci && node build.mjs [--watch]
//
// Bundles src/main.js (the app, the pinned Tinfoil SDK, just-bash, pi-durable
// and CodeMirror; package-lock.json is the supply-chain pin) into the one
// inline script, stamps the CSP with the SHA-256 of each inline script so
// nothing else can run, and prints the file's SHA-256 for a release.
import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

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

// The installable app shell around pouch.html, copied as is (icons/make-icons.py
// regenerates the PNGs). sw.js does not depend on the page, so its hash can be
// built into the page, which shows whether the served worker is this one.
const STATIC = ['sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
const SW_SHA256 = sha256(readFileSync('sw.js'), 'hex');

function assemble(code) {
  // An inline script ends at the first "</script", wherever it appears.
  const app = code.replaceAll('</script', '<\\/script');
  let html = readFileSync('pouch.html', 'utf8').replace('<script>/*APP*/</script>', () => `<script>${app}</script>`);
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(([, body]) => `'sha256-${sha256(body, 'base64')}'`);
  html = html.replace('__SCRIPT_HASHES__', hashes.join(' ')).replaceAll('__BUILD_ID__', BUILD_ID);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/pouch.html`, html);
  mkdirSync(`${OUT}/icons`, { recursive: true });
  for (const f of STATIC) copyFileSync(f, `${OUT}/${f}`);
  // The whole deployable artifact is the files SHA256SUMS lists: pouch.html
  // (first), the app shell, plus dist/models/** with --with-models (deploy.mjs
  // uploads exactly these). sha256sum -c SHA256SUMS checks a downloaded or
  // served copy against the build; the offline copy checks itself against it.
  const sums = [[sha256(html, 'hex'), 'pouch.html'], ...STATIC.map((f) => [sha256(readFileSync(f), 'hex'), f]), ...(models?.sums ?? [])];
  writeFileSync(`${OUT}/SHA256SUMS`, sums.map(([h, p]) => `${h}  ${p}\n`).join(''));
  console.log(`${OUT}/pouch.html  ${(html.length / 1024).toFixed(0)} KiB  ${hashes.length} inline script(s)`);
  console.log(`sha256 ${sha256(html, 'hex')}  build ${BUILD_ID}`);
}

// The `run` tool's worker (QuickJS with its wasm inline) is bundled first and
// becomes a string constant in the app, so the page keeps one inline script.
// Rebuilt only at start: restart --watch after editing src/run/worker*.js.
const WORKER_SRC = (await build({ entryPoints: ['src/run/worker-browser.js'], bundle: true, minify: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2022', legalComments: 'inline', logLevel: 'warning' })).outputFiles[0].text;

// --with-models: the Local lane's model, runtime and manifest under
// dist/models/ (build-models.mjs). The page embeds the manifest's hash; a
// build without it has LOCAL_MODEL null and offers no Local lane.
const models = process.argv.includes('--with-models') ? await (await import('./build-models.mjs')).buildModels(OUT) : null;

const ctx = await context({
  entryPoints: ['src/main.js'],
  bundle: true, minify: !watch, write: false,
  define: { WORKER_SRC: JSON.stringify(WORKER_SRC), LOCAL_MODEL: JSON.stringify(models?.local ?? null), SW_SHA256: JSON.stringify(SW_SHA256) },
  format: 'iife', platform: 'browser', target: 'es2022',
  // just-bash's browser build imports node:zlib for gzip/tar -z; those commands
  // fail at call time instead. Other Node-only paths are behind dynamic imports.
  // decode-named-character-reference's browser build decodes entities via
  // innerHTML; the table-based build keeps reply text out of the HTML parser.
  alias: { 'node:zlib': './src/shims/zlib.js', zlib: './src/shims/zlib.js',
    'decode-named-character-reference': './node_modules/decode-named-character-reference/index.js' },
  legalComments: 'inline',
  logLevel: 'warning',
  plugins: [{ name: 'assemble', setup(b) { b.onEnd((r) => { if (!r.errors.length) assemble(r.outputFiles[0].text); }); } }],
});
if (watch) { await ctx.watch(); console.log('watching src/ and pouch.html (reload the page after each build)'); }
else { await ctx.rebuild(); await ctx.dispose(); }
