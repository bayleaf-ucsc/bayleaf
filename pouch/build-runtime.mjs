// The tool-runtime convention: how any heavy in-browser tool (the Transformers.js
// model today; OCR, ASR, DuckDB, libav later) ships its runtime.
//
// - Its code runs in its own worker: one bundled script, same-origin, never a CDN.
// - Every runtime file (the worker, wasm, data) is cut into parts of at most
//   PART_MAX bytes named by their SHA-256 under dist/runtime/<group>/, listed in
//   SHA256SUMS, and described by manifest.<hash>.json; the page embeds that
//   manifest's SHA-256 and reassembles the files with src/assets.ts partAssets,
//   checking every part. Cloudflare Static Assets refuses files over 25 MiB.
// - Model weights are not runtime: they come from the BayLeaf HF gateway
//   (api.bayleaf.dev/hf), pinned in models.lock.json (src/models.ts).
// - No asset may default to a third-party host: library defaults that point at
//   a CDN or the Hub are rewritten at build (each rewrite must match exactly the
//   expected number of times), and assertNoCdn fails the build if any remain.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PART_MAX = 20 * 2 ** 20;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// URLs a runtime must never fetch by default. Documentation links in error
// messages (huggingface.co/docs/...) and bare hostnames are not fetch targets.
export const CDN = /https?:\/\/(?:[a-z0-9-]+\.)*(?:jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev|githubusercontent\.com|hf\.co|huggingface\.co(?!\/docs\/))|https?:\/\/cdn\.[a-z0-9.-]+/g;
export function assertNoCdn(text, name) {
  const hits = [...String(text).matchAll(CDN)].map((m) => m[0]);
  if (hits.length) throw new Error(`${name} defaults to a third-party host: ${[...new Set(hits)].join(', ')}`);
}

function rewrite(text, rewrites, name) {
  for (const [re, to, count] of rewrites) {
    const n = [...text.matchAll(re)].length;
    if (n !== count) throw new Error(`${name}: rewrite ${re} matched ${n} times, expected ${count} (did a dependency change?)`);
    text = text.replace(re, to);
  }
  return text;
}

// Bundle a worker entry; rewrites: [[RegExp, replacement, expectedCount]] on
// the minified bundle. sources: { 'path/suffix.mjs': rewrites } on a module's
// source before bundling (for code that minification would rename).
export async function bundleWorker(entry, rewrites = [], { sources = {} } = {}) {
  const hit = new Set();
  const plugins = Object.keys(sources).length ? [{ name: 'source-rewrites', setup(b) {
    b.onLoad({ filter: /\.m?js$/ }, async ({ path }) => {
      const key = Object.keys(sources).find((k) => path.replaceAll('\\', '/').endsWith(k));
      if (!key) return undefined;
      hit.add(key);
      const { readFile } = await import('node:fs/promises');
      return { contents: rewrite(await readFile(path, 'utf8'), sources[key], key), loader: 'js' };
    });
  } }] : [];
  let text = (await build({ entryPoints: [entry], bundle: true, minify: true, write: false, plugins,
    format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'inline', logLevel: 'warning' })).outputFiles[0].text;
  for (const k of Object.keys(sources)) if (!hit.has(k)) throw new Error(`${entry}: ${k} was never bundled, so its rewrites did not apply`);
  text = rewrite(text, rewrites, entry);
  assertNoCdn(text, entry);
  return Buffer.from(text);
}

// files: [{ name, role, bytes: Buffer }]. Writes dist/runtime/<group>/ and returns
// { sums: [[sha, path]], pin: { dir, manifest, sha256, bytes } } (pin is the page's define).
export function writeRuntime(out, group, files) {
  const rel = `runtime/${group}/`, dir = join(out, rel);
  mkdirSync(dir, { recursive: true });
  const keep = new Set(), sums = [];
  const put = (name, bytes, hash = sha(bytes)) => {
    const p = join(dir, name);
    if (!existsSync(p) || statSync(p).size !== bytes.length) writeFileSync(p, bytes);
    keep.add(name); sums.push([hash, rel + name]);
  };
  const manifest = { format: 2, group, partMax: PART_MAX, files: files.map(({ name, role, bytes }) => {
    const parts = [];
    for (let at = 0; at < bytes.length || at === 0; at += PART_MAX) {
      const b = bytes.subarray(at, at + PART_MAX), h = sha(b);
      put(`${h}.bin`, b, h); parts.push({ path: `${h}.bin`, bytes: b.length, sha256: h });
      if (!bytes.length) break;
    }
    return { name, role, bytes: bytes.length, sha256: sha(bytes), parts };
  }) };
  manifest.totalBytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
  const mbytes = Buffer.from(JSON.stringify(manifest, null, 1) + '\n'), mhash = sha(mbytes), mname = `manifest.${mhash.slice(0, 16)}.json`;
  put(mname, mbytes, mhash);
  for (const n of readdirSync(dir)) if (!keep.has(n)) rmSync(join(dir, n), { force: true }); // stale parts
  console.log(`${rel}  ${keep.size} files, ${(manifest.totalBytes / 2 ** 20).toFixed(1)} MiB, largest ${(Math.max(...[...keep].map((n) => statSync(join(dir, n)).size)) / 2 ** 20).toFixed(1)} MiB`);
  return { sums, pin: { dir: rel, manifest: mname, sha256: mhash, bytes: manifest.totalBytes } };
}
