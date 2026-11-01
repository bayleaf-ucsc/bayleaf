// The real libav.js runtime in a real page, under Pouch's production CSP and
// headers: built by build-libav.mjs into a scratch dir, fetched as verified
// parts on first use, driven through the shell's ffprobe and ffmpeg
// (src/media.js) over an in-memory filesystem. Checks ffprobe JSON, frames as
// PNG/JPEG with the expected colors and times, audio extraction, conversions,
// the codec gap's message, Stop through /task ctl, that the only requests are
// this origin's runtime parts (never libav-source), and no CSP violation.
// Fixtures (test/fixtures/media/, made with Homebrew ffmpeg 8 and -fflags +bitexact):
//   colors.webm  3 s, 64x48 VP8 at 10 fps: red, then green, then blue (1 s each); Opus 440 Hz
//   vp9.webm     2 s, 64x48 VP9: red, then blue
//   tone.wav     0.5 s, 8 kHz s16 sine
//   clip.mp4     1 s H.264
// and for the WebCodecs path (Homebrew ffmpeg 8.0, -fflags +bitexact, -map_metadata -1):
//   scene.mp4    2 s, 64x48 H.264 at 10 fps (keyframe every 1 s): red, then blue; AAC 440 Hz mono 44.1 kHz
//   scene.mov    the same streams in QuickTime (ftyp qt), display rotation 90 (a phone held upright)
//   tone.m4a     0.5 s AAC 44.1 kHz;  tone.mp3  0.5 s MP3 44.1 kHz, no ID3
//   tone24.wav   0.25 s, 16 kHz stereo, 24-bit PCM
//   halves.mov   0.3 s, 64x48 H.264: top half red, bottom blue; rotation -90 (Homebrew ffmpeg turns it clockwise: blue left, red right)
//   hevc.mp4     0.5 s, 64x48 HEVC (hvc1), green: decodes only where the browser has HEVC
// Run: node test/media-browser.mjs   (MEDIA_CHANNEL=chrome: installed Chrome, where HEVC decodes;
// MEDIA_ONLY="cmd;;cmd": just run those commands on the fixtures and print the results)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { buildLibav } from '../build-libav.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 4 minutes'); process.exit(2); }, 240_000).unref();
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-libav-'));
process.chdir(root);
const { pin, source } = await buildLibav(scratch);
const fixture = (f) => readFileSync(join(root, 'test/fixtures/media', f));

