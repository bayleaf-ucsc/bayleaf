// Layout journeys: sidebar sessions (D3), rail panels, resizing, phones,
// automatic titles and the sparkle (D8), the usage meter and panel (A6).
//   set -a; source ~/.tokens/bayleaf-api; set +a; node t9-layout.mjs
import { launch, instrument, sheetClick, sleep, URL, newSession, currentSession, sessionIds, pickSession, sessionMenu, waitSignedIn, ensurePanel, openSidebar } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const SHOTS = '/tmp/pouch-qa/shots/layout-';
const log = (...a) => console.log(...a);
const results = [];
const ok = (c, m) => { results.push([!!c, m]); log(c ? 'PASS' : 'FAIL', m); };
const step = async (name, fn) => { try { await fn(); } catch (e) { ok(false, `${name} threw: ${e.message.split('\n')[0]}`); } };

async function idle(page, timeout = 180_000) {
  const t = Date.now();
  await sleep(800);
  while (Date.now() - t < timeout) {
    if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return sleep(600);
    await sleep(400);
  }
  throw new Error('never idle');
}
async function say(page, text) { await page.fill('#input', text); await page.click('#send'); await idle(page); }
const width = (page, sel) => page.$eval(sel, (e) => Math.round(e.getBoundingClientRect().width));
const sideOpen = (page) => page.$eval('#app', (a) => a.classList.contains('side-open'));
const panel = (page) => page.getAttribute('#app', 'data-panel');
const dbSessions = (page) => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('bayleaf-pouch');
  r.onsuccess = () => { const q = r.result.transaction('sessions').objectStore('sessions').getAll(); q.onsuccess = () => { res(q.result); r.result.close(); }; q.onerror = rej; };
  r.onerror = rej;
}));
const dbSession = async (page, id) => (await dbSessions(page)).find((s) => String(s.id) === String(id));
const usageNum = async (page) => { const t = (await page.textContent('#usage-num')).trim(); return /^\d+$/.test(t) ? Number(t) : null; };
async function waitFor(fn, timeout = 60_000, every = 500) {
  const t = Date.now();
  while (Date.now() - t < timeout) { const v = await fn(); if (v) return v; await sleep(every); }
  return null;
}

const ctx = await launch({ fresh: true, userDataDir: '/tmp/pouch-qa/layout-desktop' });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
const errors = instrument(page);
page.on('pageerror', (e) => log('PAGEERROR', e.stack.split('\n').slice(0, 5).join(' | ')));
let real = 0, mocked = false;
page.on('request', (r) => { if (!mocked && r.url().includes('/sealed/v1/chat/completions')) real++; });
await page.goto(URL);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });

await step('sidebar flipper', async () => {
  ok(!(await sideOpen(page)) && (await page.getAttribute('#flipper', 'aria-expanded')) === 'false', 'sidebar collapsed by default');
  await page.click('#flipper'); await sleep(200);
  ok(await sideOpen(page) && await page.isVisible('#new'), 'flipper opens the sidebar');
  await page.reload(); await page.waitForSelector('#badge'); await sleep(300);
  ok(await sideOpen(page), 'open sidebar persists across reload');
  await page.click('#flipper'); await sleep(200);
  await page.reload(); await page.waitForSelector('#badge'); await sleep(300);
  ok(!(await sideOpen(page)), 'closed sidebar persists across reload');
});

