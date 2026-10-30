// Zero-dependency PNG helpers for the walkthrough generator: decode the
// 8-bit RGBA/RGB PNGs Chromium writes, downscale by area averaging, encode
// losslessly (indexed when the crop has 256 colors or fewer, else RGB/RGBA
// with per-row adaptive filters and zlib level 9), and compare two images.
// Pedagogical, not fast: crops are small.
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

// -> { width, height, data: Uint8Array RGBA }
export function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let at = 8, width, height, depth, type, palette, trns; const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), t = buf.toString('latin1', at + 4, at + 8), d = buf.subarray(at + 8, at + 8 + len);
    if (t === 'IHDR') { width = d.readUInt32BE(0); height = d.readUInt32BE(4); depth = d[8]; type = d[9]; if (d[12]) throw new Error('interlaced PNG'); }
    else if (t === 'PLTE') palette = d; else if (t === 'tRNS') trns = d; else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break;
    at += 12 + len;
  }
  if (depth !== 8) throw new Error('only 8-bit PNGs');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type], stride = width * ch, raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[row - stride + x] : 0, c = x >= ch && y ? px[row - stride + x - ch] : 0;
      px[row + x] = (src[x] + [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]) & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch, o = i * 4;
    if (type === 3) { const p = px[i]; data.set([palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2], trns && p < trns.length ? trns[p] : 255], o); }
    else if (type === 6) data.set(px.subarray(s, s + 4), o);
    else if (type === 2) data.set([px[s], px[s + 1], px[s + 2], 255], o);
    else if (type === 4) data.set([px[s], px[s], px[s], px[s + 1]], o);
    else data.set([px[s], px[s], px[s], 255], o);
  }
  return { width, height, data };
}

function filterRows(px, width, height, ch) {
  const stride = width * ch, out = Buffer.alloc((stride + 1) * height), cand = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride; let best = null, bestSum = Infinity, bestF = 0;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[row - stride + x] : 0, c = x >= ch && y ? px[row - stride + x - ch] : 0;
        const v = (px[row + x] - [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]) & 255;
        cand[x] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; bestF = f; best = Buffer.from(cand); }
    }
    out[y * (stride + 1)] = bestF; best.copy(out, y * (stride + 1) + 1);
  }
  return out;
}

export function encode({ width, height, data }) {
  const n = width * height;
  let opaque = true; for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  // Indexed when the image has at most 256 distinct colors (lossless).
  const colors = new Map(); const idx = new Uint8Array(n);
  for (let i = 0; i < n && colors.size <= 256; i++) {
    const k = data[i * 4] << 24 | data[i * 4 + 1] << 16 | data[i * 4 + 2] << 8 | data[i * 4 + 3];
    let p = colors.get(k); if (p === undefined) { p = colors.size; colors.set(k, p); } idx[i] = p;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8;
  const parts = [SIG];
  let body;
  if (colors.size <= 256) {
    ihdr[9] = 3; parts.push(chunk('IHDR', ihdr));
    const plte = Buffer.alloc(colors.size * 3), trns = Buffer.alloc(colors.size);
    for (const [k, p] of colors) { plte[p * 3] = k >>> 24; plte[p * 3 + 1] = k >>> 16 & 255; plte[p * 3 + 2] = k >>> 8 & 255; trns[p] = k & 255; }
    parts.push(chunk('PLTE', plte)); if (!opaque) parts.push(chunk('tRNS', trns));
    body = filterRows(idx, width, height, 1);
  } else {
    const ch = opaque ? 3 : 4; ihdr[9] = opaque ? 2 : 6; parts.push(chunk('IHDR', ihdr));
    const px = new Uint8Array(n * ch);
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) px[i * ch + c] = data[i * 4 + c];
    body = filterRows(px, width, height, ch);
  }
  parts.push(chunk('IDAT', deflateSync(body, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Area-average downscale by an integer factor (2x captures to 1x).
export function shrink(img, k) {
  if (k === 1) return img;
  const width = Math.floor(img.width / k), height = Math.floor(img.height / k), data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
    let s = 0; for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) s += img.data[((y * k + dy) * img.width + x * k + dx) * 4 + c];
    data[(y * width + x) * 4 + c] = Math.round(s / (k * k));
  }
  return { width, height, data };
}

// Pixels whose largest channel difference exceeds `tolerance`; Infinity when sizes differ.
export function diff(a, b, tolerance = 32) {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]), Math.abs(a.data[i + 3] - b.data[i + 3]));
    if (d > tolerance) n++;
  }
  return n;
}
