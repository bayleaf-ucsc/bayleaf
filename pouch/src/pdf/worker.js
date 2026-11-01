// The pdf.js worker: pdf.js 6 (library and its own worker code, run in this
// one thread as pdf.js's "fake worker") behind a small message protocol.
// build-pdf.mjs bundles it into runtime/pdf/worker.js; src/pdf.js starts it
// from the verified blob and talks to it.
//
// Containment (stories PD6, AG4):
// - No network. Everything pdf.js would fetch (cmaps, standard fonts, the
//   OpenJPEG/JBIG2/qcms wasm, the CMYK ICC profile) is read from data.pack,
//   which the page verified against this build's manifest. build-pdf.mjs
//   rewrites pdf.js's two fetch helpers to call pouchFile(); fetch and
//   XMLHttpRequest are then removed from this worker, so a PDF's links, forms
//   or a bug cannot reach any host, same-origin included.
// - No script. PDF JavaScript needs pdf.js's scripting sandbox
//   (quickjs-eval.wasm), which is not shipped; enableScripting stays off and
//   nothing here creates a sandbox. pdfinfo only reports that JS is present.
// - No DOM: fonts are drawn as paths (disableFontFace), canvases are
//   OffscreenCanvas, and SVG filters are no-ops.
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { getDocument, AnnotationMode } from 'pdfjs-dist/build/pdf.mjs';

globalThis.pdfjsWorker = pdfjsWorker; // pdf.js runs its worker side in this thread

let files = null; // path in data.pack -> Uint8Array
globalThis.pouchFile = (url) => {
  const b = files?.get(String(url));
  if (!b) throw new Error(`${url} is not in Pouch's pdf runtime`);
  return b.slice(); // pdf.js may transfer or detach what it gets
};

// data.pack: u32 LE header length, JSON { path: [offset, length] }, bytes.
function unpack(buf) {
  const n = new DataView(buf).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  return new Map(Object.entries(index).map(([p, [o, l]]) => [p, new Uint8Array(buf, 4 + n + o, l)]));
}

class OffscreenCanvasFactory {
  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset(cc, width, height) { cc.canvas.width = width; cc.canvas.height = height; }
  destroy(cc) { cc.canvas.width = cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
}
class NoFilterFactory {
  addFilter() { return 'none'; } addHCMFilter() { return 'none'; } addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; } addKnockoutFilter() { return 'none'; } addHighlightHCMFilter() { return 'none'; }
  addSelectionHCMFilter() { return 'none'; } addSelectionFilter() { return 'none'; } createSelectionStyle() { return null; }
  destroy() {}
}

const OPTIONS = {
  cMapUrl: 'cmaps/', cMapPacked: true, standardFontDataUrl: 'standard_fonts/', wasmUrl: 'wasm/', iccUrl: 'iccs/',
  useWorkerFetch: true, // "worker fetch" here means pouchFile(): see the build rewrites
  disableFontFace: true, useSystemFonts: false, enableXfa: false, isEvalSupported: false, enableScripting: false,
  isOffscreenCanvasSupported: true, disableRange: true, disableStream: true, disableAutoFetch: true,
  CanvasFactory: OffscreenCanvasFactory, FilterFactory: NoFilterFactory, verbosity: 0,
};

const stopped = new Set(); // job ids asked to stop
const check = (id) => { if (stopped.has(id)) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' }); };

async function open(data, password) {
  const task = getDocument({ ...OPTIONS, data, password });
  try { return await task.promise; }
  catch (e) {
    await task.destroy().catch(() => {});
    if (e?.name === 'PasswordException') throw Object.assign(new Error(e.code === 2 ? 'incorrect password' : 'encrypted: it needs a password to open'), { code: 'EENCRYPTED' });
    if (e?.name === 'InvalidPDFException') throw Object.assign(new Error('not a PDF file (or damaged beyond repair)'), { code: 'ENOTPDF' });
    throw e;
  }
}

const textOf = (items) => items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
// -layout: lines by baseline, items left to right, gaps as spaces (an approximation of poppler's).
function layoutOf(items) {
  const runs = items.filter((it) => it.str).map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 10 }));
  if (!runs.length) return '';
  const cw = runs.reduce((n, r) => n + r.w, 0) / Math.max(1, runs.reduce((n, r) => n + r.s.length, 0)) || 5;
  const lines = [];
  for (const r of runs.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const l = lines.find((l) => Math.abs(l.y - r.y) < Math.min(l.h, r.h) * 0.5);
    l ? l.runs.push(r) : lines.push({ y: r.y, h: r.h, runs: [r] });
  }
  const left = Math.min(...runs.map((r) => r.x));
  return lines.sort((a, b) => b.y - a.y).map((l) => {
    let out = '';
    for (const r of l.runs.sort((a, b) => a.x - b.x)) {
      const col = Math.round((r.x - left) / cw);
      out += (out.length < col ? ' '.repeat(col - out.length) : out && !/\s$/.test(out) && !/^\s/.test(r.s) ? ' ' : '') + r.s;
    }
    return out.trimEnd();
  }).join('\n');
}
const hasText = (items) => items.some((it) => /\S/.test(it.str));

