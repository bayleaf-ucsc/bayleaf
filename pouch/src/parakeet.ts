// Speech to text in this browser: the `transcribe` command, on Pouch's third
// heavy-tool runtime (parakeet.js with ONNX Runtime Web, NVIDIA Parakeet TDT
// 0.6B v3, fp16: encoder on WebGPU, decoder on wasm).
//
//   transcribe FILE [--txt|--srt|--vtt|--json] [-o OUT] [-y] [--lang auto]
//
// Two jobs, each a /task entry whose ctl stops it: libav.js, the media add-on
// (src/media.ts, its wc.audio job), decodes any audio or video it reads to
// 16 kHz mono float WAV; then the Parakeet worker transcribes it with word
// timestamps, and src/parakeet/format.ts writes cues. Nothing leaves the
// browser: the audio goes from the caller's filesystem to two workers that
// have no network, and the transcript back to the caller.
//
// Trust: two add-ons (src/addons-registry.ts), installed together after the user
// approves `addons install parakeet`: the model, pinned in models.lock.json and
// fetched from the BayLeaf HF gateway, and its hidden runtime (worker bundle and
// ORT wasm, build-parakeet.mjs) from this origin as content-hash parts. The
// worker starts only from addons.files(), which re-checks every byte.
import { createJobs } from './jobs.ts';
import { normalize } from './vfs.ts';
import { PARAKEET, PARAKEET_RUNTIME, parakeetSupport } from './addons-registry.ts';
import { say } from './addons.ts';
import { coded, installLines } from './pdf.ts';
import { MAX_INPUT_BYTES, decodePcm } from './media.ts';
import { render } from './parakeet/format.ts';
import type { defineCommand as DefineCommand, ExecResult } from 'just-bash';
import type { WorkerDef } from './jobs.ts';
import type { Tasks } from './ns/tasks.ts';
import type { RuntimeFiles } from './assets.ts';
import type { Note, Pending, Who, WhoOf } from './pdf.ts';
import type { MediaService } from './media.ts';
import type { Addons } from './addons.ts';
import type { AsrJob, AsrLoaded, AsrReply, AsrResult } from './parakeet/protocol.ts';
import type { TranscriptFormat } from './parakeet/format.ts';
import type { AsrPin } from './trust.ts';

export { PARAKEET };

// Caps (named in every refusal).
export const MAX_SECONDS = 2 * 3600;                  // per file: 16 kHz float PCM is 230 MB an hour
export const MAX_STDOUT_BYTES = 1 * 2 ** 20;          // a transcript printed rather than written (-o)
// The jobs memory guard's estimate for the worker's own heap (the graphs in wasm, the samples).
// Measured, the loaded model holds about 4.6 GiB across Chrome's processes on an M3 Max (the
// worker's copy, ORT's wasm heap, the GPU's buffers; test/parakeet-browser.mjs), hence IDLE_MS.
export const ENGINE_MEMORY = 1.5 * 2 ** 30;
export const IDLE_MS = 5 * 60_000;                    // the worker ends this long after its last job; the next reloads it (seconds)
const STOP_GRACE_MS = 3000;                           // a window (90 s of audio) takes about 1.3 s on an M3 Max; then the worker is ended

export const DIARIZATION_GAP = 'Speakers are not separated: Parakeet has no speaker labels (diarization), so an interview comes out as one stream of text. Label speakers yourself, or leave the transcript unlabeled.';
export const HELP = `transcribe: speech to text in this browser (NVIDIA Parakeet TDT 0.6B v3, on this computer's GPU)

  transcribe FILE [--txt|--srt|--vtt|--json] [-o OUT] [-y] [--lang auto]

  FILE       audio or video in the workspace: M4A, MP3, MP4, MOV, WAV, FLAC, Ogg, Opus, WebM
  --txt      one line per sentence or pause, "[mm:ss] text" (the default)
  --srt      SubRip subtitles (cues of at most 7 s and two lines)
  --vtt      WebVTT subtitles
  --json     {text, segments: [{start, end, text}], words: [{start, end, text, confidence}]}
  -o OUT     write there (the format follows its extension unless a flag says); else print
  -y         overwrite OUT
  --lang     auto only: the model detects the language itself (25 European languages,
             English, Spanish, French, German, Italian, Portuguese, Dutch, Polish, Russian,
             Ukrainian and others; not Chinese, Japanese or Korean)

${DIARIZATION_GAP}

Needs the add-on, once: \`addons install parakeet\` (about 1.3 GB; the user approves). The
audio never leaves this browser: it is decoded by libav.js and transcribed on
the GPU, in two workers with no network. Caps: ${MAX_INPUT_BYTES / 2 ** 20} MiB per file
(MAX_INPUT_BYTES), ${MAX_SECONDS / 3600} hours of audio (MAX_SECONDS). Progress and Stop: the
/task entries it names (echo stop > /task/<id>/ctl). Model: CC-BY-4.0, NVIDIA.
Exit codes: 0 ok, 1 error, 2 usage, 130 stopped.
`;

