// The libav.js worker: FFmpeg 9 (libav.js 6.10.9.0, variant webm-vp9-cli) run
// in this one worker ("direct" mode), behind a small message protocol.
// build-libav.mjs bundles it into runtime/libav/worker.js; src/media.ts starts
// it from the verified blob and talks to it.
//
// Containment:
// - No network. The wasm arrives as bytes from the page (verified against this
//   build's manifest) and is compiled once; fetch, XMLHttpRequest and friends
//   are then removed from this worker. The variant has only the file and data
//   protocols, and its files live in a private in-memory filesystem (MEMFS)
//   that holds only what a job copies in.
// - One fresh libav instance per job, so no job sees another's files or state,
//   and the memory a job grew is released with its instance.
// - Image outputs: the variant has no PNG encoder or image muxer, so frames
//   are decoded through libav's API (demux, decode, the user's filters, RGBA)
//   and encoded here with OffscreenCanvas.
// - MOV/MP4/M4A and MP3 (H.264, HEVC, AAC, MP3: no libav.js variant decodes
//   them) take the WebCodecs path: a second, API-only libav build
//   (webcodecs-avf: the MOV demuxer, swresample, the audio filters, the FLAC
//   and Opus encoders) demuxes, the browser's VideoDecoder and AudioDecoder
//   decode, frames are drawn with OffscreenCanvas (fps, scale, crop, the
//   display rotation) and audio goes through that build's filters
//   (aresample included) to WAV (written here), FLAC or Opus. Audio
//   conversions the CLI build cannot do (no aresample) fall back to it too.
import libav from '../../node_modules/@libav.js/variant-webm-vp9-cli/dist/libav-6.10.9.0-webm-vp9-cli.mjs';
import factory from '../../node_modules/@libav.js/variant-webm-vp9-cli/dist/libav-6.10.9.0-webm-vp9-cli.wasm.mjs';
import avf from '../../node_modules/@libav.js/variant-webcodecs-avf/dist/libav-6.10.9.0-webcodecs-avf.mjs';
import avfFactory from '../../node_modules/@libav.js/variant-webcodecs-avf/dist/libav-6.10.9.0-webcodecs-avf.wasm.mjs';
import { codecString, mp3Frames, readWav, rotationOf, vfPlan, geometry, fpsPicker, wavHeader, wavBytes, AUDIO_FILTERS } from './wc.ts';

let wasm = null; // Promise of the WebAssembly.Module, compiled once (jobs posted meanwhile wait for it)
let avfWasm = null; // the same for the webcodecs-avf build
const stopped = new Set(); // job ids asked to stop
const check = (id) => { if (stopped.has(id)) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' }); };
const tick = () => new Promise((r) => setTimeout(r, 0)); // lets a stop message in
const fail = (msg, code) => Object.assign(new Error(msg), { code });
const DECODE_STEP = 8; // packets per decode call when extracting frames (bounds the RGBA held at once)

// A new libav instance whose print and printErr land in out/err.
async function instance(out, err) {
  const mod = await wasm;
  return libav.LibAV({ noworker: true, factory: (opts) => factory({ ...opts,
    instantiateWasm(imports, done) { WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod)); return {}; },
    print: (s) => out.push(s), printErr: (s) => err.push(s) }) });
}
async function avfInstance(err) {
  const mod = await avfWasm;
  return avf.LibAV({ noworker: true, factory: (opts) => avfFactory({ ...opts,
    instantiateWasm(imports, done) { WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod)); return {}; },
    print: () => {}, printErr: (s) => err.push(s) }) });
}

// ── The WebCodecs path ───────────────────────────────────────────────
const H264_PROFILES = { 66: 'Constrained Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4 Predictive' };
const HEVC_PROFILES = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Rext' };
const AAC_PROFILES = { 0: 'Main', 1: 'LC', 3: 'LTP', 4: 'HE-AAC', 28: 'HE-AACv2' };
const LONG = { h264: 'H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10', hevc: 'H.265 / HEVC (High Efficiency Video Coding)', aac: 'AAC (Advanced Audio Coding)',
  mp3: 'MP3 (MPEG audio layer 3)', opus: 'Opus (Opus Interactive Audio Codec)', alac: 'ALAC (Apple Lossless Audio Codec)', prores: 'Apple ProRes (iCodec Pro)',
  mjpeg: 'Motion JPEG', vp9: 'Google VP9', av1: 'Alliance for Open Media AV1', flac: 'FLAC (Free Lossless Audio Codec)', mov_text: '3GPP Timed Text subtitle' };
const fourcc = (n) => String.fromCharCode(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255).replace(/[^\x20-\x7e]/g, '.');
const SAMPLE_FMTS = ['u8', 's16', 's32', 'flt', 'dbl', 'u8p', 's16p', 's32p', 'fltp', 'dblp', 's64', 's64p'];
const layoutOf = (n) => (n === 1 ? 4 : n === 2 ? 3 : (2 ** n) - 1);
const layoutName = (n) => (n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} channels`);
const ratio = (x) => { if (!(x > 0)) return '0/0'; for (const d of [1, 1001, 100, 1000]) { const n = x * d; if (Math.abs(n - Math.round(n)) < 0.01 * d / 100) return `${Math.round(n)}/${d}`; } return `${Math.round(x * 1000)}/1000`; };

async function videoSupport(config) {
  if (typeof VideoDecoder === 'undefined') return { supported: false, why: 'this browser has no WebCodecs VideoDecoder' };
  try { const r = await VideoDecoder.isConfigSupported(config); return r.supported ? { supported: true } : { supported: false, why: `this browser's VideoDecoder cannot decode ${config.codec}` }; }
  catch (e) { return { supported: false, why: String(e.message ?? e) }; }
}
async function audioSupport(config) {
  if (typeof AudioDecoder === 'undefined') return { supported: false, why: 'this browser has no WebCodecs AudioDecoder' };
  try { const r = await AudioDecoder.isConfigSupported(config); return r.supported ? { supported: true } : { supported: false, why: `this browser's AudioDecoder cannot decode ${config.codec}` }; }
  catch (e) { return { supported: false, why: String(e.message ?? e) }; }
}

