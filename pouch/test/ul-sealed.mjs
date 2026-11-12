// One live sanity run of the ubiquitous-language realignment (LANGUAGE.md)
// against BayLeaf Sealed in the real page: main spawns a background subagent
// that messages main by handle, and the user sends a Follow-up while main
// works. Checks that handles render as a-handles (a1, a2), tags read
// [from <name> (a2)], and the model uses them. Spends real requests: hard stop at CAP.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/ul-sealed.mjs
// Prints an outline (tools called, labels, final replies), not model internals.
import assert from 'node:assert/strict';
import { signInSealed, assertLiveRequests } from './sealed-auth.mjs';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 10);
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-ul-sealed-'));

const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.ts')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') } });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
let n = 0;
const t0 = Date.now();
try {
  // Count model requests (chat completions through the sealed relay); refuse past CAP.
  await context.route('https://api.bayleaf.dev/**', (r) => {
    if (r.request().method() === 'POST' && /chat\/completions/.test(r.request().url())) {
      if (++n > CAP) { console.log(`ABORT: request ${n} over cap ${CAP}`); return r.abort(); }
    }
    return r.continue();
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss());
  await page.goto(url);
  await page.click('#welcome button >> text=Got it').catch(() => {});
  await signInSealed(page, key);
  const model = await page.inputValue('#model');
  const T = { timeout: 180000 };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  const tools = () => page.evaluate(() => [...document.querySelectorAll('#log details.tool summary .what')].map((s) => s.textContent));
  const replies = () => page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].map((b) => b.textContent));

  const log = () => page.textContent('#log');

  await page.fill('#input', 'Spawn one background subagent named counter. Its task: "Count the words in the sentence: the quick brown fox jumps over the lazy dog. Send just the number to main with the agents tool, then finish." Then tell me in one line that it started.');
  await page.press('#input', 'Enter');
  for (let i = 0; n < 1 && i < 300; i++) await page.waitForTimeout(100);
  if (n < 1) { console.log('not sent:', JSON.stringify(await page.evaluate(() => ({ status: document.getElementById('status').textContent, input: document.getElementById('input').value.slice(0, 40), send: document.getElementById('send-label').textContent, disabled: document.getElementById('send').disabled, sheet: document.getElementById('sheet')?.textContent?.slice(0, 200) })))); throw new Error('the first message was not sent'); }
  // A Follow-up while main works: Alt+Enter with the default Steer setting.
  await page.fill('#input', 'Follow-up: once counter has reported, list the agents in this session with their handles, in one short line each.');
  await page.press('#input', 'Alt+Enter');
  // The follow-up is a write to main's in file, held by the harness side: wait for its row.
  await page.waitForSelector('#tray-list .tray-row[data-kind="followup"]', { timeout: 2000 }).catch(() => {});
  const tray = await page.evaluate(() => [...document.querySelectorAll('#tray-list .tray-row')].map((r) => `${r.dataset.kind}: ${r.querySelector('.tray-origin')?.textContent ?? ''}`));
  console.log('tray after Alt+Enter:', JSON.stringify(tray));
  const heldFollowUp = tray.some((t) => /^followup: Follow-up · /.test(t));
  // Wait for the follow-up's turn to finish (its text reaches a request, then main idles).
  for (let i = 0; i < 1800; i++) {
    const r = await replies();
    if (r.length >= 2 && /a1|a2/.test(r.at(-1) ?? '') && (await page.textContent('#send-label')) === 'Send') break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(1500);
  const l = await log(), t = await tools(), rs = await replies();
  console.log('tools:', JSON.stringify(t));
  console.log('replies:', JSON.stringify(rs.map((x) => x.slice(0, 240))));
  console.log('labels:', JSON.stringify([...new Set(l.match(/(from )?[a-z-]+ \((a|s)\d+\)/g) ?? [])]));
  const checks = {
    'follow-up held in the tray': heldFollowUp,
    'no s-handle in the thread view': !/\(s\d+\)/.test(l),
    'peer message labeled from counter (a2)': /from counter \(a2\)/.test(l),
    'final reply names a1 and a2': /a1/.test(rs.at(-1) ?? '') && /a2/.test(rs.at(-1) ?? ''),
  };
  for (const [k, v] of Object.entries(checks)) console.log(v ? 'ok' : 'FAIL', k);
  console.log(`requests: ${n} (cap ${CAP}), ${Math.round((Date.now() - t0) / 1000)} s, model ${model}`);
  assertLiveRequests(n, CAP);
  if (Object.values(checks).some((v) => !v)) process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
