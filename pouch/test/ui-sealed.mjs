// Stories UI1, UI2 and UI5 live against BayLeaf Sealed (JOURNEYS section 18), at
// most CAP (default 12) model requests counted at the route (titles included).
// The real app, the real DuckDB runtime (built into a scratch dir, installed by
// `addons install duckdb` with the sheet approved, so the agent can compute), a
// real Sealed model. The messy export test/fixtures/duckdb/messy-sales.csv (a
// fixture: no user data) is attached and the person asks in plain words, naming
// no tool or syntax. Prints an outline: whether the agent read the ui-blocks
// and duckdb skills unprompted, the commands it ran, whether its reply holds an
// openui-lang block that rendered (div.oui), the Program footer's problems, and
// every number in the block against messyExpected (UI1) and what became of the
// n/a region-month (UI2). Model mistakes are evidence, printed PASS/FAIL per
// story, not a failed run. If the footer lists problems and requests remain, the
// person tells the agent and the outline records whether its next block is clean (UI5).
//   FAKE=1 node test/ui-sealed.mjs      (the harness against the scripted fake: no key, no Sealed request)
//   FAKE=1 FAKE_REPLY=reply.md node test/ui-sealed.mjs   (replay a recorded reply through the same verdicts)
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/ui-sealed.mjs   (MODEL=kimi-k3, CAP=12)
import assert from 'node:assert/strict';
import { signInSealed, assertLiveRequests } from './sealed-auth.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { duckdbPage, scratch, installDuckdb } from './duckdb-journey-browser.mjs';
import { readBlock, numOf, expectedGrid, REPLY } from './ui-journey-browser.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const CAP = Number(process.env.CAP ?? 12);
const FAKE = !!process.env.FAKE;
const key = process.env.BAYLEAF_API_KEY;
assert.ok(key || FAKE, 'BAYLEAF_API_KEY not set');
const MODEL = process.env.MODEL ?? 'kimi-k3';
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
const tag = FAKE ? 'fake' : 'live';
const ASK = 'How did each region do month by month? Show me in the chat, I don\'t want to open a file.';

// Every value the data explains: per region-month totals, medians and order
// counts, and the sums a summary might show (per region, per month, overall).
const { rows, regions, months } = expectedGrid();
const sum = (xs) => Math.round(xs.reduce((s, x) => s + (x ?? 0), 0) * 100) / 100;
const explained = new Set([...rows.flatMap(([, , t, m, n]) => [t, m, n]),
  ...regions.map((r) => sum(rows.filter((x) => x[0] === r).map((x) => x[2]))), ...regions.map((r) => sum(rows.filter((x) => x[0] === r).map((x) => x[4]))),
  ...months.map((m) => sum(rows.filter((x) => x[1] === m).map((x) => x[2]))), ...months.map((m) => sum(rows.filter((x) => x[1] === m).map((x) => x[4]))),
  sum(rows.map((x) => x[2])), sum(rows.map((x) => x[4])), regions.length, months.length].filter((x) => x != null));
const near = (x, set) => [...set].some((y) => Math.abs(x - y) < 0.01);
// A region or month named in a label, however the model wrote it ("East", "Jan 2026", "2026-01").
const MONTH = { '2026-01': /2026-01|jan/i, '2026-02': /2026-02|feb/i };
const regionIn = (s) => regions.find((r) => new RegExp(r.split(',')[0], 'i').test(s));
const monthIn = (s) => months.find((m) => MONTH[m].test(s));

