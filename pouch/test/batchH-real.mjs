// Batch H with the real model: the built dist/ (real runtime, real LFM3 pins),
// weights put into the gateway-backed store through "Load from files" from the
// local verified copy (the same incremental check as a download, at 1.09 GB),
// then the Transformers.js provider loads them and answers one tool turn.
// Measures ingest and load time and the browser's peak memory (ps RSS).
// Every request but this page, its runtime and api.bayleaf.dev/hf is blocked in
// the browser; nothing reaches BayLeaf Sealed.   node build.mjs && node test/batchH-real.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { CACHE } from '../fetch-models.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 15 minutes'); process.exit(2); }, 900_000).unref();
const root = resolve(import.meta.dirname, '..'), dist = join(root, 'dist');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || '/tmp/pouch-qa', 'pouch-batchH-real-'));
const lock = JSON.parse(readFileSync(join(root, 'models.lock.json'), 'utf8')), m = lock.models[0];
const html = readFileSync(join(dist, 'pouch.html'));
const HEADERS = headersFile(html.toString().match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], viewerCsp(dist));
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    const body = path === '/' ? html : readFileSync(join(dist, path));
    res.writeHead(200, { 'content-type': path.endsWith('.html') || path === '/' ? 'text/html; charset=utf-8' : 'application/octet-stream', ...headersFor(HEADERS, path === '/' ? '/pouch.html' : path) });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
// Peak RSS of the Playwright browser's processes (Chrome for Testing), sampled every 500 ms.
const rss = () => { try { return execSync("ps -axo rss=,command= | grep -i 'chrom' | grep -i 'ms-playwright' | grep -v grep", { encoding: 'utf8' }).trim().split('\n').map((l) => +l.trim().split(/\s+/)[0] * 1024); } catch { return []; } };
const peak = { total: 0, proc: 0 };
const sampler = setInterval(() => { const r = rss(); peak.total = Math.max(peak.total, r.reduce((a, b) => a + b, 0)); peak.proc = Math.max(peak.proc, ...r, 0); }, 500);
const GB = (n) => (n / 2 ** 30).toFixed(2) + ' GiB';
const blocked = [], hf = [];
let context;
try {
  // Headed by default: headless Chromium's WebGPU adapter lacks shader-f16, which q4f16 needs.
  context = await pw.chromium.launchPersistentContext(join(scratch, 'profile'), { headless: !!process.env.HEADLESS, viewport: { width: 1280, height: 800 }, args: ['--enable-unsafe-webgpu'] });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => {
    const u = new URL(r.request().url());
    if (u.hostname === 'api.bayleaf.dev' && u.pathname.startsWith('/hf/')) { hf.push(u.pathname); return r.continue(); }
    blocked.push(u.host + u.pathname); return r.abort();
  });
  const page = context.pages()[0] ?? await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.click('#welcome button >> text=Got it', { timeout: 5000 }).catch(() => {});
  await page.click('button[data-panel="settings"]');
  await page.waitForFunction(() => /Not downloaded/.test(document.getElementById('local-state')?.textContent ?? ''), null, { timeout: 30000 });
  const before = peak.total;
  const dir = join(CACHE, m.id, m.revision);
  const picked = m.files.map((f) => join(dir, f.name));
  let t = Date.now();
  await page.setInputFiles('#local-files', picked);
  await page.waitForFunction(() => /loaded from your files/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 600000 });
  const ingest = { ms: Date.now() - t, peak: peak.total };
  console.log(`ok Load from files: ${m.files.length} files, 1.09 GB hashed incrementally against the lock and kept in ${(ingest.ms / 1000).toFixed(0)} s; browser peak RSS ${GB(ingest.peak)} (idle ${GB(before)})`);
  peak.total = 0; peak.proc = 0;
  // Pick the Transformers.js provider and send one tool turn.
  await page.click('button[data-panel="files"]').catch(() => {});
  await page.selectOption('#model', `local:${m.id}`);
  t = Date.now();
  await page.fill('#input', 'List the files in /work.'); await page.press('#input', 'Enter');
  await page.waitForFunction((id) => /is ready in this browser/.test(document.getElementById('status')?.textContent ?? '') || document.getElementById('local-settings')?.dataset.state === 'ready', m.id, { timeout: 300000 });
  const load = { ms: Date.now() - t, peak: peak.total, proc: peak.proc };
  await page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, { timeout: 300000 });
  const turn = { ms: Date.now() - t, peak: peak.total, proc: peak.proc };
  await page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, { timeout: 300000 });
  const transcript = await page.$eval('#log', (e) => e.innerText).catch(async () => page.evaluate(() => document.body.innerText));
  console.log(`ok model verified and loaded on WebGPU in ${(load.ms / 1000).toFixed(0)} s (peak RSS ${GB(load.peak)}); turn finished at ${(turn.ms / 1000).toFixed(0)} s; peak RSS ${GB(turn.peak)} total, largest process ${GB(turn.proc)}`);
  const tail = transcript.slice(-600).replace(/\s+/g, ' ');
  console.log('transcript tail:', tail);
  assert.ok(/bash|ls|read/i.test(transcript), 'a tool ran');
  assert.deepEqual(errors, []);
  const sealed = blocked.filter((b) => b.includes('/sealed') || b.includes('tinfoil'));
  console.log(`requests: ${hf.length} to api.bayleaf.dev/hf (expected 0: weights came from files), blocked in the browser ${blocked.length} (${[...new Set(blocked)].slice(0, 6).join(', ')}); Sealed requests that left the browser: 0`);
  assert.equal(hf.length, 0);
  console.log(`\nREAL OK ingest=${ingest.ms}ms load=${load.ms}ms ingestPeak=${GB(ingest.peak)} loadPeak=${GB(load.peak)} sealedBlocked=${sealed.length}`);
} catch (e) {
  console.error('FAIL', e.stack ?? e); process.exitCode = 1;
} finally {
  clearInterval(sampler);
  await context?.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
