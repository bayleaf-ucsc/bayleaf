// The libav worker's message protocol, types only: src/media.ts posts a
// MediaRequest and reads a MediaReply, src/media/worker.ts the reverse. Each
// side casts once, where event data arrives; this is what crosses into the worker.
import type { MediaKind } from './wc.ts';

// A file copied in: name is libav's (in0.webm), label the caller's path (for messages).
export interface MediaInput { name: string; label: string; bytes: Uint8Array }
// What call() reads to choose the transfer list, on every request.
interface Transfers { inputs?: MediaInput[]; input?: MediaInput; wasm?: undefined; avf?: undefined }
export interface RunJob extends Transfers {
  action: 'run'; program: 'ffmpeg' | 'ffprobe'; args: string[]; inputs: MediaInput[]; outputs: string[]; maxSeconds: number; maxOutputBytes: number;
}
// frames: the CLI build's decoders (WebM, Ogg); wc.frames: the browser's (MOV, MP4).
export interface FramesJob extends Transfers {
  action: 'frames' | 'wc.frames'; input: MediaInput; ss: number; t: number | null; filters: string[]; want: number;
  maxImages: number; maxPixels: number; maxBytes?: number; type: string; quality: number; maxSeconds: number;
}
export interface ProbeJob extends Transfers { action: 'wc.probe'; input: MediaInput; kind: MediaKind }
// format: wav, flac, ogg or webm; sampleFmt null: s32 from a deeper source, else s16.
export interface AudioOut { name: string; format: string; codec: string; sampleFmt: string | null; bitRate?: number | null }
// kind null: a conversion the CLI build could not do, retried here.
export interface AudioJob extends Transfers {
  action: 'wc.audio'; input: MediaInput; kind: MediaKind | null; ss: number; t: number | null; filters: string | null;
  rate: number | null; channels: number | null; out: AudioOut; maxSeconds: number; maxOutputBytes: number;
}
export type MediaJob = RunJob | FramesJob | ProbeJob | AudioJob;
export type MediaAction = MediaJob['action'];
// A job as the engine posts it (with its id), or the runtime's wasm.
export type MediaCallBody = Omit<RunJob, 'action'> | Omit<FramesJob, 'action'> | Omit<ProbeJob, 'action'> | Omit<AudioJob, 'action'> | Omit<MediaLoad, 'id' | 'action'>;
export interface MediaLoad { id: number; action: 'load'; wasm: ArrayBuffer; avf: ArrayBuffer | undefined; inputs?: undefined; input?: undefined }
export interface MediaStop { id?: undefined; action: 'stop'; job: number }
export type MediaRequest = (MediaJob & { id: number }) | MediaLoad | MediaStop;

// ffprobe's report on the WebCodecs path, as data (src/media.ts writes it in ffprobe's formats).
export type ProbeValue = string | number | undefined;
export type ProbeFields = Record<string, ProbeValue>;
export interface ProbeStream {
  [key: string]: ProbeValue | ProbeFields[]; index: number; codec_type: string; codec_name: string; side_data_list?: ProbeFields[];
}
export interface ProbeFormat {
  [key: string]: ProbeValue | Record<string, string>; format_name: string; duration: number; start_time?: number; bit_rate?: number; tags?: Record<string, string>;
}
export interface MediaProbe { kind: MediaKind; notes: string[]; format: ProbeFormat; streams: ProbeStream[]; files?: undefined; images?: undefined }
// bytes null: not written.
export interface RunResult { code: number; stdout: string; stderr: string; files: { name: string; bytes: Uint8Array | null }[]; images?: undefined }
export interface MediaImage { t: number; width: number; height: number; bytes: Uint8Array }
export interface FramesResult { width: number; height: number; images: MediaImage[]; files?: undefined }
export interface AudioResult {
  files: { name: string; bytes: Uint8Array }[]; rate: number; channels: number; source: { codec: string; rate: number; channels: number }; images?: undefined;
}
export interface MediaLoaded { version: string; config: unknown; files?: undefined; images?: undefined }
export type MediaResult = MediaProbe | RunResult | FramesResult | AudioResult | MediaLoaded;
export type MediaResultOf<A extends MediaAction> = A extends 'run' ? RunResult : A extends 'wc.probe' ? MediaProbe : A extends 'wc.audio' ? AudioResult : FramesResult;

export type MediaReply =
  | { id: number; note: string; result?: undefined; error?: undefined }
  | { id: number; result: MediaResult; note?: undefined; error?: undefined }
  | { id: number; error: string; code?: string; name?: string; note?: undefined; result?: undefined };