// ── Arguments ────────────────────────────────────────────────────────
export interface TranscribeArgs { help?: undefined; error?: undefined; file: string; format: TranscriptFormat; out: string | null; overwrite: boolean }
const FORMATS: TranscriptFormat[] = ['txt', 'srt', 'vtt', 'json'];
const isFormat = (s: string): s is TranscriptFormat => FORMATS.some((f) => f === s);
export function parseArgs(args: string[]): TranscribeArgs | { help: true; error?: undefined } | { error: string; help?: undefined } {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  let file: string | null = null, out: string | null = null, flag: TranscriptFormat | null = null, overwrite = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') { const v = args[++i]; if (!v) return { error: `${a} needs a path` }; out = v; }
    else if (a === '-y') overwrite = true;
    else if (a === '--lang' || a.startsWith('--lang=')) {
      const v = a === '--lang' ? args[++i] : a.slice(7);
      if (v !== 'auto') return { error: `--lang ${v ?? ''}: only auto; Parakeet v3 detects the language itself and takes no hint` };
    } else if (a.startsWith('--') && isFormat(a.slice(2))) {
      const f = a.slice(2);
      if (flag && flag !== f) return { error: `--${flag} and --${f}: pick one format` };
      if (isFormat(f)) flag = f;
    } else if (a.startsWith('-') && a !== '-') return { error: `unknown option ${a}` };
    else if (file) return { error: `one file per call (got ${file} and ${a}); run it once per file` };
    else file = a;
  }
  if (!file) return { error: 'name an audio or video file' };
  const ext = out?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '';
  if (flag && out && isFormat(ext) && ext !== flag) return { error: `--${flag} but -o ${out} ends in .${ext}` };
  return { file, out, overwrite, format: flag ?? (isFormat(ext) ? ext : 'txt') };
}

// ── Where it can run (story TR6): the registry's check (src/addons-registry.ts) ──
export const support = parakeetSupport;

