// Batch D live check against BayLeaf Sealed (at most CAP requests, default 15):
// (a) main watches an essay and offers a re-run when it changes (set up
//     directly, without the panel, to fit the budget); edit and save in the
//     editor; does it wake and offer? (b) the tray's Background button on a
//     blocking foreground subagent; (c) Enter right after Stop: is the draft
//     kept or sent? The key is pasted as the whole BAYLEAF_API_KEY= line.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/batchD-sealed.mjs
// Prints an outline (tools, labels, replies), not model internals.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 15);
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchD-sealed-'));

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
const out = {};
try {
  await context.route('https://api.bayleaf.dev/**', (r) => {
    if (r.request().method() === 'POST' && /chat\/completions/.test(r.request().url())) {
      if (++n > CAP) { console.log(`ABORT: request ${n} over cap ${CAP}`); return r.abort(); }
    }
    return r.continue();
  });
  const page = await context.newPage();
  page.on('dialog', (d) => { console.log('NATIVE DIALOG', d.message()); d.dismiss(); });
  await page.goto(url);
  await page.click('#welcome button >> text=Got it').catch(() => {});
  await page.click('#auth');
  await page.waitForSelector('#sheet[open] #key-input', { timeout: 10000 });
  await page.fill('#key-input', 'BAYLEAF_API_KEY=' + key); // the whole line, as pasted from the token file
  await page.click('#sheet .key-form button[type=submit]');
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  const T = { timeout: 240000 };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  const settle = async () => { await idle(); await page.waitForTimeout(2500); await idle(); };
  const send = async (t) => { await page.fill('#input', t); await page.press('#input', 'Enter'); };
  const lastReply = () => page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? '');
  console.log('model', await page.inputValue('#model'));

  // (a) A watch that offers a re-run.
  await send('Create /work/essay.md: a three-sentence essay arguing towns should be walkable. Then set up a watch on /work/essay.md so that when I change it you wake, tell me what changed in one line, and offer to re-run a review. Do not review it now. Keep replies short.');
  await settle();
  const before = n;
  console.log('(a) setup requests', n, '| tools:', (await page.evaluate(() => [...document.querySelectorAll('#log details.tool summary .what')].map((s) => s.textContent))).join(' / '));
  if ((await page.getAttribute('#app', 'data-panel')) !== 'files') await page.click('#rail [data-panel="files"]');
  await page.click('#tree .row[data-path="/work/essay.md"]');
  await page.waitForSelector('.cm-content', T);
  await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nP.S. Shade trees make walking pleasant in summer.');
  await page.keyboard.press('ControlOrMeta+s');
  const woke = await page.waitForFunction(() => [...document.querySelectorAll('#log .watch-from')].length > 0, null, { timeout: 90000 }).then(() => true, () => false);
  await settle();
  const r = await lastReply();
  out.a = { woke, offers: /re-?run|review/i.test(r), requests: n - before, reply: r.slice(0, 240), editorStatus: await page.evaluate(() => document.getElementById('editor-status').hidden ? '' : document.getElementById('editor-status').textContent) };
  console.log('(a)', JSON.stringify(out.a));

  // (b) Background on a blocking foreground subagent.
  const b0 = n;
  await send('Use a foreground subagent (background: false) named lister to list /work and summarize it in one line; wait for it. Then reply "main done" plus its line.');
  const tray = await page.waitForSelector('.tray-row .tray-bg', { timeout: 120000 }).then(() => true, () => false);
  if (tray) await page.click('.tray-row .tray-bg');
  const freed = tray && await page.waitForFunction(() => !document.querySelector('.tray-row .tray-bg'), null, { timeout: 30000 }).then(() => true, () => false);
  await settle();
  out.b = { trayButton: tray, mainFreed: freed, requests: n - b0, reply: (await lastReply()).slice(0, 200) };
  console.log('(b)', JSON.stringify(out.b));

  // (c) Enter right after Stop.
  const c0 = n;
  await send('Write four short paragraphs about sidewalks, one sentence each.');
  await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Stop', null, T);
  await page.waitForTimeout(800);
  await page.fill('#input', 'After stop: say "got it" only.');
  await page.click('#send');
  await page.press('#input', 'Enter');
  await page.waitForTimeout(1500);
  const afterEnter = { box: await page.inputValue('#input'), tray: await page.evaluate(() => [...document.querySelectorAll('.tray-row')].map((r) => r.textContent.trim().slice(0, 80))) };
  await settle();
  const users = await page.evaluate(() => [...document.querySelectorAll('#log .msg.user .body')].map((b) => b.textContent));
  out.c = { ...afterEnter, sentAsTurn: users.some((u) => /After stop/.test(u)), requests: n - c0, reply: (await lastReply()).slice(0, 120) };
  console.log('(c)', JSON.stringify(out.c));
  console.log('total requests', n, 'of cap', CAP);
} finally {
  await context.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
