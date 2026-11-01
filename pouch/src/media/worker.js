// The libav.js worker: FFmpeg 9 (libav.js 6.10.9.0, variant webm-vp9-cli) run
// in this one worker ("direct" mode), behind a small message protocol.
// build-libav.mjs bundles it into runtime/libav/worker.js; src/media.js starts
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
import libav from '../../node_modules/@libav.js/variant-webm-vp9-cli/dist/libav-6.10.9.0-webm-vp9-cli.mjs';
import factory from '../../node_modules/@libav.js/variant-webm-vp9-cli/dist/libav-6.10.9.0-webm-vp9-cli.wasm.mjs';

let wasm = null; // Promise of the WebAssembly.Module, compiled once (jobs posted meanwhile wait for it)
const stopped = new Set(); // job ids asked to stop
const check = (id) => { if (stopped.has(id)) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' }); };
const tick = () => new Promise((r) => setTimeout(r, 0)); // lets a stop message in
const fail = (msg, code) => Object.assign(new Error(msg), { code });

// A new libav instance whose print and printErr land in out/err.
async function instance(out, err) {
  const mod = await wasm;
  return libav.LibAV({ noworker: true, factory: (opts) => factory({ ...opts,
    instantiateWasm(imports, done) { WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod)); return {}; },
    print: (s) => out.push(s), printErr: (s) => err.push(s) }) });
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
      const rc = await m[program](...args);
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
  async frames({ input, ss, t, filters, want, maxImages, maxPixels, type, quality, maxSeconds }, id, note) {
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
      for (let done = false; !done;) {
        check(id); await tick();
        const [res, packets] = await m.ff_read_frame_multi(fmt, pkt, { limit: 2 * 2 ** 20 });
        const eof = res === m.AVERROR_EOF;
        if (res < 0 && !eof && res !== -m.EAGAIN) throw fail(`${input.label}: read error ${res}`, 'EIO');
        const mine = packets[vi] ?? [];
        const past = mine.length && m.i64tof64(mine.at(-1).pts, mine.at(-1).ptshi) * tb > end + 1;
        const fin = eof || past;
        const frames = await m.ff_decode_filter_multi(c, src, sink, pkt, frame, mine, { fin, ignoreErrors: true });
        for (const fr of frames) {
          if (images.length >= want) break;
          if (images.length >= maxImages) throw fail(`that would write more than ${maxImages} images (MAX_IMAGES); add -frames:v N or a lower rate (fps=1/10)`, 'ECAP');
          if (fr.width * fr.height > maxPixels) throw fail(`frames are ${fr.width}x${fr.height}, over ${maxPixels} pixels (MAX_FRAME_PIXELS); add scale=1280:-1`, 'ECAP');
          const time = fr.pts * (fr.time_base_num ?? vs.time_base_num) / (fr.time_base_den ?? vs.time_base_den);
          images.push({ t: time, width: fr.width, height: fr.height, bytes: await encode(fr, type, quality) });
          note(`frame ${images.length} at ${fmtTime(time)}`);
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
      await wasm;
      // From here on this worker has no network at all (see the header).
      for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
        try { Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false }); } catch { globalThis[k] = undefined; }
      }
      result = { version: libav.VER, config: libav.CONFIG };
    } else {
      result = await actions[action](msg, id, (line) => postMessage({ id, note: line }));
    }
    const transfer = [...(result?.files ?? []), ...(result?.images ?? [])].flatMap((f) => (f.bytes ? [f.bytes.buffer] : []));
    postMessage({ id, result }, transfer);
  } catch (e) {
    postMessage({ id, error: String(e?.message ?? e), code: e?.code, name: e?.name });
  } finally { stopped.delete(id); }
};