await step('rail', async () => {
  ok((await panel(page)) === 'files', 'first visit on desktop opens Files');
  await page.click('#rail [data-panel=usage]'); await sleep(200);
  ok((await panel(page)) === 'usage' && await page.isVisible('#usage') && !(await page.isVisible('#files')), 'Usage replaces Files: one panel at a time');
  ok((await page.getAttribute('#rail [data-panel=usage]', 'aria-pressed')) === 'true' && (await page.getAttribute('#rail [data-panel=files]', 'aria-pressed')) === 'false', 'rail aria-pressed follows the open panel');
  await page.click('#rail [data-panel=usage]'); await sleep(200);
  ok((await panel(page)) === '' && !(await page.isVisible('#panel-host')), 'clicking the active icon closes the panel');
  await page.click('#badge'); await sleep(200);
  ok((await panel(page)) === 'trust' && /talks only to api\.bayleaf\.dev/.test(await page.textContent('#trust')), 'shield opens Trust');
  await page.click('#trust-close'); await sleep(200);
  ok((await panel(page)) === '', 'Trust close button closes it');
  const tips = await page.$$eval('button.icon', (bs) => bs.filter((b) => !b.ariaLabel || !b.title).map((b) => b.id || b.className));
  ok(tips.length === 0, 'every icon button has aria-label and title' + (tips.length ? ': ' + tips.join(', ') : ''));
});

