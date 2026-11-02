// The spike page's module (bundled by run.mjs with Pouch's pinned parakeet.js and
// onnxruntime-web, the version Transformers.js already ships). It loads the model
// the way the Pouch worker will: graphs as bytes (Uint8Array, no URL), the ORT
// wasm handed in as bytes, and fetch() answering only from verified in-memory
// files (the vocab, by a made-up URL) or this spike's own server. A blob: URL
// would not do: Pouch's CSP connect-src does not list blob:, and a blob worker
// inherits it.
import * as ort from 'onnxruntime-web'; // aliased to ORT's WebGPU bundle (run.mjs), the one parakeet.js gets too
import { ParakeetModel } from 'parakeet.js';

const origFetch = self.fetch.bind(self), refused = [], verified = new Map();
self.fetch = (u, o) => {
  const url = new URL(u instanceof Request ? u.url : String(u), location.href).href;
  if (verified.has(url)) return Promise.resolve(new Response(verified.get(url)));
  if (url.startsWith(location.origin + '/')) return origFetch(u, o);
  refused.push(url); return Promise.reject(new TypeError('refused: ' + url));
};
const bytes = async (p) => new Uint8Array(await (await fetch(p)).arrayBuffer());

// Count WebGPU dispatches, to show the encoder really runs on the GPU.
let dispatches = 0;
if (self.GPUComputePassEncoder) {
  const d = GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.dispatchWorkgroups = function (...a) { dispatches++; return d.apply(this, a); };
}

function wav16k(buf) { // 16-bit PCM mono 16 kHz WAV (say --data-format=LEI16@16000)
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 12;
  while (at < v.byteLength) {
    const id = String.fromCharCode(...buf.subarray(at, at + 4)), n = v.getUint32(at + 4, true);
    if (id === 'data') { const out = new Float32Array(n / 2); for (let i = 0; i < out.length; i++) out[i] = v.getInt16(at + 8 + 2 * i, true) / 32768; return out; }
    at += 8 + n + (n & 1);
  }
  throw new Error('no data chunk');
}

self.runSpike = async ({ encoder, decoder, backend = 'webgpu-hybrid', clips, threads = 1 }) => {
  const adapter = await navigator.gpu?.requestAdapter();
  const out = { encoder, decoder, backend, ort: ort.env.versions?.common, adapter: adapter && { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, f16: adapter.features.has('shader-f16') } };
  ort.env.wasm.wasmBinary = await bytes('/ort/ort-wasm-simd-threaded.asyncify.wasm');
  ort.env.wasm.wasmPaths = undefined; // the WebGPU bundle's embedded glue (run.mjs removes parakeet.js's CDN default)
  ort.env.wasm.numThreads = threads;
  let t0 = performance.now();
  const enc = await bytes('/model/' + encoder), dec = await bytes('/model/' + decoder);
  const vocab = 'verified:vocab.txt'; // a URL no server answers: only the shim's map does
  verified.set(vocab, new Blob([await bytes('/model/vocab.txt')]));
  out.read_ms = Math.round(performance.now() - t0);
  t0 = performance.now();
  const model = await ParakeetModel.fromUrls({ encoderUrl: enc, decoderUrl: dec, tokenizerUrl: vocab, backend, preprocessorBackend: 'js', cpuThreads: threads });
  out.load_ms = Math.round(performance.now() - t0);
  out.clips = [];
  for (const clip of clips) {
    const pcm = wav16k(await bytes('/audio/' + clip));
    const r = { clip, seconds: +(pcm.length / 16000).toFixed(2) };
    for (const pass of ['cold', 'warm']) {
      dispatches = 0; t0 = performance.now();
      const res = await model.transcribeLongAudio(pcm, 16000, { returnTimestamps: true });
      const ms = performance.now() - t0;
      r[pass] = { ms: Math.round(ms), rtf: +(ms / 1000 / r.seconds).toFixed(4), dispatches };
      r.text = res.text; r.chunks = res.chunks?.length; r.firstChunk = res.chunks?.[0]; r.lastChunk = res.chunks?.at(-1);
    }
    out.clips.push(r);
  }
  out.refused = refused;
  return out;
};
self.spikeReady = true;
