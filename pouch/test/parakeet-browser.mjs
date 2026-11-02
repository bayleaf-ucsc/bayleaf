// The real speech-to-text runtime in a real page (stories TR1-TR3, TR5), under
// Pouch's production CSP: build-libav.mjs and build-parakeet.mjs into a scratch
// dir; the model's pinned files served by range from a stand-in for the BayLeaf
// HF gateway on this test's origin (from the cache fetch-models.mjs fills; the
// page checks every byte against models.lock.json as it would from
// api.bayleaf.dev). Clips are spoken by macOS `say` from known text and made
// into M4A (afconvert) and MP4 with a video track (Homebrew ffmpeg, if present).
//
// Checks: `addons install parakeet --wait` (approved by a stand-in for the user's
// click) downloads and verifies; transcribe writes TXT, SRT, VTT and JSON with
// sane timestamps and a word error rate under 10% against the spoken text, from
// M4A and MP4; a 4-minute clip shows window progress in /task and stops through
// ctl with exit 130; offline (no network at all) after a reload it transcribes
// again from the kept files; the only requests are this origin's runtime parts
// and gateway ranges; no CSP violation. Skips cleanly without WebGPU and
// shader-f16, or without `say`.
// Run: node test/parakeet-browser.mjs   (PARAKEET_CHROME: a Chrome binary; default the installed Google Chrome)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { buildLibav } from '../build-libav.mjs';
import { buildParakeet } from '../build-parakeet.mjs';
import { ensureModels } from '../fetch-models.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 15 minutes'); process.exit(2); }, 900_000).unref();
const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const has = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
if (!has('say') || !has('afconvert')) { console.log('SKIP parakeet-browser: needs macOS say and afconvert to make the clips'); process.exit(0); }

const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-parakeet-'));
const libav = await buildLibav(scratch), asr = await buildParakeet(scratch);
const lockModel = asr.pin.model;
const paths = (await ensureModels({ log: () => {}, only: [lockModel.id] }))[lockModel.id]; // the pinned files, verified, from the local cache

// Clips: known text, spoken. The long one is over 180 s, so parakeet.js windows it (progress, Stop between windows).
const TEXT = 'Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal. Now we are engaged in a great civil war, testing whether that nation, or any nation so conceived and so dedicated, can long endure.';
const LONG = Array.from({ length: 12 }, () => TEXT).join(' '); // about 3.5 minutes
const clip = (name, text, args = []) => { const p = join(scratch, name); execFileSync('say', ['-v', 'Samantha', '-o', p, ...args, '-f', '-'], { input: text }); return p; };
const wav = clip('speech.wav', TEXT, ['--file-format=WAVE', '--data-format=LEI16@22050']);
const m4a = join(scratch, 'interview.m4a'); execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', wav, m4a]);
const longWav = clip('long.wav', LONG, ['--file-format=WAVE', '--data-format=LEI16@16000']);
const longM4a = join(scratch, 'long.m4a'); execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', longWav, longM4a]);
let mp4 = null;
if (has('ffmpeg')) {
  mp4 = join(scratch, 'call.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=10', '-i', wav, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', mp4]);
}

export function wer(ref, hyp) {
  const norm = (s) => s.toLowerCase().replace(/[-–]/g, ' ').replace(/[^\p{L}\p{N}' ]+/gu, '').replace(/\bfourscore\b/g, 'four score').split(/\s+/).filter(Boolean);
  const r = norm(ref), h = norm(hyp);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) { const cur = [i]; for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)); prev = cur; }
  return prev[h.length] / r.length;
}