const actions = {
  async info({ data, password, scan }, id) {
    const doc = await open(data, password);
    try {
      const { info } = await doc.getMetadata();
      const js = await doc.getJSActions().catch(() => null), hasJs = await doc.hasJSActions?.().catch(() => false);
      const p1 = await doc.getPage(1), [x0, y0, x1, y1] = p1.view;
      const out = { pages: doc.numPages, info, javascript: !!(js && Object.keys(js).length) || !!hasJs,
        size: [x1 - x0, y1 - y0], rotate: p1.rotate, noText: [], scanned: Math.min(doc.numPages, scan) };
      for (let n = 1; n <= out.scanned; n++) {
        check(id);
        const page = n === 1 ? p1 : await doc.getPage(n);
        if (!hasText((await page.getTextContent()).items)) out.noText.push(n);
        if (n !== 1) page.cleanup();
      }
      return out;
    } finally { await doc.loadingTask.destroy(); }
  },
  async text({ data, password, first, last, layout }, id, note) {
    const doc = await open(data, password);
    try {
      const pages = [], hi = Math.min(last ?? doc.numPages, doc.numPages);
      if (first > doc.numPages) throw Object.assign(new Error(`first page ${first} is past the last page (${doc.numPages})`), { code: 'ERANGE' });
      for (let n = first; n <= hi; n++) {
        check(id);
        const page = await doc.getPage(n);
        const { items } = await page.getTextContent();
        pages.push({ n, text: layout ? layoutOf(items) : textOf(items), empty: !hasText(items) });
        page.cleanup();
        if (n % 10 === 0) note(`page ${n} of ${hi}`);
      }
      return { numPages: doc.numPages, pages };
    } finally { await doc.loadingTask.destroy(); }
  },
  // Pixel caps are checked by the page before asking; maxPixels is checked again here per page.
  async render({ data, password, first, last, dpi, maxPixels, maxBytes = Infinity, type, crop }, id, note) {
    const doc = await open(data, password);
    try {
      let total = 0;
      const out = [], hi = Math.min(last ?? doc.numPages, doc.numPages);
      if (first > doc.numPages) throw Object.assign(new Error(`first page ${first} is past the last page (${doc.numPages})`), { code: 'ERANGE' });
      for (let n = first; n <= hi; n++) {
        check(id);
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: dpi / 72 });
        const w = Math.ceil(viewport.width - 1e-6), h = Math.ceil(viewport.height - 1e-6); // 792 pt at 600 DPI is 6600, not 6601
        if (w * h > maxPixels) throw Object.assign(new Error(`page ${n} at ${dpi} DPI is ${w}x${h} pixels, over the cap of ${maxPixels}; lower -r`), { code: 'ECAP' });
        const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        await page.render({ canvasContext: ctx, canvas, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
        let img = canvas;
        if (crop) {
          const x = Math.min(crop.x, w - 1), y = Math.min(crop.y, h - 1);
          const cw = Math.max(1, Math.min(crop.W || w - x, w - x)), ch = Math.max(1, Math.min(crop.H || h - y, h - y));
          img = new OffscreenCanvas(cw, ch); img.getContext('2d').drawImage(canvas, x, y, cw, ch, 0, 0, cw, ch);
        }
        const blob = await img.convertToBlob({ type, quality: 0.9 });
        total += blob.size;
        if (total > maxBytes) throw Object.assign(new Error(`pages ${first}-${n} come to over ${Math.round(maxBytes / 2 ** 20)} MB of images together; render fewer pages per call (-f, -l) or lower -r`), { code: 'ECAP' });
        out.push({ n, width: img.width, height: img.height, bytes: new Uint8Array(await blob.arrayBuffer()) });
        page.cleanup();
        note(`rendered page ${n} of ${hi}`);
      }
      return { numPages: doc.numPages, pages: out };
    } finally { await doc.loadingTask.destroy(); }
  },
};

self.onmessage = async ({ data: msg }) => {
  const { id, action } = msg;
  if (action === 'stop') { stopped.add(msg.job); return; }
  try {
    let result;
    if (action === 'load') {
      files = unpack(msg.pack);
      // From here on this worker has no network at all (see the header).
      for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
        try { Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false }); } catch { globalThis[k] = undefined; }
      }
      result = { files: files.size };
    } else {
      result = await actions[action](msg, id, (line) => postMessage({ id, note: line }));
    }
    const transfer = (Array.isArray(result?.pages) ? result.pages : []).flatMap((p) => (p.bytes ? [p.bytes.buffer] : []));
    postMessage({ id, result }, transfer);
  } catch (e) {
    postMessage({ id, error: String(e?.message ?? e), code: e?.code, name: e?.name });
  } finally { stopped.delete(id); }
};
