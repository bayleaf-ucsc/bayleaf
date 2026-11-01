// Stand-in for src/local/engine.ts in walkthrough builds only (aliased at
// bundle time, like the fake Tinfoil). The Transformers.js provider's real code
// (src/local/provider.ts) still parses the text and runs the tools; only the
// WebGPU model is replaced by window.localScript, a queue of raw model
// outputs in LFM's XML tool-call format. Nothing is downloaded.
export const LOCAL = { id: 'lfm3-1.7b', label: 'LFM3 1.7B', bytes: 1_150_000_000, dir: 'models/lfm3/', manifest: 'manifest.json', sha256: 'walkthrough' };
export async function support() { return { ok: true }; }
export async function stored() { return { bytes: LOCAL.bytes, total: LOCAL.bytes, complete: true, persistent: true }; }
export async function obtain() { throw new Error('walkthrough: no model files'); }
export async function importFiles() { return stored(); }
export async function remove() {}
// The model store behind `models` (src/models.ts): already downloaded, nothing to move.
export const models = { models: [], migrate: async () => null, status: async () => ({ id: LOCAL.id, label: LOCAL.label, total: LOCAL.bytes, bytes: LOCAL.bytes, complete: true, files: [] }), catalog: async () => [], release: async () => null };
export const engine = {
  loaded: () => true,
  start: async () => ({ loaded: true }),
  dispose: async () => {},
  async generate(req, { onDelta } = {}) {
    const text = (window.localScript ?? []).shift() ?? 'Done.';
    onDelta?.(text);
    return { text, input_tokens: 900, output_tokens: 60 };
  },
};