// An MP4/MOV demuxed by the avf build: { fmt, streams: [{ ...stream, par, name, config, rotation }], duration }.
async function openMp4(m, input, err) {
  await m.writeFile(input.name, input.bytes);
  let fmt, streams;
  try { [fmt, streams] = await m.ff_init_demuxer_file(input.name); }
  catch { throw fail(`${input.label}: cannot open it as MOV/MP4 (${err.slice(-1)[0] || 'damaged or not MP4'})`, 'EFORMAT'); }
  const d = m.i64tof64(await m.AVFormatContext_duration(fmt), await m.AVFormatContext_durationhi(fmt));
  const out = [];
  for (const s of streams) {
    const par = await m.ff_copyout_codecpar(s.codecpar), name = await m.avcodec_get_name(par.codec_id);
    let rotation = 0;
    const nsd = await m.AVCodecParameters_nb_coded_side_data(s.codecpar);
    if (nsd) {
      const sd = await m.AVCodecParameters_coded_side_data(s.codecpar);
      for (let k = 0; k < nsd; k++) {
        const p = sd + k * 12; // AVPacketSideData { uint8_t *data; size_t size; enum type } in wasm32
        if (await m.AVPacketSideData_type(p) === 5 && await m.AVPacketSideData_size(p) >= 36) rotation = rotationOf(await m.copyout_s32(await m.AVPacketSideData_data(p), 9)); // AV_PKT_DATA_DISPLAYMATRIX
      }
    }
    const sdur = m.i64tof64(await m.AVStream_duration(s.ptr), await m.AVStream_durationhi(s.ptr));
    const tag = fourcc(par.codec_tag), codec = codecString(name, par.extradata, tag);
    const config = s.codec_type === m.AVMEDIA_TYPE_VIDEO
      ? codec && { codec, codedWidth: par.width, codedHeight: par.height, ...(par.extradata?.length && /^(avc1|hvc1|hev1|vp09|av01)/.test(codec) && name !== 'vp9' && name !== 'av1' ? { description: par.extradata } : {}) }
      : s.codec_type === m.AVMEDIA_TYPE_AUDIO ? codec && { codec, sampleRate: par.sample_rate, numberOfChannels: par.channels || 1, ...(par.extradata?.length && name !== 'mp3' ? { description: par.extradata } : {}) } : null;
    out.push({ ...s, par, name, tag, config, rotation, duration: sdur > 0 && sdur !== m.AV_NOPTS_VALUE ? sdur * s.time_base_num / s.time_base_den : NaN });
  }
  return { fmt, streams: out, duration: d > 0 && d !== m.AV_NOPTS_VALUE ? d / m.AV_TIME_BASE : NaN };
}

// Every packet of the file, a batch at a time: each(packets by stream index) until it returns true.
async function eachPackets(m, fmt, pkt, id, each) {
  for (;;) {
    check(id); await tick();
    const [res, packets] = await m.ff_read_frame_multi(fmt, pkt, { limit: 2 * 2 ** 20 });
    const eof = res === m.AVERROR_EOF;
    if (res < 0 && !eof && res !== -m.EAGAIN) throw fail(`read error ${res}`, 'EIO');
    if (await each(packets, eof) || eof) return;
  }
}