await step('widths and resizing', async () => {
  await ensurePanel(page, 'files');
  ok(Math.abs((await width(page, '#panel-host')) - 300) <= 2, 'Files default width 300: ' + await width(page, '#panel-host'));
  ok((await width(page, '#chat')) >= 500, 'chat with Files open: ' + await width(page, '#chat'));
  await page.click('#rail [data-panel=editor]'); await sleep(200);
  const ew = await width(page, '#panel-host');
  ok(Math.abs(ew - 640) <= 2 && (await width(page, '#chat')) >= 500, `Editor default ~50%: ${ew}, chat ${await width(page, '#chat')}`);
  await ensurePanel(page, 'files');
  const h = await page.$eval('#panel-handle', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
  await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(h.x - 50, h.y, { steps: 3 }); await page.mouse.move(h.x - 100, h.y, { steps: 3 }); await page.mouse.up();
  ok(Math.abs((await width(page, '#panel-host')) - 400) <= 2, 'drag widens Files to 400: ' + await width(page, '#panel-host'));
  await page.reload(); await page.waitForSelector('#badge'); await sleep(300);
  ok((await panel(page)) === 'files' && Math.abs((await width(page, '#panel-host')) - 400) <= 2, 'dragged width and open panel persist across reload');
  await page.focus('#panel-handle'); await page.keyboard.press('ArrowLeft');
  ok(Math.abs((await width(page, '#panel-host')) - 416) <= 2, 'ArrowLeft on the handle widens by 16');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await page.reload(); await page.waitForSelector('#badge'); await sleep(300);
  ok(Math.abs((await width(page, '#panel-host')) - 384) <= 2, 'keyboard width persists: ' + await width(page, '#panel-host'));
  await page.dblclick('#panel-handle'); await sleep(100);
  ok(Math.abs((await width(page, '#panel-host')) - 300) <= 2, 'double-click resets to 300');
  await page.click('#rail [data-panel=usage]'); await sleep(100);
  ok(Math.abs((await width(page, '#panel-host')) - 320) <= 2, 'widths are per panel: Usage 320');
  await openSidebar(page);
  ok(Math.abs((await width(page, '#sidebar')) - 260) <= 2, 'sidebar default 260');
  await page.focus('#side-handle'); await page.keyboard.press('ArrowRight');
  await page.reload(); await page.waitForSelector('#badge'); await sleep(300);
  ok(Math.abs((await width(page, '#sidebar')) - 276) <= 2, 'sidebar width persists: ' + await width(page, '#sidebar'));
  await page.dblclick('#side-handle'); await sleep(100);
  ok(Math.abs((await width(page, '#sidebar')) - 260) <= 2, 'sidebar double-click resets');
  await openSidebar(page, false);
  await ensurePanel(page, 'files');
});

let R0 = null, aId = null, bId = null;
await step('sign in and meter', async () => {
  await page.click('#auth'); page.dialogQueue.push(KEY); await sheetClick(page, 'Paste a key');
  await waitSignedIn(page);
  await page.waitForSelector('#badge.ok', { timeout: 60_000 });
  R0 = await waitFor(() => usageNum(page), 15_000, 300);
  ok(R0 != null, 'keyed meter shows a number: ' + R0);
  await ensurePanel(page, 'usage'); await sleep(200);
  const t = await page.textContent('#usage-body');
  ok(/of \d+ left today/.test(t) && /personal key/.test(t) && /Resets at/.test(t), 'Usage panel: remaining/limit, key wording, reset time');
  ok(/Not used by Pouch/.test(t), 'standard lane shown as not used by Pouch');
  ok(/one request/.test(t) && /compaction/.test(t) && /automatic title/.test(t), 'explains what one request is');
});

await step('auto-name after the first turn', async () => {
  await page.selectOption('#model', 'glm-5-3').catch(() => {});
  await newSession(page); await sleep(400);
  aId = await currentSession(page);
  const before = real;
  const msg = 'Reply with exactly these three words and nothing else: blue harbor lighthouse';
  await say(page, msg);
  const fallback = msg.slice(0, 60).trim();
  const title = await waitFor(async () => { const t = (await page.textContent('#title')).trim(); return t && t !== fallback && t !== 'New session' ? t : null; }, 90_000);
  ok(!!title && title.length <= 60 && !/^["'].*["']$/.test(title) && !/\.$/.test(title), 'session auto-named: ' + title);
  const s = await dbSession(page, aId);
  ok(s?.titleSource === 'auto', 'stored titleSource: ' + s?.titleSource);
  ok(real - before === 2, `one turn plus one naming request: ${real - before}`);
  const r1 = await waitFor(async () => { const n = await usageNum(page); return n != null && n < R0 ? n : null; }, 20_000);
  ok(r1 != null, `meter decrements after the turn: ${R0} -> ${r1}`);
  await ensurePanel(page, 'usage'); await sleep(300);
  ok((await page.$$('#usage-body table.tokens tbody tr')).length >= 1, 'token table lists the session');
  await page.screenshot({ path: SHOTS + 'desktop-usage.png' });
});

await step('sparkle', async () => {
  await page.click('#title');
  await page.waitForSelector('#topbar .title-input');
  ok(/1 Sealed request/.test(await page.getAttribute('#topbar .spark', 'title')), 'sparkle tooltip names the cost');
  const before = real, old = await page.inputValue('#topbar .title-input');
  await page.click('#topbar .spark');
  await page.waitForFunction(() => !document.querySelector('#topbar .spark')?.classList.contains('working'), null, { timeout: 90_000 });
  const v = await page.inputValue('#topbar .title-input');
  ok(v.length > 0 && real - before === 1, `sparkle regenerated in place (${old} -> ${v}), ${real - before} request`);
  await page.screenshot({ path: SHOTS + 'desktop-title-edit.png' });
  await page.keyboard.press('Enter'); await sleep(400);
  const s = await dbSession(page, aId);
  ok(s.title === v && s.titleSource === 'auto' && (await page.textContent('#title')) === v, 'Enter keeps the suggestion as an auto title');
  await page.click('#title'); await page.fill('#topbar .title-input', 'Should not stick'); await page.keyboard.press('Escape'); await sleep(300);
  ok((await page.textContent('#title')) === v && (await dbSession(page, aId)).title === v, 'Esc cancels an edit');
});

await step('typed title survives a turn', async () => {
  await newSession(page); await sleep(400);
  bId = await currentSession(page);
  await page.click('#title'); await page.fill('#topbar .title-input', 'My typed title'); await page.keyboard.press('Enter'); await sleep(300);
  ok((await dbSession(page, bId))?.titleSource === 'user', 'typed title is marked user');
  const before = real;
  await page.fill('#input', 'Reply with exactly: ok');
  await page.click('#send');
  const spun = await waitFor(() => page.$('#session-list .session[data-id="' + bId + '"] .spin'), 15_000, 100);
  ok(!!spun, 'sidebar row shows a busy spinner while running');
  await idle(page); await sleep(2500);
  ok((await page.textContent('#title')) === 'My typed title' && (await dbSession(page, bId)).title === 'My typed title', 'typed title not overwritten after the turn');
  ok(real - before === 1, `no naming request for a typed title: ${real - before}`);
});

await step('sidebar sessions', async () => {
  await openSidebar(page);
  const ids = await sessionIds(page);
  ok(ids.length === 2 && ids[0] === bId, 'sidebar lists both, newest first');
  ok(/^(now|\dm)$/.test((await page.textContent(`#session-list .session[data-id="${aId}"] .s-time`)).trim()), 'rows show relative time');
  await pickSession(page, aId); await sleep(1200);
  ok((await currentSession(page)) === aId && /blue harbor lighthouse/i.test(await page.textContent('#log')), 'switch via sidebar shows that transcript');
  await sessionMenu(page, aId); await sheetClick(page, 'Rename');
  await page.fill('#session-list .title-input', 'Sidebar named'); await page.keyboard.press('Enter'); await sleep(400);
  ok((await page.textContent(`#session-list .session[data-id="${aId}"] .s-title`)) === 'Sidebar named' && (await dbSession(page, aId)).titleSource === 'user', 'rename in place from the row menu');
  await page.screenshot({ path: SHOTS + 'desktop-sidebar.png' });
  page.dialogQueue.push(true);
  await sessionMenu(page, bId); await sheetClick(page, 'Delete session'); await sleep(1200);
  ok(!(await sessionIds(page)).includes(bId) && (await sessionIds(page)).includes(aId), 'delete from the row menu');
  await newSession(page); await sleep(400);
  ok((await sessionIds(page)).length === 2, 'New session from the sidebar');
  await pickSession(page, aId); await sleep(800);
});

await step('quota exhaustion message', async () => {
  mocked = true;
  await page.route('**/sealed/v1/chat/completions', (r) => r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Daily Sealed request limit reached', type: 'rate_limit' } }) }));
  await page.fill('#input', 'This request is answered by a mocked 429.');
  await page.click('#send');
  await idle(page, 120_000);
  const st = await page.textContent('#status');
  ok(/used up/.test(st) && /resets at/i.test(st), 'a 429 shows the allowance message with the reset time: ' + st);
  await page.unroute('**/sealed/v1/chat/completions');
  mocked = false;
});

await step('campus pass view', async () => {
  const cp = await (await fetch('https://api.bayleaf.dev/campus-pass')).json();
  if (!cp.campus_network) {
    await page.route('**/campus-pass', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ campus_network: true, enabled: true, quota: { remaining: 7, limit: 100, resets_at: new Date(Date.now() + 3600e3).toISOString(), scope: 'network_address', approximate: true } }) }));
  }
  log('campus-pass:', cp.campus_network ? 'real (on campus)' : 'mocked');
  page.dialogQueue.push(true);
  await page.click('#auth');
  await page.waitForFunction(() => document.querySelector('#auth').getAttribute('aria-label') === 'Sign in');
  await ensurePanel(page, 'usage');
  const t = await waitFor(async () => { const x = await page.textContent('#usage-body'); return /shared with everyone/.test(x) ? x : null; }, 15_000, 300) ?? '';
  const n = await usageNum(page);
  ok(n != null && /shared with everyone behind the same campus network address/.test(t) && /about \d+/.test(t), `Campus Pass view: about ${n} left, shared`);
  if (!cp.campus_network) ok(await page.$eval('#rail-usage', (b) => b.classList.contains('low')), 'below 10% the meter turns warning-colored');
  await page.screenshot({ path: SHOTS + 'desktop-campus.png' });
});

