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
//   clip.mp4     1 s H.264 (not decodable here: the documented gap)
// Run: node test/media-browser.mjs
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
const browser = await pw.chromium.launch();
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
  for (const f of ['colors.webm', 'vp9.webm', 'tone.wav', 'clip.mp4']) await put('/work/' + f, fixture(f));

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
  // The gaps: no resampling (Opus to WAV), no MP4/H.264. FFmpeg's error, then Pouch's hint.
  r = await sh('ffmpeg -i colors.webm -vn audio.wav');
  assert.equal(r.code, 1); assert.match(r.err, /nothing was written to \/work\/audio\.wav/); assert.match(r.err, /hint: this build reads and writes/);
  r = await sh('ffprobe -v error -show_format clip.mp4');
  assert.equal(r.code, 1); assert.match(r.err, /\/work\/clip\.mp4: Invalid data found/); assert.match(r.err, /not MP4\/MOV\/M4A, H\.264, AAC or MP3/);
  r = await sh('ffmpeg -i clip.mp4 x.png');
  assert.equal(r.code, 1); assert.match(r.err, /clip\.mp4/);
  r = await sh('ffmpeg -decoders');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /libvpx-vp9/); assert.doesNotMatch(r.out, /\bh264\b/);
  ok('audio copy to Opus, trim, VP9 transcode, WAV to FLAC/Opus; the gaps say so');

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
  assert.deepEqual(errors.filter((e) => !/Warning/i.test(e)), [], 'no page errors');
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