const wcActions = {
  // ffprobe's report as data: { kind, format, streams, notes } (src/media.ts writes it as ffprobe would).
  async probe({ input, kind }, id) {
    const notes = [];
    if (kind === 'mp3') {
      const frames = mp3Frames(input.bytes);
      if (!frames.length) throw fail(`${input.label}: no MP3 frames found`, 'EFORMAT');
      const f0 = frames[0], samples = frames.reduce((a, f) => a + f.samples, 0), duration = samples / f0.sampleRate;
      const bitRate = Math.round(frames.reduce((a, f) => a + f.size, 0) * 8 / duration);
      const sup = await audioSupport({ codec: 'mp3', sampleRate: f0.sampleRate, numberOfChannels: f0.channels });
      if (!sup.supported) notes.push(`${sup.why}; audio from it will fail`);
      return { kind, notes, format: { nb_streams: 1, format_name: 'mp3', format_long_name: 'MP2/3 (MPEG audio layer 2/3)', start_time: 0, duration, size: input.bytes.length, bit_rate: bitRate, probe_score: 51 },
        streams: [{ index: 0, codec_name: 'mp3', codec_long_name: LONG.mp3, codec_type: 'audio', sample_fmt: 'fltp', sample_rate: f0.sampleRate, channels: f0.channels, channel_layout: layoutName(f0.channels),
          time_base: `1/${f0.sampleRate}`, start_time: 0, duration, bit_rate: bitRate, nb_frames: frames.length }] };
    }
    const err = [], m = await avfInstance(err);
    try {
      const { fmt, streams, duration } = await openMp4(m, input, err);
      const counts = streams.map(() => 0), pkt = await m.av_packet_alloc();
      await eachPackets(m, fmt, pkt, id, (packets) => { for (const [i, p] of Object.entries(packets)) counts[i] += p.length; });
      const out = [];
      for (const [i, s] of streams.entries()) {
        const p = s.par, base = { index: i, codec_name: s.name, codec_long_name: LONG[s.name] ?? s.name, codec_tag_string: s.tag, codec_tag: `0x${(p.codec_tag >>> 0).toString(16).padStart(4, '0')}`,
          time_base: `${s.time_base_num}/${s.time_base_den}`, duration: s.duration, nb_frames: counts[i], ...(p.bit_rate > 0 ? { bit_rate: p.bit_rate } : {}) };
        if (s.codec_type === m.AVMEDIA_TYPE_VIDEO) {
          const rate = counts[i] && s.duration > 0 ? counts[i] / s.duration : 0;
          const sup = s.config ? await videoSupport(s.config) : { supported: false, why: `no WebCodecs decoder for ${s.name} video` };
          if (!sup.supported) notes.push(`stream ${i} (${s.name}): ${sup.why}; frames from it will fail`);
          out.push({ ...base, codec_type: 'video', profile: (s.name === 'h264' ? H264_PROFILES : s.name === 'hevc' ? HEVC_PROFILES : {})[p.profile] ?? String(p.profile),
            width: p.width, height: p.height, coded_width: p.width, coded_height: p.height, pix_fmt: p.format >= 0 ? ['yuv420p'][p.format] ?? undefined : undefined, level: p.level,
            r_frame_rate: ratio(rate), avg_frame_rate: ratio(rate), ...(s.config ? { webcodecs_codec: s.config.codec } : {}),
            ...(s.rotation ? { side_data_list: [{ side_data_type: 'Display Matrix', rotation: s.rotation }] } : {}) });
        } else if (s.codec_type === m.AVMEDIA_TYPE_AUDIO) {
          const sup = s.config ? await audioSupport(s.config) : { supported: false, why: `no WebCodecs decoder for ${s.name} audio` };
          if (!sup.supported) notes.push(`stream ${i} (${s.name}): ${sup.why}; audio from it will fail`);
          out.push({ ...base, codec_type: 'audio', profile: s.name === 'aac' ? AAC_PROFILES[p.profile] ?? String(p.profile) : undefined, sample_fmt: SAMPLE_FMTS[p.format] ?? 'fltp',
            sample_rate: p.sample_rate, channels: p.channels, channel_layout: layoutName(p.channels) });
        } else out.push({ ...base, codec_type: ['video', 'audio', 'data', 'subtitle', 'attachment'][s.codec_type] ?? 'data' });
      }
      const brand = String.fromCharCode(...input.bytes.subarray(8, 12));
      return { kind, notes, format: { nb_streams: streams.length, format_name: 'mov,mp4,m4a,3gp,3g2,mj2', format_long_name: 'QuickTime / MOV', start_time: 0, duration,
        size: input.bytes.length, bit_rate: duration > 0 ? Math.round(input.bytes.length * 8 / duration) : undefined, probe_score: 100, ...(String.fromCharCode(...input.bytes.subarray(4, 8)) === 'ftyp' ? { tags: { major_brand: brand.trim() } } : {}) }, streams: out };
    } finally { m.terminate?.(); }
  },

  // Frames from an MP4/MOV's video: the libav path's arguments; decoded by VideoDecoder, drawn here.
  async frames({ input, ss, t, filters, want, maxImages, maxPixels, maxBytes = Infinity, type, quality, maxSeconds }, id, note) {
    const plan = vfPlan(filters);
    if (plan.error) throw fail(plan.error, 'EFILTER');
    const err = [], m = await avfInstance(err);
    let dec = null;
    const live = new Set(); // VideoFrames not yet closed
    try {
      const { fmt, streams, duration } = await openMp4(m, input, err);
      if (duration > maxSeconds) throw fail(`${input.label} is ${fmtTime(duration)} long; the cap is ${fmtTime(maxSeconds)} (MAX_INPUT_SECONDS)`, 'ECAP');
      const vi = streams.findIndex((s) => s.codec_type === m.AVMEDIA_TYPE_VIDEO);
      if (vi < 0) throw fail(`${input.label} has no video stream`, 'ENOVIDEO');
      const vs = streams[vi], tb = vs.time_base_num / vs.time_base_den;
      if (!vs.config) throw fail(`${input.label}: its video is ${vs.name}, which the browser's VideoDecoder does not take here (H.264, HEVC where the browser supports it, VP9, AV1)`, 'ECODEC');
      const sup = await videoSupport(vs.config);
      if (!sup.supported) throw fail(`${input.label}: ${sup.why} (${vs.name}${vs.name === 'hevc' ? ': HEVC decodes in Chrome and Edge with hardware support, and in Safari' : ''})`, 'ECODEC');
      if (ss > 0) { const [lo, hi] = m.f64toi64(Math.floor(ss / tb)); await m.av_seek_frame(fmt, vi, lo, hi, m.AVSEEK_FLAG_BACKWARD); }
      const end = t != null ? ss + t : Infinity, rot = ((vs.rotation % 360) + 360) % 360;
      const images = [], decoded = [];
      let bytes = 0, failure = null, last = -Infinity, step = 0, geo = null, canvas = null, ctx = null;
      dec = new VideoDecoder({ output: (f) => { live.add(f); decoded.push(f); }, error: (e) => { failure = e; } });
      dec.configure(vs.config);
      const picker = plan.rate ? fpsPicker(plan.rate, Math.min(want, maxImages + 1)) : null; // one past MAX_IMAGES, so draw refuses
      const release = (f) => { if (f && live.has(f)) { f.close(); live.delete(f); } };
      async function draw(f, time) {
        if (images.length >= want) return;
        if (images.length >= maxImages) throw fail(`that would write more than ${maxImages} images (MAX_IMAGES); add -frames:v N or a lower rate (fps=1/10)`, 'ECAP');
        const iw = rot % 180 ? f.displayHeight : f.displayWidth, ih = rot % 180 ? f.displayWidth : f.displayHeight;
        if (!geo) {
          geo = geometry(plan.ops, iw, ih);
          if (geo.error) throw fail(geo.error, 'EFILTER');
          if (geo.w * geo.h > maxPixels) throw fail(`frames are ${geo.w}x${geo.h}, over ${maxPixels} pixels (MAX_FRAME_PIXELS); add scale=1280:-1`, 'ECAP');
          canvas = new OffscreenCanvas(geo.w, geo.h); ctx = canvas.getContext('2d');
        }
        // The rotated source rect (sx, sy, sw, sh) onto the canvas: rotate about the center, draw the whole frame scaled.
        const kx = geo.w / geo.sw, ky = geo.h / geo.sh;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, geo.w, geo.h);
        ctx.translate(-geo.sx * kx, -geo.sy * ky); ctx.scale(kx, ky); ctx.translate(iw / 2, ih / 2); ctx.rotate(-rot * Math.PI / 180);
        ctx.drawImage(f, -f.displayWidth / 2, -f.displayHeight / 2, f.displayWidth, f.displayHeight);
        const img = new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer());
        if ((bytes += img.length) > maxBytes) throw fail(`the images come to over ${Math.round(maxBytes / 2 ** 20)} MiB together (MAX_OUTPUT_BYTES); add -frames:v N, a lower rate or scale=1280:-1`, 'ECAP');
        images.push({ t: time, width: geo.w, height: geo.h, bytes: img });
        note(`frame ${images.length} at ${fmtTime(time)}`);
      }
      // Decoded frames in presentation order: trim to [ss, end), then the fps choice or every frame.
      async function drain() {
        while (decoded.length) {
          const f = decoded.shift(), time = f.timestamp / 1e6;
          if (time + 1e-6 < ss || time >= end || images.length >= want) { release(f); continue; }
          if (time > last) { if (last > -Infinity) step = time - last; last = time; }
          if (!picker) { await draw(f, time); release(f); continue; }
          const r = picker.push(f, time);
          for (const [g, at] of r.emit) await draw(g, at);
          release(r.release);
        }
      }
      const pkt = await m.av_packet_alloc();
      await eachPackets(m, fmt, pkt, id, async (packets) => {
        for (const p of packets[vi] ?? []) {
          const pts = m.i64tof64(p.pts, p.ptshi), dts = m.i64tof64(p.dts, p.dtshi);
          dec.decode(new EncodedVideoChunk({ type: p.flags & 1 ? 'key' : 'delta', timestamp: Math.round((pts !== m.AV_NOPTS_VALUE ? pts : dts) * tb * 1e6), data: p.data }));
          while (dec.decodeQueueSize > 8 && !failure) { check(id); await new Promise((r) => setTimeout(r, 1)); }
          if (failure) throw fail(`${input.label}: the browser's decoder failed (${failure.message})`, 'ECODEC');
          await drain();
          if (images.length >= want) return true;
          if (pts !== m.AV_NOPTS_VALUE && pts * tb > end + 1) return true;
        }
        return false;
      });
      if (images.length < want) { await dec.flush().catch((e) => { failure ??= e; }); await drain(); }
      if (failure && !images.length) throw fail(`${input.label}: the browser's decoder failed (${failure.message ?? failure})`, 'ECODEC');
      if (picker && images.length < want) { const r = picker.end(Math.min(end, last + (step || 0))); for (const [g, at] of r.emit) await draw(g, at); release(r.release); }
      if (!images.length) throw fail(`no frames${ss > 0 ? ` at or after ${fmtTime(ss)}` : ''}: check -ss against the duration (ffprobe)`, 'ENOFRAMES');
      return { width: geo.w, height: geo.h, images };
    } finally {
      for (const f of live) f.close();
      try { dec?.close(); } catch { /* closed */ }
      m.terminate?.();
    }
  },

  // Audio out through the avf build's filters: { input, kind, ss, t, filters (string or null), rate, channels,
  //   out: { name, format: wav|flac|ogg|webm, codec, sampleFmt, bitRate }, maxSeconds, maxOutputBytes }.
  async audio({ input, kind, ss, t, filters, rate, channels, out, maxSeconds, maxOutputBytes }, id) {
    const err = [], m = await avfInstance(err);
    let adec = null;
    try {
      const end = t != null ? ss + t : Infinity;
      // 1. A source of planar float frames: pull() -> [{ data: Float32Array[], rate }] batches, null at the end.
      const src = await audioSource(m, input, kind, err, id, maxSeconds, (d) => { adec = d; });
      const inRate = src.rate, inCh = src.channels, outRate = rate || (out.codec === 'libopus' ? (([48000, 24000, 16000, 12000, 8000].includes(inRate)) ? inRate : 48000) : inRate);
      const outCh = channels || (out.codec === 'libopus' ? Math.min(inCh, 2) : inCh);
      // 2. The encoder (FLAC, Opus) and muxer, or the WAV writer.
      const sampleFmt = out.sampleFmt ?? (src.deep || /^pcm_(s24|s32|f32|f64)/.test(src.codec) ? 's32' : 's16'); // FLAC keeps a deeper source's depth, as ffmpeg does
      const fmtId = { u8: 0, s16: 1, s32: 2, flt: 3 }[sampleFmt];
      let enc = null, oc = null, pb = null, frameSize = 0;
      if (out.format !== 'wav') {
        const [, c, frame, pkt, fs] = await m.ff_init_encoder(out.codec, { ctx: { sample_fmt: fmtId, sample_rate: outRate, channel_layoutmask: layoutOf(outCh), ...(out.bitRate ? { bit_rate: out.bitRate } : {}) }, time_base: [1, outRate] });
        enc = { c, frame, pkt }; frameSize = fs;
        [oc, , pb] = await m.ff_init_muxer({ format_name: out.format, filename: out.name, open: true }, [[c, 1, outRate]]);
        await m.avformat_write_header(oc, 0);
      }
      // 3. The graph: the user's -af, then (aformat, auto-inserted aresample) to the output's rate, format and layout.
      const [srcCtx, sinkCtx] = await audioGraph(m, filters || 'anull', { rate: inRate, fmt: m.AV_SAMPLE_FMT_FLTP, layout: layoutOf(inCh) }, { rate: outRate, fmt: fmtId, layout: layoutOf(outCh), frameSize }).catch((e) => {
        throw fail(`could not set up the audio filters "${filters}": ${err.slice(-3).join(' ') || e.message} (audio filters here: ${AUDIO_FILTERS})`, 'EFILTER');
      });
      const fr = await m.av_frame_alloc();
      const chunks = [];
      let total = 0, pos = 0, written = 0, outPts = 0;
      const put = (b) => { total += b.length; if (total > maxOutputBytes) throw fail(`the output is over ${maxOutputBytes / 2 ** 20} MiB (MAX_OUTPUT_BYTES); nothing was written. Trim (-ss/-t), or use FLAC or Opus`, 'ECAP'); chunks.push(b); };
      async function feed(frames, fin) {
        const got = await m.ff_filter_multi(srcCtx, sinkCtx, fr, frames, { fin }).catch((e) => { throw fail(`the audio filters failed: ${err.slice(-2).join(' ') || e.message}`, 'EFILTER'); });
        for (const g of got) written += g.nb_samples;
        if (out.format === 'wav') { for (const g of got) put(wavBytes(out.codec, g.data)); return; }
        for (const g of got) { g.pts = outPts; g.ptshi = 0; outPts += g.nb_samples; }
        const pkts = await m.ff_encode_multi(enc.c, enc.frame, enc.pkt, got, fin);
        if (pkts.length) await m.ff_write_multi(oc, enc.pkt, pkts);
      }
      for (;;) {
        check(id); await tick();
        const batch = await src.pull();
        if (!batch) break;
        const frames = [];
        for (const d of batch) {
          // Trim on the decoded samples: [ss, end) in the source's time.
          const n = d[0].length, a = Math.max(0, Math.ceil(ss * inRate) - pos), b = Math.min(n, Math.floor(end * inRate) - pos);
          if (b > a) frames.push({ data: d.map((ch) => ch.subarray(a, b).slice()), format: m.AV_SAMPLE_FMT_FLTP, sample_rate: inRate, channel_layout: layoutOf(inCh), channels: inCh, nb_samples: b - a, pts: pos + a - Math.ceil(ss * inRate), ptshi: 0 });
          pos += n;
        }
        if (frames.length) await feed(frames, false);
        if (pos >= end * inRate) break;
      }
      await feed([], true);
      let bytes;
      if (out.format === 'wav') {
        const data = new Uint8Array(total); let o = 0; for (const c of chunks) { data.set(c, o); o += c.length; }
        bytes = new Uint8Array(44 + total); bytes.set(wavHeader(out.codec, outRate, outCh, total)); bytes.set(data, 44);
        if (!written) bytes = null;
      } else {
        await m.av_write_trailer(oc); await m.ff_free_muxer(oc, pb);
        bytes = await m.readFile(out.name);
        if (bytes.length > maxOutputBytes) throw fail(`the output is over ${maxOutputBytes / 2 ** 20} MiB (MAX_OUTPUT_BYTES); nothing was written`, 'ECAP');
      }
      if (!bytes?.length || !written) throw fail(`${input.label}: no audio${ss > 0 ? ` at or after ${fmtTime(ss)}` : ''}`, 'ENOAUDIO');
      return { files: [{ name: out.name, bytes }], rate: outRate, channels: outCh, source: { codec: src.codec, rate: inRate, channels: inCh } };
    } finally {
      try { adec?.close(); } catch { /* closed */ }
      m.terminate?.();
    }
  },
};

