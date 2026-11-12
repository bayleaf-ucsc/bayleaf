// Story TR4 live against BayLeaf Sealed: the agent transcribes a folder of
// interviews and writes an index of topics with [mm:ss] links. At most CAP
// (default 12) model requests, counted at the route (titles included).
//
// The full page (src/main.ts) with the real libav and Parakeet runtimes built
// into a scratch dir, in installed Chrome with WebGPU. Until the gateway release
// is deployed, requests for the pinned Parakeet files at api.bayleaf.dev/hf are
// answered by this test from the local cache (fetch-models.mjs), by range; the
// page checks every byte against models.lock.json as it would from the gateway.
// Everything else to api.bayleaf.dev goes through (Sealed inference, the
// catalog); any other host is refused and listed.
//
// Steps: the user's terminal runs `addons install parakeet --wait` and clicks
// Install in the real approval sheet (its text is printed: story TR1); two
// interviews spoken by macOS `say` (M4A, distinct topics) are attached and moved
// into /work/interviews; one message asks for transcripts and an index.md.
// Prints an outline, the sheet and the index (fixture text, no user data).
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/parakeet-sealed.mjs
import assert from 'node:assert/strict';
import { signInSealed, assertLiveRequests } from './sealed-auth.mjs';
import { readFileSync, mkdtempSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 12);
const MODEL = process.env.MODEL ?? 'kimi-k3';
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-parakeet-sealed-'));
process.chdir(root);
const libav = await buildLibav(scratch), asr = await buildParakeet(scratch);
const m = asr.pin.model, files = (await ensureModels({ log: () => {}, only: [m.id] }))[m.id];

// Two short interviews on different topics, so an index has something to say.
const INTERVIEWS = {
  'garden.m4a': ['Thanks for meeting me. I have run the community garden on Pine Street for six years.', 'Water is our biggest cost. In the drought summer we switched every bed to drip irrigation, and the bill fell by half.',
    'The second thing people ask about is the waiting list. We have forty families waiting for a plot right now.', 'Finally, the tool library. Anyone can borrow a shovel or a wheelbarrow with a library card.'],
  'transit.m4a': ['I drive the night bus on route twelve, from downtown to the university.', 'The hardest part of the night shift is the last run at two in the morning, when the buses are full of students and hospital workers.',
    'We asked the city for a second bus on Fridays, and they agreed last spring.', 'If I could change one thing, it would be a shelter at the hospital stop. People wait in the rain.'],
};
for (const [name, lines] of Object.entries(INTERVIEWS)) {
  const wav = join(scratch, name.replace('.m4a', '.wav'));
  execFileSync('say', ['-v', 'Samantha', '-o', wav, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', '-'], { input: lines.join(' [[slnc 1500]] ') });
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', wav, join(scratch, name)]);
}

const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.ts')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"', POUCH_PDF_RUNTIME: 'null', POUCH_LIBAV_RUNTIME: JSON.stringify(libav.pin), POUCH_LIBAV_SOURCE: JSON.stringify(libav.source), POUCH_PARAKEET: JSON.stringify(asr.pin) },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') } });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const HEADERS = headersFile(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], viewerCsp(root));
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/runtime/')) { try { res.writeHead(200, headersFor(HEADERS, path)); return res.end(readFileSync(join(scratch, path))); } catch { res.writeHead(404); return res.end(); } }
  const viewer = path === '/viewer.html';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, viewer ? '/viewer.html' : '/pouch.html') });
  res.end(viewer ? readFileSync(join(root, 'viewer.html')) : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 },
  executablePath: process.env.PARAKEET_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-first-run'] });
