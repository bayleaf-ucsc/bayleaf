// Constants build.mjs injects with esbuild's define (each read behind a
// typeof check, so a bundle without one still runs).
declare const WORKER_SRC: string;
declare const LOCAL_MODEL: unknown;
declare const SW_SHA256: string;
declare const POUCH_PDF_RUNTIME: unknown;
declare const POUCH_LIBAV_RUNTIME: unknown;
declare const POUCH_LIBAV_SOURCE: unknown;
declare const POUCH_CHUNK: number;