// Story verdicts from what the block shows (readBlock in ui-journey-browser.mjs).
function judge(b) {
  const cells = [], seen = new Map(); // seen: region\tmonth -> the totals shown for it
  const note = (r, m, v) => { if (r && m) (seen.get(`${r}\t${m}`) ?? seen.set(`${r}\t${m}`, []).get(`${r}\t${m}`)).push(v); };
  // Long tables (a row per region-month, a Total column) and pivoted ones (a
  // row per region, a column per month) both name a region-month per cell.
  const TOTAL = /total|sum|amount|revenue|sales/i;
  for (const t of b.tables) for (const row of t.rows) {
    const r = regionIn(row.join(' ')), rowMonth = monthIn(row.join(' '));
    row.forEach((c, i) => {
      const h = t.head[i] ?? '', m = monthIn(h) ?? rowMonth, totalCell = monthIn(h) || (rowMonth && TOTAL.test(h));
      if (totalCell) note(r, m, c.trim() || '(empty)');
      if ((monthIn(c) && !monthIn(h)) || numOf(c) == null || regionIn(c)) return;
      cells.push({ where: `table [${h || i}] ${row[0]}`, text: c, ok: near(numOf(c), explained) });
    });
  }
  for (const f of b.bars) for (const [label, vals] of f.rows) vals.forEach((v, k) => {
    const key = `${label} ${f.legend[k] ?? ''}`;
    if (v !== 'no data') cells.push({ where: `bar ${key}`, text: v, ok: near(numOf(v), explained) });
    note(regionIn(key), monthIn(key), v);
  });
  for (const [label, v] of b.stats) if (numOf(v) != null) cells.push({ where: `stat ${label}`, text: v, ok: near(numOf(v), explained) });
  // Lines: which series drew a point at the null month (the first label is 2026-01 when x=0 is January).
  const lineGap = b.lines.flatMap((l) => l.legend.map((name, k) => ({ name, d: l.d[k], first: l.axis[0] }))).filter((s) => regionIn(s.name) === 'EAST')
    .map((s) => ({ ...s, drewJan: monthIn(s.first ?? '') === '2026-01' && /^M0\.0 /.test(s.d ?? '') }));
  const missing = rows.filter(([r, m, t]) => t != null && !(seen.get(`${r}\t${m}`) ?? []).some((v) => Math.abs(numOf(v) - t) < 0.01)).map(([r, m, t]) => `${r} ${m} ${t}`);
  const nullShown = seen.get(`EAST\t2026-01`) ?? [];
  return {
    UI1: { pass: cells.length > 0 && cells.every((c) => c.ok) && !missing.length, numbers: cells.length, unexplained: cells.filter((c) => !c.ok), totalsNotShown: missing },
    UI2: { pass: !nullShown.some((v) => numOf(v) === 0) && !lineGap.some((s) => s.drewJan), eastJanShownAs: nullShown, eastLine: lineGap },
  };
}

