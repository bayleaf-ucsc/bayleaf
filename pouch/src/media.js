// Audio and video commands for the shell, on Pouch's second heavy-tool
// runtime (libav.js: FFmpeg 9 compiled to WebAssembly):
//
//   ffprobe [OPTIONS] FILE         ffprobe itself: -show_format -show_streams -of json ...
//   ffmpeg  [OPTIONS] -i IN ... OUT  ffmpeg itself, over copies of the files
//
// FFmpeg's own names, flags and messages, so an agent's prior knowledge works
// (stories AG2, AG5). Inputs are copied from the caller's filesystem into a
// fresh libav instance's private memory, outputs copied back; libav never
// sees a Pouch path (names are rewritten to in0.webm, out0.opus, and back in
// messages). Writing images (.png, .jpg) is Pouch's own path: the build has
// no image encoder, so frames are decoded with libav's API, filtered with the
// user's -vf, and encoded by the browser (story AG1). What the build lacks
// (MP4, H.264, AAC, MP3, resampling) fails with FFmpeg's error plus a hint.
//
// The runtime (build-libav.mjs, src/media/worker.js) is fetched only when a
// media command first needs it, from this origin as content-hash parts
// checked against the manifest this page was built with (src/assets.js
// partAssets), and then kept for offline use. Every command is an engine job
// (src/jobs.js): a /task entry whose ctl stops it.
import { partAssets } from './assets.js';
import { createJobs } from './jobs.js';
import { normalize } from './vfs.js';

export const LIBAV_RUNTIME = typeof POUCH_LIBAV_RUNTIME !== 'undefined' ? POUCH_LIBAV_RUNTIME : null; // eslint-disable-line no-undef
// The LGPL corresponding source (build-libav.mjs): never fetched by the page, named in help and NOTICE.
export const LIBAV_SOURCE = typeof POUCH_LIBAV_SOURCE !== 'undefined' ? POUCH_LIBAV_SOURCE : null; // eslint-disable-line no-undef

// Caps, named so errors and the media skill can cite them.
export const MAX_INPUT_BYTES = 256 * 2 ** 20;  // all inputs of one call together; refused before anything loads
export const MAX_OUTPUT_BYTES = 256 * 2 ** 20; // all outputs of one call together; over it nothing is written
export const MAX_INPUT_SECONDS = 3 * 3600;     // per input, from its container's duration
export const MAX_IMAGES = 100;                 // images per ffmpeg call
export const MAX_FRAME_PIXELS = 3840 * 2160;   // per image (width x height)
export const MAX_STDOUT_BYTES = 1 * 2 ** 20;   // ffprobe's report; more is cut with a note
export const MAX_STDERR_LINES = 60;            // FFmpeg's log, first and last lines kept
export const ENGINE_MEMORY = 1 * 2 ** 30;      // the jobs memory guard's estimate: inputs, MEMFS copies, decode buffers
const STOP_GRACE_MS = 1000;                    // after Stop, how long before the worker is ended (ffmpeg itself cannot be interrupted)

const ok = (stdout = '', stderr = '') => ({ stdout, stderr, exitCode: 0 });
const fail = (cmd, msg, code = 1) => ({ stdout: '', stderr: `${cmd}: ${msg}\n`, exitCode: code });

const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
// What this build reads and writes (variant webm-vp9-cli), for hints.
export const CODECS = 'WebM/Matroska, Ogg, WAV and FLAC files; VP8, VP9, Opus, FLAC and PCM audio';
const GAP = `this build reads and writes ${CODECS}; not MP4/MOV/M4A, H.264, AAC or MP3 (those need patent-encumbered codecs libav.js does not ship)`;