// abuffer -> chain -> aformat -> abuffersink, built here rather than with
// ff_init_filter_graph: on a parse or config error that one frees the source
// filter and the in/out lists the graph already owns (libav.js 6.10.9), and the
// double free wedges the wasm heap. Here a failed graph is freed once, by
// avfilter_graph_free; avfilter_graph_parse has taken the lists either way.
async function audioGraph(m, chain, inp, out) {
  const g = await m.avfilter_graph_alloc();
  if (!g) throw new Error('could not allocate a filter graph');
  const make = async (name, label, args) => {
    const c = await m.avfilter_graph_create_filter_js(await m.avfilter_get_by_name(name), label, args, null, g);
    if (!c) { await m.avfilter_graph_free_js(g); throw new Error(`could not create ${name}`); }
    return c;
  };
  const src = await make('abuffer', 'in', `time_base=1/${inp.rate}:sample_rate=${inp.rate}:sample_fmt=${inp.fmt}:channel_layout=0x${inp.layout.toString(16)}`);
  const fmt = await make('aformat', 'out_format', `sample_fmts=${out.fmt}:channel_layouts=0x${out.layout.toString(16)}:sample_rates=${out.rate}`);
  const sink = await make('abuffersink', 'out', null);
  if (await m.avfilter_link(fmt, 0, sink, 0) < 0) { await m.avfilter_graph_free_js(g); throw new Error('could not link the sink'); }
  const io = async (name, ctx) => { const x = await m.avfilter_inout_alloc(); await m.AVFilterInOut_name_s(x, await m.av_strdup(name)); await m.AVFilterInOut_filter_ctx_s(x, ctx); await m.AVFilterInOut_pad_idx_s(x, 0); await m.AVFilterInOut_next_s(x, 0); return x; };
  const outputs = await io('in', src), inputs = await io('out', fmt);
  let ret = await m.avfilter_graph_parse(g, chain, inputs, outputs, 0);
  if (ret >= 0 && out.frameSize) await m.av_buffersink_set_frame_size(sink, out.frameSize);
  if (ret >= 0) ret = await m.avfilter_graph_config(g, 0);
  if (ret < 0) { await m.avfilter_graph_free_js(g); throw new Error(await m.ff_error(ret)); }
  return [src, sink];
}

