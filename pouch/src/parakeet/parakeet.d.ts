// parakeet.js and ONNX Runtime Web are imported by path (build-parakeet.mjs pins,
// aliases and rewrites them), so these say what those paths are.
//
// parakeet.js's own types say fromUrls takes URLs; it hands encoderUrl and
// decoderUrl straight to ort.InferenceSession.create, which also takes the
// model's bytes (read 1.4.4, 2026-11-01). Pouch passes bytes: the worker has no
// network, and its CSP's connect-src lists no blob:. The tokenizer still fetches
// its URL, which the worker's fetch answers from the verified vocab.
declare module '*/parakeet.js/src/parakeet.js' {
  type Upstream = typeof import('parakeet.js/parakeet').ParakeetModel;
  export type FromUrlsConfig = Omit<import('parakeet.js/parakeet').FromUrlsConfig, 'encoderUrl' | 'decoderUrl'> & { encoderUrl: Uint8Array; decoderUrl: Uint8Array };
  export type ParakeetModel = import('parakeet.js/parakeet').ParakeetModel;
  export const ParakeetModel: Omit<Upstream, 'fromUrls'> & { fromUrls(cfg: FromUrlsConfig): Promise<ParakeetModel> };
}
declare module '*/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs' {
  export * from 'onnxruntime-web';
}