export const HELP = {
  ffprobe: `usage: ffprobe [-v error] [-show_format] [-show_streams] [-of json] [-show_entries ...] [-select_streams ...] FILE
  FFmpeg's ffprobe (libav.js, FFmpeg 9) on a copy of FILE. For an overview:
    ffprobe -v error -show_format -show_streams -of json FILE
  Reads ${CODECS}.
  At most ${MAX_INPUT_BYTES / 2 ** 20} MiB per file; output over ${MAX_STDOUT_BYTES / 2 ** 20} MiB is cut.${LIBAV_SOURCE ? `
  License: LGPL-2.1 (ffmpeg -L); source: /${LIBAV_SOURCE.dir}${LIBAV_SOURCE.manifest}` : ''}
`,
  ffmpeg: `usage: ffmpeg [-y] [-ss T] [-t T] -i INPUT ... [OPTIONS] OUTPUT
  FFmpeg's ffmpeg (libav.js, FFmpeg 9) over copies of the files: outputs are
  written to the paths you name. Runs as a /task job; stop it through its ctl.
  Reads and writes ${CODECS}.
  Images (OUTPUT ending .png, .jpg or .webp; a %03d in the name numbers them):
    ffmpeg -i in.webm -vf fps=1/10,scale=640:-1 frames/f-%03d.png
    ffmpeg -ss 12.5 -i in.webm -frames:v 1 still.png
  take -ss, -t/-to, -i, -vf (fps, scale, crop, trim), -r, -frames:v, -q:v;
  each is named with its time in the source. At most ${MAX_IMAGES} images per call.
  Audio: ffmpeg -i in.webm -vn -c:a copy audio.opus (no resampling here, so
  Opus cannot become WAV or FLAC; WAV can become FLAC or Opus).
  Caps: inputs ${MAX_INPUT_BYTES / 2 ** 20} MiB and ${MAX_INPUT_SECONDS / 3600} h each, outputs ${MAX_OUTPUT_BYTES / 2 ** 20} MiB, images ${MAX_FRAME_PIXELS.toLocaleString('en-US')} pixels.
  ffmpeg -codecs, -formats, -filters, -encoders and -decoders list what is built in.${LIBAV_SOURCE ? `
  License: LGPL-2.1 (ffmpeg -L); source: /${LIBAV_SOURCE.dir}${LIBAV_SOURCE.manifest}` : ''}
`,
};

// ── Arguments ────────────────────────────────────────────────────────
// FFmpeg options that take no value (everything else starting with "-" takes one).
const FFMPEG_BOOLS = new Set(['y', 'n', 'an', 'vn', 'sn', 'dn', 'hide_banner', 'nostdin', 'stdin', 'nostats', 'stats', 'shortest', 'copyts',
  'start_at_zero', 're', 'benchmark', 'benchmark_all', 'ignore_unknown', 'accurate_seek', 'noaccurate_seek', 'xerror', 'debug_ts', 'dump', 'hex',
  'copyinkf', 'autorotate', 'noautorotate', 'autoscale', 'noautoscale', 'update', 'report',
  'version', 'buildconf', 'formats', 'muxers', 'demuxers', 'devices', 'codecs', 'decoders', 'encoders', 'bsfs', 'protocols', 'filters',
  'pix_fmts', 'layouts', 'sample_fmts', 'colors', 'hwaccels', 'L']);
const INFO = new Set(['version', 'buildconf', 'formats', 'muxers', 'demuxers', 'devices', 'codecs', 'decoders', 'encoders', 'bsfs', 'protocols',
  'filters', 'pix_fmts', 'layouts', 'sample_fmts', 'colors', 'hwaccels', 'L', 'h', 'help', '?']);
// ffprobe options that take a value (most of its options are switches).
const FFPROBE_VALUES = new Set(['v', 'loglevel', 'of', 'print_format', 'output_format', 'show_entries', 'select_streams', 'read_intervals', 'f',
  'show_optional_fields', 'analyzeduration', 'probesize', 'threads', 'i', 'o', 'output', 'sections_filter']);

const scheme = (p) => /^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('/');
const ext = (p) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();

// ffprobe argv -> { args (with the inputs' indexes), files } or { error } / { help } / { info }.
export function parseProbe(args) {
  const files = [], out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '-help' || a === '--help' || a === '-?') return { help: true };
    if (!a.startsWith('-') || a === '-') {
      if (a === '-' || scheme(a)) return { error: `${a}: only files in this workspace (no pipes or URLs)` };
      files.push(a); out.push({ file: files.length - 1 }); continue;
    }
    const name = a.slice(1).replace(/:.*$/, '');
    if (name === 'o' || name === 'output') return { error: `${a}: ffprobe writes to standard output here; redirect it (> report.json)` };
    if (FFPROBE_VALUES.has(name)) {
      if (i + 1 >= args.length) return { error: `${a} needs a value` };
      if (name === 'i') { files.push(args[++i]); out.push(a, { file: files.length - 1 }); continue; }
      out.push(a, args[++i]); continue;
    }
    out.push(a);
  }
  if (!files.length) return out.some((a) => typeof a === 'string' && INFO.has(a.slice(1))) ? { args: out, files } : { error: 'needs a FILE to probe' };
  if (files.length > 1) return { error: `one file per call (got ${files.join(', ')})` };
  return { args: out, files };
}

