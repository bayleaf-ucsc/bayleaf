// The WebCodecs path's pure parts, shared by src/media.ts (routing, ffprobe's
// writers) and src/media/worker.ts (decoding), and tested in Node:
// - sniff: which inputs go to this path (MOV/MP4/M4A and MP3: the containers
//   and codecs the webm-vp9-cli build cannot read).
// - codec strings for VideoDecoder/AudioDecoder from FFmpeg's extradata.
// - an MP3 frame walker (no libav.js variant demuxes MP3).
// - WAV in and out (the conversion path writes WAV itself: its libav build
//   has no pcm_s16le encoder).
// - the -vf subset this path draws itself (fps, scale, crop) and ffmpeg's
//   fps frame choice, so frames from H.264 match the libav path's.

// ── Routing ──────────────────────────────────────────────────────────
// 'mp4' (ISO BMFF / QuickTime: ftyp, or an old .mov that starts with moov,
// mdat, wide, free or skip), 'mp3' (ID3v2, or an MPEG audio layer III sync),
// or null (the libav CLI path: WebM, Ogg, WAV, FLAC ...).
export type MediaKind = 'mp4' | 'mp3';
export function sniff(b: Uint8Array | null | undefined): MediaKind | null {
  if (!b || b.length < 12) return null;
  const at = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(at(4, 4))) return 'mp4';
  if (at(0, 3) === 'ID3') return 'mp3';
  if (mp3Header(b, 0)) return 'mp3';
  return null;
}

// ── MP3 ──────────────────────────────────────────────────────────────
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MP3_KBPS: Record<number, number[]> = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
// The layer III frame header at i, or null.
export interface Mp3Header { size: number; sampleRate: number; channels: number; samples: number; kbps: number }
export interface Mp3Frame extends Mp3Header { offset: number }
export function mp3Header(b: Uint8Array, i: number): Mp3Header | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, br = b[i + 2] >> 4, sr = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (ver === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) return null;
  const sampleRate = MP3_RATES[ver][sr], kbps = MP3_KBPS[ver === 3 ? 1 : 2][br], samples = ver === 3 ? 1152 : 576;
  return { size: Math.floor((samples / 8) * kbps * 1000 / sampleRate) + pad, sampleRate, channels: (b[i + 3] >> 6) === 3 ? 1 : 2, samples, kbps };
}
// Every frame; an ID3v2 tag in front is skipped, junk between frames resyncs.
export function mp3Frames(b: Uint8Array): Mp3Frame[] {
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) i = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
  const out: Mp3Frame[] = [];
  while (i + 4 <= b.length) {
    const h = mp3Header(b, i);
    if (!h || i + h.size > b.length) { i++; continue; }
    out.push({ offset: i, ...h }); i += h.size;
  }
  return out;
}

