// The DuckDB worker's message protocol, types only: src/duckdb.ts posts a
// DuckRequest and reads a DuckReply, src/duckdb/worker.ts the reverse. Each
// side reads event data once, where it arrives; this is what crosses into the worker.

// A file the job may read, under the name DuckDB sees (an absolute Pouch path).
export interface DuckFile { name: string; bytes: Uint8Array }
export interface DuckJob {
  statements: string[];  // run in order; the first error stops the rest
  files: DuckFile[];
  outputs: string[];     // names a COPY ... TO may write; those that exist afterwards come back
  allowed: string[];     // DuckDB's allowed_directories (each ends in /)
  maxRows: number;       // rows kept per result; one more is read to know there are more
  memoryLimit: string;   // DuckDB's memory_limit
  maxOutputBytes: number;
}
// pack: extensions.pack (u32 LE header length, JSON { name: [offset, length] }, then the bytes).
export interface DuckLoad { id: number; action: 'load'; wasm: ArrayBuffer; pack: ArrayBuffer }
export type DuckRequest = (DuckJob & { id: number; action: 'run' }) | DuckLoad;

// A cell as plain data: 64-bit integers and decimals too large for a number are
// strings, with the column marked numeric so -json writes them unquoted.
export type DuckCell = string | number | boolean | null;
export interface DuckColumn { name: string; type: string; numeric: boolean }
export interface DuckResult { columns: DuckColumn[]; rows: DuckCell[][]; more: boolean }
export interface DuckRun {
  version: string;
  results: DuckResult[];                                   // one per statement that ran
  error: { message: string; statement: number } | null;    // statement: its index
  outputs: DuckFile[];
}
export interface DuckLoaded { version: string; extensions: string[] }

export type DuckReply =
  | { id: number; result: DuckRun | DuckLoaded; error?: undefined }
  | { id: number; error: string; code?: string; result?: undefined };