// ffmpeg argv -> { args, inputs, outputs, flags } where inputs/outputs are
// paths and args holds { input: n } / { output: n } placeholders; or { error } / { help }.
export function parseFfmpeg(args) {
  const inputs = [], outputs = [], out = [], opts = [], flags = new Set();
  let pendingInput = []; // options since the last input or output (they apply to the next file)
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '-help' || a === '--help' || a === '-?') return { help: true, args };
    if (a.startsWith('-') && a !== '-') {
      const name = a.slice(1), base = name.replace(/:.*$/, '');
      if (FFMPEG_BOOLS.has(base)) { flags.add(base); out.push(a); pendingInput.push([base]); continue; }
      if (i + 1 >= args.length) return { error: `${a} needs a value` };
      const v = args[++i];
      if (base === 'i') {
        if (v === '-' || v.startsWith('pipe:') || scheme(v)) return { error: `-i ${v}: only files in this workspace (no pipes, URLs or protocols)` };
        inputs.push({ path: v, opts: pendingInput }); out.push('-i', { input: inputs.length - 1 }); pendingInput = []; continue;
      }
      out.push(a, v); pendingInput.push([base, v, name]); opts.push([base, v, name]); continue;
    }
    if (a === '-' || a.startsWith('pipe:') || scheme(a)) return { error: `${a}: only files in this workspace (no pipes, URLs or protocols)` };
    outputs.push({ path: a, opts: pendingInput }); out.push({ output: outputs.length - 1 }); pendingInput = [];
  }
  const info = [...flags].some((f) => INFO.has(f));
  if (!inputs.length && !info) return { error: 'needs an input: -i FILE' };
  if (!outputs.length && !info) return { error: 'needs an output file (ffprobe reads a file without writing one)' };
  return { args: out, inputs, outputs, flags, info: info && !inputs.length };
}

