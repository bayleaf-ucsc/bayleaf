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
// user's -vf, and encoded by the browser (story AG1).
//
// MOV/MP4/M4A and MP3 (phone videos, voice memos) take the WebCodecs path
// (src/media/wc.js, the worker's wc.* actions): ffprobe's report is built
// from a second, API-only libav build's demuxer and written here in ffprobe's
// own formats; frames are decoded by the browser's VideoDecoder; audio by its
// AudioDecoder, then that build's filters (aresample included) and encoders.
// Audio conversions the CLI build cannot do (it has no aresample) are retried
// there. Video re-encoding and MP4 muxing are not available: a one-line hint.
//
// The runtime (build-libav.mjs, src/media/worker.js) is fetched only when a
// media command first needs it, from this origin as content-hash parts
// checked against the manifest this page was built with (src/assets.js
// partAssets), and then kept for offline use. Every command is an engine job
// (src/jobs.js): a /task entry whose ctl stops it.
import { partAssets } from './assets.js';
import { createJobs } from './jobs.js';
import { normalize } from './vfs.js';
import { sniff, AUDIO_FILTERS, WC_FILTERS, WAV_CODECS } from './media/wc.js';

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
// What this build reads and writes (variant webm-vp9-cli, plus the WebCodecs path), for hints.
export const CODECS = 'WebM/Matroska, Ogg, WAV and FLAC files; VP8, VP9, Opus, FLAC and PCM audio';
export const WC_CODECS = 'MOV, MP4, M4A and MP3 files: H.264 video (HEVC where this browser decodes it), AAC and MP3 audio, decoded by the browser';
const GAP = `this build reads and writes ${CODECS}; it also reads ${WC_CODECS} (frames to images, audio to WAV, FLAC or Opus). It cannot write MP4, MOV, M4A, MP3 or AAC, or re-encode H.264`;
const NO_VIDEO_OUT = 'writing video from MOV/MP4 is not available here (no H.264 encoder or MP4 muxer); extract frames (.png) or audio (-vn out.wav, .flac or .opus), or re-export the video on your own computer (QuickTime Export As, or a local ffmpeg)';

