// Batch F live play-through against BayLeaf Sealed, at most CAP (default 10)
// model requests, counted at the route: a background subagent is stopped from
// the terminal through its ctl file while the tray reflects it, and a steer
// written to main's in file from the terminal reaches main mid-turn.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/batchF-sealed.mjs
import assert from 'node:assert/strict';
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
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchF-sealed-'));

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
const log = [];
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
try {
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
  await page.click('#auth');
  await page.waitForSelector('#sheet[open] #key-input', { timeout: 10000 });
  await page.fill('#key-input', 'BAYLEAF_API_KEY=' + key);
  await page.click('#sheet .key-form button[type=submit]');
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  const T = { timeout: 120000 };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  async function term(cmd) {
    if (!(await page.isVisible('#term-input'))) { await page.keyboard.press('Control+`'); await page.waitForSelector('#term-input', { state: 'visible', timeout: 5000 }); }
    const k = await page.$$eval('#term-log .term-block', (l) => l.length);
    await page.fill('#term-input', cmd); await page.press('#term-input', 'Enter');
    await page.waitForFunction((k) => { const b = document.querySelectorAll('#term-log .term-block'); return b.length > k && !b[b.length - 1].querySelector('.term-live'); }, k, { timeout: 30000 });
    return (await page.$eval('#term-log .term-block:last-child', (b) => b.textContent)).replace(/^.*?\$ /, '');
  }
  const saRows = () => page.$$eval('#tray-list li', (l) => l.filter((x) => x.dataset.key?.startsWith('sa:')).map((x) => x.textContent.replace(/\s+/g, ' ').trim()));

  let out;
  // 1. A background subagent, stopped from the terminal through its ctl file (ONLY=2 skips it).
  if (process.env.ONLY !== '2') {
  await page.fill('#input', 'Use the subagent tool once to spawn a background subagent named "counter" with this task: "Without using any tools, write the numbers from 1 to 600, one per line, then report done." Then reply with the single word started and end your turn. Do not wait for it.');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#tray-list li')].some((l) => l.dataset.key?.startsWith('sa:')), null, T);
  log.push(['tray shows the subagent', at(), await saRows(), n]);
  out = await term('cat /session/current/agents/a2/status');
  log.push(['terminal status before', at(), out.trim(), n]);
  out = await term('echo stop > /session/current/agents/a2/ctl; cat /session/current/agents/a2/status; tail -n 3 /session/events');
  log.push(['terminal stop', at(), out.trim(), n]);
  await page.waitForFunction(() => ![...document.querySelectorAll('#tray-list li')].some((l) => l.dataset.key?.startsWith('sa:')), null, { timeout: 20000 });
  log.push(['tray row gone', at(), await saRows(), await page.textContent('#send-live'), n]);
  assert.match(out, /stopped [\d.]+s subagent counter/);
  await idle();
  log.push(['turn 1 idle', at(), n]);
  }

  // 2. A steer from the terminal reaches main mid-turn.
  await page.fill('#input', 'Run the bash command `sleep 6 && echo ready` with the bash tool. After it finishes, reply with one short sentence.');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#log details.tool .what')].some((d) => /sleep 6/.test(d.textContent)), null, T);
  out = await term("printf 'steer\\nAlso end your sentence with the word PINEAPPLE.' > /session/current/agents/a1/in; cat /session/current/agents/a1/status");
  log.push(['terminal steer', at(), out.trim(), n]);
  const trayHad = await page.$$eval('#tray-list li', (l) => l.some((x) => x.dataset.key?.startsWith('steer:')));
  await idle();
  const last = await page.$$eval('#log .msg.assistant, #log .assistant', (l) => l.at(-1)?.textContent ?? '');
  log.push(['turn 2 reply', at(), last.slice(-160), 'tray showed steer: ' + trayHad, n]);
  assert.match(last, /PINEAPPLE/i);
  await page.screenshot({ path: '/tmp/pouch-qa/shots/batchF-sealed.png' });
} catch (e) {
  const page = context.pages().at(-1);
  console.log('FAILED at', at(), String(e.message).slice(0, 300), '| status:', await page?.textContent('#status').catch(() => '?'), '| log tail:', (await page?.textContent('#log').catch(() => '') ?? '').slice(-400));
  throw e;
} finally {
  for (const l of log) console.log(JSON.stringify(l));
  console.log(`Sealed requests: ${n} (cap ${CAP})`);
  await context.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
