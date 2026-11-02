// Constants build.mjs injects with esbuild's define (each read behind a
// typeof check, so a bundle without one still runs). Pins are typed by the
// trust contract, which both tsconfig projects can see.
declare const WORKER_SRC: string;
declare const LOCAL_MODEL: import('./trust.ts').LocalModel;
declare const SW_SHA256: string;
declare const POUCH_PDF_RUNTIME: import('./trust.ts').PartsPin;
declare const POUCH_DUCKDB_RUNTIME: import('./trust.ts').PartsPin;
declare const POUCH_LIBAV_RUNTIME: import('./trust.ts').PartsPin;
declare const POUCH_LIBAV_SOURCE: import('./trust.ts').PartsPin;
declare const POUCH_PARAKEET: import('./trust.ts').AsrPin | null;
declare const POUCH_CHUNK: number;
