// The look tool live against BayLeaf Sealed (JOURNEYS AG1), at most CAP
// (default 4) model requests counted at the route (titles included): a PNG
// drawn on a canvas ("BLUE TRIANGLE 42" and a blue triangle) is saved into
// /work by the attachment picker (a local write; the chip is removed, so it is
// not sent with the message), then a Sealed model marked images is asked to
// look at it. Prints an outline only: model, requests, whether the reply names
// the text and the shape.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/look-sealed.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 4);
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-look-sealed-'));

const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.js')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') } });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const HEADERS = headersFile(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], viewerCsp(root));
const server = createServer((req, res) => {
  const viewer = new URL(req.url, 'http://x').pathname === '/viewer.html';
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
    const b64 = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 800; c.height = 500; const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 800, 500);
      g.fillStyle = '#000000'; g.font = 'bold 72px sans-serif'; g.textAlign = 'center'; g.fillText('BLUE TRIANGLE 42', 400, 110);
      g.fillStyle = '#1e40ff'; g.beginPath(); g.moveTo(400, 170); g.lineTo(610, 460); g.lineTo(190, 460); g.closePath(); g.fill();
      return c.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#attachment-picker').setInputFiles({ name: 'mystery.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
    const chip = page.locator('.attachment').first();
    await chip.waitFor({ timeout: 10000 });
    const png = await chip.getAttribute('title');
    await chip.locator('button').click();
    await page.fill('#input', `Use the look tool on ${png} and tell me exactly what text and what shape (with its colour) the image shows. One or two sentences.`);
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send' && document.querySelectorAll('#log .msg.assistant .body').length > 0, null, { timeout: 240000 });
    await page.waitForTimeout(500);
    const reply = await page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? '');
    const looks = await page.locator('#log details.tool', { hasText: 'look:' }).count();
    const thumbs = await page.locator('#log details.tool .look-strip img').count();
    await page.screenshot({ path: join(shots, 'look-sealed.png') });
    console.log(JSON.stringify({ model: MODEL, requests: sent, attempts: n, lookCalls: looks, thumbnails: thumbs,
      text: /BLUE\s*TRIANGLE\s*42/i.test(reply), number42: /42/.test(reply), triangle: /triangle/i.test(reply), blue: /blue/i.test(reply), replyChars: reply.length, outside }, null, 1));
    assert.ok(sent <= CAP, 'request cap');
    console.log(`done (${at()}): screenshot ${join(shots, 'look-sealed.png')}`);
  }
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
