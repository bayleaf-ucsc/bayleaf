// Stories UI1-UI7 in the real page (JOURNEYS section 18), with the scripted fake in
// test/graph-fixture.js bundled in place of Tinfoil: no Sealed request is ever
// made. The person attaches the messy export of section 16 and asks in plain
// words; the fake agent reads the ui-blocks skill, then streams a reply with an
// openui-lang block: a Row of Stats, a LineChart (regions over months, the n/a
// region-month as null), a BarChart, a Table, and two hostile values (an <img>
// in a Table cell, a link to evil.example in a Text). DuckDB is not run here:
// the fake's numbers come from messyExpected() in test/duckdb-fixtures.mjs (the
// independent computation), so this tests the renderer, not the model; the
// live run (test/ui-sealed.mjs) tests the model. Then, in the DOM:
//   UI1 table cells and bar values equal messyExpected
//   UI2 the null region-month is no point in the line, "no data" in the bars, no 0
//   UI3 no <img>; the link is a button.ext with its host; no request to evil.example, no CSP violation
//   UI4 mid-stream: a code block, then a growing div.oui; once closed, no problems in the footer
//   UI5 (scripted part) a lone child in Tab("A", chart) renders and the footer names the fix
//   UI6 at 390px: no horizontal overflow beyond the table's own scroller; bar labels and values apart
//   UI7 reload, reopen the session: the same block text. The page itself reloads
//       from the test server (this harness has no service worker); the browser
//       is then taken offline before the session is reopened and rendered.
// Screenshots: POUCH_SHOTS (default /tmp/pouch-qa/shots), ui-journey-*.png.
// Run: node test/ui-journey-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { messyExpected } from './duckdb-fixtures.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });
process.chdir(root);

