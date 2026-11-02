// libav.js's types describe its package entry; src/media/worker.ts imports
// the pinned dist files by path (build-libav.mjs checks and rewrites them),
// so these say what those paths are. Both variants share libav.js's API types.
declare module '*/libav-6.10.9.0-webm-vp9-cli.mjs' {
  const LibAV: import('@libav.js/variant-webm-vp9-cli').LibAVWrapper;
  export default LibAV;
}
declare module '*/libav-6.10.9.0-webcodecs-avf.mjs' {
  const LibAV: import('@libav.js/variant-webm-vp9-cli').LibAVWrapper;
  export default LibAV;
}
// The Emscripten factories: module options in, a module out (LibAV() takes it as its factory).
declare module '*/libav-6.10.9.0-webm-vp9-cli.wasm.mjs' {
  const factory: (opts: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
declare module '*/libav-6.10.9.0-webcodecs-avf.wasm.mjs' {
  const factory: (opts: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