export const HELP = {
  ffprobe: `usage: ffprobe [-v error] [-show_format] [-show_streams] [-of json] [-show_entries ...] [-select_streams ...] FILE
  FFmpeg's ffprobe (libav.js, FFmpeg 9) on a copy of FILE. For an overview:
    ffprobe -v error -show_format -show_streams -of json FILE
  Reads ${CODECS}; and ${WC_CODECS}.
  At most ${MAX_INPUT_BYTES / 2 ** 20} MiB per file; output over ${MAX_STDOUT_BYTES / 2 ** 20} MiB is cut.${LIBAV_SOURCE ? `
  License: LGPL-2.1 (ffmpeg -L); source: /${LIBAV_SOURCE.dir}${LIBAV_SOURCE.manifest}` : ''}
`,
  ffmpeg: `usage: ffmpeg [-y] [-ss T] [-t T] -i INPUT ... [OPTIONS] OUTPUT
  FFmpeg's ffmpeg (libav.js, FFmpeg 9) over copies of the files: outputs are
  written to the paths you name. Runs as a /task job; stop it through its ctl.
  Reads and writes ${CODECS}.
  Also reads ${WC_CODECS}: frames to images (-vf ${WC_FILTERS}), audio to WAV, FLAC or Opus.
  Images (OUTPUT ending .png, .jpg or .webp; a %03d in the name numbers them):
    ffmpeg -i in.webm -vf fps=1/10,scale=640:-1 frames/f-%03d.png
    ffmpeg -ss 12.5 -i in.webm -frames:v 1 still.png
  take -ss, -t/-to, -i, -vf (fps, scale, crop, trim), -r, -frames:v, -q:v;
  each is named with its time in the source. At most ${MAX_IMAGES} images per call.
  Audio: ffmpeg -i in.webm -vn -c:a copy audio.opus; ffmpeg -i talk.mov -vn talk.wav.
  -af, -ar, -ac, -sample_fmt and PCM codecs (pcm_s16le, pcm_s24le, pcm_f32le) work
  for WAV, FLAC and Opus outputs; audio filters: ${AUDIO_FILTERS}.
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

// ── ffprobe's report for the WebCodecs path ──────────────────────────
// ffprobe prints these as strings in JSON; the rest are numbers.
const PROBE_STRINGS = new Set(['duration', 'start_time', 'bit_rate', 'size', 'sample_rate', 'nb_frames', 'time_base', 'r_frame_rate', 'avg_frame_rate', 'codec_tag']);
const probeValue = (k, v) => (k === 'duration' || k === 'start_time' ? Number(v).toFixed(6) : String(v));
// probe: the worker's { format, streams, notes }; args: parseProbe's args (strings only matter); filename: the caller's path.
// -> { stdout, stderr } as ffprobe would write them, or { error }.
export function writeProbe(probe, args, filename) {
  const opt = (names) => { const i = args.findIndex((a) => typeof a === 'string' && names.includes(a)); return i >= 0 ? String(args[i + 1]) : null; };
  const has = (n) => args.includes(n);
  const entries = opt(['-show_entries']), select = opt(['-select_streams']), of = opt(['-of', '-print_format', '-output_format']) ?? 'default';
  const level = opt(['-v', '-loglevel']) ?? 'info';
  let want = null; // section -> Set of keys (empty set: every key)
  if (entries) {
    want = {};
    for (const part of entries.split(':')) {
      const [sec, keys = ''] = part.split('=');
      const name = sec.replace(/^streams?$/, 'stream').replace(/^stream_side_data(_list)?$/, 'side_data');
      want[name] = new Set(keys.split(',').filter(Boolean));
    }
  }
  const showFormat = has('-show_format') || !!want?.format, showStreams = has('-show_streams') || !!want?.stream || !!want?.side_data;
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))));
  const pick = (o, keys) => (keys && keys.size ? Object.fromEntries([...keys].filter((k) => k in o).map((k) => [k, o[k]])) : o);
  const sel = (s) => {
    if (!select) return true;
    const m = /^(?:([vasdt])(?::(\d+))?|(\d+))$/.exec(select);
    if (!m) return true;
    if (m[3] != null) return s.index === Number(m[3]);
    const type = { v: 'video', a: 'audio', s: 'subtitle', d: 'data', t: 'attachment' }[m[1]];
    return s.codec_type === type;
  };
  let streams = probe.streams.filter(sel);
  if (select && /:\d+$/.test(select)) streams = streams.slice(Number(select.split(':')[1]), Number(select.split(':')[1]) + 1);
  const format = clean({ filename, ...probe.format });
  const sections = [];
  if (showStreams) for (const s of streams) {
    const { side_data_list: sd, ...rest } = clean(s);
    const keys = want?.stream ?? (want ? new Set(['__none__']) : null);
    const body = pick(rest, keys);
    const side = want ? (want.side_data && sd ? sd.map((d) => pick(d, want.side_data)) : null) : sd;
    sections.push(['stream', body, side]);
  }
  if (showFormat) { const { tags, ...rest } = format; sections.push(['format', pick(rest, want?.format), null, want ? null : tags]); }
  const [writer, ...wopts] = of.split(/[=:]/);
  const wo = Object.fromEntries(of.includes('=') ? of.slice(of.indexOf('=') + 1).split(':').map((x) => x.split('=')) : []);
  const nokey = wo.nokey === '1' || wo.nk === '1', nowrap = wo.noprint_wrappers === '1' || wo.nw === '1', p0 = wo.p === '0' || wo.print_section === '0';
  void wopts;
  const val = (k, v) => probeValue(k, v);
  let stdout = '';
  if (writer === 'json') {
    const json = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'object' ? v : PROBE_STRINGS.has(k) ? val(k, v) : v]));
    const out = {};
    if (showStreams) out.streams = sections.filter(([n]) => n === 'stream').map(([, b, sd]) => ({ ...json(b), ...(sd ? { side_data_list: sd.map(json) } : {}) }));
    if (showFormat) { const [, b, , tags] = sections.find(([n]) => n === 'format'); out.format = { ...json(b), ...(tags ? { tags } : {}) }; }
    stdout = JSON.stringify(out, null, 4) + '\n';
  } else if (writer === 'default' || writer === 'compact' || writer === 'csv' || writer === 'flat') {
    const lines = [];
    const kv = (k, v) => (nokey ? val(k, v) : `${k}=${val(k, v)}`);
    sections.forEach(([name, body, sd, tags], n) => {
      const pairs = Object.entries(body), extra = [...(sd ?? []).flatMap((d) => Object.entries(d)), ...Object.entries(tags ?? {}).map(([k, v]) => [`TAG:${k}`, v])];
      if (writer === 'default') {
        if (!nowrap) lines.push(`[${name.toUpperCase()}]`);
        for (const [k, v] of [...pairs, ...extra]) lines.push(kv(k, v));
        if (!nowrap) lines.push(`[/${name.toUpperCase()}]`);
      } else if (writer === 'flat') {
        const pre = name === 'stream' ? `streams.stream.${sections.slice(0, n).filter(([x]) => x === 'stream').length}.` : 'format.';
        for (const [k, v] of [...pairs, ...extra]) lines.push(`${pre}${k.replace(/:/g, '_')}=${typeof v === 'number' && !PROBE_STRINGS.has(k) ? v : JSON.stringify(val(k, v))}`);
      } else {
        const sep = writer === 'csv' ? ',' : '|', cells = [...pairs, ...extra].map(([k, v]) => (writer === 'csv' || nokey ? val(k, v) : `${k}=${val(k, v)}`));
        lines.push((p0 ? cells : [name, ...cells]).join(sep));
      }
    });
    stdout = lines.length ? lines.join('\n') + '\n' : '';
  } else return { error: `-of ${of}: on MOV/MP4/MP3 input this ffprobe writes json, default, csv, compact or flat` };
  let stderr = '';
  if (!/^(quiet|panic|fatal|error|-8|0|8|16)$/.test(level)) {
    const f = probe.format, hms = (x) => { const t = Number(x) || 0; return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`; };
    stderr = `Input #0, ${f.format_name}, from '${filename}':\n  Duration: ${hms(f.duration)}, start: ${Number(f.start_time ?? 0).toFixed(6)}, bitrate: ${Math.round((f.bit_rate ?? 0) / 1000)} kb/s\n`
      + probe.streams.map((s) => `  Stream #0:${s.index}: ${s.codec_type === 'video' ? `Video: ${s.codec_name}${s.profile ? ` (${s.profile})` : ''}, ${s.width}x${s.height}, ${Number(eval2(s.avg_frame_rate)).toFixed(2).replace(/\.00$/, '')} fps${s.side_data_list ? `, rotation ${s.side_data_list[0].rotation}` : ''}`
        : s.codec_type === 'audio' ? `Audio: ${s.codec_name}${s.profile ? ` (${s.profile})` : ''}, ${s.sample_rate} Hz, ${s.channel_layout}` : `${s.codec_type}: ${s.codec_name}`}\n`).join('');
  }
  for (const n of probe.notes ?? []) stderr += `ffprobe: note: ${n}\n`;
  return { stdout, stderr };
}
const eval2 = (r) => { const [a, b] = String(r).split('/').map(Number); return b ? a / b : a || 0; };