// ── The worker: started from the verified runtime and weights ────────
const stopped = () => new DOMException('Stopped.', 'AbortError');
const codeError = (msg: string, code?: string) => Object.assign(new Error(msg), { code });
function defaultSpawn(files: RuntimeFiles) {
  const src = URL.createObjectURL(new Blob([files['worker.js']], { type: 'text/javascript' }));
  try { return new Worker(src, { type: 'module', name: 'pouch-parakeet' }); } finally { URL.revokeObjectURL(src); }
}
export interface AsrWorkerOptions { addons?: Addons | null; pin?: AsrPin | null; spawn?: (files: RuntimeFiles) => Worker; idleMs?: number }
export function asrWorker({ addons = null, pin = PARAKEET, spawn = defaultSpawn, idleMs = IDLE_MS }: AsrWorkerOptions = {}): WorkerDef<AsrJob, AsrResult> {
  return {
    label: 'parakeet.js', memory: ENGINE_MEMORY, concurrency: 1,
    create() {
      if (!addons || !pin) throw codeError('this build of Pouch has no speech-to-text runtime', 'ENOSYS');
      const service = addons, asr = pin;
      let worker: Worker | null = null, seq = 0, idle: ReturnType<typeof setTimeout> | undefined;
      const pending = new Map<number, Pending<AsrLoaded | AsrResult>>();
      // Idle or removing the add-on unloads it: a job still running ends with a reason, never hangs.
      const end = () => { clearTimeout(idle); worker?.terminate(); worker = null; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Parakeet was removed while this job ran.')); } pending.clear(); };
      function call(w: Worker, data: object, transfer: Transferable[], { note, signal }: { note?: Note; signal?: AbortSignal } = {}) {
        return new Promise<AsrLoaded | AsrResult>((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject, note });
          signal?.addEventListener('abort', () => {
            w.postMessage({ action: 'stop', job: id });
            // A window cannot be interrupted: one that does not stop in time ends the worker; the next job starts a new one.
            const p = pending.get(id);
            if (p) p.timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); w.terminate(); if (worker === w) worker = null; reject(stopped()); } }, STOP_GRACE_MS);
          }, { once: true });
          w.postMessage({ id, ...data }, transfer);
        });
      }
      async function start(note: Note, signal?: AbortSignal) {
        note('checking the model and runtime files');
        // The model's files and its runtime's, keyed by add-on id; not installed throws the standard string.
        const got = await service.files(asr.model.id, { network: globalThis.navigator?.onLine !== false, signal });
        const code = got[PARAKEET_RUNTIME], weights = got[asr.model.id];
        if (!code || !weights) throw new Error('the Parakeet add-on came without its runtime');
        const w = spawn(code.files);
        w.onmessage = ({ data }: MessageEvent<AsrReply>) => {
          const p = pending.get(data.id);
          if (!p) return;
          if (data.note !== undefined) return p.note?.(data.note);
          pending.delete(data.id); clearTimeout(p.timer);
          if (data.error !== undefined) p.reject(data.name === 'AbortError' ? stopped() : codeError(data.error, data.code)); else p.resolve(data.result);
        };
        w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'the speech-to-text worker failed (out of memory?)')); pending.clear(); worker = null; };
        worker = w;
        note('loading the model onto the GPU');
        const wasm = code.files['ort-wasm-simd-threaded.asyncify.wasm'];
        try { await call(w, { action: 'load', files: weights.files, wasm, encoder: asr.encoder, decoder: asr.decoder, vocab: asr.vocab }, []); }
        catch (e) { w.terminate(); if (worker === w) worker = null; throw e; }
      }
      return {
        async run(job, { signal, note }) {
          clearTimeout(idle);
          if (!worker) await start(note, signal);
          if (signal.aborted) throw stopped();
          const w = worker;
          if (!w) throw new Error('the speech-to-text worker failed while starting');
          try {
            const r = await call(w, job, [job.pcm.buffer], { note, signal });
            if (r.text === undefined) throw new Error('the speech-to-text worker answered a transcription with a load result');
            return r;
          } finally { clearTimeout(idle); if (worker) idle = setTimeout(end, idleMs); } // unloaded meanwhile: nothing to idle out
        },
        dispose: end,
      };
    },
  };
}

// The service shared by the terminal and every agent: decode on the media service, then this worker.
// pin: the build's (tests pass their own).
export interface AsrServiceOptions { tasks: Tasks; media: MediaService | null; addons: Addons | null; pin?: AsrPin | null; worker?: WorkerDef<AsrJob, AsrResult>; budget?: number }
export function createAsrService({ tasks, media, addons, pin = PARAKEET, worker = asrWorker({ addons, pin }), budget }: AsrServiceOptions) {
  const jobs = createJobs({ tasks, workers: { parakeet: worker }, ...(budget ? { budget } : {}) });
  return { jobs, tasks, media, addons, pin };
}
export type AsrService = ReturnType<typeof createAsrService>;

// ── The command ──────────────────────────────────────────────────────
const ok = (stdout: string, stderr = ''): ExecResult => ({ stdout, stderr, exitCode: 0 });
const fail = (msg: string, exitCode = 1): ExecResult => ({ stdout: '', stderr: `transcribe: ${msg}\n`, exitCode });
const abs = (cwd: string, p: string) => normalize(p.startsWith('/') ? p : cwd + '/' + p);
const isResult = (x: unknown): x is AsrResult => typeof x === 'object' && x !== null && 'words' in x && Array.isArray(x.words) && 'text' in x && typeof x.text === 'string';
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