const T = { timeout: 120000 };
let n = 0, sent = 0, ranges = 0;
const t0 = Date.now(), at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const outside = [], prefix = `https://api.bayleaf.dev/hf/${m.repo}/resolve/${m.revision}/`;
try {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => {
    const u = r.request().url();
    if (!u.startsWith('https://api.bayleaf.dev/')) { outside.push(u); return r.abort(); }
    if (u.startsWith(prefix) && files[decodeURIComponent(u.slice(prefix.length))]) { // the gateway stand-in (see the header)
      const file = files[decodeURIComponent(u.slice(prefix.length))], size = statSync(file).size, mr = /^bytes=(\d+)-(\d+)$/.exec(r.request().headers().range ?? '');
      const from = mr ? Number(mr[1]) : 0, to = mr ? Math.min(Number(mr[2]) + 1, size) : size, body = Buffer.alloc(to - from), fd = openSync(file, 'r');
      try { readSync(fd, body, 0, body.length, from); } finally { closeSync(fd); }
      ranges++;
      return r.fulfill({ status: mr ? 206 : 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream', ...(mr ? { 'content-range': `bytes ${from}-${to - 1}/${size}` } : {}) }, body });
    }
    if (r.request().method() === 'POST' && /chat\/completions/.test(u) && ++n > CAP) { console.log(`ABORT: request ${n} over cap ${CAP}`); return r.abort(); }
    if (r.request().method() === 'POST' && /chat\/completions/.test(u)) sent++;
    return r.continue();
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss());
  await page.goto(url);
  await page.click('#welcome button >> text=Got it').catch(() => {});
  if (!(await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter())?.features.has('shader-f16')))) { console.log('SKIP: no WebGPU with shader-f16 here'); process.exit(0); }
  await signInSealed(page, 'BAYLEAF_API_KEY=' + key);
  const label = await page.$eval('#model', (s, id) => [...s.options].find((o) => o.value === id)?.textContent ?? null, MODEL);
  if (!label) { console.log(`SKIP: ${MODEL} is not in the Sealed catalog`); process.exit(0); }
  await page.selectOption('#model', MODEL);

  // TR1 in the real interface: the user's terminal asks, the user clicks Install.
  async function term(cmd, answer) {
    if (!(await page.isVisible('#term-input'))) { await page.keyboard.press('Control+`'); await page.waitForSelector('#term-input', { state: 'visible', ...T }); }
    const k = await page.$$eval('#term-log .term-block', (l) => l.length);
    await page.fill('#term-input', cmd); await page.press('#term-input', 'Enter');
    let sheet = null;
    if (answer) {
      await page.waitForSelector('#sheet[open]', T);
      sheet = await page.evaluate(() => ({ title: document.getElementById('sheet-title').textContent, body: document.getElementById('sheet-body').innerText }));
      await page.click(`#sheet-actions button >> text=${answer}`);
    }
    await page.waitForFunction((k) => { const b = document.querySelectorAll('#term-log .term-block'); return b.length > k && !b[b.length - 1].querySelector('.term-live'); }, k, { timeout: 600000 });
    return { out: await page.$eval('#term-log .term-block:last-child', (b) => b.textContent), sheet };
  }
  const got = await term('addons install parakeet --wait', 'Install');
  assert.match(got.out, /installed Parakeet TDT 0\.6B v3 \(1\.3 GB\)/);
  for (const re of [/Size\s+1\.3 GB/, /Runs\s+only in this browser/, /License\s+MIT.*CC-BY-4\.0/, /Attribution\s+Parakeet TDT 0\.6B v3 by NVIDIA/, /From\s+api\.bayleaf\.dev/]) assert.match(got.sheet.body, re);
  console.log(`downloaded (${at()}), ${ranges} ranges`);

  for (const name of Object.keys(INTERVIEWS)) await page.locator('#attachment-picker').setInputFiles({ name, mimeType: 'audio/mp4', buffer: readFileSync(join(scratch, name)) });
  const chips = page.locator('.attachment');
  await chips.nth(1).waitFor({ timeout: 10000 });
  const paths = await chips.evaluateAll((l) => l.map((c) => c.getAttribute('title')));
  while (await chips.count()) await chips.first().locator('button').click(); // local files only: nothing attached to the message
  const moved = await term(`mkdir -p /work/interviews && mv ${paths.map((p) => `'${p}'`).join(' ')} /work/interviews/ && ls /work/interviews`);
  assert.match(moved.out, /garden.*transit|transit.*garden/s);
  await page.keyboard.press('Control+`').catch(() => {});

  await page.fill('#input', 'Transcribe everything in /work/interviews with timestamps, then make an index of topics with [mm:ss] links: write /work/interviews/index.md, one section per interview, each topic a line with its time and a link to the transcript. Be efficient: one bash call for all the transcriptions (see the media skill), then read the transcripts, then write the index.');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send' && document.querySelectorAll('#log .msg.assistant .body').length > 0, null, { timeout: 600000 });
  await page.waitForTimeout(500);
  const reply = await page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? '');
  const transcribeCalls = await page.locator('#log details.tool', { hasText: 'transcribe' }).count();
  const index = (await term('cat /work/interviews/index.md')).out;
  const listing = (await term('ls /work/interviews')).out;
  const stamps = [...index.matchAll(/\[\d{1,2}:\d\d(?::\d\d)?\]/g)].map((x) => x[0]);
  const outline = { model: MODEL, requests: sent, attempts: n, transcribeToolCards: transcribeCalls, listing: listing.replace(/\s+/g, ' ').trim(),
    indexStamps: stamps.length, mentions: { water: /water|irrigation/i.test(index), waitingList: /waiting/i.test(index), nightShift: /night/i.test(index), shelter: /shelter/i.test(index) }, outside, elapsed: at() };
  console.log(JSON.stringify(outline, null, 1));
  console.log('SHEET:', got.sheet.title, '\n' + got.sheet.body);
  console.log('INDEX (fixture text, no user data):\n' + index.slice(0, 2000));
  console.log('REPLY:', reply.slice(0, 500));
  assertLiveRequests(n, CAP);
  assert.deepEqual(outside, []);
  assert.ok(stamps.length >= 4, 'the index cites times');
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