// ── Codec strings (WebCodecs registry) from FFmpeg's codec name and extradata ──
const hex2 = (n: number) => n.toString(16).padStart(2, '0');
export function codecString(name: string, extradata: Uint8Array | null | undefined, tag?: string): string | null {
  const x = extradata ?? new Uint8Array(0);
  if (name === 'h264') return x.length >= 4 && x[0] === 1 ? `avc1.${hex2(x[1])}${hex2(x[2])}${hex2(x[3])}` : null;
  if (name === 'hevc') {
    if (x.length < 13 || x[0] !== 1) return null;
    const space = x[1] >> 6, tier = (x[1] >> 5) & 1, idc = x[1] & 31;
    let compat = ((x[2] << 24) | (x[3] << 16) | (x[4] << 8) | x[5]) >>> 0, rev = 0;
    for (let k = 0; k < 32; k++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
    const cons = [...x.subarray(6, 12)];
    while (cons.length && !cons.at(-1)) cons.pop();
    return [`${tag === 'hev1' ? 'hev1' : 'hvc1'}`, `${['', 'A', 'B', 'C'][space]}${idc}`, (rev >>> 0).toString(16), `${tier ? 'H' : 'L'}${x[12]}`, ...cons.map((c) => c.toString(16))].join('.');
  }
  if (name === 'aac') return `mp4a.40.${x.length ? (x[0] >> 3) || 2 : 2}`;
  if (name === 'mp3') return 'mp3';
  if (name === 'opus') return 'opus';
  if (name === 'flac') return 'flac';
  if (name === 'vp9') return 'vp09.00.10.08';
  if (name === 'av1') return 'av01.0.04M.08';
  if (name === 'vp8') return 'vp8';
  return null;
}

// The display matrix (nine 16.16/2.30 int32s) as ffprobe's rotation: degrees counterclockwise.
export function rotationOf(m: ArrayLike<number>): number {
  const s0 = Math.hypot(m[0], m[3]), s1 = Math.hypot(m[1], m[4]);
  if (!s0 || !s1) return 0;
  const r = -Math.atan2(m[1] / s1, m[0] / s0) * 180 / Math.PI;
  return Math.round(r) === 0 ? 0 : Math.round(r);
}

// ── WAV ──────────────────────────────────────────────────────────────
// Planar float samples, or throws.
export interface Wav { sampleRate: number; channels: number; bits: number; float: boolean; codec: string; data: Float32Array[] }
export function readWav(b: Uint8Array): Wav {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = (i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF WAVE file');
  let fmt: { code: number; channels: number; sampleRate: number; bits: number } | null = null, data: Uint8Array | null = null;
  for (let i = 12; i + 8 <= b.length;) {
    const id = tag(i), size = dv.getUint32(i + 4, true);
    if (id === 'fmt ') {
      let code = dv.getUint16(i + 8, true);
      if (code === 0xfffe && size >= 26) code = dv.getUint16(i + 32, true); // WAVE_FORMAT_EXTENSIBLE: the subformat GUID's first two bytes
      fmt = { code, channels: dv.getUint16(i + 10, true), sampleRate: dv.getUint32(i + 12, true), bits: dv.getUint16(i + 22, true) };
    } else if (id === 'data') data = b.subarray(i + 8, Math.min(b.length, i + 8 + size));
    i += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt or data');
  const { code, channels, sampleRate, bits } = fmt, float = code === 3, bps = bits / 8;
  if (!channels || !sampleRate) throw new Error('WAV with zero channels or sample rate');
  if (!(code === 1 || (float && (bits === 32 || bits === 64))) || ![8, 16, 24, 32, 64].includes(bits)) throw new Error(`WAV format ${code} with ${bits}-bit samples is not supported here`);
  const n = Math.floor(data.length / (bps * channels)), out = Array.from({ length: channels }, () => new Float32Array(n));
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let s = 0, o = 0; s < n; s++) for (let c = 0; c < channels; c++, o += bps) {
    out[c][s] = float ? (bits === 32 ? ddv.getFloat32(o, true) : ddv.getFloat64(o, true))
      : bits === 8 ? (data[o] - 128) / 128 : bits === 16 ? ddv.getInt16(o, true) / 32768
      : bits === 24 ? ((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8 >> 8) / 8388608 : ddv.getInt32(o, true) / 2147483648;
  }
  const codec = float ? `pcm_f${bits}le` : bits === 8 ? 'pcm_u8' : `pcm_s${bits}le`;
  return { sampleRate, channels, bits, float, codec, data: out };
}
// WAV codec -> the libav sample format its writer takes, and bytes per sample.
export const WAV_CODECS: Record<string, [sampleFmt: string, bytes: number]> = { pcm_u8: ['u8', 1], pcm_s16le: ['s16', 2], pcm_s24le: ['s32', 3], pcm_s32le: ['s32', 4], pcm_f32le: ['flt', 4] };
export function wavHeader(codec: string, sampleRate: number, channels: number, dataBytes: number): Uint8Array {
  const bps = WAV_CODECS[codec][1], h = new DataView(new ArrayBuffer(44)), put = (i: number, s: string) => [...s].forEach((c, k) => h.setUint8(i + k, c.charCodeAt(0)));
  put(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); put(8, 'WAVE'); put(12, 'fmt ');
  h.setUint32(16, 16, true); h.setUint16(20, codec === 'pcm_f32le' ? 3 : 1, true); h.setUint16(22, channels, true);
  h.setUint32(24, sampleRate, true); h.setUint32(28, sampleRate * channels * bps, true); h.setUint16(32, channels * bps, true);
  h.setUint16(34, bps * 8, true); put(36, 'data'); h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}
// Interleaved samples (Uint8Array u8, Int16Array s16, Int32Array s32, Float32Array flt) as WAV data bytes.
export type WavSamples = Uint8Array | Int16Array | Int32Array | Float32Array;
export function wavBytes(codec: string, samples: WavSamples): Uint8Array {
  if (codec !== 'pcm_s24le') return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength).slice();
  const out = new Uint8Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) { const v = samples[i]; out[i * 3] = (v >> 8) & 255; out[i * 3 + 1] = (v >> 16) & 255; out[i * 3 + 2] = (v >> 24) & 255; }
  return out;
}

// ── -vf on this path: fps, scale, crop (and null), drawn with a canvas ──
// Arithmetic over numbers, iw, ih (and in_w, in_h; crop's x and y also ow, oh,
// out_w, out_h), + - * / and parentheses.
function expr(s: unknown, vars: Record<string, number>): number {
  const t = String(s).replace(/\s+/g, '').match(/\d+(?:\.\d+)?|in_w|in_h|out_w|out_h|iw|ih|ow|oh|[-+*/()]/g);
  if (!t || t.join('') !== String(s).replace(/\s+/g, '')) return NaN;
  let i = 0;
  const atom = (): number => { const x = t[i++]; if (x === '(') { const v = sum(); i++; return v; } if (x === '-') return -atom(); return x in vars ? vars[x] : Number(x); };
  const prod = (): number => { let v = atom(); while (t[i] === '*' || t[i] === '/') v = t[i++] === '*' ? v * atom() : v / atom(); return v; };
  const sum = (): number => { let v = prod(); while (t[i] === '+' || t[i] === '-') v = t[i++] === '+' ? v + prod() : v - prod(); return v; };
  const v = sum();
  return i === t.length ? v : NaN;
}
const opts = (body: string | undefined, names: string[]) => {
  const o: Record<string, string> = {}, parts = body ? body.split(':') : [];
  parts.forEach((p, k) => { const m = /^([a-z_]+)=(.*)$/.exec(p); if (m) o[m[1]] = m[2]; else if (names[k]) o[names[k]] = p; });
  return o;
};
export const WC_FILTERS = 'fps, scale, crop and null';
// The conversion path's audio filters (libav.js webcodecs-avf: its audio-filters and swresample fragments).
export const AUDIO_FILTERS = 'acompressor, adeclick, adeclip, aecho, afade, aformat, agate, alimiter, amix, anull, apad, aresample, asettb, asplit, atempo, atrim, bandpass, bandreject, dynaudnorm, equalizer, loudnorm, pan, volume';
// rate: frames per second or null; ops in order: scale [w, h], crop [w, h, x?, y?].
export type VfOp = { scale: string[]; crop?: undefined } | { crop: (string | undefined)[]; scale?: undefined };
export type VfPlan = { rate: number | null; ops: VfOp[]; error?: undefined } | { error: string; rate?: undefined; ops?: undefined };
export function vfPlan(filters: string[]): VfPlan {
  let rate: number | null = null;
  const ops: VfOp[] = [];
  for (const f of filters) {
    const [, name, body] = /^([a-z_0-9]+)(?:=(.*))?$/.exec(f) ?? [];
    if (name === 'null' || name === 'format' || name === 'setsar') continue;
    if (name === 'fps') {
      const v = opts(body, ['fps']).fps ?? '', m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(v);
      rate = m ? +m[1] / (m[2] ? +m[2] : 1) : NaN;
      if (!(rate > 0 && rate <= 1000)) return { error: `fps=${v}: a rate such as 1, 0.5 or 1/10 (at most 1000)` };
      continue;
    }
    if (name === 'scale') { const o = opts(body, ['w', 'h']); ops.push({ scale: [o.w ?? o.width ?? 'iw', o.h ?? o.height ?? 'ih'] }); continue; }
    if (name === 'crop') { const o = opts(body, ['w', 'h', 'x', 'y']); ops.push({ crop: [o.w ?? o.out_w ?? 'iw', o.h ?? o.out_h ?? 'ih', o.x, o.y] }); continue; }
    return { error: `-vf ${f}: on MOV/MP4 input (decoded by the browser) the video filters are ${WC_FILTERS}; use -ss and -t for trims` };
  }
  return { rate, ops };
}
// The picture for a source of iw x ih: the source rect (sx, sy, sw, sh) and the output size.
export type Geometry = { sx: number; sy: number; sw: number; sh: number; w: number; h: number; error?: undefined } | { error: string };
export function geometry(ops: VfOp[], iw: number, ih: number): Geometry {
  let sx = 0, sy = 0, sw = iw, sh = ih, w = iw, h = ih;
  for (const op of ops) {
    const vars = { iw: w, ih: h, in_w: w, in_h: h };
    if (op.scale) {
      let [W, H] = op.scale.map((e) => expr(e, vars));
      if (!Number.isFinite(W) || !Number.isFinite(H) || (W <= 0 && H <= 0)) return { error: `scale=${op.scale.join(':')}: use numbers, iw, ih, or -1/-2 for one side` };
      const even = (v: number, n: number) => Math.max(n, Math.round(v / n) * n);
      if (W < 0) W = even(H * w / h, -W); else if (H < 0) H = even(W * h / w, -H);
      w = Math.round(W); h = Math.round(H); continue;
    }
    const [cw, ch] = op.crop.slice(0, 2).map((e) => expr(e, vars));
    if (!(cw > 0 && ch > 0)) return { error: `crop=${op.crop.filter((x) => x != null).join(':')}: needs a width and height` };
    const cx = op.crop[2] != null ? expr(op.crop[2], { ...vars, ow: cw, oh: ch, out_w: cw, out_h: ch }) : (w - cw) / 2;
    const cy = op.crop[3] != null ? expr(op.crop[3], { ...vars, ow: cw, oh: ch, out_w: cw, out_h: ch }) : (h - ch) / 2;
    if (![cx, cy].every(Number.isFinite)) return { error: `crop=${op.crop.join(':')}: x and y are numbers or iw/ih arithmetic` };
    // As ffmpeg's crop: the rect is clipped to the picture, then x and y keep it inside.
    const kx = sw / w, ky = sh / h, ow = Math.min(cw, w), oh = Math.min(ch, h);
    sx += Math.min(Math.max(0, cx), w - ow) * kx; sy += Math.min(Math.max(0, cy), h - oh) * ky; sw = ow * kx; sh = oh * ky; w = Math.min(Math.round(cw), w); h = Math.min(Math.round(ch), h);
  }
  return { sx, sy, sw, sh, w, h };
}
// ffmpeg's fps filter (round=near), streaming: feed frame times in order; it says
// which earlier frame fills each output slot. Slot n is at start + n/rate and takes
// the last frame whose time rounds to n or before (ties go later). It emits at
// most cap slots in all (the caller's frame or image limit), so a long gap or a
// high rate cannot grow one emit list without bound.
export function fpsPicker<F>(rate: number, cap = Infinity) {
  let start: number | null = null, next = 0, held: F | null = null, emitted = 0;
  const slotOf = (t: number) => Math.floor((t - start!) * rate + 0.5 + 1e-9);
  const fill = (upto: number, emit: [F, number][]) => { while (held && next < upto && emitted < cap) { emit.push([held, start! + next / rate]); next++; emitted++; } };
  return {
    // Frame at time t arrives: -> { emit: [[frame, slotTime]...], release } where
    // release is the frame it replaces (close it after drawing the emits).
    push(frame: F, t: number) {
      if (start == null) start = t;
      const emit: [F, number][] = [];
      fill(slotOf(t), emit);
      const release = held;
      held = frame;
      return { emit, release };
    },
    // The stream ended at endT (the last frame's end, or the -t limit): slots
    // before it are filled; a stream shorter than one slot still yields one frame.
    end(endT: number) {
      const emit: [F, number][] = [];
      if (held) { fill(Math.max(Number.isFinite(endT) ? slotOf(endT) : 0, emitted ? 0 : next + 1), emit); }
      const release = held; held = null;
      return { emit, release };
    },
  };
}
