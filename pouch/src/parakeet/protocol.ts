// The Parakeet worker's message protocol, types only: src/parakeet.ts posts an
// AsrRequest and reads an AsrReply, src/parakeet/worker.ts the reverse. Each
// side casts once, where event data arrives; this is what crosses into the worker.

// One word as parakeet.js times it (seconds from the start of the audio).
export interface AsrWord { text: string; start_time: number; end_time: number; confidence?: number }

// files: the model's verified files by name (Blobs read back from Cache Storage,
// disk-backed); wasm: the verified ORT binary. The worker reads them into memory itself.
export interface AsrLoad { id: number; action: 'load'; files: Record<string, Blob>; wasm: Blob; encoder: string; decoder: string; vocab: string }
// pcm: 16 kHz mono float samples (transferred); label: the caller's path, for messages.
export interface AsrTranscribe { id: number; action: 'transcribe'; pcm: Float32Array; label: string }
export interface AsrStop { id?: undefined; action: 'stop'; job: number }
export type AsrRequest = AsrLoad | AsrTranscribe | AsrStop;
export type AsrJob = Omit<AsrTranscribe, 'id'>;

export interface AsrLoaded { load_ms: number; ort: string; adapter: { vendor?: string; architecture?: string; f16: boolean }; refused: string[]; text?: undefined }
// ms: wall time of the transcription; windows: how many pieces parakeet.js cut it into.
export interface AsrResult { text: string; words: AsrWord[]; seconds: number; ms: number; windows: number }

export type AsrReply =
  | { id: number; note: string; result?: undefined; error?: undefined }
  | { id: number; result: AsrLoaded | AsrResult; note?: undefined; error?: undefined }
  | { id: number; error: string; code?: string; name?: string; note?: undefined; result?: undefined };