const entry = `
import { InMemoryFs } from 'just-bash';
import { shellFor } from './src/tools.js';
import { createMediaService } from './src/media.js';
import { Tasks } from './src/ns/tasks.js';
const fs = new InMemoryFs();
const tasks = new Tasks();
const media = createMediaService({ tasks });
const shell = shellFor(fs, { media });
window.violations = [];
document.addEventListener('securitypolicyviolation', (e) => window.violations.push(e.violatedDirective + ' ' + e.blockedURI));
const bitmap = async (p) => { const b = await createImageBitmap(new Blob([await fs.readFileBuffer(p)])); const c = new OffscreenCanvas(b.width, b.height).getContext('2d'); c.drawImage(b, 0, 0); return { b, c }; };
window.pouch = {
  put: async (p, b64) => { await fs.mkdir(p.replace(/\\/[^/]*$/, ''), { recursive: true }); await fs.writeFile(p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); },
  sh: async (cmd) => { const r = await shell.exec(cmd, { cwd: '/work' }); return { out: r.stdout, err: r.stderr, code: r.exitCode }; },
  start: (cmd) => { window.pending = shell.exec(cmd, { cwd: '/work' }); },
  finish: async () => { const r = await window.pending; return { out: r.stdout, err: r.stderr, code: r.exitCode }; },
  tasks: () => tasks.list().map((t) => ({ id: t.id, kind: t.kind, label: t.label, status: t.status })),
  kill: (id) => tasks.kill(tasks.get(id)),
  pixel: async (p, x, y) => { const { b, c } = await bitmap(p); return { w: b.width, h: b.height, rgba: [...c.getImageData(x, y, 1, 1).data] }; },
  bytes: async (p) => [...(await fs.readFileBuffer(p)).subarray(0, 4)],
  size: async (p) => (await fs.stat(p)).size,
};`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const app = (await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, write: false, format: 'iife', minify: true,
  define: { WORKER_SRC: JSON.stringify(worker), POUCH_LIBAV_RUNTIME: JSON.stringify(pin), POUCH_LIBAV_SOURCE: JSON.stringify(source) },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js') }, logLevel: 'error' })).outputFiles[0].text;
const script = app.replaceAll('</script', '<\\/script');
const csp = readFileSync(join(root, 'pouch.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
  .replace('__SCRIPT_HASHES__', `'sha256-${createHash('sha256').update(script).digest('base64')}'`);
const HEADERS = headersFile(csp, viewerCsp(root));
const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>media test</title><script>${script}</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/runtime/')) { try { res.writeHead(200, headersFor(HEADERS, path)); return res.end(readFileSync(join(scratch, path))); } catch { res.writeHead(404); return res.end(); } }
  if (path === '/pouch.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, '/pouch.html') }); return res.end(html); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
const ok = (name) => { pass++; console.log('ok', name); };
const near = (rgba, want, name) => assert.ok(rgba.slice(0, 3).every((v, i) => Math.abs(v - want[i]) < 40), `${name}: got ${rgba}, want about ${want}`);
const browser = await pw.chromium.launch(process.env.MEDIA_CHANNEL ? { channel: process.env.MEDIA_CHANNEL } : {});
try {
  const page = await browser.newPage();
  const requests = [], errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin + '/pouch.html');
  const put = (p, bytes) => page.evaluate(([p, b]) => window.pouch.put(p, b), [p, Buffer.from(bytes).toString('base64')]);
  const sh = (cmd) => page.evaluate((c) => window.pouch.sh(c), cmd);
  const px = (p, x = 32, y = 24) => page.evaluate(([p, x, y]) => window.pouch.pixel(p, x, y), [p, x, y]);
  for (const f of ['colors.webm', 'vp9.webm', 'tone.wav', 'clip.mp4', 'scene.mp4', 'scene.mov', 'tone.m4a', 'tone.mp3', 'tone24.wav', 'hevc.mp4', 'halves.mov']) await put('/work/' + f, fixture(f));

  if (process.env.MEDIA_ONLY) { for (const c of process.env.MEDIA_ONLY.split(';;')) console.log(c, await Promise.race([sh(c), new Promise((r) => setTimeout(() => r('TIMEOUT'), 15000))])); console.log(errors); process.exit(0); }
  // Argument errors and missing files are answered before the runtime loads.
  let r = await sh('ffprobe nope.webm');
  assert.equal(r.code, 1); assert.match(r.err, /\/work\/nope\.webm: No such file or directory/);
  r = await sh('ffmpeg -i colors.webm');
  assert.equal(r.code, 1); assert.match(r.err, /needs an output file/);
  r = await sh('ffmpeg -i https://example.com/a.webm out.webm');
  assert.equal(r.code, 1); assert.match(r.err, /only files in this workspace/);
  assert.ok(!requests.some((u) => u.includes('/runtime/')), 'nothing fetched yet');
  ok('argument errors without loading the runtime');

  // AG2: a structured probe.
  r = await sh('ffprobe -v error -show_format -show_streams -of json colors.webm');
  assert.equal(r.code, 0, r.err);
  const probe = JSON.parse(r.out);
  assert.deepEqual(probe.streams.map((s) => s.codec_name), ['vp8', 'opus']);
  assert.equal(probe.streams[0].width, 64); assert.equal(probe.streams[0].height, 48);
  assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.1, `duration ${probe.format.duration}`);
  assert.equal(probe.format.filename, '/work/colors.webm', 'the caller\'s path, not libav\'s');
  r = await sh('ffprobe -v error -show_entries format=duration -of csv=p=0 vp9.webm');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^2\.0\d*\n$/);
  r = await sh('ffprobe -v error -show_entries stream=codec_name -of csv=p=0 tone.wav');
  assert.equal(r.out, 'pcm_s16le\n');
  ok('ffprobe: JSON format and streams, -show_entries, the caller\'s file names');

  // AG1: frames at a rate, scaled, numbered; colors match the scenes; times reported.
  r = await sh('ffmpeg -i colors.webm -vf fps=1,scale=32:-1 frames/f-%03d.png');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /wrote \/work\/frames\/f-001\.png \(t=0s, 32x24\)\nwrote \/work\/frames\/f-002\.png \(t=1s, 32x24\)\nwrote \/work\/frames\/f-003\.png \(t=2s, 32x24\)\n$/);
  let p = await px('/work/frames/f-001.png', 16, 12); assert.deepEqual([p.w, p.h], [32, 24]); near(p.rgba, [255, 0, 0], 'frame 1 red');
  near((await px('/work/frames/f-002.png', 16, 12)).rgba, [0, 255, 0], 'frame 2 green');
  near((await px('/work/frames/f-003.png', 16, 12)).rgba, [0, 0, 255], 'frame 3 blue');
  r = await sh('ffmpeg -ss 2.5 -i colors.webm -frames:v 1 still.png');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote \/work\/still\.png \(t=2\.5s, 64x48\)/);
  near((await px('/work/still.png')).rgba, [0, 0, 255], '-ss 2.5 is blue');
  r = await sh('ffmpeg -ss 00:00:01.2 -i colors.webm -frames:v 1 -q:v 3 still.jpg');
  assert.equal(r.code, 0, r.err); near((await px('/work/still.jpg')).rgba, [0, 255, 0], '-ss 1.2 is green (JPEG)');
  assert.deepEqual(await page.evaluate(() => window.pouch.bytes('/work/still.jpg')).then((b) => b.slice(0, 3)), [0xff, 0xd8, 0xff]);
  r = await sh('ffmpeg -i vp9.webm -r 1 v9-%d.png');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /v9-1\.png.*\n.*v9-2\.png/);
  near((await px('/work/v9-1.png')).rgba, [255, 0, 0], 'VP9 frame 1 red'); near((await px('/work/v9-2.png')).rgba, [0, 0, 255], 'VP9 frame 2 blue');
  r = await sh('ffmpeg -i colors.webm out.png');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote \/work\/out\.png \(t=0s/);
  r = await sh('ffmpeg -i colors.webm out.png');
  assert.equal(r.code, 1); assert.match(r.err, /already exists\. Exiting \(use -y to overwrite\)/);
  r = await sh('ffmpeg -i colors.webm -c:v libx264 out2.png');
  assert.equal(r.code, 1); assert.match(r.err, /images are PNG, JPEG or WebP/);
  r = await sh('ffmpeg -i colors.webm -frames:v 3 one.png');
  assert.equal(r.code, 1); assert.match(r.err, /use a pattern such as frame-%03d\.png/);
  r = await sh('ffmpeg -i colors.webm f/all-%03d.png');
  assert.equal(r.code, 0, r.err); assert.equal(r.out.trim().split('\n').length, 30, 'every frame of 3 s at 10 fps');
  r = await sh('ffmpeg -ss 10 -i colors.webm -frames:v 1 late.png');
  assert.equal(r.code, 1); assert.match(r.err, /no frames at or after 10s/);
  r = await sh('ffmpeg -i tone.wav x.png');
  assert.equal(r.code, 1); assert.match(r.err, /has no video stream/);
  ok('frames: fps+scale pattern, -ss stills (PNG, JPEG), VP9, one-file default, -y, errors');

  // AV2, AV3: audio out, trims, conversions; outputs are real files.
  r = await sh('ffmpeg -i colors.webm -vn -c:a copy audio/voice.opus');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote \/work\/audio\/voice\.opus \([\d,]+ bytes\)/);
  assert.deepEqual(await page.evaluate(() => window.pouch.bytes('/work/audio/voice.opus')), [0x4f, 0x67, 0x67, 0x53], 'OggS');
  r = await sh('ffprobe -v error -show_entries stream=codec_name -of csv=p=0 audio/voice.opus');
  assert.equal(r.out, 'opus\n');
  r = await sh('ffmpeg -y -ss 1 -t 1 -i colors.webm -c copy cut.webm && ffprobe -v error -show_entries format=duration -of csv=p=0 cut.webm');
  assert.equal(r.code, 0, r.err); assert.ok(Number(r.out.split('\n').at(-2)) <= 1.6, r.out);
  r = await sh('ffmpeg -i colors.webm -an -vf scale=32:-1 -c:v libvpx-vp9 -b:v 50k small.webm && ffprobe -v error -show_entries stream=codec_name,width -of csv=p=0 small.webm');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /vp9,32/);
  r = await sh('ffmpeg -i tone.wav tone.flac && ffmpeg -i tone.wav -c:a libopus tone.opus');
  assert.equal(r.code, 0, r.err);
  // Opus to WAV needs resampling the CLI build lacks: retried on the conversion path, written.
  r = await sh('ffmpeg -i colors.webm -vn audio.wav');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote \/work\/audio\.wav \([\d,]+ bytes, 48000 Hz, (mono|stereo)\)/);
  r = await sh('ffmpeg -decoders');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /libvpx-vp9/); assert.doesNotMatch(r.out, /\bh264\b/);
  ok('audio copy to Opus, trim, VP9 transcode, WAV to FLAC/Opus, Opus to WAV');

  // The WebCodecs path: MOV/MP4/M4A/MP3, decoded by the browser.
  const caps = await page.evaluate(async () => ({ hevc: (await VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L30.90', codedWidth: 64, codedHeight: 48 })).supported }));
  r = await sh('ffprobe -v error -show_format -show_streams -of json scene.mov');
  assert.equal(r.code, 0, r.err);
  let pj = JSON.parse(r.out);
  assert.equal(pj.format.filename, '/work/scene.mov'); assert.equal(pj.format.format_name, 'mov,mp4,m4a,3gp,3g2,mj2');
  assert.ok(Math.abs(Number(pj.format.duration) - 2) < 0.1, pj.format.duration);
  assert.deepEqual(pj.streams.map((s) => [s.codec_type, s.codec_name]), [['video', 'h264'], ['audio', 'aac']]);
  assert.equal(pj.streams[0].width, 64); assert.equal(pj.streams[0].height, 48); assert.equal(pj.streams[0].avg_frame_rate, '10/1');
  assert.equal(pj.streams[0].side_data_list[0].rotation, 90); assert.equal(pj.streams[1].sample_rate, '44100'); assert.equal(pj.streams[1].channels, 1);
  assert.equal(r.err, '');
  r = await sh('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 scene.mp4');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^2\.0\d+\n$/);
  r = await sh('ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 scene.mp4');
  assert.equal(r.out, 'h264,64,48\n');
  r = await sh('ffprobe clip.mp4');
  assert.equal(r.code, 0, r.err); assert.match(r.err, /Input #0, mov,mp4.*from '\/work\/clip\.mp4'/); assert.match(r.err, /Stream #0:0: Video: h264 \(High\), 64x48/);
  r = await sh('ffprobe -v error -show_format -show_streams -of json tone.mp3');
  assert.equal(r.code, 0, r.err); pj = JSON.parse(r.out);
  assert.equal(pj.streams[0].codec_name, 'mp3'); assert.equal(pj.streams[0].sample_rate, '44100'); assert.ok(Math.abs(Number(pj.format.duration) - 0.5) < 0.1);
  r = await sh('ffprobe -v error -show_streams -of json hevc.mp4');
  assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).streams[0].codec_name, 'hevc');
  if (!caps.hevc) assert.match(r.err, /note: stream 0 \(hevc\): this browser's VideoDecoder cannot decode hvc1\./);
  ok('ffprobe on MOV, MP4 and MP3: JSON, -show_entries, csv, the summary, rotation, an HEVC note where it cannot decode');

  r = await sh('ffmpeg -i scene.mp4 -vf fps=1,scale=32:-1 sc/f-%03d.png');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^wrote \/work\/sc\/f-001\.png \(t=0s, 32x24\)\nwrote \/work\/sc\/f-002\.png \(t=1s, 32x24\)\n$/);
  near((await px('/work/sc/f-001.png', 16, 12)).rgba, [255, 0, 0], 'H.264 frame 1 red'); near((await px('/work/sc/f-002.png', 16, 12)).rgba, [0, 0, 255], 'H.264 frame 2 blue');
  r = await sh('ffmpeg -ss 1.5 -i scene.mp4 -frames:v 1 sc/at15.png');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /\(t=1\.5s, 64x48\)/); near((await px('/work/sc/at15.png')).rgba, [0, 0, 255], '-ss 1.5 blue');
  r = await sh('ffmpeg -ss 0.5 -i scene.mov -frames:v 1 -q:v 3 sc/mov.jpg');
  assert.equal(r.code, 0, r.err); p = await px('/work/sc/mov.jpg', 24, 32);
  assert.deepEqual([p.w, p.h], [48, 64], 'the display rotation is applied'); near(p.rgba, [255, 0, 0], 'MOV frame red');
  r = await sh('ffmpeg -i halves.mov -frames:v 1 sc/halves.png');
  assert.equal(r.code, 0, r.err); p = await px('/work/sc/halves.png', 4, 32);
  assert.deepEqual([p.w, p.h], [48, 64]); near(p.rgba, [0, 0, 255], 'rotation -90 turns clockwise: blue on the left'); near((await px('/work/sc/halves.png', 40, 32)).rgba, [255, 0, 0], 'red on the right');
  r = await sh('ffmpeg -i scene.mov -vf fps=1/10,crop=iw/2:ih/2 sc/one-%02d.png');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /one-01\.png \(t=0s, 24x32\)\n$/, 'shorter than one slot: one frame');
  r = await sh('ffmpeg -i scene.mp4 -vf hflip sc/x.png');
  assert.equal(r.code, 1); assert.match(r.err, /the video filters are fps, scale, crop and null/);
  r = await sh('ffmpeg -i tone.mp3 sc/x.png');
  assert.equal(r.code, 1); assert.match(r.err, /has no video stream/);
  r = await sh('ffmpeg -i hevc.mp4 -frames:v 1 sc/hevc.png');
  if (caps.hevc) { assert.equal(r.code, 0, r.err); near((await px('/work/sc/hevc.png')).rgba, [0, 128, 0], 'HEVC green'); }
  else { assert.equal(r.code, 1); assert.match(r.err, /cannot decode hvc1.*HEVC decodes in Chrome and Edge with hardware support, and in Safari/); }
  ok(`frames from H.264 MP4 and MOV (rotated): fps, scale, crop, -ss, JPEG; filter and codec errors; HEVC ${caps.hevc ? 'decoded' : 'refused clearly'}`);

  const probe1 = async (f) => (await sh(`ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 ${f}`)).out.trim();
  r = await sh('ffmpeg -i scene.mov -vn au/scene.wav');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote \/work\/au\/scene\.wav \([\d,]+ bytes, 44100 Hz, mono\)/);
  assert.equal(await probe1('au/scene.wav'), 'pcm_s16le,44100,1');
  r = await sh('ffmpeg -ss 0.5 -t 1 -i scene.mp4 -vn -ar 16000 au/cut.flac');
  assert.equal(r.code, 0, r.err); assert.equal(await probe1('au/cut.flac'), 'flac,16000,1');
  r = await sh('ffprobe -v error -show_entries format=duration -of csv=p=0 au/cut.flac');
  assert.ok(Math.abs(Number(r.out) - 1) < 0.05, `trimmed to 1 s: ${r.out}`);
  r = await sh('ffmpeg -i tone.m4a -b:a 24k au/tone.opus');
  assert.equal(r.code, 0, r.err); assert.equal(await probe1('au/tone.opus'), 'opus,48000,1');
  r = await sh('ffmpeg -i tone.mp3 -ac 2 au/mp3.wav');
  assert.equal(r.code, 0, r.err); assert.equal(await probe1('au/mp3.wav'), 'pcm_s16le,44100,2');
  r = await sh('ffmpeg -i scene.mp4 au/video.mp4');
  assert.equal(r.code, 1); assert.match(r.err, /writing \.mp4 from MOV\/MP4 is not available here.*re-export the video on your own computer/);
  r = await sh('ffmpeg -i scene.mp4 au/v.webm');
  assert.equal(r.code, 1); assert.match(r.err, /For audio only, add -vn/);
  r = await sh('ffmpeg -i tone.m4a -c:a copy au/copy.m4a');
  assert.equal(r.code, 1); assert.match(r.err, /not available here/);
  ok('audio from MOV, MP4, M4A and MP3 to WAV, FLAC and Opus: -ss/-t, -ar, -ac, -b:a; video out says what instead');

  // Conversions the CLI build cannot do (no aresample) go to the conversion path.
  r = await sh('ffmpeg -i tone24.wav -c:a pcm_s16le au/t16.wav');
  assert.equal(r.code, 0, r.err); assert.equal(await probe1('au/t16.wav'), 'pcm_s16le,16000,2');
  r = await sh('ffmpeg -i tone24.wav -ar 8000 -ac 1 au/t8.wav');
  assert.equal(r.code, 0, r.err); assert.equal(await probe1('au/t8.wav'), 'pcm_s16le,8000,1');
  r = await sh('ffmpeg -i tone24.wav au/t24.flac');
  assert.equal(r.code, 0, r.err);
  r = await sh('ffprobe -v error -show_entries stream=sample_fmt,bits_per_raw_sample -of csv=p=0 au/t24.flac');
  assert.match(r.out, /^s32,24\n$/, 'FLAC keeps 24 bits');
  r = await sh('ffmpeg -i tone24.wav -af loudnorm au/ln.wav');
  assert.equal(r.code, 0, r.err); assert.equal(await probe1('au/ln.wav'), 'pcm_s16le,16000,2');
  r = await sh('ffmpeg -i tone.m4a -af dynaudnorm,volume=0.5 -c:a pcm_s24le au/dn.wav');
  assert.equal(r.code, 0, r.err); assert.equal(await probe1('au/dn.wav'), 'pcm_s24le,44100,1');
  r = await sh('ffmpeg -i tone.m4a -af chorus au/bad.wav');
  assert.equal(r.code, 1); assert.match(r.err, /audio filters here: acompressor, .*loudnorm, pan, volume/);
  ok('24-bit WAV to 16-bit, sample rate and channel conversion, 24-bit FLAC, loudnorm and dynaudnorm; an unknown filter lists the real ones');

  // AG6: Stop through the task's ctl (tasks.kill is what `echo stop > /task/N/ctl` calls), mid-ffmpeg.
  const job = await page.evaluate(async () => {
    window.pouch.start('ffmpeg -stream_loop 400 -i colors.webm -c:v libvpx-vp9 -b:v 50k -an long.webm');
    for (let i = 0; i < 4000; i++) {
      const t = window.pouch.tasks().find((t) => t.kind === 'job' && t.label === 'ffmpeg colors.webm' && t.status === 'running');
      if (t) { await new Promise((r) => setTimeout(r, 300)); await window.pouch.kill(t.id); return t; }
      await new Promise((r) => setTimeout(r, 2));
    }
  });
  assert.ok(job, 'ffmpeg runs as a /task job');
  r = await page.evaluate(() => window.pouch.finish());
  assert.equal(r.code, 130, r.err + r.out); assert.match(r.err, /stopped \(\/task\/\d+\)/);
  assert.equal(await page.evaluate(() => window.pouch.size('/work/long.webm').catch(() => -1)), -1, 'a stopped job writes nothing');
  r = await sh('ffprobe -v error -show_entries format=duration -of csv=p=0 colors.webm');
  assert.equal(r.code, 0, 'the engine serves the next job after a stop');
  ok('Stop through /task ends ffmpeg; nothing written; the next job runs');

  // blob: requests are the worker itself, started from the verified bytes (one more after the Stop ended one).
  const blobs = requests.filter((u) => u.startsWith(`blob:${origin}/`));
  assert.ok(blobs.length >= 1 && blobs.length <= 2, `worker starts: ${blobs.length}`);
  const foreign = requests.filter((u) => !u.startsWith(origin + '/') && !blobs.includes(u));
  assert.deepEqual(foreign, [], 'no request leaves this origin');
  const own = requests.filter((u) => u !== origin + '/pouch.html' && !blobs.includes(u));
  assert.ok(own.length && own.every((u) => u.startsWith(origin + '/runtime/libav/')), `only runtime parts: ${own.join(', ')}`);
  assert.ok(!own.some((u) => u.includes('libav-source')), 'the source is never fetched by the page');
  assert.deepEqual(await page.evaluate(() => window.violations), [], 'no CSP violations');
  // Installed Chrome (MEDIA_CHANNEL) also asks for /favicon.ico, outside page.on('request').
  assert.deepEqual(errors.filter((e) => !/Warning/i.test(e) && !(process.env.MEDIA_CHANNEL && /^Failed to load resource: .*404/.test(e))), [], 'no page errors');
  ok(`network: ${own.length} same-origin runtime fetches, nothing else, no CSP violation`);

  // After one use the runtime is kept in this browser; a reload reads it with /runtime unreachable.
  await page.route(`${origin}/runtime/**`, (r) => r.abort());
  await page.reload();
  await put('/work/colors.webm', fixture('colors.webm'));
  r = await sh('ffmpeg -ss 0.5 -i colors.webm -frames:v 1 again.png');
  assert.equal(r.code, 0, r.err);
  ok('after a reload, the kept runtime works with /runtime unreachable');
} finally {
  await browser.close(); server.close(); rmSync(scratch, { recursive: true, force: true });
}
console.log(`media-browser: ${pass} passed`);