// The WebCodecs path's audio plan: one input, one WAV/FLAC/Opus output, the options it takes.
const AUDIO_OUT = { wav: 'wav', flac: 'flac', opus: 'ogg', ogg: 'ogg', oga: 'ogg', webm: 'webm', weba: 'webm', mka: 'webm' };
const AUDIO_OPTS = new Set(['ss', 't', 'to', 'vn', 'sn', 'dn', 'y', 'n', 'af', 'filter', 'ar', 'ac', 'sample_fmt', 'c', 'codec', 'acodec', 'b', 'ab', 'map', 'f', 'v', 'loglevel',
  'hide_banner', 'nostdin', 'nostats', 'stats', 'map_metadata', 'compression_level', 'vbr', 'application']);
export const isAudioOutput = (p) => !!AUDIO_OUT[ext(p)];
// Safe to retry on the conversion path (which writes audio only): the output cannot carry video, or -vn says so.
const audioOnly = (a) => a.outputs.length === 1 && (/^(wav|flac|opus|oga|weba|mka)$/.test(ext(a.outputs[0].path)) || (isAudioOutput(a.outputs[0].path) && a.flags.has('vn')));
export function audioPlan(parsed) {
  const { inputs, outputs } = parsed;
  if (inputs.length !== 1 || outputs.length !== 1) return { error: 'audio from MOV/MP4/MP3 (or with conversion): one input and one output per call' };
  const path = outputs[0].path, x = ext(path), format = AUDIO_OUT[x];
  if (!format) return { error: /^(mp4|m4a|mov|aac|mp3|m4v|3gp|mkv|avi)$/.test(x) ? `.${x}: ${NO_VIDEO_OUT.replace(/^writing video/, `writing .${x}`)}` : `.${x}: audio is written as .wav, .flac, .opus (or .ogg, .webm)` };
  let ss = 0, t = null, to = null, filters = null, rate = null, channels = null, codec = null, sampleFmt = null, bitRate = null, vn = false;
  for (const [base, v, name] of [...inputs[0].opts, ...outputs[0].opts]) {
    if (!AUDIO_OPTS.has(base)) return { error: `-${name ?? base} is not supported on this path (it takes -ss, -t, -to, -vn, -af, -ar, -ac, -sample_fmt, -c:a, -b:a)` };
    if (v === undefined) { if (base === 'vn') vn = true; continue; }
    if (base === 'ss') { ss = parseTime(v); if (!(ss >= 0)) return { error: `-ss ${v}: not a time (seconds, or HH:MM:SS.ms)` }; }
    if (base === 't') { t = parseTime(v); if (!(t > 0)) return { error: `-t ${v}: not a positive duration` }; }
    if (base === 'to') { to = parseTime(v); if (!(to > 0)) return { error: `-to ${v}: not a time` }; }
    if (base === 'af' || (base === 'filter' && /^filter:a/.test(name))) filters = v;
    if (base === 'filter' && !/^filter:a/.test(name)) return { error: `-${name}: use -af for audio filters (and extract frames for video)` };
    if (base === 'ar') { rate = Number(v.replace(/k$/i, '000')); if (!(Number.isInteger(rate) && rate >= 1000 && rate <= 384000)) return { error: `-ar ${v}: a sample rate in Hz such as 16000 or 48000` }; }
    if (base === 'ac') { channels = Number(v); if (!(Number.isInteger(channels) && channels >= 1 && channels <= 8)) return { error: `-ac ${v}: 1 to 8 channels` }; }
    if (base === 'sample_fmt') { sampleFmt = { s16: 's16', s16p: 's16', s32: 's32', s32p: 's32', flt: 'flt', fltp: 'flt', u8: 'u8', u8p: 'u8' }[v]; if (!sampleFmt) return { error: `-sample_fmt ${v}: s16, s32, flt or u8` }; }
    if (base === 'c' || base === 'codec' || base === 'acodec') {
      if (/^c(odec)?:v|^vcodec/.test(name)) continue;
      if (v === 'copy') return { error: `-${name} copy: this path decodes and re-encodes; drop -c copy and write .wav, .flac or .opus` };
      codec = v;
    }
    if (base === 'b' || base === 'ab') { if (/^b:v/.test(name)) continue; const m = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(v); if (!m) return { error: `-${name} ${v}: a bitrate such as 64k` }; bitRate = Math.round(+m[1] * ({ k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1)); }
    if (base === 'map' && !/^-?0(:a(:\d+)?)?$|^a$/.test(v)) return { error: `-map ${v}: this path takes the first audio stream (-map 0:a)` };
  }
  void vn;
  if (to != null) { if (to <= ss) return { error: `-to ${to} is not after -ss ${ss}` }; t = t ?? to - ss; }
  let out;
  if (format === 'wav') {
    codec = codec ?? { s32: 'pcm_s32le', flt: 'pcm_f32le', u8: 'pcm_u8' }[sampleFmt] ?? 'pcm_s16le';
    if (!WAV_CODECS[codec]) return { error: `-c:a ${codec}: WAV is written as ${Object.keys(WAV_CODECS).join(', ')}` };
    out = { format, codec, sampleFmt: WAV_CODECS[codec][0] };
  } else if (format === 'flac') {
    if (codec && codec !== 'flac') return { error: `-c:a ${codec}: .flac is FLAC` };
    out = { format, codec: 'flac', sampleFmt: sampleFmt === 's32' || sampleFmt === 'flt' ? 's32' : sampleFmt === 's16' ? 's16' : null }; // null: s32 from a deeper source, else s16
  } else {
    if (codec && !/^(libopus|opus)$/.test(codec)) return { error: `-c:a ${codec}: .${x} is written as Opus here (no Vorbis, AAC or MP3 encoder)` };
    out = { format, codec: 'libopus', sampleFmt: 'flt', bitRate };
  }
  return { path, ss, t, filters, rate, channels, out };
}

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
        // A failed load (say, compile out of memory) must not leave a worker that fails every job.
        try { await call('load', { wasm: await got.files['libav.wasm'].arrayBuffer(), avf: await got.files['libav-avf.wasm']?.arrayBuffer() }); }
        catch (e) { w.terminate(); if (worker === w) worker = null; throw e; }
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
          w.postMessage({ id, action, ...data }, data.wasm ? [data.wasm, data.avf].filter(Boolean) : transfer);
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
    const kind = sniff(inputs[0]?.bytes);
    if (kind) { // MOV/MP4/M4A or MP3: the WebCodecs path builds the report
      const j = await job('ffprobe', ctx, { action: 'wc.probe', input: inputs[0], kind }, `ffprobe ${read.files[0].path.split('/').pop()}`);
      if (j.error) return j.error;
      const w = writeProbe(j.r, a.args, read.files[0].path);
      if (w.error) return fail('ffprobe', w.error);
      return { stdout: w.stdout.length > MAX_STDOUT_BYTES ? w.stdout.slice(0, MAX_STDOUT_BYTES) : w.stdout, stderr: w.stderr, exitCode: 0 };
    }
    const argv = ['-hide_banner', ...a.args.map((x) => (typeof x === 'object' ? inputs[x.file].name : x))];
    const j = await job('ffprobe', ctx, { action: 'run', program: 'ffprobe', args: argv, inputs, outputs: [], maxSeconds: 0, maxOutputBytes: 0 },
      `ffprobe ${read.files[0]?.path.split('/').pop() ?? ''}`.trim());
    if (j.error) return j.error;
    const names = inputs.map((f) => [f.name, f.label]);
    // Paths go back into the report escaped as its writer would (a quote in a name must not break JSON).
    const of = a.args.findIndex((x) => x === '-of' || x === '-print_format' || x === '-output_format');
    const writer = of >= 0 ? String(a.args[of + 1]).split(/[=:]/)[0] : 'default';
    const escOut = writer === 'json' ? (s) => JSON.stringify(s).slice(1, -1)
      : writer === 'xml' ? (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      : (s) => s;
    let stdout = j.r.stdout ? names.map(([from, to]) => [from, escOut(to)]).reduce((t, [from, to]) => t.split(from).join(to), j.r.stdout) + '\n' : '', more = '';
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
      // The CLI build lists audio filters it can only run when no conversion is needed (it has no aresample): say where they run.
      const note = a.flags.has('filters') ? `\nPouch: audio filters with -af run on the conversion path (WAV, FLAC or Opus out), which has aresample and: ${AUDIO_FILTERS}.\nVideo filters: WebM/Ogg input as listed above; MOV/MP4 input (the browser's decoder): ${WC_FILTERS}.\n` : '';
      return { stdout: j.r.stdout ? j.r.stdout + '\n' + note : note, stderr: tidy(j.r.stderr), exitCode: j.r.code ? 1 : 0 };
    }
    const outPaths = a.outputs.map((o) => abs(ctx.cwd, o.path));
    // Each file reaches FFmpeg under its own internal name, so it cannot see an output that is an input.
    const inPaths = a.inputs.map((i) => abs(ctx.cwd, i.path)), same = outPaths.find((p) => inPaths.includes(p));
    if (same) return fail('ffmpeg', `Output ${same} is the same as an input; FFmpeg does not edit in place (not even with -y). Write a new file, then mv it over.`);
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

    const kind = inputs.length === 1 ? sniff(inputs[0].bytes) : inputs.map((f) => sniff(f.bytes)).find(Boolean) ?? null;
    if (images.length) {
      const plan = imagePlan(a);
      if (plan.error) return fail('ffmpeg', plan.error);
      if (kind === 'mp3') return fail('ffmpeg', `${read.files[0].path} has no video stream`);
      const j = await job('ffmpeg', ctx, { action: kind ? 'wc.frames' : 'frames', input: inputs[0], ss: plan.ss, t: plan.t, filters: plan.filters, want: plan.want,
        maxImages: MAX_IMAGES, maxPixels: MAX_FRAME_PIXELS, maxBytes: MAX_OUTPUT_BYTES, type: plan.type, quality: plan.quality, maxSeconds: MAX_INPUT_SECONDS }, `ffmpeg ${read.files[0].path.split('/').pop()} (frames)`);
      if (j.error) return j.error;
      const base = outPaths[0], lines = [];
      const targets = j.r.images.map((_, i) => (plan.pattern ? frameName(base, plan.start + i) : base));
      // All numbered targets are checked first, so a refusal writes no frame at all.
      if (!overwrite) for (const p of targets) if (await ctx.fs.exists(p)) return fail('ffmpeg', `File '${p}' already exists. Exiting (use -y to overwrite).`);
      for (const [i, im] of j.r.images.entries()) {
        const p = targets[i];
        await mkdirFor(ctx.fs, p);
        await ctx.fs.writeFile(p, im.bytes);
        lines.push(`wrote ${p} (t=${+im.t.toFixed(3)}s, ${im.width}x${im.height})`);
      }
      const quiet = a.args.some((x, i) => (x === '-v' || x === '-loglevel') && /^(quiet|panic|fatal|error|-8|0|8|16)$/.test(a.args[i + 1]));
      return ok(quiet ? '' : lines.join('\n') + '\n');
    }

    // The WebCodecs path's audio: MOV/MP4/MP3 inputs, or a conversion the CLI build cannot do (below).
    async function viaAudio(plan, note = '') {
      const j = await job('ffmpeg', ctx, { action: 'wc.audio', input: inputs[0], kind, ss: plan.ss, t: plan.t, filters: plan.filters, rate: plan.rate, channels: plan.channels,
        out: { name: `out0.${ext(plan.path)}`, ...plan.out }, maxSeconds: MAX_INPUT_SECONDS, maxOutputBytes: MAX_OUTPUT_BYTES }, `ffmpeg ${read.files[0].path.split('/').pop()} (audio)`);
      if (j.error) return { ...j.error, stderr: note + j.error.stderr };
      const f = j.r.files[0];
      await mkdirFor(ctx.fs, outPaths[0]);
      await ctx.fs.writeFile(outPaths[0], f.bytes);
      return { stdout: `wrote ${outPaths[0]} (${f.bytes.length.toLocaleString('en-US')} bytes, ${j.r.rate} Hz, ${j.r.channels === 1 ? 'mono' : j.r.channels === 2 ? 'stereo' : `${j.r.channels} channels`})\n`, stderr: '', exitCode: 0 };
    }
    if (kind) {
      if (inputs.length > 1) return fail('ffmpeg', 'MOV/MP4/MP3 inputs: one input per call');
      const plan = audioPlan(a);
      if (plan.error) return fail('ffmpeg', plan.error);
      if (/\.(webm|mka)$/i.test(plan.path) && !a.flags.has('vn') && kind === 'mp4') return fail('ffmpeg', `${NO_VIDEO_OUT}. For audio only, add -vn`);
      return viaAudio(plan);
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
      // No aresample in the CLI build: format, rate and layout conversions and most audio filters fail there. The avf build has them.
      if ((/'aresample' filter not present|No such filter: 'aresample'|Error reinitializing filters|Failed to inject frame into filter network/.test(stderr) || empty.length) && audioOnly(a)) {
        const plan = audioPlan(a);
        if (!plan.error) return viaAudio(plan);
      }
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
