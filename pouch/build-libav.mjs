// The libav.js runtime's build inputs (build.mjs runs this): Pouch's second
// heavy tool, under dist/runtime/libav/ by the build-runtime.mjs convention,
// plus the corresponding source it owes under dist/runtime/libav-source/.
//
// Variant: webm-vp9-cli (not default-cli). default-cli has no video decoder
// at all, so it cannot extract a frame (story AG1); webm-vp9-cli adds VP8 and
// VP9 (libvpx), swscale and the video filters (fps, scale, crop, trim) for
// 1.8 MiB more wasm. Neither has swresample, PNG, MP4, MP3, AAC or H.264: see
// the media skill and README "Media" for what that rules out.
//
// runtime/libav/ (the page fetches it on the first media command):
// - worker.js: src/media/worker.js bundled with libav.js's wrapper and its
//   Emscripten factory (direct mode: libav runs in this one worker).
// - libav.wasm: the variant's wasm, byte for byte as released.
// - NOTICE.txt: licenses, and where the source is.
// runtime/libav-source/ (never fetched by the page; LGPL-2.1 section 6):
//   the release's whole sources/ (this variant's, then the unlinked rest), from
//   pinned upstream URLs whose bytes equal the libav.js 6.10.9.0 release zip's
//   sources/ (checked 2026-11-01), except libav.js itself: GitHub's archive of
//   the same tag (the zip holds `git archive HEAD | xz`, the same tree).
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { bundleWorker, writeRuntime } from './build-runtime.mjs';

const PKG = 'node_modules/@libav.js/variant-webm-vp9-cli/';
// The WebCodecs path's build (src/media/worker.js header): webcodecs-avf is API
// only (no ffmpeg or ffprobe programs) with the MOV demuxer, swresample, the
// audio and video filters, and the FLAC and Opus encoders; it decodes no H.264,
// HEVC, AAC or MP3 itself (the browser does). Same FFmpeg 9.0, opus 1.6.1,
// libav.js and emfiberthreads sources as webm-vp9-cli, so SOURCES covers both.
const AVF = 'node_modules/@libav.js/variant-webcodecs-avf/';
// The pin: package.json says 6.10.9 exactly; the lockfile carries npm's
// integrity; these catch a tree that differs anyway (and equal the release zip's dist/).
export const LIBAV = { version: '6.10.9', release: '6.10.9.0', variant: 'webm-vp9-cli', sha256: {
  'dist/libav-6.10.9.0-webm-vp9-cli.mjs': 'f6e25016b3a2ce688fe83ebf11e2c53e5129905331b32bfcf3c0a16ca6b3febb',
  'dist/libav-6.10.9.0-webm-vp9-cli.wasm.mjs': 'ef22fe85ed64a3a8d8417c51914d405a5b2d023bc6b0737c72ae032b8e815bd6',
  'dist/libav-6.10.9.0-webm-vp9-cli.wasm.wasm': '96c3e65dca8ea56fd5de99ebf3c380d1b4fe446e4c5c78f1f269569e1574951c',
}, avf: { variant: 'webcodecs-avf', sha256: {
  'dist/libav-6.10.9.0-webcodecs-avf.mjs': '93e172fc9ead23f0dfce6cfa361e1e07466887c7e1af0680d3b3a6d1a5e536f0',
  'dist/libav-6.10.9.0-webcodecs-avf.wasm.mjs': '9a377e18d19ba5041eed38728237e0479c788cd67ebef25c992a0e5038df0291',
  'dist/libav-6.10.9.0-webcodecs-avf.wasm.wasm': 'ff9a841032499ce87c0f019f602a2f5f30a4f9dcb74c7de4c087024d4706b730',
} } };

