// ffmpeg frames plus the look tool live against BayLeaf Sealed (stories AV5,
// AG1), at most CAP (default 4) model requests counted at the route (titles
// included). A 4 s WebM, red with "ONE" for 2 s then blue with "TWO" for 2 s
// (frames drawn on a canvas here, encoded by the local Homebrew ffmpeg), is
// saved into /work by the attachment picker (a local write; the chip is
// removed, so it is not sent), then a Sealed model marked images is asked what
// happens in the video. It must run ffprobe/ffmpeg (the real libav runtime,
// built into a scratch dir) and look at the frames. Prints an outline only.
// FORMAT=mov: the same scenes as an H.264/AAC QuickTime .mov (ftyp qt), the
// phone-video case on the WebCodecs path.
// Needs the look tool (PR #128, branch pouch-look): run it on a merge of both.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/media-sealed.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { buildLibav } from '../build-libav.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 4);
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-media-sealed-'));
process.chdir(root);
const libav = await buildLibav(scratch);

const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.js')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"', POUCH_PDF_RUNTIME: 'null', POUCH_LIBAV_RUNTIME: JSON.stringify(libav.pin), POUCH_LIBAV_SOURCE: JSON.stringify(libav.source) },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') } });
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

const MODEL = process.env.MODEL ?? 'kimi-k3';
const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
let n = 0, sent = 0;
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const outside = [];
try {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => {
    const u = r.request().url();
    if (!u.startsWith('https://api.bayleaf.dev/')) { outside.push(u); return r.abort(); }
    if (r.request().method() === 'POST' && /chat\/completions/.test(u) && ++n > CAP) { console.log(`ABORT: request ${n} over cap ${CAP}`); return r.abort(); }
    if (r.request().method() === 'POST' && /chat\/completions/.test(u)) sent++;
    return r.continue();
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss());
  await page.goto(url);
  await page.click('#welcome button >> text=Got it').catch(() => {});
  await page.click('#auth');
  await page.waitForSelector('#sheet[open] #key-input', { timeout: 10000 });
  await page.fill('#key-input', 'BAYLEAF_API_KEY=' + key);
  await page.click('#sheet .key-form button[type=submit]');
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  const label = await page.$eval('#model', (s, m) => [...s.options].find((o) => o.value === m)?.textContent ?? null, MODEL);
  if (!label || !/images/.test(label)) { console.log(`SKIP: ${MODEL} is not in the catalog as a model marked images (${label})`); process.exitCode = 0; } else {
    await page.selectOption('#model', MODEL);
    const frames = await page.evaluate(() => [['#d01818', 'ONE'], ['#1838d0', 'TWO']].map(([bg, word]) => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d');
      g.fillStyle = bg; g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#ffffff'; g.font = 'bold 160px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(word, 320, 180);
      return c.toDataURL('image/png').split(',')[1];
    }));
    frames.forEach((b, i) => writeFileSync(join(scratch, `s${i}.png`), Buffer.from(b, 'base64')));
    const mov = process.env.FORMAT === 'mov', name = mov ? 'scenes.mov' : 'scenes.webm';
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-t', '2', '-r', '10', '-i', join(scratch, 's0.png'), '-loop', '1', '-t', '2', '-r', '10', '-i', join(scratch, 's1.png'),
      ...(mov ? ['-f', 'lavfi', '-i', 'sine=f=440:d=4'] : []),
      '-filter_complex', '[0][1]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]',
      ...(mov ? ['-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'mov'] : ['-c:v', 'libvpx-vp9', '-b:v', '300k']), join(scratch, name)]);
    await page.locator('#attachment-picker').setInputFiles({ name, mimeType: mov ? 'video/quicktime' : 'video/webm', buffer: readFileSync(join(scratch, name)) });
    const chip = page.locator('.attachment').first();
    await chip.waitFor({ timeout: 10000 });
    const file = await chip.getAttribute('title');
    await chip.locator('button').click();
    await page.fill('#input', `What happens in the video ${file}? Be efficient: in ONE bash call, run ffprobe on it and extract at most 8 frames as PNGs with ffmpeg (see the media skill), then look at all the frames in ONE look call, then answer in two or three sentences with times.`);
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send' && document.querySelectorAll('#log .msg.assistant .body').length > 0, null, { timeout: 240000 });
    await page.waitForTimeout(500);
    const reply = await page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? '');
    const looks = await page.locator('#log details.tool', { hasText: 'look:' }).count();
    const thumbs = await page.locator('#log details.tool .look-strip img').count();
    const bash = await page.locator('#log details.tool', { hasText: /ffmpeg|ffprobe/ }).count();
    await page.screenshot({ path: join(shots, 'media-sealed.png') });
    const one = reply.search(/\bONE\b/), two = reply.search(/\bTWO\b/), red = reply.search(/\bred\b/i), blue = reply.search(/\bblue\b/i);
    console.log(JSON.stringify({ model: MODEL, requests: sent, attempts: n, mediaToolCalls: bash, lookCalls: looks, thumbnails: thumbs,
      one: one >= 0, two: two >= 0, inOrder: one >= 0 && two > one, red: red >= 0, blue: blue >= 0, colorsInOrder: red >= 0 && blue > red, replyChars: reply.length, outside }, null, 1));
    console.log('REPLY (fixture description, no user data):', reply.slice(0, 600));
    assert.ok(sent <= CAP, 'request cap');
    console.log(`done (${at()}): screenshot ${join(shots, 'media-sealed.png')}`);
  }
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
