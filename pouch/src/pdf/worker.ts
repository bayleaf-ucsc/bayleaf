// The pdf.js worker: pdf.js 6 (library and its own worker code, run in this
// one thread as pdf.js's "fake worker") behind a small message protocol.
// build-pdf.mjs bundles it into runtime/pdf/worker.js; src/pdf.ts starts it
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
/// <reference path="./pdfjs.d.ts" />
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { getDocument, AnnotationMode } from 'pdfjs-dist/build/pdf.mjs';
import type { PDFPageProxy, TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import type { PdfDocInfo, PdfInfo, PdfInfoJob, PdfJob, PdfReply, PdfRenderJob, PdfRequest, PdfResult, PdfTextJob, PdfTextPage, PdfImage } from './protocol.ts';

let files: Map<string, Uint8Array> | null = null; // path in data.pack
const pouchFile = (url: unknown) => {
  const b = files?.get(String(url));
  if (!b) throw new Error(`${url} is not in Pouch's pdf runtime`);
  return b.slice(); // pdf.js may transfer or detach what it gets
};
Object.assign(globalThis, { pdfjsWorker, pouchFile }); // pdf.js runs its worker side in this thread

// data.pack: u32 LE header length, JSON { path: [offset, length] }, bytes.
function unpack(buf: ArrayBuffer) {
  const n = new DataView(buf).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as Record<string, [number, number]>;
  return new Map(Object.entries(index).map(([p, [o, l]]) => [p, new Uint8Array(buf, 4 + n + o, l)]));
}

interface CanvasAndContext { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null }
class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset(cc: CanvasAndContext, width: number, height: number) { const canvas = live(cc); canvas.width = width; canvas.height = height; }
  destroy(cc: CanvasAndContext) { const canvas = live(cc); canvas.width = canvas.height = 0; cc.canvas = null; cc.context = null; }
}
// pdf.js's own canvas factory throws the same on a destroyed pair.
function live(cc: CanvasAndContext) { if (!cc.canvas) throw new Error('Canvas is not specified'); return cc.canvas; }
function context2d(canvas: OffscreenCanvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas context in this worker');
  return ctx;
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
const check = (id: number) => { if (stopped.has(id)) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' }); };

// What a thrown value carries, whatever was thrown.
const isObject = (e: unknown): e is object => typeof e === 'object' && e !== null;
const nameOf = (e: unknown) => isObject(e) && 'name' in e ? e.name : undefined;
const codeOf = (e: unknown) => isObject(e) && 'code' in e ? e.code : undefined;
const messageOf = (e: unknown) => isObject(e) && 'message' in e ? e.message : undefined;
async function open(data: Uint8Array, password: string | undefined) {
  const task = getDocument({ ...OPTIONS, data, password });
  try { return await task.promise; }
  catch (e) {
    await task.destroy().catch(() => {});
    if (nameOf(e) === 'PasswordException') throw Object.assign(new Error(codeOf(e) === 2 ? 'incorrect password' : 'encrypted: it needs a password to open'), { code: 'EENCRYPTED' });
    if (nameOf(e) === 'InvalidPDFException') throw Object.assign(new Error('not a PDF file (or damaged beyond repair)'), { code: 'ENOTPDF' });
    throw e;
  }
}

// Without includeMarkedContent pdf.js yields TextItems only; the guard says so to tsc.
const isTextItem = (it: TextItem | TextMarkedContent): it is TextItem => 'str' in it;
const textItems = async (page: PDFPageProxy) => (await page.getTextContent()).items.filter(isTextItem);

const textOf = (items: TextItem[]) => items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
// -layout: lines by baseline, items left to right, gaps as spaces (an approximation of poppler's).
interface Run { s: string; x: number; y: number; w: number; h: number }
function layoutOf(items: TextItem[]) {
  const runs = items.filter((it) => it.str).map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 10 }));
  if (!runs.length) return '';
  const cw = runs.reduce((n, r) => n + r.w, 0) / Math.max(1, runs.reduce((n, r) => n + r.s.length, 0)) || 5;
  const lines: { y: number; h: number; runs: Run[] }[] = [];
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
const hasText = (items: TextItem[]) => items.some((it) => /\S/.test(it.str));