// FFmpeg time syntax: [-][HH:]MM:SS[.m...], or seconds with an optional s/ms/us unit.
export function parseTime(v) {
  const s = String(v).trim();
  let m = /^(-?)(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return (m[1] ? -1 : 1) * ((+(m[2] ?? 0)) * 3600 + +m[3] * 60 + +m[4]);
  m = /^(-?\d+(?:\.\d*)?|-?\.\d+)(s|ms|us)?$/.exec(s);
  if (m) return +m[1] / ({ ms: 1e3, us: 1e6 }[m[2]] ?? 1);
  return NaN;
}

// The image path: one input, image outputs, the options it understands.
const IMAGE_OPTS = new Set(['ss', 't', 'to', 'vf', 'filter', 'r', 'frames', 'vframes', 'q', 'qscale', 'v', 'loglevel', 'f', 'c', 'codec', 'vcodec', 'start_number', 'update', 'y', 'n', 'an', 'sn', 'dn', 'hide_banner', 'nostdin', 'nostats', 'stats']);
export const isImageOutput = (p) => !!IMAGE[ext(p)];
export function imagePlan(parsed) {
  const { inputs, outputs } = parsed;
  if (outputs.length !== 1) return { error: 'images: one output name per call (use a %03d pattern for many)' };
  if (inputs.length !== 1) return { error: 'images: one input per call' };
  const all = [...inputs[0].opts, ...outputs[0].opts];
  let ss = 0, t = null, to = null, rate = null, want = null, quality = 0.9, start = 1, filters = [];
  for (const [base, v, name] of all) {
    if (!IMAGE_OPTS.has(base)) return { error: `-${name ?? base} is not supported when writing images (Pouch encodes frames itself; it takes -ss, -t, -to, -vf, -r, -frames:v, -q:v, -start_number)` };
    if (v === undefined) continue;
    if (base === 'ss') { ss = parseTime(v); if (!(ss >= 0)) return { error: `-ss ${v}: not a time (seconds, or HH:MM:SS.ms)` }; }
    if (base === 't') { t = parseTime(v); if (!(t > 0)) return { error: `-t ${v}: not a positive duration` }; }
    if (base === 'to') { to = parseTime(v); if (!(to > 0)) return { error: `-to ${v}: not a time` }; }
    if (base === 'vf' || (base === 'filter' && /^filter:v/.test(name))) filters = v.split(',').filter(Boolean);
    if (base === 'filter' && !/^filter:v/.test(name)) return { error: `-${name}: use -vf for video filters` };
    if (base === 'r') { if (!/^\d+(\.\d+)?(\/\d+)?$/.test(v)) return { error: `-r ${v}: a rate such as 1, 0.5 or 1/10` }; rate = v; }
    if (base === 'frames' || base === 'vframes') { if (name !== 'vframes' && !/^frames(:v)?$/.test(name)) return { error: `-${name}: use -frames:v` }; want = Number(v); if (!(Number.isInteger(want) && want > 0)) return { error: `-${name} ${v}: a whole number of frames` }; }
    if (base === 'q' || base === 'qscale') { const q = Number(v); if (!(q >= 1 && q <= 31)) return { error: `-${name} ${v}: 2 (best) to 31` }; quality = Math.max(0.05, Math.min(1, 1 - (q - 2) / 30)); }
    if (base === 'start_number') { start = Number(v); if (!Number.isInteger(start) || start < 0) return { error: `-start_number ${v}: a whole number` }; }
    if ((base === 'c' || base === 'codec' || base === 'vcodec') && !/^(png|mjpeg|libwebp|copy)$/.test(v)) return { error: `-${name} ${v}: images are PNG, JPEG or WebP by the file name` };
    if (base === 'f' && !/^(image2|apng|webp)$/.test(v)) return { error: `-f ${v}: images take their format from the file name` };
  }
  if (to != null) { if (to <= ss) return { error: `-to ${to} is not after -ss ${ss}` }; t = t ?? to - ss; }
  if (rate) filters.push(`fps=${rate}`);
  const path = outputs[0].path, pattern = /%(0?\d*)d/.test(path);
  if (!pattern && want == null) want = 1; // ffmpeg -update writes one picture; Pouch writes the first
  if (!pattern && want > 1) return { error: `-frames:v ${want} with one file name: use a pattern such as frame-%03d.${ext(path)}` };
  return { path, pattern, ss, t, filters, want: want ?? Infinity, quality, start, type: IMAGE[ext(path)] };
}
export const frameName = (pattern, n) => pattern.replace(/%(0?)(\d*)d/, (_, z, w) => String(n).padStart(Number(w) || 0, z ? '0' : ' ').replace(/ /g, '0'));

// FFmpeg's log, without progress lines, first and last lines kept; libav's
// names (in0.webm, out0.opus) back to the caller's paths.
export function tidy(text, names = []) {
  let lines = String(text ?? '').split('\n').filter((l) => l && !/^\s*(frame|size)=.*time=/.test(l));
  if (lines.length > MAX_STDERR_LINES) {
    const head = Math.floor(MAX_STDERR_LINES / 3), tail = MAX_STDERR_LINES - head;
    lines = [...lines.slice(0, head), `[... ${lines.length - MAX_STDERR_LINES} lines of FFmpeg's log cut ...]`, ...lines.slice(-tail)];
  }
  let out = lines.join('\n');
  for (const [from, to] of names) out = out.split(from).join(to);
  return out ? out + '\n' : '';
}
const hint = (stderr) => (/Could not open|Invalid data found|Unknown decoder|could not find codec|Decoder .* not found|Unknown encoder|Requested output format .* not known|Unable to choose an output format|Unable to find a suitable output format|Encoder not found|No such filter|Filter not found|Could not open encoder|received no packets/i.test(stderr) ? `ffmpeg: hint: ${GAP}.\n` : '');

// ── The engine: one worker from the verified runtime ─────────────────
const stopped = () => new DOMException('Stopped.', 'AbortError');
const codeError = (msg, code) => Object.assign(new Error(msg), { code });

function defaultSpawn(files) {
  const src = URL.createObjectURL(new Blob([files['worker.js']], { type: 'text/javascript' }));
  try { return new Worker(src, { type: 'module', name: 'pouch-libav' }); } finally { URL.revokeObjectURL(src); }
}

// Same shape as src/pdf.js pdfEngine (a third runtime should share one).
export function mediaEngine({ assets = LIBAV_RUNTIME && partAssets(LIBAV_RUNTIME), spawn = defaultSpawn, onLoad } = {}) {
  return {
    label: 'libav.js', memory: ENGINE_MEMORY, concurrency: 1,
    create() {
      if (!assets) throw codeError('this build of Pouch has no media runtime (built with it left out)', 'ENOSYS');
      let worker = null, seq = 0;
      const pending = new Map();
      async function start(note) {
        note?.('loading the media runtime');
        const got = await assets.obtain({ network: globalThis.navigator?.onLine !== false });
        onLoad?.(got);
        const w = spawn(got.files);
        w.onmessage = ({ data }) => {
          const p = pending.get(data.id);
          if (!p) return;
          if (data.note !== undefined) return p.note?.(data.note);
          pending.delete(data.id); clearTimeout(p.timer);
          data.error !== undefined ? p.reject(data.name === 'AbortError' ? stopped() : codeError(data.error, data.code)) : p.resolve(data.result);
        };
        w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'the media worker failed (out of memory?)')); pending.clear(); worker = null; };
        worker = w;
        await call('load', { wasm: await got.files['libav.wasm'].arrayBuffer() });
      }
      function call(action, data, { note, signal } = {}) {
        return new Promise((resolve, reject) => {
          const id = ++seq, w = worker;
          pending.set(id, { resolve, reject, note });
          if (signal) signal.addEventListener('abort', () => {
            w.postMessage({ action: 'stop', job: id });
            // ffmpeg runs to completion inside wasm: a job that does not stop in time ends the worker; the next starts a new one.
            const t = setTimeout(() => { if (pending.has(id)) { pending.delete(id); w.terminate(); if (worker === w) worker = null; reject(stopped()); } }, STOP_GRACE_MS);
            pending.get(id) && (pending.get(id).timer = t);
          }, { once: true });
          const transfer = [...(data.inputs ?? []), ...(data.input ? [data.input] : [])].map((f) => f.bytes.buffer);
          w.postMessage({ id, action, ...data }, data.wasm ? [data.wasm] : transfer);
        });
      }
      return {
        async run({ action, ...data }, { signal, note }) {
          if (!worker) await start(note);
          if (signal.aborted) throw stopped();
          // Copies: the caller's bytes stay theirs; these are transferred to the worker.
          if (data.inputs) data.inputs = data.inputs.map((f) => ({ ...f, bytes: f.bytes.slice() }));
          if (data.input) data.input = { ...data.input, bytes: data.input.bytes.slice() };
          return call(action, data, { note, signal });
        },
        dispose() { worker?.terminate(); worker = null; },
      };
    },
  };
}