export function transcribeCommands(defineCommand: typeof DefineCommand, service: AsrService | null | undefined, whoOf: WhoOf = () => ({ name: 'terminal' })) {
  const who = (): Who => (typeof whoOf === 'function' ? whoOf() : whoOf) ?? {};
  const installs = installLines(); // a quiet libav.js install during the decode says so on stderr
  return [defineCommand('transcribe', installs.wrap('transcribe', async (args, ctx) => {
    const a = parseArgs(args);
    if (a.help) return ok(HELP);
    if (a.error !== undefined) return { stdout: '', stderr: `transcribe: ${a.error}\nRun \`transcribe --help\` for usage.\n`, exitCode: 2 };
    if (!service?.pin || !service.addons || !service.media) return fail(say.notBuilt('speech to text'));
    const { pin, addons, media } = service, model = pin.model, def = addons.get(model.id);
    const st = await addons.status(model.id);
    if (st.reason !== undefined) return fail(st.installed ? say.installedNotHere(def, st.reason) : say.notHere(def, st.reason));
    if (!st.installed) return fail(say.notInstalled(def, st.size, st.tier));
    const path = abs(ctx.cwd, a.file), out = a.out && abs(ctx.cwd, a.out);
    if (out === path) return fail(`-o ${out} is the input`);
    if (out && !a.overwrite && await ctx.fs.exists(out)) return fail(`${out} exists; add -y to overwrite`);
    let size;
    try { const s = await ctx.fs.stat(path); if (s.isDirectory) return fail(`${path} is a folder; run transcribe once per file`); size = s.size; } catch { return fail(`${path}: No such file or directory`); }
    if (size > MAX_INPUT_BYTES) return fail(`${path} is ${(size / 2 ** 20).toFixed(0)} MiB; the cap is ${MAX_INPUT_BYTES / 2 ** 20} MiB (MAX_INPUT_BYTES). For a long video call, export its audio on your computer (an .m4a or .opus is a few MB an hour)`);
    const bytes = await ctx.fs.readFileBuffer(path), name = path.split('/').pop() ?? path, caller = who();
    // 1. Decode to 16 kHz mono float: libav.js's audio path (src/media.ts), as its own job.
    const dec = decodePcm(media, { path, bytes, rate: 16000, maxSeconds: MAX_SECONDS }, { who: caller, fs: ctx.fs, signal: ctx.signal, label: `transcribe ${name} (decode)` });
    let pcm: Float32Array;
    try { pcm = await dec.samples; installs.note(ctx, dec.task); } catch (caught) {
      const e = coded(caught);
      return e.name === 'AbortError' ? fail(`stopped (/task/${dec.task.id})`, 130) : fail(e.message.replace('(MAX_INPUT_SECONDS)', '(MAX_SECONDS)').replace(/over \d+ MiB \(MAX_OUTPUT_BYTES\)[^]*/, `over ${MAX_SECONDS / 3600} hours (MAX_SECONDS)`));
    }
    // 2. Transcribe, as a job on this service's worker.
    const seconds = pcm.length / 16000;
    const { task, result } = service.jobs.submit('parakeet', { action: 'transcribe', pcm, label: path } satisfies AsrJob, { caller: { sid: caller.sid ?? undefined, name: caller.name, fs: ctx.fs }, label: `transcribe ${name} (${mmss(seconds)})` });
    const kill = () => { service.tasks.kill(task).catch(() => {}); };
    if (ctx.signal) { if (ctx.signal.aborted) kill(); else ctx.signal.addEventListener('abort', kill, { once: true }); }
    let r: AsrResult;
    try {
      const got = await result;
      if (!isResult(got)) throw new Error('the speech-to-text worker gave no transcript');
      r = got;
    } catch (caught) {
      const e = coded(caught);
      return e.name === 'AbortError' ? fail(`stopped (/task/${task.id})`, 130) : fail(e.message);
    } finally { ctx.signal?.removeEventListener('abort', kill); }
    const text = render(a.format, r.words, r.text, { source: path, duration: seconds, model: model.label, attribution: model.attribution ?? model.license });
    const summary = `${mmss(seconds)} of audio in ${(r.ms / 1000).toFixed(1)} s (${(seconds / Math.max(r.ms / 1000, 0.001)).toFixed(0)}x real time), ${r.words.length} words. ${DIARIZATION_GAP.split(':')[0]}.\n`;
    if (!r.words.length) return ok('', `transcribe: no speech found in ${path} (${mmss(seconds)} of audio)\n`);
    if (out) {
      await ctx.fs.mkdir(normalize(out + '/..'), { recursive: true }).catch(() => {});
      await ctx.fs.writeFile(out, text);
      return ok(`wrote ${out} (${a.format}, ${text.length.toLocaleString('en-US')} bytes): ${summary}`);
    }
    if (text.length > MAX_STDOUT_BYTES) return ok(text.slice(0, MAX_STDOUT_BYTES) + `\n[cut at ${MAX_STDOUT_BYTES / 2 ** 20} MiB (MAX_STDOUT_BYTES): use -o FILE for the whole transcript]\n`, summary);
    return ok(text, summary);
  }))];
}