// Decoded audio as planar float batches, from: MP4/MOV (AudioDecoder), MP3 (AudioDecoder),
// WAV (read here) or anything the avf build demuxes and decodes itself (FLAC, Opus in Ogg or WebM).
async function audioSource(m, input, kind, err, id, maxSeconds, keep) {
  const tooLong = (d) => { if (d > maxSeconds) throw fail(`${input.label} is ${fmtTime(d)} long; the cap is ${fmtTime(maxSeconds)} (MAX_INPUT_SECONDS)`, 'ECAP'); };
  const head = String.fromCharCode(...input.bytes.subarray(0, 4)) + String.fromCharCode(...input.bytes.subarray(8, 12));
  if (head === 'RIFFWAVE') {
    let w;
    try { w = readWav(input.bytes); } catch (e) { throw fail(`${input.label}: ${e.message}`, 'EFORMAT'); }
    tooLong(w.data[0].length / w.sampleRate);
    let i = 0; const STEP = 65536;
    return { rate: w.sampleRate, channels: w.channels, codec: w.codec, async pull() { if (i >= w.data[0].length) return null; const b = [w.data.map((c) => c.subarray(i, i + STEP))]; i += STEP; return b; } };
  }
  // WebCodecs: chunks in, AudioData out, as planar float.
  const viaDecoder = async (config, chunks) => {
    const sup = await audioSupport(config);
    if (!sup.supported) throw fail(`${input.label}: ${sup.why}`, 'ECODEC');
    const ready = [];
    let failure = null, done = false, got = null;
    const dec = new AudioDecoder({ output: (a) => {
      got ??= { rate: a.sampleRate, channels: a.numberOfChannels };
      const n = a.numberOfFrames, data = [];
      for (let c = 0; c < a.numberOfChannels; c++) { const d = new Float32Array(n); a.copyTo(d, { planeIndex: c, format: 'f32-planar' }); data.push(d); }
      a.close(); ready.push(data);
    }, error: (e) => { failure = e; } });
    keep(dec); dec.configure(config);
    const it = chunks();
    async function pull() {
      for (;;) {
        if (failure) throw fail(`${input.label}: the browser's audio decoder failed (${failure.message})`, 'ECODEC');
        if (ready.length) { const b = ready.splice(0); return b; }
        if (done) return null;
        const { value, done: end } = await it.next();
        if (end) { done = true; await dec.flush().catch((e) => { failure ??= e; }); continue; }
        for (const c of value) dec.decode(c);
        while (dec.decodeQueueSize > 16 && !failure) { check(id); await new Promise((r) => setTimeout(r, 1)); }
        await tick();
      }
    }
    // The first decoded batch says the real rate and channels (HE-AAC's SBR doubles the container's rate).
    let first = await pull();
    return { rate: got?.rate ?? config.sampleRate, channels: got?.channels ?? config.numberOfChannels, codec: config.codec, async pull() {
      if (first) { const b = first; first = null; return b; }
      return pull();
    } };
  };
  if (kind === 'mp3') {
    const frames = mp3Frames(input.bytes);
    if (!frames.length) throw fail(`${input.label}: no MP3 frames found`, 'EFORMAT');
    const f0 = frames[0]; tooLong(frames.length * f0.samples / f0.sampleRate);
    return viaDecoder({ codec: 'mp3', sampleRate: f0.sampleRate, numberOfChannels: f0.channels }, async function* () {
      let ts = 0;
      for (let i = 0; i < frames.length; i += 64) {
        yield frames.slice(i, i + 64).map((f) => { const c = new EncodedAudioChunk({ type: 'key', timestamp: Math.round(ts * 1e6 / f.sampleRate), data: input.bytes.subarray(f.offset, f.offset + f.size) }); ts += f.samples; return c; });
      }
    });
  }
  // A container the avf build demuxes: MP4/MOV (decoded by AudioDecoder), or FLAC/Ogg/WebM (decoded by libav).
  const { fmt, streams, duration } = kind === 'mp4' ? await openMp4(m, input, err) : await (async () => {
    await m.writeFile(input.name, input.bytes);
    let fmt, streams;
    try { [fmt, streams] = await m.ff_init_demuxer_file(input.name); } catch { throw fail(`${input.label}: cannot open it (${err.slice(-1)[0] || 'unknown format'})`, 'EFORMAT'); }
    const d = m.i64tof64(await m.AVFormatContext_duration(fmt), await m.AVFormatContext_durationhi(fmt));
    return { fmt, streams, duration: d > 0 && d !== m.AV_NOPTS_VALUE ? d / m.AV_TIME_BASE : NaN };
  })();
  tooLong(duration);
  const ai = streams.findIndex((s) => s.codec_type === m.AVMEDIA_TYPE_AUDIO);
  if (ai < 0) throw fail(`${input.label} has no audio stream`, 'ENOAUDIO');
  const as = streams[ai], pkt = await m.av_packet_alloc();
  async function* packets() {
    for (;;) {
      check(id);
      const [res, got] = await m.ff_read_frame_multi(fmt, pkt, { limit: 2 * 2 ** 20 });
      if (res < 0 && res !== m.AVERROR_EOF && res !== -m.EAGAIN) throw fail(`${input.label}: read error ${res}`, 'EIO');
      yield got[ai] ?? [];
      if (res === m.AVERROR_EOF) return;
    }
  }
  if (kind === 'mp4') {
    if (!as.config) throw fail(`${input.label}: its audio is ${as.name}, which the browser's AudioDecoder does not take here (AAC, MP3, Opus, FLAC)`, 'ECODEC');
    const tb = as.time_base_num / as.time_base_den;
    return viaDecoder(as.config, async function* () {
      for await (const ps of packets()) yield ps.map((p) => new EncodedAudioChunk({ type: 'key', timestamp: Math.round(m.i64tof64(p.pts, p.ptshi) * tb * 1e6), data: p.data }));
    });
  }
  // libav decodes FLAC and Opus itself (to whatever sample format), then the frames become planar float.
  const par = await m.ff_copyout_codecpar(as.codecpar), name = await m.avcodec_get_name(par.codec_id);
  let c, dpkt, dframe;
  try { [, c, dpkt, dframe] = await m.ff_init_decoder(par.codec_id, { codecpar: as.codecpar }); }
  catch { throw fail(`${input.label}: no decoder here for its audio (${name}); this path decodes AAC and MP3 (browser), FLAC, Opus and PCM WAV`, 'ECODEC'); }
  const it = packets();
  const toFloat = (f) => {
    const ch = f.channels || par.channels || 1, n = f.nb_samples, planar = f.format >= 5, k = [128, 32768, 2147483648, 1][f.format % 5] ?? 1, off = f.format % 5 === 0 ? 128 : 0;
    return Array.from({ length: ch }, (_, c) => { const d = new Float32Array(n); for (let s = 0; s < n; s++) d[s] = ((planar ? f.data[c][s] : f.data[s * ch + c]) - off) / k; return d; });
  };
  let done = false;
  const decode = async () => {
    const { value, done: end } = await it.next();
    const frames = await m.ff_decode_multi(c, dpkt, dframe, value ?? [], { fin: !!end, ignoreErrors: true });
    if (end) done = true;
    return frames;
  };
  // The first decoded frames say the source's depth: the decoder gives s32 for 24-bit FLAC, which a FLAC output keeps.
  let first = [];
  while (!done && !first.length) first = await decode();
  const deep = first.length > 0 && (first[0].format === 2 || first[0].format === 7); // AV_SAMPLE_FMT_S32, S32P
  return { rate: par.sample_rate, channels: par.channels || 1, codec: name, deep, async pull() {
    if (first.length) { const f = first; first = []; return f.map(toFloat); }
    if (done) return null;
    return (await decode()).map(toFloat);
  } };
}

