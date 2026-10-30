// Deploy a prebuilt artifact, never a moving source tree. No credentials enter assets.
// node build.mjs [--with-models] && node deploy.mjs [--check] [path/to/dist]
// --check stops after verifying and staging: nothing is published.
// The artifact is exactly the files SHA256SUMS lists: pouch.html, the app shell
// (sw.js, manifest, icons), and with --with-models the Local lane's
// dist/models/<id>/ (manifest, worker, parts).
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');
const source = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || join(root, 'dist'));
const html = readFileSync(join(source, 'pouch.html'));
const hash = createHash('sha256').update(html).digest('hex');
const manifest = readFileSync(join(source, 'SHA256SUMS'), 'utf8');
const listed = manifest.trimEnd().split('\n').map((l) => l.match(/^([0-9a-f]{64})  (\S+)$/)?.slice(1));
if (listed.some((x) => !x) || listed[0][1] !== 'pouch.html' || listed[0][0] !== hash) throw new Error('Artifact checksum mismatch');
// Allowlist: only these shapes may be uploaded, each within Cloudflare Static
// Assets' 25 MiB per-file limit, and few enough files for any plan.
const FILE_MAX = 25 * 2 ** 20, FILES_MAX = 20_000;
const SHELL = ['sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
const SHAPES = [/^pouch\.html$/, /^sw\.js$/, /^manifest\.webmanifest$/, /^icons\/[a-z0-9-]+\.png$/, /^models\/[a-z0-9.-]+\/manifest\.[0-9a-f]{16}\.json$/, /^models\/[a-z0-9.-]+\/worker\.[0-9a-f]{16}\.js$/, /^models\/[a-z0-9.-]+\/[0-9a-f]{64}\.bin$/];
if (listed.length + 3 > FILES_MAX) throw new Error(`Too many files: ${listed.length}`);
const files = listed.map(([sha, path]) => {
  if (!SHAPES.some((re) => re.test(path)) || new Set(listed.map((x) => x[1])).size !== listed.length) throw new Error(`Not an allowed artifact path: ${path}`);
  const bytes = readFileSync(join(source, path));
  if (bytes.length > FILE_MAX) throw new Error(`${path} is over 25 MiB`);
  if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error(`Checksum mismatch: ${path}`);
  if (path.endsWith('.bin') && !path.endsWith(`/${sha}.bin`)) throw new Error(`Part name is not its hash: ${path}`);
  if (/\/(manifest|worker)\./.test(path) && !path.includes(`.${sha.slice(0, 16)}.`)) throw new Error(`Name is not its hash: ${path}`);
  return { path, sha, size: bytes.length };
});
// The page must embed the manifest it ships with (build-models.mjs define LOCAL_MODEL).
for (const f of files.filter((x) => x.path.includes('/manifest.'))) {
  if (!html.includes(f.sha)) throw new Error(`pouch.html does not trust ${f.path}`);
  const m = JSON.parse(readFileSync(join(source, f.path), 'utf8'));
  const dir = f.path.slice(0, f.path.lastIndexOf('/') + 1);
  for (const part of [m.worker, ...m.files.flatMap((x) => x.parts)]) {
    const row = files.find((x) => x.path === dir + part.path);
    if (!row || row.sha !== part.sha256 || row.size !== part.bytes) throw new Error(`Manifest part missing or different: ${dir}${part.path}`);
  }
}
const modelFiles = files.filter((f) => f.path.startsWith('models/'));
// The offline copy pins every shell file, and the page shows whether the
// served worker is the one it was built with: all must ship, and agree.
const shellFiles = files.filter((f) => !f.path.startsWith('models/') && f.path !== 'pouch.html');
if (SHELL.some((p) => !shellFiles.find((f) => f.path === p))) throw new Error('App shell file missing from SHA256SUMS');
if (!html.includes(files.find((f) => f.path === 'sw.js').sha)) throw new Error('pouch.html does not expect this sw.js');
const text = html.toString('utf8');
const csp = text.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
if (!csp || !csp.includes("connect-src 'self' https://api.bayleaf.dev;") || /script-src[^;]*'unsafe-(inline|eval|hashes)'/.test(csp)
  || !csp.includes("worker-src 'self' blob:;") || !csp.includes("manifest-src 'self';") || !csp.includes("img-src 'self' data: blob:;") || !csp.startsWith("default-src 'none';"))
  throw new Error('Unexpected CSP'); // 'wasm-unsafe-eval' (QuickJS, ONNX Runtime) is expected; JS eval is not
// worker-src 'self' is for /sw.js only; manifest-src 'self' for /manifest.webmanifest.
const scripts = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const expected = scripts.map(([, body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
if (!scripts.length || csp.match(/script-src ([^;]+)/)?.[1] !== expected.join(' ') + " 'wasm-unsafe-eval'")
  throw new Error('Script hash policy does not match scripts');

// Immutable local record for rollback and repeatable deploys of these exact bytes.
const snapshot = check ? mkdtempSync(join(tmpdir(), 'pouch-check-')) : join(root, '.deploy', hash);
mkdirSync(snapshot, { recursive: true });
writeFileSync(join(snapshot, 'pouch.html'), html);
writeFileSync(join(snapshot, 'SHA256SUMS'), manifest);
for (const f of shellFiles) { mkdirSync(dirname(join(snapshot, f.path)), { recursive: true }); copyFileSync(join(source, f.path), join(snapshot, f.path)); }
// Model parts are content-addressed: the snapshot keeps their list (SHA256SUMS);
// rebuild them with build.mjs --with-models from the pinned models.lock.json.
// Stage only allowlisted public files, outside the checkout and its Wrangler caches.
const staging = mkdtempSync(join(tmpdir(), 'pouch-static-'));
mkdirSync(join(staging, 'assets'));
writeFileSync(join(staging, 'assets/pouch.html'), html);
writeFileSync(join(staging, 'assets/SHA256SUMS'), manifest);
for (const f of [...shellFiles, ...modelFiles]) { mkdirSync(dirname(join(staging, 'assets', f.path)), { recursive: true }); copyFileSync(join(source, f.path), join(staging, 'assets', f.path)); }
writeFileSync(join(staging, 'assets/_redirects'), '/ /pouch.html 200\n');
// Rules for one path merge (same header: comma-joined), so Cache-Control is
// set per path, never on /*: the page and checksums are never cached; sw.js
// and the manifest are revalidated every time (no-cache), so a release reaches
// them at once; icons may be cached for a day; the content-hash-named model
// files are immutable.
writeFileSync(join(staging, 'assets/_headers'), `/
  Cache-Control: no-store, no-transform
/pouch.html
  Cache-Control: no-store, no-transform
/SHA256SUMS
  Cache-Control: no-store, no-transform
/sw.js
  Cache-Control: no-cache, no-transform
/manifest.webmanifest
  Cache-Control: no-cache, no-transform
/icons/*
  Cache-Control: public, max-age=86400
/models/*
  Cache-Control: public, max-age=31536000, immutable
/*
  NEL: {"max_age":0}
  Report-To: {"group":"cf-nel","max_age":0,"endpoints":[]}
  Content-Security-Policy: ${csp}; frame-ancestors 'none'; object-src 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000
  X-Robots-Tag: noindex
`);
const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
config.assets.directory = './assets';
writeFileSync(join(staging, 'wrangler.json'), JSON.stringify(config, null, 2));
copyFileSync(join(staging, 'assets/_headers'), join(snapshot, '_headers'));
copyFileSync(join(staging, 'assets/_redirects'), join(snapshot, '_redirects'));

if (check) {
  console.log(`Checked and staged ${files.length} files (${(files.reduce((n, f) => n + f.size, 0) / 2 ** 20).toFixed(0)} MiB, largest ${(Math.max(...files.map((f) => f.size)) / 2 ** 20).toFixed(1)} MiB) in ${staging}; not deployed (--check).`);
  process.exit(0);
}
// A real API read refreshes the approved BayLeaf cf OAuth login before private use.
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.account_id, WRANGLER_SEND_METRICS: 'false' };
delete env.CLOUDFLARE_API_TOKEN;
execFileSync('cf', ['pages', 'projects', 'list', '--profile', 'ucsc'], { env, stdio: 'ignore' });
const auth = JSON.parse(readFileSync(join(homedir(), 'Library/Preferences/cloudflare/config/ucsc.json'), 'utf8'));
env.CLOUDFLARE_API_TOKEN = auth.oauth_token;
console.log(`Experimental static deployment: SHA256 ${hash}; ${files.length} files, ${(files.reduce((n, f) => n + f.size, 0) / 2 ** 20).toFixed(0)} MiB`);
console.log(`Rollback artifact: ${snapshot}`);
execFileSync('wrangler', ['deploy', '--config', join(staging, 'wrangler.json')], { cwd: staging, env, stdio: 'inherit' });
// Right after a deploy the edge can serve the previous release, or a wrong model
// part, for under a minute, so byte mismatches are retried before failing.
const settle = async (label, attempt) => {
  if (attempt === 6) throw new Error(`Served bytes differ after ${attempt} attempts: ${label}`);
  console.log(`Served bytes differ: ${label}; retrying in 15 s (attempt ${attempt})`);
  await new Promise((resolve) => setTimeout(resolve, 15000));
};
for (const path of ['/', '/pouch.html', '/SHA256SUMS']) {
  let response;
  for (let attempt = 1; ; attempt++) {
    response = await fetch(`https://pouch.bayleaf.dev${path}`, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    const body = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || response.headers.has('set-cookie')) throw new Error(`Unexpected response: ${path}`);
    if (response.headers.get('nel') !== '{"max_age":0}' || response.headers.get('cache-control') !== 'no-store, no-transform')
      throw new Error(`Unexpected reporting/cache policy: ${path}`);
    if (path === '/SHA256SUMS' ? body.toString() === manifest : body.equals(html)) break;
    await settle(path, attempt);
  }
  if (!response.headers.get('content-security-policy')?.startsWith(csp)) throw new Error(`CSP mismatch: ${path}`);
  console.log(`Verified HTTPS ${path}: 200, exact bytes, no cookies, NEL disabled`);
}
// Model files: every one downloaded and hashed (about 1 GB), with immutable
// caching. A size check by HEAD is not possible: Cloudflare omits
// Content-Length on HEAD for cached assets and ignores Range on them.
const verifyModelFile = async (f) => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://pouch.bayleaf.dev/${f.path}`, { signal: AbortSignal.timeout(120000), redirect: 'error' });
    if (response.status !== 200 || response.headers.has('set-cookie') || response.headers.get('cache-control') !== 'public, max-age=31536000, immutable')
      throw new Error(`Unexpected response or cache policy: /${f.path}`);
    if (createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') === f.sha) return;
    await settle(`/${f.path}`, attempt);
  }
};
const queue = [...modelFiles];
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await verifyModelFile(queue.shift()); }));
for (const f of shellFiles) {
  const response = await fetch(`https://pouch.bayleaf.dev/${f.path}`, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  const body = Buffer.from(await response.arrayBuffer());
  const cache = f.path.startsWith('icons/') ? 'public, max-age=86400' : 'no-cache, no-transform';
  if (response.status !== 200 || response.headers.has('set-cookie') || response.headers.get('cache-control') !== cache)
    throw new Error(`Unexpected response or cache policy: /${f.path}`);
  if (createHash('sha256').update(body).digest('hex') !== f.sha) throw new Error(`Served bytes differ: /${f.path}`);
}
console.log(`Verified ${shellFiles.length} app shell files: exact bytes, cache policy`);
if (modelFiles.length) console.log(`Verified ${modelFiles.length} model files: immutable and byte-exact`);
