// The Transformers.js provider's build inputs (build.mjs runs this unless --no-models).
//
// Weights are not in the artifact: the page downloads them from the BayLeaf HF
// gateway (api.bayleaf.dev/hf) and checks every file against models.lock.json
// (src/models.ts), so building needs no model files at all. What ships is the
// runtime, under dist/runtime/transformers/ (build-runtime.mjs): the
// Transformers.js + ORT WebGPU worker bundle and the ORT wasm, both from npm
// and checked against the lock's runtime hashes. The define LOCAL_MODEL gives
// the page the model's pins and the runtime manifest's SHA-256.
import { readFileSync } from 'node:fs';
import { sha256File } from './fetch-models.mjs';
import { bundleWorker, writeRuntime } from './build-runtime.mjs';
import { GATEWAY } from './src/models.ts';

// Library defaults rewritten so nothing in the bundle points at a CDN or the Hub.
// The worker never uses either (no fetch; wasm handed in; allowRemoteModels false).
const REWRITES = [
  [/remoteHost:"https:\/\/huggingface\.co\/"/g, `remoteHost:"${GATEWAY}/"`, 1],
  [/`https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\$\{[^}`]+\}\/dist\/`/g, '"./"', 1],
];

export async function buildModels(out) {
  const lock = JSON.parse(readFileSync('models.lock.json', 'utf8'));
  const rt = lock.runtime;
  const tjs = JSON.parse(readFileSync('node_modules/@huggingface/transformers/package.json', 'utf8')).version;
  const ortv = JSON.parse(readFileSync('node_modules/onnxruntime-web/package.json', 'utf8')).version;
  if (tjs !== rt['@huggingface/transformers'].version || ortv !== rt['onnxruntime-web'].version) throw new Error(`npm runtime ${tjs}/${ortv} differs from models.lock.json`);
  if (await sha256File('node_modules/@huggingface/transformers/' + rt['@huggingface/transformers'].file) !== rt['@huggingface/transformers'].sha256) throw new Error('Transformers.js dist hash differs from models.lock.json');
  const wasm = rt['onnxruntime-web'].files[0];
  if (await sha256File('node_modules/' + wasm.npm) !== wasm.sha256) throw new Error('ORT wasm hash differs from models.lock.json');

  const worker = await bundleWorker('src/local/worker.ts', REWRITES);
  const { sums, pin } = writeRuntime(out, 'transformers', [
    { name: 'worker.js', role: 'worker', bytes: worker },
    { name: wasm.name, role: 'wasm', bytes: readFileSync('node_modules/' + wasm.npm) },
  ]);
  const m = lock.models[0];
  if (!m) return { sums, local: null };
  const files = m.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
  const local = { id: m.id, label: m.label, repo: m.repo, revision: m.revision, dtype: m.dtype, license: m.license,
    files, bytes: files.reduce((n, f) => n + f.bytes, 0), runtime: pin };
  return { sums, local };
}
