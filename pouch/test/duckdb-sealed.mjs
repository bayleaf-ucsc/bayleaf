// Stories DB1 and DB2 live against BayLeaf Sealed (JOURNEYS section 16), at
// most CAP (default 12) model requests counted at the route (titles included).
// The real app, the real DuckDB runtime (built into a scratch dir, installed
// by `addons install duckdb` with the sheet approved: an asked add-on), a real
// Sealed model. The messy export test/fixtures/duckdb/messy-sales.csv (a
// fixture: no user data) is attached and the person asks in plain words,
// naming no tool. Prints an outline: the commands the agent ran, whether it
// saved a .sql, whether its CSV's totals and medians match the independent
// computation, and whether rerunning its .sql in the terminal gives the same bytes.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/duckdb-sealed.mjs
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { duckdbPage, term, scratch, installDuckdb } from './duckdb-journey-browser.mjs';
import { messyExpected, parseCsv } from './duckdb-fixtures.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 12);
// FAKE=1 checks this harness against the scripted fake (no key, no Sealed request).
const FAKE = !!process.env.FAKE;
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key || FAKE, 'BAYLEAF_API_KEY not set');
const MODEL = process.env.MODEL ?? 'kimi-k3';
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
const app = await duckdbPage({ fake: FAKE });
const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
let n = 0, sent = 0, outline = null;
const t0 = Date.now(), outside = [];
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
  await page.goto(app.url);
  await page.click('#welcome button >> text=Got it').catch(() => {});
  if (FAKE) await context.route('https://api.bayleaf.dev/sealed/models', (r) => r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } }));
  else {
    await page.click('#auth');
    await page.waitForSelector('#sheet[open] #key-input', { timeout: 10000 });
    await page.fill('#key-input', 'BAYLEAF_API_KEY=' + key);
    await page.click('#sheet .key-form button[type=submit]');
  }
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  if (await page.$eval('#model', (s, m) => [...s.options].some((o) => o.value === m), MODEL)) await page.selectOption('#model', MODEL);
  const model = await page.$eval('#model', (s) => s.value);
  await installDuckdb(page);

  await page.locator('#attachment-picker').setInputFiles({ name: 'sales.csv', mimeType: 'text/csv', buffer: readFileSync(join(root, 'test/fixtures/duckdb/messy-sales.csv')) });
  await page.locator('.attachment').first().waitFor({ timeout: 10000 });
  await page.fill('#input', 'Here is our sales export. I need the total and median amount by region and month, as a CSV.');
  await page.press('#input', 'Enter');
  // Done when the turn ends: with a reply, or with an error (the cap aborts request CAP+1).
  outline = async () => ({ status: await page.$eval('#send-label', (e) => e.textContent).catch(() => '?'), cards: await page.$$eval('#log details.tool summary', (s) => s.map((x) => x.textContent.replace(/\s+/g, ' ').trim().slice(0, 140))).catch(() => []),
    errors: await page.$$eval('#log .error, #log .msg.error', (s) => s.map((x) => x.textContent.slice(0, 200))).catch(() => []) });
  await page.waitForFunction(() => window.__turnStarted || document.getElementById('send-label').textContent !== 'Send', null, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, { timeout: 360000 });
  await page.waitForTimeout(1000);
  const reply = await page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? '');
  const cards = await page.$$eval('#log details.tool summary', (s) => s.map((x) => x.textContent.replace(/\s+/g, ' ').trim().slice(0, 140)));
  await page.screenshot({ path: join(shots, 'duckdb-sealed.png') });

  const ls = await term(page, 'ls /work');
  const csvs = [...ls.matchAll(/([\w.-]+\.csv)/g)].map((m) => m[1]).filter((f) => f !== 'sales.csv');
  const sqls = [...ls.matchAll(/([\w.-]+\.sql)/g)].map((m) => m[1]);
  let numbersMatch = false, sameBytes = null;
  const expected = messyExpected();
  for (const f of csvs) {
    const text = await term(page, `cat /work/${f}`);
    const rows = parseCsv(text.slice(text.search(/[A-Za-z_]+,/)).trim() + '\n');
    const nums = (r) => Object.values(r).map((v) => Number(String(v).replace(/[$,]/g, ''))).filter((x) => Number.isFinite(x));
    numbersMatch ||= expected.filter(([, , total]) => total !== null).every(([region, month, total, median]) =>
      rows.some((r) => Object.values(r).some((v) => String(v).toUpperCase().includes(region.split(',')[0])) && Object.values(r).some((v) => String(v).includes(month))
        && nums(r).some((x) => Math.abs(x - total) < 0.01) && nums(r).some((x) => Math.abs(x - median) < 0.01)));
  }
  if (sqls.length && csvs.length) {
    const target = csvs[0], before = await term(page, `sha256sum /work/${target}`);
    await term(page, `duckdb -f /work/${sqls[0]}`);
    const after = await term(page, `sha256sum /work/${target}`);
    sameBytes = before.match(/[0-9a-f]{64}/)?.[0] === after.match(/[0-9a-f]{64}/)?.[0];
  }
  console.log(JSON.stringify({ model, requests: sent, attempts: n, seconds: Math.round((Date.now() - t0) / 1000), toolCards: cards, csvs, sqls, numbersMatch, rerunSameBytes: sameBytes, outside }, null, 1));
  console.log('REPLY (fixture analysis, no user data):', reply.slice(0, 700));
  assert.ok(sent <= CAP, 'request cap');
  outline = null;
} catch (e) {
  console.log('FAILED:', e.message.split('\n')[0]);
  throw e;
} finally {
  if (outline) console.log('OUTLINE AT FAILURE:', JSON.stringify({ requests: sent, attempts: n, seconds: Math.round((Date.now() - t0) / 1000), ...(await outline()) }, null, 1));
  else console.log(`requests: ${sent} (attempts ${n})`);
  await context.close();
  app.close();
  rmSync(scratch, { recursive: true, force: true });
}
