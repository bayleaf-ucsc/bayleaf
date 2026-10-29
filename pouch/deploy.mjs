// Deploy a prebuilt artifact, never a moving source tree. No credentials enter assets.
// node build.mjs && node deploy.mjs [path/to/dist]
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] || join(root, 'dist'));
const html = readFileSync(join(source, 'pouch.html'));
const hash = createHash('sha256').update(html).digest('hex');
const manifest = readFileSync(join(source, 'SHA256SUMS'), 'utf8');
if (manifest !== `${hash}  pouch.html\n`) throw new Error('Artifact checksum mismatch');
const text = html.toString('utf8');
const csp = text.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
if (!csp || !csp.includes("connect-src https://api.bayleaf.dev;") || /script-src[^;]*unsafe/.test(csp))
  throw new Error('Unexpected CSP');
const scripts = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const expected = scripts.map(([, body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
if (!scripts.length || csp.match(/script-src ([^;]+)/)?.[1] !== expected.join(' '))
  throw new Error('Script hash policy does not match scripts');

// Immutable local record for rollback and repeatable deploys of these exact bytes.
const snapshot = join(root, '.deploy', hash);
mkdirSync(snapshot, { recursive: true });
writeFileSync(join(snapshot, 'pouch.html'), html);
writeFileSync(join(snapshot, 'SHA256SUMS'), manifest);
// Stage only allowlisted public files, outside the checkout and its Wrangler caches.
const staging = mkdtempSync(join(tmpdir(), 'pouch-static-'));
mkdirSync(join(staging, 'assets'));
writeFileSync(join(staging, 'assets/pouch.html'), html);
writeFileSync(join(staging, 'assets/SHA256SUMS'), manifest);
writeFileSync(join(staging, 'assets/_redirects'), '/ /pouch.html 200\n');
writeFileSync(join(staging, 'assets/_headers'), `/*
  NEL: {"max_age":0}
  Report-To: {"group":"cf-nel","max_age":0,"endpoints":[]}
  Cache-Control: no-store, no-transform
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

// A real API read refreshes the approved BayLeaf cf OAuth login before private use.
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.account_id, WRANGLER_SEND_METRICS: 'false' };
delete env.CLOUDFLARE_API_TOKEN;
execFileSync('cf', ['pages', 'projects', 'list', '--profile', 'ucsc'], { env, stdio: 'ignore' });
const auth = JSON.parse(readFileSync(join(homedir(), 'Library/Preferences/cloudflare/config/ucsc.json'), 'utf8'));
env.CLOUDFLARE_API_TOKEN = auth.oauth_token;
console.log(`Experimental static deployment: SHA256 ${hash}`);
console.log(`Rollback artifact: ${snapshot}`);
execFileSync('wrangler', ['deploy', '--config', join(staging, 'wrangler.json')], { cwd: staging, env, stdio: 'inherit' });
for (const path of ['/', '/pouch.html', '/SHA256SUMS']) {
  const response = await fetch(`https://pouch.bayleaf.dev${path}`, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  const body = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200 || response.headers.has('set-cookie')) throw new Error(`Unexpected response: ${path}`);
  if (response.headers.get('nel') !== '{"max_age":0}' || response.headers.get('cache-control') !== 'no-store, no-transform')
    throw new Error(`Unexpected reporting/cache policy: ${path}`);
  if (path === '/SHA256SUMS' ? body.toString() !== manifest : !body.equals(html))
    throw new Error(`Served bytes differ: ${path}`);
  if (!response.headers.get('content-security-policy')?.startsWith(csp)) throw new Error(`CSP mismatch: ${path}`);
  console.log(`Verified HTTPS ${path}: 200, exact bytes, no cookies, NEL disabled`);
}