// The page as built (no DuckDB pin), with the fake model when asked. A trimmed
// copy of duckdbPage in test/duckdb-journey-browser.mjs.
export async function uiPage({ fake }) {
  const stub = `
import { createFake } from './test/graph-fixture.js';
window.fake = createFake();
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Fake title' } }] }) } };
    this.secureClient = { fetch: (u, i) => window.fake.fetch(u, i) };
  }
  async ready() {} async getVerificationDocument() { return { securityVerified: true }; }
}`;
  const define = { LOCAL_MODEL: 'null', SW_SHA256: '"test"', POUCH_PDF_RUNTIME: 'null', POUCH_DUCKDB_RUNTIME: 'null' };
  const alias = { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') };
  const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.ts')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
  const bundled = await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, write: false, format: 'iife', define: { ...define, WORKER_SRC: JSON.stringify(worker) }, alias,
    plugins: fake ? [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js', resolveDir: root })); } }] : [] });
  let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
  html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
  const HEADERS = headersFile(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], viewerCsp(root));
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname, viewer = path === '/viewer.html';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, viewer ? '/viewer.html' : '/pouch.html') });
    res.end(viewer ? readFileSync(join(root, 'viewer.html')) : html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/pouch.html`, close: () => server.close() };
}

// What the block shows, read back from the DOM (shared with test/ui-sealed.mjs):
// tables as rows of cell text, bar charts as label -> [series value text], line
// charts as their paths' d, the footer's problems, and every number in the block.
export const readBlock = (oui) => {
  const t = (e) => e.textContent.trim();
  return {
    tables: [...oui.querySelectorAll('div.table table')].map((tb) => ({ head: [...tb.querySelectorAll('thead th')].map(t), rows: [...tb.querySelectorAll('tbody tr')].map((r) => [...r.cells].map(t)) })),
    bars: [...oui.querySelectorAll('figure.oui-chart')].filter((f) => f.querySelector('.oui-bar-row')).map((f) => ({
      legend: [...f.querySelectorAll('.oui-legend > span')].map(t),
      rows: [...f.querySelectorAll('.oui-bar-row')].map((r) => [t(r.querySelector(':scope > .oui-label')), [...r.querySelectorAll('.oui-bar .num')].map(t)]) })),
    lines: [...oui.querySelectorAll('.oui-plot svg')].map((s) => ({ label: s.getAttribute('aria-label'), legend: [...s.closest('figure').querySelectorAll('.oui-legend > span')].map(t), d: [...s.querySelectorAll('path')].map((p) => p.getAttribute('d')), axis: [...s.closest('figure').querySelectorAll('.oui-axis span')].map(t) })),
    stats: [...oui.querySelectorAll('.oui-stat')].map((s) => [t(s.querySelector('.oui-label')), t(s.querySelector('.oui-value'))]),
    problems: [...oui.querySelectorAll(':scope > details.oui-source ul.oui-errors li')].map(t),
    summary: t(oui.querySelector(':scope > details.oui-source > summary')),
  };
};
// "86,250.5 USD" -> 86250.5; "" or "no data" -> null.
export const numOf = (s) => { const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };

// The program the fake writes, from the independent computation. A Map keyed
// region\tmonth; a region-month with no rows at all is null too.
export function expectedGrid() {
  const rows = messyExpected(), at = new Map(rows.map(([r, m, total]) => [`${r}\t${m}`, total]));
  const regions = [...new Set(rows.map((r) => r[0]))], months = [...new Set(rows.map((r) => r[1]))].sort();
  return { rows, regions, months, total: (r, m) => at.get(`${r}\t${m}`) ?? null };
}
function program() {
  const { rows, regions, months, total } = expectedGrid(), J = JSON.stringify;
  const sum = Math.round(rows.reduce((s, r) => s + (r[2] ?? 0), 0) * 100) / 100, orders = rows.reduce((s, r) => s + r[4], 0);
  return [
    'root = Stack([intro, stats, line, bars, table, notes, source])',
    'intro = Text("Totals by region and month from **sales.csv**. EAST has no amount for 2026-01 (its only order says n/a): a gap, not 0.")',
    'stats = Row([total, orders, regions])',
    `total = Stat("Total", ${sum}, null, "info")`,
    `orders = Stat("Orders", ${orders})`,
    `regions = Stat("Regions", ${regions.length})`,
    `line = LineChart(${J(months)}, [${regions.map((r) => `Series(${J(r)}, ${J(months.map((m) => total(r, m)))})`).join(', ')}], "USD")`,
    `bars = BarChart(${J(regions)}, [${months.map((m) => `Series(${J(m)}, ${J(regions.map((r) => total(r, m)))})`).join(', ')}], "USD")`,
    `table = Table(["Region", "Month", "Total", "Median", "Orders"], ${J(rows)})`,
    'notes = Table(["Order", "Note"], [[1, "<img src=x onerror=alert(1)>"]])',
    'source = Text("Checked against [x](https://evil.example).")',
  ].join('\n');
}
export const REPLY = 'Here is how each region did, month by month:\n\n```openui-lang\n' + program() + '\n```\n\nWEST carries almost all of it, mostly one $85,000 order in January.';
// UI5: Tab's children written as a lone component, not a list.
const BROKEN = 'Just the West bars:\n\n```openui-lang\nroot = Stack([tabs])\ntabs = Tabs([Tab("A", chart)])\nchart = BarChart(["2026-01", "2026-02"], [Series("WEST", [86250.5, 450])], "USD")\n```';

if (import.meta.url === `file://${process.argv[1]}`) {
  setTimeout(() => { console.error('FAIL: over 3 minutes'); process.exit(2); }, 180_000).unref();
  const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-ui-journey-'));
  const app = await uiPage({ fake: true });
  let passed = 0;
  const ok = (name) => { passed++; console.log('ok', name); };
  const errors = [], outside = [], requests = [], dialogs = [], cspConsole = [];
  const T = { timeout: 30000 };
  const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
  try {
    await context.route('https://**/*', (r) => {
      const u = new URL(r.request().url());
      if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
      if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
      outside.push(u.href); return r.abort();
    });
    // CSP violations, as the page sees them (survives reloads).
    await context.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => requests.push(r.url()));
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    page.on('console', (m) => { if (/Content.Security.Policy/i.test(m.text())) cspConsole.push(m.text()); });
    await page.goto(app.url);
    await page.waitForSelector('#badge.ok');
    await page.click('#welcome button >> text=Got it').catch(() => {});

    // The person attaches the export and asks in plain words.
    await page.locator('#attachment-picker').setInputFiles({ name: 'sales.csv', mimeType: 'text/csv', buffer: readFileSync(join(root, 'test/fixtures/duckdb/messy-sales.csv')) });
    await page.locator('.attachment').first().waitFor(T);
    const rule = (r) => page.evaluate((r) => { window.fake.rule({ ...r, when: new Function('c', 'return ' + r.when) }); }, r);
    await rule({ who: 'main', when: '/month by month/.test(c.since)', reply: [['read', { path: '/pouch/skills/ui-blocks/SKILL.md' }]] });
    // Streamed in 40-character pieces every 40 ms, so the block is seen growing.
    await rule({ who: 'main', when: '/# UI blocks/.test(c.since)', reply: { content: REPLY, size: 40, ms: 40 } });
    // UI4: record what the last reply's body shows at each change, as it streams.
    await page.evaluate(() => {
      window.__states = [];
      new MutationObserver(() => {
        const b = [...document.querySelectorAll('#log .msg.assistant .body')].at(-1);
        if (!b || !/openui-lang|oui/.test(b.innerHTML)) return;
        const oui = b.querySelector('div.oui'), code = b.querySelector('div.code');
        const s = oui ? `oui:${oui.querySelectorAll('*').length}` : code ? `code:${code.querySelector('.code-head span')?.textContent}` : 'none';
        if (window.__states.at(-1) !== s) window.__states.push(s);
      }).observe(document.getElementById('log'), { subtree: true, childList: true, characterData: true });
    });
    await page.fill('#input', 'How did each region do month by month? Show me in the chat, I don\'t want to open a file.');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => window.fake.requests.main?.length >= 2, null, T);
    await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
    const reqs = await page.evaluate(() => window.fake.requests.main.map((b) => JSON.stringify(b.messages)));
    assert.match(reqs[1], /# UI blocks/, 'the skill reached the agent');
    const oui = page.locator('#log .msg.assistant .body div.oui').first();
    await oui.waitFor(T);
    await oui.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'ui-journey-desktop.png'), fullPage: false });
    await oui.screenshot({ path: join(shots, 'ui-journey-block-desktop.png') });
    const got = await oui.evaluate(new Function('o', `return (${readBlock})(o)`));
    ok('setup: attach, ask in plain words; the agent reads the ui-blocks skill and its reply renders as a div.oui');

    // UI1: every Table cell and bar value equals the independent computation.
    const { rows, regions, months, total } = expectedGrid();
    const [table, notes] = got.tables;
    assert.deepEqual(table.head, ['Region', 'Month', 'Total', 'Median', 'Orders']);
    assert.deepEqual(table.rows.map((r) => [r[0], r[1], numOf(r[2]), numOf(r[3]), numOf(r[4])]), rows);
    const [bars] = got.bars;
    assert.deepEqual(bars.legend, months);
    assert.deepEqual(bars.rows.map(([l]) => l), regions);
    for (const [ri, [, vals]] of bars.rows.entries()) assert.deepEqual(vals.map(numOf), months.map((m) => total(regions[ri], m)));
    const [line] = got.lines;
    const present = rows.map((r) => r[2]).filter((x) => x != null);
    assert.deepEqual(line.axis[1].split('–').map(numOf), [Math.min(...present), Math.max(...present)]); // first label, "lo – hi", last label
    assert.deepEqual(line.legend, regions);
    assert.deepEqual(got.stats.map(([l, v]) => [l, numOf(v)]), [['Total', 101000.75], ['Orders', 7], ['Regions', 3]]);
    ok(`UI1: ${table.rows.length} table rows, ${bars.rows.length}x${months.length} bar values, the line's range (${line.axis[1]}) and 3 stats equal messyExpected`);

    // UI2: the n/a region-month (EAST 2026-01) is missing, never 0. With two
    // months the gap is a leading one: EAST's path has no point at x=0 and
    // starts a fresh run (M) at the second month.
    const eastRow = table.rows.find((r) => r[0] === 'EAST' && r[1] === '2026-01');
    assert.deepEqual([eastRow[2], eastRow[3]], ['', ''], 'the null total and median are empty cells');
    assert.equal(bars.rows.find(([l]) => l === 'EAST')[1][0], 'no data');
    assert.ok(!bars.rows.flatMap(([, v]) => v).some((v) => /^0(\s|$)/.test(v)), 'no bar says 0');
    const dEast = line.d[regions.indexOf('EAST')], dWest = line.d[regions.indexOf('WEST')];
    assert.match(dEast, /^M300\.0 [\d.]+( h0)?$/, `EAST is one run at the second month: ${dEast}`);
    assert.match(dWest, /^M0\.0 [\d.]+ L300\.0 [\d.]+/, `WEST is a line: ${dWest}`);
    // A run of one point (EAST and NORTH, UPPER here) is drawn as a dot: a
    // zero-length segment (h0) with a round cap, not an invisible lone M.
    const dots = await oui.evaluate((o) => [...o.querySelectorAll('.oui-plot path')].map((p) => ({ d: p.getAttribute('d'), cap: getComputedStyle(p).strokeLinecap })));
    for (const p of dots) assert.ok(/L/.test(p.d) || (/h0$/.test(p.d) && p.cap === 'round'), `every series shows: ${JSON.stringify(p)}`);
    ok(`UI2: EAST 2026-01 is an empty cell, "no data" in the bars, no point in the line (d "${dEast}": its one value a dot); no 0 anywhere`);

    // UI3: hostile values stay text; the link is the guarded button; nothing left.
    assert.equal(await oui.locator('img').count(), 0);
    assert.deepEqual(notes.rows, [['1', '<img src=x onerror=alert(1)>']]);
    const ext = oui.locator('button.ext');
    assert.equal(await ext.count(), 1);
    const extText = (await ext.textContent()).trim();
    assert.match(extText, /evil\.example/, `the host is shown: ${extText}`);
    assert.equal(await oui.locator('a[href]').count(), 0);
    ok(`UI3: no img in the block, the <img> cell is its literal text, the link is button.ext "${extText}"`);

    // UI4: a code block first, then a growing div.oui; when done, no problems.
    const states = await page.evaluate(() => window.__states);
    const firstOui = states.findIndex((s) => s.startsWith('oui:'));
    assert.ok(states.slice(0, firstOui).includes('code:openui-lang'), `a code block before the block: ${states.join(' ')}`);
    const sizes = states.slice(firstOui).map((s) => Number(s.split(':')[1]));
    assert.ok(sizes.length >= 3 && sizes.at(-1) > sizes[0], `the block grew: ${sizes.join(' ')}`);
    assert.deepEqual(got.problems, []);
    assert.equal(got.summary, 'Program');
    ok(`UI4: streamed, the program showed as a code block then a growing div.oui (${states.length} states, ${sizes[0]} -> ${sizes.at(-1)} nodes); closed, "Program" with no problems`);

    // UI5 (scripted part): Tab("A", chart) renders anyway, and the footer names the fix.
    await rule({ who: 'main', when: '/West bars/.test(c.since)', reply: BROKEN });
    await page.fill('#input', 'Now just the West bars, in a tab.');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#log .msg.assistant .body div.oui').length >= 2, null, T);
    await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
    const broken = page.locator('#log .msg.assistant .body div.oui').nth(1);
    const b5 = await broken.evaluate(new Function('o', `return (${readBlock})(o)`));
    assert.deepEqual(b5.bars[0]?.rows.map(([l, v]) => [l, v.map(numOf)]), [['2026-01', [86250.5]], ['2026-02', [450]]]);
    assert.equal(await broken.locator('.oui-tabbar button').textContent(), 'A');
    assert.ok(b5.problems.some((p) => p.includes('children are a list: write [chart]')), `footer: ${b5.problems.join(' | ')}`);
    assert.equal(b5.summary, 'Program, 1 problem');
    await broken.screenshot({ path: join(shots, 'ui-journey-ui5-broken.png') });
    ok(`UI5 (scripted): the lone child renders; the footer says "${b5.problems[0]}"`);

    // UI6: phone width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await oui.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'ui-journey-390.png') });
    await oui.screenshot({ path: join(shots, 'ui-journey-block-390.png') });
    const fit = await oui.evaluate((o) => {
      const log = document.getElementById('log'), lr = log.getBoundingClientRect();
      const r = (e) => e.getBoundingClientRect();
      const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      // Everything in the block within the transcript, except what sits inside a table's own scroller.
      const over = [...o.querySelectorAll('*')].filter((e) => !e.closest('div.table') && !e.closest('details:not([open])') && r(e).width && r(e).right > lr.right + 0.5).map((e) => e.className || e.tagName);
      const tables = [...o.querySelectorAll('div.table')].map((t) => ({ overflows: t.scrollWidth > t.clientWidth, scrolls: getComputedStyle(t).overflowX, within: r(t).right <= lr.right + 0.5 }));
      const bars = [...o.querySelectorAll('.oui-bar-row')].flatMap((row) => [...row.querySelectorAll('.oui-bar .num')].map((n) => ({
        label: row.querySelector(':scope > .oui-label').textContent, value: n.textContent, overlaps: meets(r(row.querySelector(':scope > .oui-label')), r(n)), clipped: r(n).right > r(row).right + 0.5 })));
      // A number cell on one line: a narrow table scrolls rather than splitting 12,000.25.
      const split = [...o.querySelectorAll('div.table td.num')].filter((td) => { const rs = document.createRange(); rs.selectNodeContents(td); return rs.getClientRects().length > 1; }).map((td) => td.textContent);
      const stats = [...o.querySelectorAll('.oui-row > .oui-stat')].map((s) => Math.round(r(s).top));
      return { page: document.documentElement.scrollWidth - innerWidth, log: log.scrollWidth - log.clientWidth, over, tables, bars, split, statRows: new Set(stats).size };
    });
    assert.equal(fit.page, 0, 'the page does not scroll sideways');
    assert.ok(fit.log <= 0, `the transcript does not scroll sideways (by ${fit.log}px)`);
    assert.deepEqual(fit.over, [], 'nothing in the block runs past the transcript');
    assert.ok(fit.tables.every((t) => t.within && (!t.overflows || t.scrolls === 'auto')), JSON.stringify(fit.tables));
    assert.deepEqual(fit.bars.filter((b) => b.overlaps || b.clipped), [], 'bar values clear of labels and inside the row');
    assert.deepEqual(fit.split, [], 'no number cell broken across lines');
    ok(`UI6: at 390px no sideways scroll (page, transcript, block); tables ${fit.tables.map((t) => (t.overflows ? 'scroll' : 'fit')).join('/')}; ${fit.bars.length} bar values clear of labels; stats in ${fit.statRows} row(s)`);
    await page.setViewportSize({ width: 1280, height: 800 });

    // UI7: reload, reopen the session offline, the same block.
    const before = await oui.textContent();
    await page.reload();
    await page.waitForSelector('#session-list .session', { state: 'attached', ...T }); // the sidebar may be closed
    await context.setOffline(true);
    const n = requests.length;
    if (!(await page.locator('#log div.oui').count())) await page.$eval('#session-list .session', (s) => s.click());
    await page.locator('#log div.oui').first().waitFor(T);
    const after = await page.locator('#log .msg.assistant .body div.oui').first().textContent();
    assert.equal(after, before);
    assert.deepEqual(requests.slice(n).filter((u) => !u.startsWith('blob:') && !u.startsWith('data:')), [], 'reopening fetched nothing');
    await context.setOffline(false);
    ok(`UI7: reloaded, offline, the session reopens and the block renders the same text (${after.length} characters); the page itself came from the test server`);

    // UI3, the rest: nothing left for evil.example, no CSP violation, no alert.
    const csp = await page.evaluate(() => window.__csp ?? []);
    assert.ok(!requests.some((u) => u.includes('evil.example')) && !outside.some((u) => u.includes('evil.example')));
    assert.deepEqual(outside.filter((u) => u !== 'https://api.bayleaf.dev/campus-pass'), [], 'only the account plane\'s Campus Pass check (aborted here) went out');
    assert.deepEqual([...csp, ...cspConsole], []);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
    ok('UI3: no request to evil.example, no CSP violation, no alert; nothing but Campus Pass left this origin; no page error');
  } finally { await context.close(); app.close(); rmSync(scratch, { recursive: true, force: true }); }
  console.log(`ui-journey-browser: ${passed} passed`);
}
