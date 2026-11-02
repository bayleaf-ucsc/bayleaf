// The speech-to-text runtime's build inputs (build.mjs runs this unless
// --no-models): Pouch's third heavy tool, under dist/runtime/parakeet/ by the
// build-runtime.mjs convention. Weights are not in it: the page downloads them
// from the BayLeaf HF gateway after the user approves (`addons install parakeet`;
// this runtime is its hidden tool-kind add-on, `parakeet-runtime`)
// and checks every byte against models.lock.json.
//
// runtime/parakeet/ (the page fetches it on the first `transcribe`):
// - worker.js: src/parakeet/worker.ts bundled with parakeet.js 1.4.4 (MIT) and
//   ONNX Runtime Web's WebGPU bundle (MIT), the same onnxruntime-web build the
//   Transformers.js provider ships (package.json overrides parakeet.js's 1.24.1
//   pin; the spike, experiments/parakeet-webgpu, qualified it). parakeet.js's
//   `import('onnxruntime-web')` is aliased to that bundle, so one ORT is in it.
// - ort-wasm-simd-threaded.asyncify.wasm: a second copy of the Transformers.js
//   runtime's wasm (same bytes, same lock hash). Sharing one copy across
//   runtime groups would need a shared runtime/ort/ group: a later change.
// - NOTICE.txt: what is shipped and both MIT licenses (parakeet.js's LICENSE
//   verbatim; onnxruntime-web's npm package carries none, so its MIT terms and
//   Microsoft's copyright line from the project's repository).
//
// Rewrites, each matched exactly once: parakeet.js's initOrt fills an unset
// wasmPaths with jsDelivr, and any wasmPaths makes ORT's WebGPU bundle import
// its glue from there instead of its embedded copy; removed, so the bundle uses
// its own glue and the wasm the page hands in. hub.js (fromHub, which reads
// huggingface.co and caches in IndexedDB) is never imported: the worker imports
// src/parakeet.js directly, and the build fails if hub.js was bundled anyway.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bundleWorker, writeRuntime } from './build-runtime.mjs';

const PKG = 'node_modules/parakeet.js/';
const ORT_BUNDLE = 'node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs';
export const SOURCES = { 'parakeet.js/src/backend.js': [
  [/ort\.env\.wasm\.wasmPaths = `https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\$\{ver\}\/dist\/`;/g,
    '/* Pouch: no CDN default (build-parakeet.mjs); the WebGPU bundle uses its embedded glue and the wasm handed in */', 1],
] };
const sha = (b) => createHash('sha256').update(b).digest('hex');

export async function buildParakeet(out) {
  const lock = JSON.parse(readFileSync('models.lock.json', 'utf8'));
  const pin = lock.runtime['parakeet.js'], ort = lock.runtime['onnxruntime-web'];
  const v = JSON.parse(readFileSync(PKG + 'package.json', 'utf8')).version;
  if (v !== pin.version) throw new Error(`parakeet.js ${v} in node_modules; models.lock.json pins ${pin.version}`);
  for (const [f, h] of Object.entries(pin.files)) if (sha(readFileSync(PKG + f)) !== h) throw new Error(`${PKG}${f} differs from its pinned SHA-256 (models.lock.json)`);
  const ortv = JSON.parse(readFileSync('node_modules/onnxruntime-web/package.json', 'utf8')).version;
  if (ortv !== ort.version) throw new Error(`onnxruntime-web ${ortv} in node_modules; models.lock.json pins ${ort.version}`);
  const wasm = ort.files[0], wasmBytes = readFileSync('node_modules/' + wasm.npm);
  if (sha(wasmBytes) !== wasm.sha256) throw new Error('ORT wasm hash differs from models.lock.json');

  const worker = await bundleWorker('src/parakeet/worker.ts', [], { sources: SOURCES, alias: { 'onnxruntime-web': './' + ORT_BUNDLE },
    forbid: [/parakeet\.js[\\/]src[\\/]hub\.js$/] });
  const notice = Buffer.from(`BayLeaf Pouch's speech-to-text runtime (add-on parakeet-runtime).
worker.js: Pouch's src/parakeet/worker.ts bundled with parakeet.js ${pin.version}
(https://github.com/ysdede/parakeet.js; hub.js left out; one line removed: its
jsDelivr default for ONNX Runtime's wasm) and ONNX Runtime Web ${ort.version}
(https://github.com/microsoft/onnxruntime), unmodified. ${wasm.name}:
ONNX Runtime Web's wasm, unmodified (SHA-256 ${wasm.sha256}).
The model (NVIDIA Parakeet TDT 0.6B v3, CC-BY-4.0) is a separate add-on, not in this runtime.

==> parakeet.js LICENSE <==
${readFileSync(PKG + 'LICENSE', 'utf8').trim()}

==> ONNX Runtime (onnxruntime-web) <==
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);
  const { sums, pin: runtime } = writeRuntime(out, 'parakeet', [
    { name: 'worker.js', role: 'worker', bytes: worker },
    { name: wasm.name, role: 'wasm', bytes: wasmBytes },
    { name: 'NOTICE.txt', role: 'license', bytes: notice },
  ]);
  const m = lock.models.find((x) => x.kind === 'speech-to-text');
  if (!m) return { sums, pin: null };
  const model = { id: m.id, label: m.label, repo: m.repo, revision: m.revision, license: m.license, attribution: m.attribution, runs: m.runs,
    files: m.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) };
  for (const k of ['encoder', 'decoder', 'vocab']) if (!model.files.some((f) => f.name === m[k])) throw new Error(`models.lock.json: ${m.id} ${k} ${m[k]} is not one of its files`);
  return { sums, pin: { model, encoder: m.encoder, decoder: m.decoder, vocab: m.vocab, runtime } };
}
