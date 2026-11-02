// Fetch the Parakeet TDT 0.6B v3 files this spike compares into the model cache
// outside the repo (like fetch-models.mjs), straight from Hugging Face at one
// pinned revision. Only this script talks to Hugging Face; the spike page reads
// the cached files from a local server. Hashes: the Hub's LFS SHA-256 (weights)
// and the repository's asrjs-manifest.json (vocab, config).
//
//   node experiments/parakeet-webgpu/fetch.mjs [--all]   (--all adds the int8 encoder and fp16 decoder)
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const REPO = 'ysdede/parakeet-tdt-0.6b-v3-onnx';
export const REVISION = 'e5356bf6e24bdb7a269536b0e9e7869bc034b893';
export const DIR = join(process.env.POUCH_MODEL_CACHE ?? join(homedir(), '.cache/bayleaf-pouch/models'), 'parakeet-tdt-0.6b-v3', REVISION);
export const FILES = [
  ['config.json', 101, '562aedb0b804acbeb4e04215de190846c37e0bb239b696376df69d555785373a'],
  ['vocab.txt', 102132, 'ba8e4007c65f4bb4358ffe2ecc13d9ccc7a10351151065242b5c3a943e685742'],
  ['decoder_joint-model.int8.onnx', 18202004, 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70'],
  ['encoder-model.fp16.onnx', 1238960452, 'a2bdeeb99cb7e5548818e823127b33854dd0c26f5d0c8da91effdd895ea0e717'],
];
export const EXTRA = [
  ['encoder-model.int8.onnx', 652183999, '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09'],
  ['decoder_joint-model.fp16.onnx', 36266140, 'b33a73b7c1d71b9d5a0911f5cb478be3dcbf79f53355c531ab1cd1dcd68ad8ef'],
];

const sha = async (p) => { const h = createHash('sha256'); for await (const b of createReadStream(p, { highWaterMark: 8 << 20 })) h.update(b); return h.digest('hex'); };

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(DIR, { recursive: true });
  for (const [name, bytes, hash] of [...FILES, ...(process.argv.includes('--all') ? EXTRA : [])]) {
    const dest = join(DIR, name);
    if (existsSync(dest) && statSync(dest).size === bytes && await sha(dest) === hash) { console.log(`ok      ${name}`); continue; }
    const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${name}`;
    console.log(`fetch   ${name} (${(bytes / 2 ** 20).toFixed(1)} MiB)`);
    const t0 = Date.now(), r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    mkdirSync(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(r.body), createWriteStream(dest + '.part'));
    renameSync(dest + '.part', dest);
    if (statSync(dest).size !== bytes || await sha(dest) !== hash) { rmSync(dest); throw new Error(`${name}: size or SHA-256 mismatch; removed`); }
    console.log(`ok      ${name} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  console.log(DIR);
}
