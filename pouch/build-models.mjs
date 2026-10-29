// build.mjs --with-models: the Local lane's static artifact under dist/models/<id>/.
//
// Every file (model files from fetch-models.mjs, the ORT wasm from npm) is cut
// into parts of at most PART_MAX bytes, each named by its own SHA-256, so each
// fits Cloudflare Static Assets' 25 MiB per-file limit with margin and can be
// cached as immutable. The Transformers.js + ORT worker is bundled into one
// script. manifest.<hash>.json lists every part in order with its hash, and
// each whole file's size and hash; the page embeds the manifest's SHA-256
// (define LOCAL_MODEL) and so trusts exactly these bytes and nothing else.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureModels, sha256File } from './fetch-models.mjs';

export const PART_MAX = 20 * 2 ** 20; // Cloudflare's per-file limit is 25 MiB
const sha = (b) => createHash('sha256').update(b).digest('hex');

export async function buildModels(out) {
  const lock = JSON.parse(readFileSync('models.lock.json', 'utf8'));
  const paths = await ensureModels({ log: () => {} });
  // The runtime comes from npm; package-lock.json pins it, the lock records what was qualified.
  const rt = lock.runtime;
  const tjs = JSON.parse(readFileSync('node_modules/@huggingface/transformers/package.json', 'utf8')).version;
  const ortv = JSON.parse(readFileSync('node_modules/onnxruntime-web/package.json', 'utf8')).version;
  if (tjs !== rt['@huggingface/transformers'].version || ortv !== rt['onnxruntime-web'].version) throw new Error(`npm runtime ${tjs}/${ortv} differs from models.lock.json`);
  if (await sha256File('node_modules/@huggingface/transformers/' + rt['@huggingface/transformers'].file) !== rt['@huggingface/transformers'].sha256) throw new Error('Transformers.js dist hash differs from models.lock.json');
  const wasm = rt['onnxruntime-web'].files[0];
  if (await sha256File('node_modules/' + wasm.npm) !== wasm.sha256) throw new Error('ORT wasm hash differs from models.lock.json');

  const worker = Buffer.from((await build({ entryPoints: ['src/local/worker.js'], bundle: true, minify: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'inline', logLevel: 'warning' })).outputFiles[0].contents);

  const sums = [], defines = [];
  for (const m of lock.models) {
    const dir = join(out, 'models', m.id), rel = `models/${m.id}/`;
    mkdirSync(dir, { recursive: true });
    const keep = new Set();
    const put = (name, bytes, hash = sha(bytes)) => {
      const p = join(dir, name);
      if (!existsSync(p) || statSync(p).size !== bytes.length) writeFileSync(p, bytes);
      keep.add(name); sums.push([hash, rel + name]);
      return hash;
    };
    // Split a file into parts, checking it against the lock as it is read.
    const split = (path, f, role) => {
      const fd = openSync(path, 'r'), whole = createHash('sha256'), parts = [];
      try {
        for (let at = 0; at < f.bytes; at += PART_MAX) {
          const buf = Buffer.alloc(Math.min(PART_MAX, f.bytes - at));
          if (readSync(fd, buf, 0, buf.length, at) !== buf.length) throw new Error(`${path}: short read`);
          whole.update(buf);
          const h = sha(buf);
          put(`${h}.bin`, buf, h);
          parts.push({ path: `${h}.bin`, bytes: buf.length, sha256: h });
        }
      } finally { closeSync(fd); }
      if (whole.digest('hex') !== f.sha256) throw new Error(`${f.name}: SHA-256 differs from models.lock.json`);
      return { name: f.name, role, bytes: f.bytes, sha256: f.sha256, parts };
    };
    const workerName = `worker.${sha(worker).slice(0, 16)}.js`;
    put(workerName, worker);
    const manifest = {
      format: 1, id: m.id, label: m.label, repo: m.repo, revision: m.revision, dtype: m.dtype,
      runtime: { transformers: tjs, onnxruntime: ortv },
      partMax: PART_MAX,
      worker: { path: workerName, bytes: worker.length, sha256: sha(worker) },
      files: [split('node_modules/' + wasm.npm, wasm, 'wasm'), ...m.files.map((f) => split(paths[m.id][f.name], f, 'model'))],
    };
    manifest.totalBytes = manifest.worker.bytes + manifest.files.reduce((n, f) => n + f.bytes, 0);
    const mbytes = Buffer.from(JSON.stringify(manifest, null, 1) + '\n');
    const mhash = sha(mbytes), mname = `manifest.${mhash.slice(0, 16)}.json`;
    put(mname, mbytes, mhash);
    for (const n of readdirSync(dir)) if (!keep.has(n)) rmSync(join(dir, n), { force: true }); // stale parts
    const count = keep.size;
    console.log(`${rel}  ${count} files, ${(manifest.totalBytes / 2 ** 30).toFixed(3)} GiB, largest ${(Math.max(...[...keep].map((n) => statSync(join(dir, n)).size)) / 2 ** 20).toFixed(1)} MiB`);
    defines.push({ id: m.id, label: m.label, revision: m.revision, dir: rel, manifest: mname, sha256: mhash, bytes: manifest.totalBytes });
  }
  return { sums, local: defines[0] ?? null };
}