// What webm-vp9-cli is built from (its deps.mk: ffmpeg, libvpx, libopus;
// emfiberthreads is linked by every libav.js build). [file, url, sha256, licenses in it]
export const SOURCES = [
  ['libav.js-6.10.9.0.tar.gz', 'https://github.com/Yahweasel/libav.js/archive/refs/tags/v6.10.9.0.tar.gz',
    '3b640c356d74724a99230b077ef442d8c995a37c03e0729d6d2a9be0f3a41fd3', ['libav.js-6.10.9.0/LICENSE.md']],
  ['ffmpeg-9.0.tar.xz', 'https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz',
    '7f607a00dd0d28a729d5a4811205812eef01cf6ef6155025febb6f36a9062d52', ['ffmpeg-9.0/LICENSE.md', 'ffmpeg-9.0/COPYING.LGPLv2.1']],
  ['libvpx-1.16.0.tar.gz', 'https://github.com/webmproject/libvpx/archive/refs/tags/v1.16.0.tar.gz',
    '7a479a3c66b9f5d5542a4c6a1b7d3768a983b1e5c14c60a9396edc9b649e015c', ['libvpx-1.16.0/LICENSE', 'libvpx-1.16.0/PATENTS']],
  ['opus-1.6.1.tar.gz', 'https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz',
    '6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1', ['opus-1.6.1/COPYING']],
  ['emfiberthreads-1.3.tar.gz', 'https://github.com/Yahweasel/emfiberthreads/archive/refs/tags/v1.3.tar.gz',
    '0fe933d7742de3b3213608e0fb087a1ae0d060604d5835f7c9cdfcee0fc8cbcb', ['emfiberthreads-1.3/LICENSE.md']],
];
// The rest of the release's sources/: libraries other variants link and this
// one does not (its deps.mk), hosted anyway so the source set is the release's
// whole. Byte-identical to the zip's sources/ (checked 2026-11-01). [file, url, sha256]
export const UNLINKED = [
  ['libvorbis-1.3.7.tar.xz', 'https://downloads.xiph.org/releases/vorbis/libvorbis-1.3.7.tar.xz',
    'b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b'],
  ['libogg-1.3.6.tar.xz', 'https://downloads.xiph.org/releases/ogg/libogg-1.3.6.tar.xz',
    '5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061'],
  ['lame-3.100.tar.gz', 'https://sourceforge.net/projects/lame/files/lame/3.100/lame-3.100.tar.gz',
    'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e'],
  ['libaom-03087864.tar.gz', 'https://gitlab.com/webmproject/libaom/-/archive/03087864/libaom-03087864.tar.gz',
    '364cc54d1879a0a84b9b78ff5e1f5f04d0a3833e83edc38a10f80c67dc0e0ad3'],
  ['zlib-1.3.2.tar.gz', 'https://www.zlib.net/fossils/zlib-1.3.2.tar.gz',
    'bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16'],
];
// Fetched once into the gitignored node_modules cache, then checked on every build.
const CACHE = 'node_modules/.cache/pouch-libav-source/';

