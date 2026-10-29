// Fetch the Local lane's pinned model files into a cache outside the repo and
// check them against models.lock.json. Weights never enter git or the repo tree.
//
//   node fetch-models.mjs            (cache: ~/.cache/bayleaf-pouch/models, or $POUCH_MODEL_CACHE)
//
// An existing copy (the cache, or the LFM3 experiment's gitignored assets/) is
// reused when its SHA-256 matches; otherwise the file is downloaded from its
// pinned Hugging Face revision URL. Anything that does not match is refused.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = dirname(fileURLToPath(import.meta.url));
export const CACHE = process.env.POUCH_MODEL_CACHE ?? join(homedir(), '.cache/bayleaf-pouch/models');
const EXPERIMENT = join(root, 'experiments/lfm3-webgpu/qualification/assets/model');
const lock = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'models.lock.json'), 'utf8'));

export async function sha256File(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path, { highWaterMark: 8 << 20 }), async function* (src) { for await (const b of src) h.update(b); });
  return h.digest('hex');
}
const ok = async (path, f) => existsSync(path) && statSync(path).size === f.bytes && await sha256File(path) === f.sha256;

// Path of a verified copy of each model file: { [modelId]: { [name]: path } }.
export async function ensureModels({ log = console.log } = {}) {
  const out = {};
  for (const m of lock.models) {
    out[m.id] = {};
    for (const f of m.files) {
      const dest = join(CACHE, m.id, m.revision, f.name);
      mkdirSync(dirname(dest), { recursive: true });
      if (!(await ok(dest, f))) {
        rmSync(dest, { force: true });
        const local = join(EXPERIMENT, f.name);
        if (m.id === 'lfm3-1.7b-q4f16' && await ok(local, f)) { linkSync(local, dest); log(`linked  ${f.name} (experiment copy)`); }
        else {
          log(`fetch   ${f.name} (${(f.bytes / 2 ** 20).toFixed(1)} MiB) from ${new URL(f.url).host}`);
          const r = await fetch(f.url, { redirect: 'follow' });
          if (!r.ok) throw new Error(`${f.url}: HTTP ${r.status}`);
          await pipeline(Readable.fromWeb(r.body), createWriteStream(dest + '.part'));
          renameSync(dest + '.part', dest);
          if (!(await ok(dest, f))) { rmSync(dest, { force: true }); throw new Error(`${f.name}: size or SHA-256 does not match models.lock.json; removed`); }
        }
      }
      out[m.id][f.name] = dest;
    }
    log(`ok      ${m.id} @ ${m.revision.slice(0, 12)}: ${m.files.length} files verified in ${join(CACHE, m.id)}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await ensureModels();