const entry = `
import { InMemoryFs } from 'just-bash';
import { shellFor } from './src/tools.ts';
import { createMediaService } from './src/media.ts';
import { createAsrService } from './src/parakeet.ts';
import { createAddons, backendOf } from './src/addons.ts';
import { REGISTRY } from './src/addons-registry.ts';
import { Tasks } from './src/ns/tasks.ts';
const fs = new InMemoryFs();
const tasks = new Tasks();
// The registry from this build's pins; the gateway stand-in is this origin's /hf (the CSP's 'self').
window.asked = [];
const addons = createAddons({ entries: REGISTRY, tasks, approve: async (req) => { window.asked.push(req); return true; },
  backend: (d) => backendOf(d, { gateway: location.origin + '/hf' }) });
const media = createMediaService({ tasks, addons });
const transcribe = createAsrService({ tasks, media, addons });
const shell = shellFor(fs, { media, transcribe, addons });
window.violations = [];
document.addEventListener('securitypolicyviolation', (e) => window.violations.push(e.violatedDirective + ' ' + e.blockedURI));
window.pouch = {
  gpu: async () => { const a = await navigator.gpu?.requestAdapter(); return a ? { f16: a.features.has('shader-f16'), vendor: a.info?.vendor } : null; },
  put: async (p, b64) => { await fs.mkdir(p.replace(/\\/[^/]*$/, ''), { recursive: true }); await fs.writeFile(p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); },
  sh: async (cmd) => { const t0 = performance.now(); const r = await shell.exec(cmd, { cwd: '/work' }); return { out: r.stdout, err: r.stderr, code: r.exitCode, ms: Math.round(performance.now() - t0) }; },
  read: async (p) => fs.readFile(p),
  start: (cmd) => { window.pending = shell.exec(cmd, { cwd: '/work' }); },
  finish: async () => { const r = await window.pending; return { out: r.stdout, err: r.stderr, code: r.exitCode }; },
  tasks: () => tasks.list().map((t) => ({ id: t.id, label: t.label, status: t.status, log: [...t.log] })),
  kill: (id) => tasks.kill(tasks.get(id)),
};`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.ts')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const app = (await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, write: false, format: 'iife', minify: true,
  define: { WORKER_SRC: JSON.stringify(worker), POUCH_LIBAV_RUNTIME: JSON.stringify(libav.pin), POUCH_LIBAV_SOURCE: JSON.stringify(libav.source), POUCH_PARAKEET: JSON.stringify(asr.pin) },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts') }, logLevel: 'error' })).outputFiles[0].text;
