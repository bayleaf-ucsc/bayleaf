// One real run of "$panel review this draft" in the built page against
// BayLeaf Sealed (batch A): how many requests the one-shot panel costs (41
// before), and whether the result renders as a success.
//   POUCH_OUT=/tmp/pouch-qa/distA node build.mjs
//   POUCH_OUT=/tmp/pouch-qa/distA node test/batchA-sealed.mjs
// Spends real requests. Hard cap CAP (default 20) at the network route: the
// request past it is aborted in the browser and Stop all is pressed. The key
// is pasted from ~/.tokens/bayleaf-api as its whole NAME=value line (fix 7).
// Prints counts and what the page shows, never request content.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const dist = resolve(process.env.POUCH_OUT || join(root, 'dist'));
const CAP = Number(process.env.CAP ?? 20);
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || '/tmp/pouch-qa', 'pouch-sealedA-'));
const ESSAY = `# Walkable towns

Cities have spent a century designing for cars. This essay argues that towns
should be walkable, and that the way there is to remove parking minimums.

Walking cuts car trips by 40% in towns that try it, and shops on walkable
streets earn more. Residents are healthier too.

Everyone knows this basically always works: my friend in Oakland says it is
much easier to get around since they widened the sidewalks.

So plan for feet: remove parking minimums, widen sidewalks, and let mixed uses
back in.
`;
const line = readFileSync(join(homedir(), '.tokens/bayleaf-api'), 'utf8').split('\n').find((l) => /sk-bayleaf-/.test(l));
assert.ok(line, 'no key line in ~/.tokens/bayleaf-api');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(dist) || !existsSync(p) || p === dist) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[extname(p)] ?? 'application/octet-stream'); res.end(readFileSync(p));
});
await new Promise((r) => server.listen(8763, '127.0.0.1', r));

const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 860 } });
let sent = 0, refused = 0, page;
const t0 = Date.now();
try {
  await context.route('**/chat/completions', async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    if (sent >= CAP) { refused++; if (refused === 1) { console.log(`CAP ${CAP} reached: aborting and pressing Stop all`); page.click('#tray-stop-all').catch(() => {}); page.keyboard.press('Escape').catch(() => {}); } return r.abort(); }
    sent++; return r.continue();
  });
  page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:8763/pouch.html');
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  await page.click('#welcome button >> text=Got it').catch(() => {});
  // Fix 7, for real: paste the whole NAME=value line.
  await page.click('#auth');
  await page.waitForSelector('#sheet[open] #key-input');
  await page.fill('#key-input', line.trim());
  await page.click('#sheet .key-form button[type=submit]');
  await page.waitForSelector('#auth.on', { timeout: 30000 });
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  console.log('signed in from a NAME=value line; usage:', await page.textContent('#composer-usage-num').catch(() => '?'));
  // The draft, uploaded into /work.
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[aria-label="Actions for work"]').dispatchEvent('click');
  await page.click('#sheet-actions button >> text=Upload files here');
  await (await chooser).setFiles({ name: 'essay.md', mimeType: 'text/markdown', buffer: Buffer.from(ESSAY) });
  await page.waitForSelector('#tree .row[data-path="/work/essay.md"]', { state: 'attached', timeout: 15000 });
  // $pan -> completion (with its cost hint) -> the request.
  await page.fill('#input', '$pan');
  await page.waitForSelector('#ac:not([hidden]) .ac-cost');
  console.log('completion cost hint:', await page.textContent('#ac .ac-cost'));
  await page.press('#input', 'Enter');
  await page.type('#input', 'Review this draft: /work/essay.md');
  await page.press('#input', 'Enter');
  // Watch: tray spend mid-run; then quiet (Send idle, no subagent working) or 6 minutes.
  let trayMax = '';
  const deadline = Date.now() + 6 * 60_000;
  let quietSince = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({ send: document.getElementById('send-label').textContent, tray: document.getElementById('tray-count').textContent, working: [...document.querySelectorAll('#session-list .s-child-state')].filter((s) => s.textContent === 'working').length }));
    if (/requests? this turn/.test(st.tray)) trayMax = st.tray;
    if (st.send === 'Send' && !st.working && sent > 1) { quietSince ||= Date.now(); if (Date.now() - quietSince > 4000) break; } else quietSince = 0;
  }
  const out = await page.evaluate(() => {
    const last = [...document.querySelectorAll('#log .msg.assistant')].at(-1);
    return {
      reply: last?.querySelector('.body')?.textContent ?? '', error: !!last?.querySelector('.body.bad'),
      numbered: last?.querySelectorAll('ol li').length ?? 0,
      cards: [...document.querySelectorAll('#log .subagent[data-child]')].map((c) => `${c.querySelector('.sa-name')?.textContent}:${c.querySelector('.sa-status')?.textContent}:${c.querySelector('.sa-meta')?.textContent}`),
      noReport: /No report\./.test(document.getElementById('log').textContent),
      joins: [...document.querySelectorAll('#log details.sa-joins > summary')].map((s) => s.textContent),
      tools: [...document.querySelectorAll('#log > * details.tool summary .what')].map((s) => s.textContent.slice(0, 80)),
    };
  });
  await page.screenshot({ path: join(shots, 'batchA-sealed-final.png'), fullPage: false });
  await page.click('#rail-usage').catch(() => {});
  await page.waitForTimeout(800);
  const usageRow = await page.$$eval('#usage-body table.tokens tr.current td', (n) => n.map((x) => x.textContent)).catch(() => []);
  await page.screenshot({ path: join(shots, 'batchA-sealed-usage.png') });
  console.log(JSON.stringify({ requests: sent, refusedOverCap: refused, seconds: Math.round((Date.now() - t0) / 1000), trayMax, usageRow, ...out, reply: out.reply.slice(0, 1200), errors }, null, 1));
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