// Emscripten's Node branches import node:module and require node:fs, path, url
// and crypto, which a browser bundle cannot resolve; they never run in a
// worker (ENVIRONMENT_IS_NODE is false), so they become a throw and (void 0).
const NODE_AND_BOOTSTRAP = [
  [/const\{createRequire\}=await import\("node:module"\);var require=createRequire\(import\.meta\.url\)/g, 'throw new Error("libav.js: Node is not supported here")', 1],
  [/require\("node:(crypto|fs|path|url)"\)/g, '(void 0)', 4],
  // libav.js's own worker bootstrap: in a worker whose URL is the module's
  // (our blob), it would replace src/media/worker.js's onmessage with its protocol.
  [/self\.location\.href === import\.meta\.url &&/g, 'false &&', 1],
];
const REWRITES = { 'dist/libav-6.10.9.0-webm-vp9-cli.wasm.mjs': NODE_AND_BOOTSTRAP, 'dist/libav-6.10.9.0-webcodecs-avf.wasm.mjs': NODE_AND_BOOTSTRAP };

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function source([file, url, hash]) {
  const p = CACHE + file;
  if (!existsSync(p)) {
    mkdirSync(CACHE, { recursive: true });
    console.log(`fetching ${url} (libav.js corresponding source, once)`);
    // curl, not fetch: GitLab's archive endpoint answers Node's fetch with 406 (checked 2026-11-01).
    try { execFileSync('curl', ['-fsSL', '--retry', '2', '-o', p + '.part', url], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { throw new Error(`${url}: ${String(e.stderr ?? e.message).trim()}; the libav runtime cannot ship without its source (LGPL-2.1)`); }
    renameSync(p + '.part', p);
  }
  const bytes = readFileSync(p);
  if (sha(bytes) !== hash) throw new Error(`${p} differs from its pinned SHA-256; delete it to fetch again, or update build-libav.mjs SOURCES/UNLINKED after checking`);
  return bytes;
}

export async function buildLibav(out) {
  const v = JSON.parse(readFileSync(PKG + 'package.json', 'utf8')).version;
  if (v !== LIBAV.version) throw new Error(`@libav.js/variant-${LIBAV.variant} ${v} in node_modules; build-libav.mjs pins ${LIBAV.version}`);
  for (const [f, h] of Object.entries(LIBAV.sha256)) if (sha(readFileSync(PKG + f)) !== h) throw new Error(`${PKG}${f} differs from its pinned SHA-256`);
  const va = JSON.parse(readFileSync(AVF + 'package.json', 'utf8')).version;
  if (va !== LIBAV.version) throw new Error(`@libav.js/variant-${LIBAV.avf.variant} ${va} in node_modules; build-libav.mjs pins ${LIBAV.version}`);
  for (const [f, h] of Object.entries(LIBAV.avf.sha256)) if (sha(readFileSync(AVF + f)) !== h) throw new Error(`${AVF}${f} differs from its pinned SHA-256`);
  const all = [...SOURCES, ...UNLINKED];
  const sources = await Promise.all(all.map(source));
  const src = writeRuntime(out, 'libav-source', all.map(([name], i) => ({ name, role: 'source', bytes: sources[i] })));

  const worker = await bundleWorker('src/media/worker.js', [], { sources: REWRITES });
  const licenses = SOURCES.flatMap(([file, , , lic]) => lic.map((l) => `==> ${l} (in ${file}) <==\n${execFileSync('tar', ['-xOf', CACHE + file, l], { encoding: 'utf8', maxBuffer: 2 ** 22 }).trim()}\n`));
  const notice = Buffer.from(`BayLeaf Pouch's media runtime: libav.js ${LIBAV.release}, variant ${LIBAV.variant}
(https://github.com/Yahweasel/libav.js): FFmpeg 9.0 (libavformat, libavcodec,
libavfilter, libavutil, libswscale, and the ffmpeg and ffprobe programs),
libvpx 1.16.0 and libopus 1.6.1, compiled to WebAssembly by libav.js's author.
The libraries are under the GNU Lesser General Public License, version 2.1
(text below); libav.js's own wrapper is 0BSD-style; libvpx and libopus are
BSD-style. Pouch ships libav.wasm unmodified (SHA-256 ${LIBAV.sha256[`dist/libav-${LIBAV.release}-${LIBAV.variant}.wasm.wasm`]}),
and in worker.js its wrapper, unmodified, and its Emscripten factory, modified
only to disable code paths: the factory's Node.js imports become a throw or
(void 0), and libav.js's own worker bootstrap is turned off (REWRITES in
Pouch's build-libav.mjs: three rules, six replacements per factory). MOV, MP4
and MP3 files go through a second build of the same sources, variant
${LIBAV.avf.variant} (libavformat, libavcodec, libavfilter, libswresample,
libswscale, libopus; no ffmpeg or ffprobe programs): libav-avf.wasm,
unmodified (SHA-256 ${LIBAV.avf.sha256[`dist/libav-${LIBAV.release}-${LIBAV.avf.variant}.wasm.wasm`]}),
its wrapper and factory also in worker.js, the factory under the same rules.
H.264, HEVC, AAC and MP3 are decoded by the browser's WebCodecs, not by these builds.

Corresponding source, from this same site: runtime/libav-source/${src.pin.manifest}
lists each tarball below with its SHA-256 and the part file(s) that hold it, in
order (concatenate them). To rebuild: unpack libav.js, put the other tarballs in
its sources/ folder, and run \`make build-${LIBAV.variant} build-${LIBAV.avf.variant}\` with Emscripten (see its README).
${SOURCES.map(([f, url, h]) => `  ${f}  sha256 ${h}\n    (also at ${url})`).join('\n')}

Included for completeness, not linked into this variant (the rest of the
release's sources/, for libav.js's other variants):
${UNLINKED.map(([f, url, h]) => `  ${f}  sha256 ${h}\n    (also at ${url})`).join('\n')}

Each license of the linked code follows, under its path in those tarballs.

${licenses.join('\n')}`);
  const runtime = writeRuntime(out, 'libav', [
    { name: 'worker.js', role: 'worker', bytes: worker },
    { name: 'libav.wasm', role: 'wasm', bytes: readFileSync(PKG + `dist/libav-${LIBAV.release}-${LIBAV.variant}.wasm.wasm`) },
    { name: 'libav-avf.wasm', role: 'wasm', bytes: readFileSync(AVF + `dist/libav-${LIBAV.release}-${LIBAV.avf.variant}.wasm.wasm`) },
    { name: 'NOTICE.txt', role: 'license', bytes: notice },
  ]);
  return { sums: [...runtime.sums, ...src.sums], pin: runtime.pin, source: src.pin };
}
