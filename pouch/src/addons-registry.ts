// The add-ons this build of Pouch carries, one entry each, built from the
// build's pins (build.mjs defines). An entry whose pin is missing (a build
// that left it out) is simply absent; its commands say "not available here".
//
// Adding an add-on (README "Add-ons: the recipe"): its build step produces a
// pin (build-runtime.mjs writeRuntime for origin parts, or a models.lock.json
// entry for gateway files), build.mjs defines it, and one entry below names
// it; its worker calls addons.assets(id).obtain() (tools) or addons.files(id)
// (models) before it starts. The consent tier follows from the entry
// (src/addons.ts tierOf), never from a flag.
import { LOCAL, support as tjsSupport } from './local/host.ts';
import type { AddonDef } from './addons.ts';

const PDF = typeof POUCH_PDF_RUNTIME !== 'undefined' ? POUCH_PDF_RUNTIME : null; // eslint-disable-line no-undef
const LIBAV = typeof POUCH_LIBAV_RUNTIME !== 'undefined' ? POUCH_LIBAV_RUNTIME : null; // eslint-disable-line no-undef

export const PDFJS = 'pdfjs', LIBAVJS = 'libavjs', TRANSFORMERSJS = 'transformersjs';
export const LFM3 = LOCAL?.id ?? null; // the lock's id (lfm3-1.7b-q4f16); `addons install lfm3` matches it

export const REGISTRY: AddonDef[] = [
  ...(PDF ? [{ id: PDFJS, label: 'pdf.js', kind: 'tool' as const, files: { origin: PDF }, license: 'Apache-2.0 and the bundled components\' licenses (NOTICE.txt)',
    notice: `${PDF.dir}NOTICE.txt`, usedBy: ['pdfinfo', 'pdftotext', 'pdftoppm'] }] : []),
  ...(LIBAV ? [{ id: LIBAVJS, label: 'libav.js', kind: 'tool' as const, files: { origin: LIBAV }, license: 'LGPL-2.1-or-later and others, with the corresponding source offered (NOTICE.txt)',
    notice: `${LIBAV.dir}NOTICE.txt`, usedBy: ['ffprobe', 'ffmpeg'] }] : []),
  // The Transformers.js code (Transformers.js and ONNX Runtime Web): installed with LFM3, never listed alone.
  ...(LOCAL ? [{ id: TRANSFORMERSJS, label: 'Transformers.js', kind: 'tool' as const, hidden: true, files: { origin: LOCAL.runtime },
    license: 'Apache-2.0 (Transformers.js), MIT (ONNX Runtime Web)', provider: 'Transformers.js', device: tjsSupport }] : []),
  ...(LOCAL ? [{ id: LOCAL.id, label: LOCAL.label, kind: 'model' as const, files: { gateway: LOCAL }, needs: [TRANSFORMERSJS],
    license: LOCAL.license, extraLicense: true, provider: 'Transformers.js', device: tjsSupport }] : []),
];