const app = await duckdbPage({ fake: FAKE });
const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 900 } });
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
    await signInSealed(page, 'BAYLEAF_API_KEY=' + key);
  }
  await page.waitForSelector('#badge.ok', { timeout: 60000 });
  if (await page.$eval('#model', (s, m) => [...s.options].some((o) => o.value === m), MODEL)) await page.selectOption('#model', MODEL);
  const model = await page.$eval('#model', (s) => s.value);
  await installDuckdb(page);
  if (FAKE) await page.evaluate((reply) => {
    // The scripted journey's turns (read the skill, then the block), so FAKE=1 exercises the outline.
    window.fake.rule({ who: 'main', when: (c) => /month by month/.test(c.since), reply: [['read', { path: '/pouch/skills/ui-blocks/SKILL.md' }]] });
    window.fake.rule({ who: 'main', when: (c) => /# UI blocks/.test(c.since), reply });
  }, process.env.FAKE_REPLY ? readFileSync(process.env.FAKE_REPLY, 'utf8') : REPLY);

  await page.locator('#attachment-picker').setInputFiles({ name: 'sales.csv', mimeType: 'text/csv', buffer: readFileSync(join(root, 'test/fixtures/duckdb/messy-sales.csv')) });
  await page.locator('.attachment').first().waitFor({ timeout: 10000 });
  const cardsOf = () => page.$$eval('#log details.tool summary', (s) => s.map((x) => x.textContent.replace(/\s+/g, ' ').trim().slice(0, 160))).catch(() => []);
  outline = async () => ({ status: await page.$eval('#send-label', (e) => e.textContent).catch(() => '?'), cards: await cardsOf(),
    errors: await page.$$eval('#log .error, #log .msg.error', (s) => s.map((x) => x.textContent.slice(0, 200))).catch(() => []) });
  // One turn: send, wait until it ends (with a reply, or an error: the cap aborts request CAP+1).
  const turn = async (text) => {
    await page.fill('#input', text);
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.getElementById('send-label').textContent !== 'Send', null, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, { timeout: 420000 });
    await page.waitForTimeout(1000);
    const last = page.locator('#log .msg.assistant .body').last();
    const blocks = last.locator(':scope div.oui');
    const k = await blocks.count();
    return { reply: (await last.textContent().catch(() => '')) ?? '', blocks: k, block: k ? blocks.first() : null,
      // Code blocks shown as code (a fence that did not render), not the Program footer's.
      fences: await last.evaluate((b) => b.querySelectorAll('div.code:not(.oui-source div.code)').length) };
  };
  const first = await turn(ASK);
  const cards = await cardsOf();
  await page.screenshot({ path: join(shots, `ui-sealed-${tag}.png`) });
  let b = null, verdict = null, program = '';
  if (first.block) {
    await first.block.scrollIntoViewIfNeeded();
    await first.block.screenshot({ path: join(shots, `ui-sealed-${tag}-block.png`) });
    b = await first.block.evaluate(new Function('o', `return (${readBlock})(o)`));
    program = await first.block.locator(':scope > details.oui-source pre').textContent();
    verdict = judge(b);
  }
  // UI5 live: told what the footer says, does the agent fix it?
  let fix = null;
  if (b?.problems.length && sent + 2 <= CAP) {
    const again = await turn(`Under the block it says: ${b.problems.join('; ')}. Can you fix that?`);
    const b2 = again.block ? await again.block.evaluate(new Function('o', `return (${readBlock})(o)`)) : null;
    if (again.block) await again.block.screenshot({ path: join(shots, `ui-sealed-${tag}-fixed.png`) });
    fix = { rendered: !!b2, problems: b2?.problems ?? null, pass: !!b2 && !b2.problems.length };
  }
  console.log(JSON.stringify({
    model, requests: sent, attempts: n, seconds: Math.round((Date.now() - t0) / 1000),
    readSkill: { 'ui-blocks': cards.some((c) => /ui-blocks\/SKILL\.md/.test(c)), duckdb: cards.some((c) => /duckdb\/SKILL\.md/.test(c)) },
    toolCards: cards, rendered: first.blocks, otherCodeFences: first.fences,
    footer: b ? { summary: b.summary, problems: b.problems } : null,
    shown: b && { tables: b.tables.map((t) => ({ head: t.head, rows: t.rows.length })), bars: b.bars.map((f) => ({ legend: f.legend, rows: f.rows })), lines: b.lines.map((l) => ({ legend: l.legend, axis: l.axis, d: l.d })), stats: b.stats },
    stories: { UI1: verdict ? (verdict.UI1.pass ? 'PASS' : 'FAIL') : 'FAIL (no block)', UI2: verdict ? (verdict.UI2.pass ? 'PASS' : 'FAIL') : 'FAIL (no block)', UI5: b?.problems.length ? (fix?.pass ? 'PASS (fixed when told)' : `FAIL ${JSON.stringify(fix)}`) : 'n/a (no problems)' },
    UI1: verdict?.UI1, UI2: verdict?.UI2, outside,
  }, null, 1));
  console.log('PROGRAM (fixture analysis, no user data):\n' + program.slice(0, 2500));
  console.log('REPLY TEXT:', first.reply.slice(0, 600));
  assertLiveRequests(FAKE ? await page.evaluate(() => Object.values(window.fake.requests).flat().length) : n, CAP);
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