// The service shared by the terminal and every agent: one engine, its jobs.
export function createMediaService({ tasks, engine = mediaEngine(), budget } = {}) {
  const jobs = createJobs({ tasks, engines: { libav: engine }, ...(budget ? { budget } : {}) });
  return {
    jobs,
    run(input, { who = {}, fs, signal, label } = {}) {
      const { task, result } = jobs.submit('libav', input, { caller: { sid: who.sid ?? undefined, name: who.name, fs }, label });
      const kill = () => tasks.kill(task).catch(() => {});
      if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true }); }
      return { task, result };
    },
  };
}

// ── Shell commands ───────────────────────────────────────────────────
const abs = (cwd, p) => normalize(p.startsWith('/') ? p : cwd + '/' + p);

// Read inputs within MAX_INPUT_BYTES: -> { files: [{ path, bytes }] } or { error }.
async function readInputs(cmd, ctx, paths) {
  const files = [];
  let total = 0;
  for (const raw of paths) {
    const p = abs(ctx.cwd, raw);
    let st;
    try { st = await ctx.fs.stat(p); } catch { return { error: fail(cmd, `${p}: No such file or directory`) }; }
    if (st.isDirectory) return { error: fail(cmd, `${p} is a folder`) };
    total += st.size;
    if (total > MAX_INPUT_BYTES) return { error: fail(cmd, `${p}: inputs total ${(total / 2 ** 20).toFixed(0)} MiB; the cap is ${MAX_INPUT_BYTES / 2 ** 20} MiB (MAX_INPUT_BYTES)`) };
    files.push({ path: p, bytes: await ctx.fs.readFileBuffer(p) });
  }
  return { files };
}