type Note = (line: string) => void;
const actions = {
  async info({ data, password, scan }: PdfInfoJob, id: number): Promise<PdfInfo> {
    const doc = await open(data, password);
    try {
      const { info } = await doc.getMetadata();
      const js = await doc.getJSActions().catch(() => null), hasJs = await doc.hasJSActions?.().catch(() => false);
      const p1 = await doc.getPage(1), [x0, y0, x1, y1] = p1.view;
      const out: PdfInfo = { pages: doc.numPages, info: info as PdfDocInfo /* pdf.js types it as object */, javascript: !!(js && Object.keys(js).length) || !!hasJs,
        size: [x1 - x0, y1 - y0], rotate: p1.rotate, noText: [], scanned: Math.min(doc.numPages, scan) };
      for (let n = 1; n <= out.scanned; n++) {
        check(id);
        const page = n === 1 ? p1 : await doc.getPage(n);
        if (!hasText(await textItems(page))) out.noText.push(n);
        if (n !== 1) page.cleanup();
      }
      return out;
    } finally { await doc.loadingTask.destroy(); }
  },
  async text({ data, password, first, last, layout }: PdfTextJob, id: number, note: Note) {
    const doc = await open(data, password);
    try {
      const pages: PdfTextPage[] = [], hi = Math.min(last ?? doc.numPages, doc.numPages);
      if (first > doc.numPages) throw Object.assign(new Error(`first page ${first} is past the last page (${doc.numPages})`), { code: 'ERANGE' });
      for (let n = first; n <= hi; n++) {
        check(id);
        const page = await doc.getPage(n);
        const items = await textItems(page);
        pages.push({ n, text: layout ? layoutOf(items) : textOf(items), empty: !hasText(items) });
        page.cleanup();
        if (n % 10 === 0) note(`page ${n} of ${hi}`);
      }
      return { numPages: doc.numPages, pages };
    } finally { await doc.loadingTask.destroy(); }
  },
  // Pixel caps are checked by the page before asking; maxPixels is checked again here per page.
  async render({ data, password, first, last, dpi, maxPixels, maxBytes = Infinity, type, crop }: PdfRenderJob, id: number, note: Note) {
    const doc = await open(data, password);
    try {
      let total = 0;
      const out: PdfImage[] = [], hi = Math.min(last ?? doc.numPages, doc.numPages);
      if (first > doc.numPages) throw Object.assign(new Error(`first page ${first} is past the last page (${doc.numPages})`), { code: 'ERANGE' });
      for (let n = first; n <= hi; n++) {
        check(id);
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: dpi / 72 });
        const w = Math.ceil(viewport.width - 1e-6), h = Math.ceil(viewport.height - 1e-6); // 792 pt at 600 DPI is 6600, not 6601
        if (w * h > maxPixels) throw Object.assign(new Error(`page ${n} at ${dpi} DPI is ${w}x${h} pixels, over the cap of ${maxPixels}; lower -r`), { code: 'ECAP' });
        const canvas = new OffscreenCanvas(w, h), ctx = context2d(canvas);
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        await page.render({ canvasContext: ctx, canvas, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
        let img = canvas;
        if (crop) {
          const x = Math.min(crop.x, w - 1), y = Math.min(crop.y, h - 1);
          const cw = Math.max(1, Math.min(crop.W || w - x, w - x)), ch = Math.max(1, Math.min(crop.H || h - y, h - y));
          img = new OffscreenCanvas(cw, ch); context2d(img).drawImage(canvas, x, y, cw, ch, 0, 0, cw, ch);
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

function run(job: PdfJob, id: number, note: Note): Promise<PdfResult> {
  switch (job.action) {
    case 'info': return actions.info(job, id);
    case 'text': return actions.text(job, id, note);
    case 'render': return actions.render(job, id, note);
  }
}
// Rendered pages move to the page rather than being copied.
const transferOf = (result: PdfResult) => !('pages' in result) || !Array.isArray(result.pages) ? [] :
  result.pages.flatMap((p) => ('bytes' in p && p.bytes.buffer instanceof ArrayBuffer ? [p.bytes.buffer] : []));

self.onmessage = async ({ data: msg }: MessageEvent<PdfRequest>) => {
  if (msg.action === 'stop') { stopped.add(msg.job); return; }
  const { id } = msg;
  try {
    let result: PdfResult;
    if (msg.action === 'load') {
      files = unpack(msg.pack);
      // From here on this worker has no network at all (see the header).
      for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
        try { Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false }); } catch { Object.assign(globalThis, { [k]: undefined }); }
      }
      result = { files: files.size };
    } else {
      result = await run(msg, id, (line) => postMessage({ id, note: line } satisfies PdfReply));
    }
    postMessage({ id, result } satisfies PdfReply, transferOf(result));
  } catch (e) {
    postMessage({ id, error: String(messageOf(e) ?? e), code: codeOf(e), name: nameOf(e) });
  } finally { stopped.delete(id); }
};
