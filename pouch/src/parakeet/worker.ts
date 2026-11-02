// The speech-to-text worker: NVIDIA Parakeet TDT 0.6B v3 through parakeet.js and
// ONNX Runtime Web (both from npm, exact-pinned; bundled into this one script by
// build-parakeet.mjs). The encoder (fp16) runs on WebGPU, the decoder (fp16) on
// ORT's single-threaded wasm, the mel features in JavaScript.
//
// Boundary: this worker has no network. The page hands it every model file as a
// verified Blob and the ORT wasm as a verified Blob; the graphs go to ORT as bytes.
// fetch answers only the verified vocab (parakeet.js's tokenizer fetches its URL)
// and refuses everything else; XMLHttpRequest, WebSocket, EventSource and
// importScripts are removed. parakeet.js's jsDelivr default for ORT's wasm is
// removed at build, and hub.js (fromHub, which talks to huggingface.co) is not
// in the bundle. Audio and transcripts never leave it except back to the page.
import * as ort from '../../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs';
import { ParakeetModel } from '../../node_modules/parakeet.js/src/parakeet.js';
import type { AsrLoad, AsrLoaded, AsrReply, AsrRequest, AsrResult, AsrTranscribe, AsrWord } from './protocol.ts';

// WebGPU is not in this TypeScript's WebWorker lib; the slice read here.
type GpuNavigator = WorkerNavigator & { gpu?: { requestAdapter(): Promise<{ features: { has(f: string): boolean }; info?: { vendor?: string; architecture?: string } } | null> } };

const VOCAB_URL = 'https://pouch.invalid/parakeet/vocab.txt'; // answered below, never fetched
const verified = new Map<string, Blob>();
const refused: string[] = [];
self.fetch = async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  const hit = verified.get(url);
  if (hit) return new Response(hit);
  refused.push(url);
  throw new TypeError('The Parakeet worker has no network access.');
};
for (const k of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
  try { Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false }); } catch { Reflect.set(globalThis, k, undefined); }
}
// parakeet.js logs every step; keep the console for warnings and errors.
console.log = () => {};

let model: ParakeetModel | null = null;
const stopped = new Set<number>();
const stopError = () => new DOMException('Stopped.', 'AbortError');
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

async function load({ files, wasm, encoder, decoder, vocab }: AsrLoad): Promise<AsrLoaded> {
  const nav: GpuNavigator = navigator;
  const adapter = await nav.gpu?.requestAdapter();
  if (!adapter) throw fail('WebGPU has no adapter in this browser.', 'ENOTSUP');
  const f16 = adapter.features.has('shader-f16');
  if (!f16) throw fail('This browser\'s WebGPU lacks shader-f16, which the fp16 encoder needs.', 'ENOTSUP');
  const file = (name: string) => { const b = files[name]; if (!b) throw fail(`missing model file ${name}`, 'EPROTO'); return b; };
  // No wasmPaths: the WebGPU bundle uses its embedded glue, and the binary comes from here.
  ort.env.wasm.wasmPaths = undefined;
  ort.env.wasm.wasmBinary = new Uint8Array(await wasm.arrayBuffer());
  ort.env.wasm.numThreads = 1; // no cross-origin isolation: no threads
  verified.set(VOCAB_URL, file(vocab));
  const t0 = performance.now();
  model = await ParakeetModel.fromUrls({
    encoderUrl: new Uint8Array(await file(encoder).arrayBuffer()), decoderUrl: new Uint8Array(await file(decoder).arrayBuffer()), tokenizerUrl: VOCAB_URL,
    backend: 'webgpu-hybrid', preprocessorBackend: 'js', cpuThreads: 1,
  });
  return { load_ms: Math.round(performance.now() - t0), ort: ort.env.versions.common, adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, f16 }, refused: [...refused] };
}

async function transcribe(id: number, { pcm, label }: AsrTranscribe, note: (line: string) => void): Promise<AsrResult> {
  const m = model;
  if (!m) throw fail('the Parakeet model is not loaded', 'EPROTO');
  const seconds = pcm.length / 16000;
  if (!pcm.length) throw fail(`${label}: no audio`, 'ENOAUDIO');
  // parakeet.js cuts audio over 180 s into 90 s windows, each one call to
  // transcribe(window, rate, { timeOffset }): wrapped here for progress and Stop.
  const inner = m.transcribe.bind(m);
  let windows = 0;
  m.transcribe = async (audio, rate, opts) => {
    if (stopped.has(id)) throw stopError();
    windows++;
    const at = opts?.timeOffset ?? 0;
    if (seconds > 180) note(`transcribing ${mmss(at)} to ${mmss(Math.min(seconds, at + (audio?.length ?? 0) / 16000))} of ${mmss(seconds)} (${Math.floor((at / seconds) * 100)}%)`);
    return inner(audio, rate, opts);
  };
  const t0 = performance.now();
  try {
    const r = await m.transcribeLongAudio(pcm, 16000, { returnTimestamps: true });
    if (stopped.has(id)) throw stopError();
    const words: AsrWord[] = (r.words ?? []).map((w) => ({ text: w.text, start_time: w.start_time, end_time: w.end_time, ...(w.confidence !== undefined ? { confidence: w.confidence } : {}) }));
    return { text: r.text, words, seconds, ms: Math.round(performance.now() - t0), windows };
  } finally { m.transcribe = inner; }
}

self.onmessage = async ({ data: msg }: MessageEvent<AsrRequest>) => {
  if (msg.action === 'stop') { stopped.add(msg.job); return; }
  const { id } = msg;
  const note = (line: string) => postMessage({ id, note: line } satisfies AsrReply);
  try {
    const result = msg.action === 'load' ? await load(msg) : await transcribe(id, msg, note);
    postMessage({ id, result } satisfies AsrReply);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    postMessage({ id, error: err.message, code: 'code' in err && typeof err.code === 'string' ? err.code : undefined, name: err.name } satisfies AsrReply);
  } finally { stopped.delete(id); }
};