// Seconds of each input (format duration), for the duration cap. NaN when unknown.
async function durations(m, names) {
  const out = [];
  for (const n of names) {
    try {
      const [fmt] = await m.ff_init_demuxer_file(n);
      const d = m.i64tof64(await m.AVFormatContext_duration(fmt), await m.AVFormatContext_durationhi(fmt));
      out.push(d > 0 && d !== m.AV_NOPTS_VALUE ? d / m.AV_TIME_BASE : NaN);
      await m.avformat_close_input_js(fmt);
    } catch { out.push(NaN); } // ffmpeg itself will say why it cannot open it
  }
  return out;
}

async function withInputs(m, inputs, maxSeconds) {
  for (const f of inputs) await m.writeFile(f.name, f.bytes);
  if (maxSeconds) {
    const secs = await durations(m, inputs.map((f) => f.name));
    const i = secs.findIndex((s) => s > maxSeconds);
    if (i >= 0) throw fail(`${inputs[i].label} is ${fmtTime(secs[i])} long; the cap is ${fmtTime(maxSeconds)} (MAX_INPUT_SECONDS)`, 'ECAP');
  }
}
const fmtTime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${+s.toFixed(1)}s`);

const actions = {
  // { program: 'ffmpeg'|'ffprobe', args, inputs: [{ name, label, bytes }], outputs: [name], maxSeconds, maxOutputBytes }
  async run({ program, args, inputs, outputs, maxSeconds, maxOutputBytes }, id) {
    const out = [], err = [], m = await instance(out, err);
    try {
      await withInputs(m, inputs, maxSeconds);
      check(id);
      if (program !== 'ffmpeg' && program !== 'ffprobe') throw fail(`unknown program ${program}`, 'EPROTO');
      const rc = await (program === 'ffmpeg' ? m.ffmpeg(...args) : m.ffprobe(...args));
      const files = [];
      let total = 0;
      for (const name of outputs) {
        let bytes = null;
        try { bytes = await m.readFile(name); } catch { /* not written */ }
        total += bytes?.length ?? 0;
        if (total > maxOutputBytes) throw fail(`the output is over ${maxOutputBytes / 2 ** 20} MiB (MAX_OUTPUT_BYTES); nothing was written. Trim (-ss/-t), scale down or lower the bitrate`, 'ECAP');
        files.push({ name, bytes });
      }
      return { code: rc ?? 0, stdout: out.join('\n'), stderr: err.join('\n'), files };
    } finally { m.terminate?.(); }
  },

  // Frames as images: { input: { name, label, bytes }, ss, t, filters, want, maxImages, maxPixels, type, quality, maxSeconds }
  async frames({ input, ss, t, filters, want, maxImages, maxPixels, maxBytes = Infinity, type, quality, maxSeconds }, id, note) {
    const out = [], err = [], m = await instance(out, err);
    let c, pkt, frame, graph;
    try {
      await withInputs(m, [input], maxSeconds);
      let fmt, streams;
      try { [fmt, streams] = await m.ff_init_demuxer_file(input.name); }
      catch { throw fail(`${input.label}: cannot open it (${err.slice(-1)[0] || 'unknown format'})`, 'EFORMAT'); }
      const vi = streams.findIndex((s) => s.codec_type === m.AVMEDIA_TYPE_VIDEO);
      if (vi < 0) throw fail(`${input.label} has no video stream`, 'ENOVIDEO');
      const vs = streams[vi];
      try { [, c, pkt, frame] = await m.ff_init_decoder(vs.codec_id, { codecpar: vs.codecpar }); }
      catch { throw fail(`${input.label}: no decoder here for its video codec (${await m.avcodec_get_name(vs.codec_id)}); this build decodes VP8 and VP9 video only`, 'ECODEC'); }
      const w = await m.AVCodecContext_width(c), h = await m.AVCodecContext_height(c), pix = await m.AVCodecContext_pix_fmt(c);
      const tb = vs.time_base_num / vs.time_base_den;
      if (ss > 0) {
        const [lo, hi] = m.f64toi64(Math.floor(ss * m.AV_TIME_BASE));
        await m.av_seek_frame(fmt, -1, lo, hi, m.AVSEEK_FLAG_BACKWARD);
      }
      // trim drops what the seek landed before ss (and after ss+t); the user's filters follow.
      const trim = ss > 0 || t != null ? [`trim=start=${ss}${t != null ? `:duration=${t}` : ''}`] : [];
      const chain = [...trim, ...filters].join(',') || 'null';
      try {
        graph = await m.ff_init_filter_graph(chain, { type: m.AVMEDIA_TYPE_VIDEO, width: w, height: h, pix_fmt: pix, time_base: [vs.time_base_num, vs.time_base_den] },
          { type: m.AVMEDIA_TYPE_VIDEO, pix_fmt: m.AV_PIX_FMT_RGBA });
      } catch { throw fail(`could not set up the filters "${chain}": ${err.slice(-3).join(' ') || 'unknown filter or bad option'} (this build has fps, scale, crop, trim, null, split, settb)`, 'EFILTER'); }
      const [, src, sink] = graph;
      const images = [], end = t != null ? ss + t : Infinity;
      let bytes = 0;
      for (let done = false; !done;) {
        check(id); await tick();
        const [res, packets] = await m.ff_read_frame_multi(fmt, pkt, { limit: 2 * 2 ** 20 });
        const eof = res === m.AVERROR_EOF;
        if (res < 0 && !eof && res !== -m.EAGAIN) throw fail(`${input.label}: read error ${res}`, 'EIO');
        const mine = packets[vi] ?? [];
        const past = mine.length && m.i64tof64(mine.at(-1).pts, mine.at(-1).ptshi) * tb > end + 1;
        const fin = eof || past;
        // A few packets at a time: each decoded frame is full-size RGBA, and a
        // 2 MiB read of a well-compressed video holds hundreds of them.
        for (let i = 0; i === 0 || i < mine.length; i += DECODE_STEP) {
          const last = i + DECODE_STEP >= mine.length;
          const frames = await m.ff_decode_filter_multi(c, src, sink, pkt, frame, mine.slice(i, i + DECODE_STEP), { fin: fin && last, ignoreErrors: true });
          for (const fr of frames) {
            if (images.length >= want) break;
            if (images.length >= maxImages) throw fail(`that would write more than ${maxImages} images (MAX_IMAGES); add -frames:v N or a lower rate (fps=1/10)`, 'ECAP');
            if (fr.width * fr.height > maxPixels) throw fail(`frames are ${fr.width}x${fr.height}, over ${maxPixels} pixels (MAX_FRAME_PIXELS); add scale=1280:-1`, 'ECAP');
            const time = fr.pts * (fr.time_base_num ?? vs.time_base_num) / (fr.time_base_den ?? vs.time_base_den);
            const img = await encode(fr, type, quality);
            if ((bytes += img.length) > maxBytes) throw fail(`the images come to over ${Math.round(maxBytes / 2 ** 20)} MiB together (MAX_OUTPUT_BYTES); add -frames:v N, a lower rate or scale=1280:-1`, 'ECAP');
            images.push({ t: time, width: fr.width, height: fr.height, bytes: img });
            note(`frame ${images.length} at ${fmtTime(time)}`);
          }
          if (images.length >= want) break;
        }
        done = fin || images.length >= want;
      }
      if (!images.length) throw fail(`no frames${ss > 0 ? ` at or after ${fmtTime(ss)}` : ''}: check -ss against the duration (ffprobe)`, 'ENOFRAMES');
      return { width: w, height: h, images };
    } finally { m.terminate?.(); } // the instance, its MEMFS and its memory go with this job
  },
};

async function encode(fr, type, quality) {
  const { width: w, height: h } = fr, stride = fr.layout?.[0]?.stride ?? w * 4, off = fr.layout?.[0]?.offset ?? 0;
  let px = fr.data;
  if (stride !== w * 4 || off) { const tight = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) tight.set(px.subarray(off + y * stride, off + y * stride + w * 4), y * w * 4); px = tight; }
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, w * h * 4), w, h), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer());
}

self.onmessage = async ({ data: msg }) => {
  const { id, action } = msg;
  if (action === 'stop') { stopped.add(msg.job); return; }
  try {
    let result;
    if (action === 'load') {
      wasm = WebAssembly.compile(msg.wasm);
      avfWasm = msg.avf ? WebAssembly.compile(msg.avf) : Promise.reject(new Error('no WebCodecs build in this runtime'));
      avfWasm.catch(() => {});
      await wasm;
      // From here on this worker has no network at all (see the header).
      for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
        try { Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false }); } catch { globalThis[k] = undefined; }
      }
      result = { version: libav.VER, config: libav.CONFIG };
    } else if (action === 'run' || action === 'frames') {
      result = await actions[action](msg, id, (line) => postMessage({ id, note: line }));
    } else if (action === 'wc.probe' || action === 'wc.frames' || action === 'wc.audio') {
      result = await wcActions[action.slice(3)](msg, id, (line) => postMessage({ id, note: line }));
    } else {
      throw fail(`unknown action ${action}`, 'EPROTO');
    }
    const transfer = [...(result?.files ?? []), ...(result?.images ?? [])].flatMap((f) => (f.bytes ? [f.bytes.buffer] : []));
    postMessage({ id, result }, transfer);
  } catch (e) {
    postMessage({ id, error: String(e?.message ?? e), code: e?.code, name: e?.name });
  } finally { stopped.delete(id); }
};
