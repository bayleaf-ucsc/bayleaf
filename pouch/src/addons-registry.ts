// The add-ons this build of Pouch carries, one entry each, built from the
// build's pins (build.mjs defines). An entry whose pin is missing (a build
// that left it out) is simply absent; its commands say "not available here".
//
// Adding an add-on (README "Add-ons: the recipe"): its build step produces a
// pin (build-runtime.mjs writeRuntime for origin parts, or a models.lock.json
// entry for gateway files), build.mjs defines it, and one entry below names
// it; its worker calls addons.assets(id).obtain() (tools) or addons.files(id)
// (models) before it starts. The consent tier follows from the entry
// (src/addons.ts tierOf), never from a flag.
import { LOCAL, support as tjsSupport, deviceSupport } from './local/host.ts';
import type { AddonDef, AddonSupport } from './addons.ts';
import type { DeviceSignals, GpuLike } from './local/host.ts';
import type { AsrPin } from './trust.ts';

const PDF = typeof POUCH_PDF_RUNTIME !== 'undefined' ? POUCH_PDF_RUNTIME : null; // eslint-disable-line no-undef
const LIBAV = typeof POUCH_LIBAV_RUNTIME !== 'undefined' ? POUCH_LIBAV_RUNTIME : null; // eslint-disable-line no-undef
const DUCKDB_PIN = typeof POUCH_DUCKDB_RUNTIME !== 'undefined' ? POUCH_DUCKDB_RUNTIME : null; // eslint-disable-line no-undef
// Speech to text (src/parakeet.ts): the model's pins, which lock files are which, and its runtime's manifest.
export const PARAKEET: AsrPin | null = typeof POUCH_PARAKEET !== 'undefined' ? POUCH_PARAKEET : null; // eslint-disable-line no-undef
export const PARAKEET_RUNTIME = 'parakeet-runtime';

// Where Parakeet can run (story TR6): a computer (the Transformers.js device signals),
// WebGPU, and shader-f16 for the fp16 encoder. Asks for an adapter only: no device, no download.
const ELSEWHERE = 'Transcribe on a computer with a recent Chrome or Edge.';
export async function parakeetSupport(nav: DeviceSignals = globalThis.navigator ?? {}): Promise<AddonSupport> {
  if (!deviceSupport(nav).ok) return { ok: false, reason: `transcription is turned off on phones and tablets and on computers with under 8 GB of memory: the model needs a computer's GPU and about 5 GB of memory across the browser's processes. ${ELSEWHERE}` };
  return parakeetGpu(nav.gpu);
}
export async function parakeetGpu(gpu: GpuLike | undefined): Promise<AddonSupport> {
  if (!gpu) return { ok: false, reason: `WebGPU is not available in this browser. ${ELSEWHERE}` };
  let adapter;
  try { adapter = await gpu.requestAdapter(); } catch (e) { return { ok: false, reason: `WebGPU failed: ${e instanceof Error ? e.message : String(e)}. ${ELSEWHERE}` }; }
  if (!adapter) return { ok: false, reason: `WebGPU found no usable graphics adapter. ${ELSEWHERE}` };
  if (!adapter.features?.has?.('shader-f16')) return { ok: false, reason: `this browser's WebGPU lacks shader-f16, which the model's fp16 encoder needs. ${ELSEWHERE}` };
  return { ok: true };
}

export const PDFJS = 'pdfjs', LIBAVJS = 'libavjs', DUCKDB = 'duckdb', TRANSFORMERSJS = 'transformersjs';
export const LFM3 = LOCAL?.id ?? null; // the lock's id (lfm3-1.7b-q4f16); `addons install lfm3` matches it

export const REGISTRY: AddonDef[] = [
  ...(PDF ? [{ id: PDFJS, label: 'pdf.js', kind: 'tool' as const, files: { origin: PDF }, license: 'Apache-2.0 and the bundled components\' licenses (NOTICE.txt)',
    notice: `${PDF.dir}NOTICE.txt`, usedBy: ['pdfinfo', 'pdftotext', 'pdftoppm'] }] : []),
  ...(LIBAV ? [{ id: LIBAVJS, label: 'libav.js', kind: 'tool' as const, files: { origin: LIBAV }, license: 'LGPL-2.1-or-later and others, with the corresponding source offered (NOTICE.txt)',
    notice: `${LIBAV.dir}NOTICE.txt`, usedBy: ['ffprobe', 'ffmpeg'] }] : []),
  // DuckDB-Wasm with its parquet and json extensions (build-duckdb.mjs): about 38 MiB, so asked.
  ...(DUCKDB_PIN ? [{ id: DUCKDB, label: 'DuckDB', kind: 'tool' as const, files: { origin: DUCKDB_PIN }, license: 'MIT, with apache-arrow Apache-2.0 (NOTICE.txt)',
    notice: `${DUCKDB_PIN.dir}NOTICE.txt`, usedBy: ['duckdb'] }] : []),
  // The Transformers.js code (Transformers.js and ONNX Runtime Web): installed with LFM3, never listed alone.
  ...(LOCAL ? [{ id: TRANSFORMERSJS, label: 'Transformers.js', kind: 'tool' as const, hidden: true, files: { origin: LOCAL.runtime },
    license: 'Apache-2.0 (Transformers.js), MIT (ONNX Runtime Web)', provider: 'Transformers.js', device: tjsSupport }] : []),
  ...(LOCAL ? [{ id: LOCAL.id, label: LOCAL.label, kind: 'model' as const, files: { gateway: LOCAL }, needs: [TRANSFORMERSJS],
    license: LOCAL.license, extraLicense: true, provider: 'Transformers.js', device: tjsSupport }] : []),
  // Parakeet's code (parakeet.js and ONNX Runtime Web): installed with the model, never listed alone.
  ...(PARAKEET ? [{ id: PARAKEET_RUNTIME, label: 'Parakeet runtime', kind: 'tool' as const, hidden: true, files: { origin: PARAKEET.runtime },
    license: 'MIT (parakeet.js, ONNX Runtime Web; NOTICE.txt)', notice: `${PARAKEET.runtime.dir}NOTICE.txt`, usedBy: ['transcribe'], device: () => parakeetSupport() }] : []),
  ...(PARAKEET ? [{ id: PARAKEET.model.id, label: PARAKEET.model.label, kind: 'model' as const, files: { gateway: PARAKEET.model }, needs: [PARAKEET_RUNTIME],
    license: 'CC-BY-4.0', extraLicense: true, attribution: PARAKEET.model.attribution, runs: PARAKEET.model.runs, usedBy: ['transcribe'], device: () => parakeetSupport() }] : []),
];
