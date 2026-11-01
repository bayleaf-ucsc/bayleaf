// The pdf.js runtime's build inputs (build.mjs runs this): Pouch's first heavy
// tool, under dist/runtime/pdf/ by the build-runtime.mjs convention.
//
// Three files, each checked against the manifest the page is built with:
// - worker.js: src/pdf/worker.js bundled with pdfjs-dist's library and its
//   worker code (one module worker; pdf.js runs its "worker" in that thread).
// - data.pack: what pdf.js would otherwise fetch at run time (cmaps, standard
//   fonts, the OpenJPEG, JBIG2 and qcms decoders' wasm, the CMYK ICC profile),
//   packed into one file so pdf.js needs no URL at all.
// - NOTICE.txt: pdf.js's license and every bundled component's license.
// Not shipped: pdf.js's scripting sandbox (quickjs-eval.wasm, pdf.sandbox.mjs),
// so PDF JavaScript cannot run; the *_nowasm_fallback.js decoders (dynamic
// import(), which the page's CSP refuses anyway); legacy/ and the web/ viewer.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bundleWorker, writeRuntime } from './build-runtime.mjs';

const DIR = 'node_modules/pdfjs-dist/';
// The pin: package.json says 6.4.299 exactly; the lockfile carries npm's
// integrity (sha512-AVl138zA...); these catch a tree that differs anyway.
export const PDFJS = { version: '6.4.299', sha256: {
  'build/pdf.mjs': 'dd13af821c9c3e1778653340d6539a1ba07bc56cba40073a4c727864cf0c232a',
  'build/pdf.worker.mjs': '07ceb740d746e5d9012fcf9f27d5c7dea09f7d2f5e74f5c8109e5787551a2333',
} };
const WASM = ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm'];
const LICENSES = ['LICENSE', 'wasm/LICENSE_PDFJS_OPENJPEG', 'wasm/LICENSE_OPENJPEG', 'wasm/LICENSE_PDFJS_JBIG2', 'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_PDFJS_QCMS', 'wasm/LICENSE_QCMS', 'standard_fonts/LICENSE_FOXIT', 'standard_fonts/LICENSE_LIBERATION', 'cmaps/LICENSE', 'iccs/LICENSE'];

// pdf.js's run-time fetches, rewritten in its source to read data.pack
// (pouchFile in src/pdf/worker.js); and its worker side must not adopt the
// module worker's own port (it would answer Pouch's messages).
const SOURCES = { 'pdfjs-dist/build/pdf.worker.mjs': [
  [/async function fetchBinaryData\(url\) \{/g, 'async function fetchBinaryData(url) { return globalThis.pouchFile(url);', 1],
  [/function fetchSync\(url\) \{/g, 'function fetchSync(url) { return globalThis.pouchFile(url).buffer;', 1],
  [/if \(typeof window === "undefined" && !isNodeJS && typeof self !== "undefined" && typeof self\.postMessage === "function" && "onmessage" in self\) \{/g, 'if (false) {', 1],
] };

// u32 LE header length, JSON { path: [offset, length] }, then the bytes.
export function pack(entries) {
  const index = {}; let at = 0;
  for (const [p, b] of entries) { index[p] = [at, b.length]; at += b.length; }
  const head = Buffer.from(JSON.stringify(index)), n = Buffer.alloc(4);
  n.writeUInt32LE(head.length);
  return Buffer.concat([n, head, ...entries.map(([, b]) => b)]);
}

export async function buildPdf(out) {
  const v = JSON.parse(readFileSync(DIR + 'package.json', 'utf8')).version;
  if (v !== PDFJS.version) throw new Error(`pdfjs-dist ${v} in node_modules; build-pdf.mjs pins ${PDFJS.version}`);
  for (const [f, h] of Object.entries(PDFJS.sha256)) {
    if (createHash('sha256').update(readFileSync(DIR + f)).digest('hex') !== h) throw new Error(`${DIR}${f} differs from its pinned SHA-256`);
  }
  const worker = await bundleWorker('src/pdf/worker.js', [], { sources: SOURCES });
  if (/quickjs/i.test(worker)) throw new Error('the pdf worker bundle mentions quickjs: scripting must not ship');
  const entries = [
    ...readdirSync(DIR + 'cmaps').filter((f) => f.endsWith('.bcmap')).sort().map((f) => ['cmaps/' + f, readFileSync(DIR + 'cmaps/' + f)]),
    ...readdirSync(DIR + 'standard_fonts').filter((f) => /\.(pfb|ttf)$/.test(f)).sort().map((f) => ['standard_fonts/' + f, readFileSync(DIR + 'standard_fonts/' + f)]),
    ...WASM.map((f) => ['wasm/' + f, readFileSync(DIR + 'wasm/' + f)]),
    ['iccs/CGATS001Compat-v2-micro.icc', readFileSync(DIR + 'iccs/CGATS001Compat-v2-micro.icc')],
  ];
  const notice = Buffer.from(`BayLeaf Pouch's pdf runtime: pdfjs-dist ${PDFJS.version} (https://github.com/mozilla/pdf.js), Apache-2.0,\n`
    + 'with the components below. Each license follows, under the path it has in the npm package.\n\n'
    + LICENSES.map((f) => `==> ${f} <==\n${readFileSync(DIR + f, 'utf8').trim()}\n`).join('\n'));
  return writeRuntime(out, 'pdf', [
    { name: 'worker.js', role: 'worker', bytes: worker },
    { name: 'data.pack', role: 'data', bytes: pack(entries) },
    { name: 'NOTICE.txt', role: 'license', bytes: notice },
  ]);
}