// service: createMediaService(); whoOf(): { name, sid? } for the /task label.
export function mediaCommands(defineCommand, service, whoOf = () => ({ name: 'terminal' })) {
  const who = () => (typeof whoOf === 'function' ? whoOf() : whoOf) ?? {};
  async function job(cmd, ctx, input, label) {
    const { task, result } = service.run(input, { who: who(), fs: ctx.fs, signal: ctx.signal, label });
    try { return { r: await result, task }; }
    catch (e) {
      if (e?.name === 'AbortError') return { error: fail(cmd, `stopped (/task/${task.id})`, 130) };
      return { error: { ...fail(cmd, e.message), ...(e.code === 'EFORMAT' || e.code === 'ECODEC' ? { stderr: `${cmd}: ${e.message}\n${cmd}: hint: ${GAP}.\n` } : {}) } };
    }
  }
  const mkdirFor = (fs, p) => fs.mkdir(normalize(p + '/..'), { recursive: true }).catch(() => {});

  const ffprobe = defineCommand('ffprobe', async (args, ctx) => {
    const a = parseProbe(args);
    if (a.help) return ok(HELP.ffprobe);
    if (a.error) return { stdout: '', stderr: `ffprobe: ${a.error}\n${HELP.ffprobe}`, exitCode: 1 };
    if (!service) return fail('ffprobe', 'the media runtime is not available here');
    const read = await readInputs('ffprobe', ctx, a.files);
    if (read.error) return read.error;
    const inputs = read.files.map((f, i) => ({ name: `in${i}.${ext(f.path) || 'bin'}`, label: f.path, bytes: f.bytes }));
    const argv = ['-hide_banner', ...a.args.map((x) => (typeof x === 'object' ? inputs[x.file].name : x))];
    const j = await job('ffprobe', ctx, { action: 'run', program: 'ffprobe', args: argv, inputs, outputs: [], maxSeconds: 0, maxOutputBytes: 0 },
      `ffprobe ${read.files[0]?.path.split('/').pop() ?? ''}`.trim());
    if (j.error) return j.error;
    const names = inputs.map((f) => [f.name, f.label]);
    let stdout = j.r.stdout ? names.reduce((t, [from, to]) => t.split(from).join(to), j.r.stdout) + '\n' : '', more = '';
    if (stdout.length > MAX_STDOUT_BYTES) { stdout = stdout.slice(0, MAX_STDOUT_BYTES); more = `ffprobe: output cut at ${MAX_STDOUT_BYTES / 2 ** 20} MiB (MAX_STDOUT_BYTES); narrow it with -show_entries or -select_streams\n`; }
    const stderr = tidy(j.r.stderr, names);
    return { stdout, stderr: stderr + (j.r.code ? hint(stderr) : '') + more, exitCode: j.r.code ? 1 : 0 };
  });

  const ffmpeg = defineCommand('ffmpeg', async (args, ctx) => {
    const a = parseFfmpeg(args);
    if (a.help && !a.args.slice(1).length) return ok(HELP.ffmpeg);
    if (a.error) return { stdout: '', stderr: `ffmpeg: ${a.error}\n${HELP.ffmpeg}`, exitCode: 1 };
    if (!service) return fail('ffmpeg', 'the media runtime is not available here');
    if (a.help || a.info) { // -h filter=scale, -codecs, -L ...: FFmpeg answers
      const j = await job('ffmpeg', ctx, { action: 'run', program: 'ffmpeg', args: ['-hide_banner', ...args], inputs: [], outputs: [], maxSeconds: 0, maxOutputBytes: 0 }, `ffmpeg ${args[0]}`);
      if (j.error) return j.error;
      return { stdout: j.r.stdout ? j.r.stdout + '\n' : '', stderr: tidy(j.r.stderr), exitCode: j.r.code ? 1 : 0 };
    }
    const outPaths = a.outputs.map((o) => abs(ctx.cwd, o.path));
    const images = a.outputs.filter((o) => isImageOutput(o.path));
    if (images.length && images.length !== a.outputs.length) return fail('ffmpeg', 'write images and media in separate calls');
    if (!images.length && a.outputs.some((o) => o.path.includes('%'))) return fail('ffmpeg', 'numbered outputs (%d) are for images only');
    const overwrite = a.flags.has('y');
    if (!overwrite && !images.length) {
      for (const p of outPaths) if (await ctx.fs.exists(p)) return fail('ffmpeg', `File '${p}' already exists. Exiting (use -y to overwrite).`);
    }
    const read = await readInputs('ffmpeg', ctx, a.inputs.map((i) => i.path));
    if (read.error) return read.error;
    const inputs = read.files.map((f, i) => ({ name: `in${i}.${ext(f.path) || 'bin'}`, label: f.path, bytes: f.bytes }));

    if (images.length) {
      const plan = imagePlan(a);
      if (plan.error) return fail('ffmpeg', plan.error);
      const j = await job('ffmpeg', ctx, { action: 'frames', input: inputs[0], ss: plan.ss, t: plan.t, filters: plan.filters, want: plan.want,
        maxImages: MAX_IMAGES, maxPixels: MAX_FRAME_PIXELS, type: plan.type, quality: plan.quality, maxSeconds: MAX_INPUT_SECONDS }, `ffmpeg ${read.files[0].path.split('/').pop()} (frames)`);
      if (j.error) return j.error;
      const base = outPaths[0], lines = [];
      for (const [i, im] of j.r.images.entries()) {
        const p = plan.pattern ? frameName(base, plan.start + i) : base;
        if (!overwrite && await ctx.fs.exists(p)) return fail('ffmpeg', `File '${p}' already exists. Exiting (use -y to overwrite).`);
        await mkdirFor(ctx.fs, p);
        await ctx.fs.writeFile(p, im.bytes);
        lines.push(`wrote ${p} (t=${+im.t.toFixed(3)}s, ${im.width}x${im.height})`);
      }
      const quiet = a.args.some((x, i) => (x === '-v' || x === '-loglevel') && /^(quiet|panic|fatal|error|-8|0|8|16)$/.test(a.args[i + 1]));
      return ok(quiet ? '' : lines.join('\n') + '\n');
    }

    const outputs = outPaths.map((p, i) => `out${i}.${ext(p) || 'bin'}`);
    const argv = ['-hide_banner', '-nostdin', '-nostats', ...a.args.map((x) => (typeof x !== 'object' ? x : x.input !== undefined ? inputs[x.input].name : outputs[x.output]))];
    if (!overwrite) argv.splice(3, 0, '-y'); // libav's own memory is empty; Pouch checked the real paths above
    const j = await job('ffmpeg', ctx, { action: 'run', program: 'ffmpeg', args: argv, inputs, outputs, maxSeconds: MAX_INPUT_SECONDS, maxOutputBytes: MAX_OUTPUT_BYTES },
      `ffmpeg ${read.files[0].path.split('/').pop()}`);
    if (j.error) return j.error;
    const names = [...inputs.map((f) => [f.name, f.label]), ...outputs.map((n, i) => [n, outPaths[i]])];
    const stderr = tidy(j.r.stderr, names);
    // FFmpeg 9 in libav.js can return 0 having written nothing: an empty or missing output is a failure.
    const empty = j.r.files.filter((f) => !f.bytes?.length).map((f) => outPaths[outputs.indexOf(f.name)]);
    if (j.r.code || empty.length) {
      return { stdout: '', stderr: stderr + (empty.length ? `ffmpeg: nothing was written to ${empty.join(', ')}\n` : '') + hint(stderr), exitCode: 1 };
    }
    const lines = [];
    for (const [i, f] of j.r.files.entries()) {
      await mkdirFor(ctx.fs, outPaths[i]);
      await ctx.fs.writeFile(outPaths[i], f.bytes);
      lines.push(`wrote ${outPaths[i]} (${f.bytes.length.toLocaleString('en-US')} bytes)`);
    }
    return { stdout: lines.join('\n') + '\n', stderr, exitCode: 0 };
  });

  return [ffprobe, ffmpeg];
}