await step('desktop editor shot', async () => {
  await openSidebar(page, false);
  await ensurePanel(page, 'files');
  await page.click('#tree .row[data-path="/pouch"]'); await sleep(300);
  await page.click('#tree .row[data-path="/pouch/AGENTS.md"]'); await sleep(500);
  ok((await panel(page)) === 'editor' && (await width(page, '#chat')) >= 500, 'opening a file opens the Editor panel; chat stays >= 500');
  await page.screenshot({ path: SHOTS + 'desktop-editor.png' });
  await page.click('#to-files'); await sleep(200);
  ok((await panel(page)) === 'files', 'editor back icon returns to Files');
});
log('desktop errors:', errors.filter((e) => !/401|429|Failed to load resource/.test(e)).slice(0, 8));
await ctx.close();

// ── Phone ──
await step('phone', async () => {
  const m = await launch({ mobile: true, fresh: true, userDataDir: '/tmp/pouch-qa/layout-mobile' });
  const mp = m.pages()[0] ?? await m.newPage();
  const me = instrument(mp, 'm ');
  await mp.goto(URL); await mp.waitForSelector('#badge.ok', { timeout: 60_000 }); await sleep(800);
  const over = () => mp.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok((await panel(mp)) === '' && (await over()) <= 0, 'phone starts on the chat, no overflow');
  await mp.screenshot({ path: SHOTS + 'mobile-chat.png' });
  const railBox = await mp.$eval('#rail', (r) => { const b = r.getBoundingClientRect(); return [b.top, b.bottom, b.width]; });
  ok(Math.round(railBox[1]) === 844 && railBox[2] === 390, 'rail is a bottom bar: ' + railBox.map(Math.round));
  await mp.click('#flipper'); await sleep(400);
  const drawer = await mp.$eval('#sidebar', (s) => { const b = s.getBoundingClientRect(); return [b.left, b.width, getComputedStyle(s).visibility]; });
  ok(drawer[0] === 0 && drawer[1] > 250 && drawer[2] === 'visible' && await mp.isVisible('#backdrop'), 'drawer slides over with a backdrop: ' + drawer);
  await mp.screenshot({ path: SHOTS + 'mobile-drawer.png' });
  await mp.mouse.click(370, 420); await sleep(400);
  ok(!(await sideOpen(mp)) && !(await mp.isVisible('#backdrop')), 'backdrop tap closes the drawer');
  for (const p of ['files', 'editor', 'usage']) {
    await mp.click(`#rail button[data-panel=${p}]`); await sleep(300);
    const b = await mp.$eval('#panel-host', (h) => { const r = h.getBoundingClientRect(); return [r.left, r.top, r.width]; });
    ok(b[0] === 0 && b[1] === 0 && b[2] === 390 && (await over()) <= 0, `${p}: full-screen sheet, no overflow`);
    await mp.screenshot({ path: SHOTS + `mobile-${p}.png` });
  }
  const sizes = await mp.$$eval('#topbar button, #topbar select, #rail button, .panel .bar button', (bs) => bs.filter((b) => b.offsetParent)
    .map((b) => [b.ariaLabel || b.id, Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]));
  const small = sizes.filter(([, w, h]) => w < 44 || h < 44);
  ok(!small.length, '44px targets' + (small.length ? ': ' + JSON.stringify(small) : ` (${sizes.length} checked)`));
  await mp.click('#rail button[data-panel=chat]'); await sleep(200);
  ok((await panel(mp)) === '', 'Chat in the bottom bar closes the sheet');
  await mp.click('#more'); await mp.waitForSelector('#sheet[open]');
  const labels = await mp.$$eval('#sheet-actions button', (b) => b.map((x) => x.textContent));
  ok(labels.some((l) => /Erase all/.test(l)) && labels.some((l) => /What can BayLeaf see/.test(l)), 'More holds Trust and Erase all');
  await mp.keyboard.press('Escape');
  log('mobile errors:', me.filter((e) => !/401|Failed to load resource/.test(e)).slice(0, 5));
  await m.close();
});

const failed = results.filter(([c]) => !c);
log(`\nreal model requests: ${real}`);
log(`${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