const script = app.replaceAll('</script', '<\\/script');
const csp = readFileSync(join(root, 'pouch.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
  .replace('__SCRIPT_HASHES__', `'sha256-${createHash('sha256').update(script).digest('base64')}'`);
const HEADERS = headersFile(csp, viewerCsp(root));
const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>parakeet test</title><script>${script}</script>`;
const requests = [];
const prefix = `/hf/${lockModel.repo}/resolve/${lockModel.revision}/`;
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  requests.push(`${req.method} ${path}${req.headers.range ? ' ' + req.headers.range : ''}`);
  if (path.startsWith('/runtime/')) { try { res.writeHead(200, headersFor(HEADERS, path)); return res.end(readFileSync(join(scratch, path))); } catch { res.writeHead(404); return res.end(); } }
  if (path === '/pouch.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, '/pouch.html') }); return res.end(html); }
  if (path === '/hf/catalog') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ releases: [] })); }
  if (path.startsWith(prefix) && paths[path.slice(prefix.length)]) {
    const file = paths[path.slice(prefix.length)], size = statSync(file).size, m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const from = m ? Number(m[1]) : 0, to = m ? Math.min(Number(m[2]) + 1, size) : size, buf = Buffer.alloc(to - from), fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
    res.writeHead(m ? 206 : 200, { 'content-type': 'application/octet-stream', ...(m ? { 'content-range': `bytes ${from}-${to - 1}/${size}` } : {}) });
    return res.end(buf);
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch({ executablePath: process.env.PARAKEET_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-first-run'] });
const context = await browser.newContext();
const offsite = [];
await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => { offsite.push(r.request().url()); return r.abort(); });
let page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error' && process.env.VERBOSE) console.log('  [page]', m.text().slice(0, 300)); });
await page.goto(origin + '/pouch.html');
const gpu = await page.evaluate(() => window.pouch.gpu());
if (!gpu?.f16) { console.log(`SKIP parakeet-browser: this browser has ${gpu ? 'WebGPU without shader-f16' : 'no WebGPU adapter'}`); await browser.close(); server.close(); rmSync(scratch, { recursive: true, force: true }); process.exit(0); }
const put = async (p, file) => page.evaluate(([p, b]) => window.pouch.put(p, b), [p, readFileSync(file).toString('base64')]);
const sh = (cmd) => page.evaluate((c) => window.pouch.sh(c), cmd);

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('ok', name); };
const timings = {};
// Resident memory of this test's Chrome: the launched browser (by its temporary
// profile) and every process under it (GPU, renderer, workers' utilities).
const chromeRss = () => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8', maxBuffer: 2 ** 26 }).split('\n').filter(Boolean)
    .map((l) => { const [pid, ppid, rss, ...args] = l.trim().split(/\s+/); return { pid: +pid, ppid: +ppid, rss: +rss * 1024, args: args.join(' ') }; });
  const tree = new Set(rows.filter((r) => /playwright_chromiumdev_profile/.test(r.args) && !/--type=/.test(r.args)).map((r) => r.pid));
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true; } }
  return rows.filter((r) => tree.has(r.pid)).reduce((n, r) => n + r.rss, 0);
};
const gib = (n) => +(n / 2 ** 30).toFixed(2);
async function measured(fn) {
  const before = chromeRss(); let peak = before;
  const timer = setInterval(() => { peak = Math.max(peak, chromeRss()); }, 500);
  try { return { r: await fn(), before: gib(before), peak: gib(peak) }; } finally { clearInterval(timer); }
}

try {
  await t('TR6 first: before the download, transcribe says to get the model and reads nothing', async () => {
    await put('/work/interviews/i1.m4a', m4a);
    const r = await sh('transcribe interviews/i1.m4a');
    assert.equal(r.code, 1); assert.match(r.err, /^transcribe: not installed: Parakeet TDT 0\.6B v3 \(1\.3 GB\)\. Run `addons install parakeet-tdt-0\.6b-v3`; the user will be asked\.\n$/);
  });

  await t('TR1: addons install parakeet --wait asks once, installs 1.3 GB (model by range, runtime from this origin) and verifies it', async () => {
    const r = await sh('addons install parakeet --wait');
    timings.download_ms = r.ms;
    assert.equal(r.code, 0, r.err); assert.match(r.out, /installed Parakeet TDT 0\.6B v3 \(1\.3 GB\) as \/task\/\d+, checked against this page's hashes/);
    const asked = await page.evaluate(() => window.asked);
    assert.equal(asked.length, 1); const [it] = asked[0].items;
    assert.match(it.runs, /only in this browser/); assert.match(it.attribution, /NVIDIA/); assert.match(it.license, /CC-BY-4\.0/);
    assert.ok(requests.some((x) => x.includes('encoder-model.fp16.onnx bytes=')), 'ranges from the gateway stand-in');
  });

  await t('TR2: an M4A interview to TXT, SRT, VTT and JSON with timestamps; WER under 10%', async () => {
    let r = await sh('transcribe interviews/i1.m4a -o interviews/i1.txt');
    timings.first_transcribe_ms = r.ms;
    assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote \/work\/interviews\/i1\.txt \(txt/); assert.match(r.out, /Speakers are not separated/);
    const txt = await page.evaluate(() => window.pouch.read('/work/interviews/i1.txt'));
    assert.match(txt, /^\[00:00\] /);
    const text = txt.replace(/^\[\d\d:\d\d\] /gm, ' ');
    timings.wer_m4a = wer(TEXT, text);
    assert.ok(timings.wer_m4a < 0.1, `WER ${timings.wer_m4a}: ${text}`);
    r = await sh('transcribe interviews/i1.m4a --srt -o interviews/i1.srt'); assert.equal(r.code, 0, r.err);
    timings.warm_transcribe_ms = r.ms;
    const srt = await page.evaluate(() => window.pouch.read('/work/interviews/i1.srt'));
    assert.match(srt, /^1\n00:00:0\d,\d{3} --> 00:00:\d\d,\d{3}\n/);
    r = await sh('transcribe interviews/i1.m4a --vtt -o interviews/i1.vtt'); assert.equal(r.code, 0, r.err);
    assert.match(await page.evaluate(() => window.pouch.read('/work/interviews/i1.vtt')), /^WEBVTT\n\nNOTE\nTranscribed in this browser/);
    r = await sh('transcribe interviews/i1.m4a --json -o interviews/i1.json'); assert.equal(r.code, 0, r.err);
    const j = JSON.parse(await page.evaluate(() => window.pouch.read('/work/interviews/i1.json')));
    const dur = Number(execFileSync('afinfo', [wav], { encoding: 'utf8' }).match(/estimated duration: ([\d.]+)/)[1]);
    assert.ok(Math.abs(j.duration - dur) < 0.3, `duration ${j.duration} vs ${dur}`);
    assert.ok(j.words.every((w, i) => w.start <= w.end && (i === 0 || w.start >= j.words[i - 1].start)), 'word times rise');
    assert.ok(j.words.at(-1).end <= j.duration + 0.1 && j.words.at(-1).end > j.duration - 3, 'the last word ends near the end');
    assert.equal(j.speakers, null);
  });

  if (mp4) await t('TR2: a video call (MP4 with H.264 video and AAC audio) works the same', async () => {
    await put('/work/interviews/call.mp4', mp4);
    const r = await sh('transcribe interviews/call.mp4');
    assert.equal(r.code, 0, r.err);
    timings.wer_mp4 = wer(TEXT, r.out.replace(/^\[\d\d:\d\d\] /gm, ' '));
    assert.ok(timings.wer_mp4 < 0.1, `WER ${timings.wer_mp4}`);
  });

  await t('TR2: a 4-minute clip shows window progress in /task, and stops through ctl (exit 130)', async () => {
    await put('/work/interviews/long.m4a', longM4a);
    const m = await measured(() => sh('transcribe interviews/long.m4a -o interviews/long.txt'));
    let r = m.r;
    assert.equal(r.code, 0, r.err);
    timings.long_ms = r.ms; timings.long_out = r.out.trim(); timings.long_rss = { before_gib: m.before, peak_gib: m.peak };
    timings.wer_long = wer(LONG, (await page.evaluate(() => window.pouch.read('/work/interviews/long.txt'))).replace(/^\[\d\d:\d\d\] /gm, ' '));
    assert.ok(timings.wer_long < 0.1, `WER ${timings.wer_long}`);
    const tasks = await page.evaluate(() => window.pouch.tasks());
    const job = tasks.filter((x) => /^transcribe long\.m4a \(\d+:\d\d\)$/.test(x.label)).at(-1);
    assert.ok(job && job.status === 'done');
    // Windows restart at sentence gaps, so they overlap: 0:00-1:30, 1:20-2:50, ...
    assert.ok(job.log.filter((l) => /^transcribing \d+:\d\d to \d+:\d\d of 3:\d\d \(\d+%\)$/.test(l)).length >= 2, `window progress in /task/${job.id}/log: ${job.log.join(' | ')}`);
    await page.evaluate(() => window.pouch.start('transcribe interviews/long.m4a -y -o interviews/long2.txt'));
    let live;
    for (let i = 0; i < 600 && !live; i++) { await new Promise((res) => setTimeout(res, 50)); live = (await page.evaluate(() => window.pouch.tasks())).find((x) => /^transcribe long\.m4a \(\d+:\d\d\)$/.test(x.label) && x.status === 'running'); }
    assert.ok(live, 'the transcription job (not the decode) runs');
    await new Promise((res) => setTimeout(res, 200));
    await page.evaluate((id) => window.pouch.kill(id), live.id);
    r = await page.evaluate(() => window.pouch.finish());
    assert.equal(r.code, 130, r.err); assert.match(r.err, /stopped \(\/task\/\d+\)/);
    assert.equal(await page.evaluate(() => window.pouch.sh('test -e /work/interviews/long2.txt; echo $?').then((x) => x.out.trim())), '1', 'nothing written');
  });

  await t('TR3: the only requests were this origin\'s runtime parts and gateway ranges; no CSP violation', async () => {
    assert.deepEqual(offsite, []);
    const odd = requests.filter((x) => !/^GET \/(runtime\/(parakeet|libav)\/|hf\/|pouch\.html)/.test(x));
    assert.deepEqual(odd, []);
    assert.ok(!requests.some((x) => x.includes('libav-source')));
    assert.deepEqual(await page.evaluate(() => window.violations), []);
  });

  await t('TR5: offline after a reload, it transcribes from the kept runtime and model', async () => {
    await context.setOffline(true);
    const before = requests.length;
    await page.close(); page = await context.newPage();
    await page.route('**/*', (r) => (r.request().url().endsWith('/pouch.html') ? r.fulfill({ status: 200, contentType: 'text/html', body: html }) : r.abort()));
    await page.goto(origin + '/pouch.html');
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    await put('/work/m.m4a', m4a);
    const cold = await measured(() => sh('transcribe m.m4a'));
    const r = cold.r;
    timings.offline_cold = { wall_ms: r.ms, rss_before_gib: cold.before, rss_peak_gib: cold.peak, rss_after_gib: gib(chromeRss()) };
    assert.equal(r.code, 0, r.err);
    assert.ok(wer(TEXT, r.out.replace(/^\[\d\d:\d\d\] /gm, ' ')) < 0.1);
    assert.equal(requests.length, before, 'no request reached the server');
  });

  if (process.env.PARAKEET_MARATHON) await t(`interview length, offline from a cold page: ${process.env.PARAKEET_MARATHON.split('/').pop()} (time and memory)`, async () => {
    const file = process.env.PARAKEET_MARATHON, name = file.split('/').pop(), text = existsSync(file.replace(/\.[a-z0-9]+$/, '.txt')) ? readFileSync(file.replace(/\.[a-z0-9]+$/, '.txt'), 'utf8') : null;
    await put('/work/interviews/' + name, file);
    const m = await measured(() => sh(`transcribe interviews/${name} --json -o interviews/marathon.json`));
    assert.equal(m.r.code, 0, m.r.err);
    const j = JSON.parse(await page.evaluate(() => window.pouch.read('/work/interviews/marathon.json')));
    timings.marathon = { file: name, bytes: statSync(file).size, audio_s: Math.round(j.duration), wall_ms: m.r.ms, rss_before_gib: m.before, rss_peak_gib: m.peak, words: j.words.length, out: m.r.out.trim(),
      ...(text ? { wer: +wer(text, j.text).toFixed(4) } : {}) };
    if (text) assert.ok(timings.marathon.wer < 0.1, `WER ${timings.marathon.wer}`);
  });

} finally {
  await context.setOffline(false).catch(() => {});
  await browser.close(); server.close();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ gpu, ...timings }));
console.log(`parakeet-browser: ${pass} passed`);
