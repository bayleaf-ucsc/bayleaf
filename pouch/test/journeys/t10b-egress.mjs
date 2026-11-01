// Pass 2: D10 egress approvals, grants, badge. POUCH_URL = the build under test.
// Real web searches: at most 3 (the mobile one is fulfilled with a fake body).
import { launch, instrument, sheetClick, sleep, URL, newSession, currentSession, pickSession, sessionMenu, waitSignedIn, ensurePanel, openSidebar } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const DIR = '/tmp/pouch-qa/p2-egress';
const SHOTS = '/tmp/pouch-qa/shots/';
const log = (...a) => console.log(...a.map((x) => typeof x === 'string' && KEY ? x.replaceAll(KEY, '[key]') : x));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); log(c ? 'PASS' : 'FAIL', m); };
let searches = 0, real = 0, modelReqs = 0, fake = false;

async function wire(ctx) {
  await ctx.route('https://api.bayleaf.dev/**', (r) => {
    const u = r.request().url();
    if (u.includes('/web/')) {
      searches++;
      if (fake) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ results: [{ title: 'Fake result', url: 'https://example.com/', snippet: 'fulfilled by the test' }] }) });
      real++;
    }
    if (/chat\/completions/.test(u) && r.request().method() === 'POST') modelReqs++;
    return r.continue();
  });
}
async function idle(page, timeout = 180_000) {
  const t = Date.now();
  await sleep(800);
  while (Date.now() - t < timeout) {
    if (!(await page.$('#egress[open]')) && (await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return;
    await sleep(500);
  }
  throw new Error('never idle');
}
const ASK = (script) => `Do not read any skill or file. Make exactly one bash tool call with exactly this script, then reply with only the word done:\n\n${script}`;
async function send(page, text) { await page.fill('#input', text); await page.click('#send'); }
async function prompt(page, timeout = 120_000) {
  await page.waitForSelector('#egress[open]', { timeout });
  await sleep(200);
  return page.evaluate(() => ({
    summary: document.querySelector('#egress-summary').textContent,
    detail: document.querySelector('#egress-detail').textContent,
    audiences: [...document.querySelectorAll('#egress-audiences li')].map((l) => l.textContent),
    focus: document.activeElement?.id,
  }));
}
async function closed(page) { await page.waitForFunction(() => !document.querySelector('#egress').open); await sleep(300); }
const countOpens = (page) => page.evaluate(() => {
  window.__opens = 0;
  const d = document.querySelector('#egress');
  new MutationObserver(() => { if (d.open) window.__opens++; }).observe(d, { attributes: true, attributeFilter: ['open'] });
});
const bashCards = (page) => page.$$eval('details.tool', (ds) => ds.map((d) => ({
  summary: d.querySelector('summary').textContent,
  badge: d.querySelector('summary .egress')?.title ?? null,
  text: d.textContent,
})));
async function ready(page) { await page.waitForSelector('#badge.ok', { timeout: 60_000 }); await sleep(1500); }

// ── Desktop ─────────────────────────────────────────────────────────
let ctx = await launch({ userDataDir: DIR, fresh: true });
await wire(ctx);
let page = ctx.pages()[0] ?? await ctx.newPage();
let errors = instrument(page, 'd:');
await page.goto(URL);
await ready(page);
await page.click('#auth'); page.dialogQueue.push(KEY); await sheetClick(page, 'Paste a key'); await waitSignedIn(page);
await ready(page);
ok(await page.locator('#trust').evaluate((t) => t.textContent.includes('The bayleaf command can send data outside the pouch; Pouch asks you every time.')), 'Trust panel states the bayleaf egress rule');
await countOpens(page);
await ensurePanel(page, 'files'); // the sheet must show over an open panel

await send(page, ASK('bayleaf web search -n 1 pouch alpha denied; bayleaf web search -n 1 banana slug mascot; bayleaf web search -n 1 monterey bay aquarium; bayleaf web search -n 1 santa cruz boardwalk'));
let p = await prompt(page);
ok(p.focus === 'egress-deny', `Deny has initial focus (${p.focus})`);
ok(p.summary.includes('pouch alpha denied') && p.detail.includes('max_results: 1') && p.audiences.some((a) => a.includes('Tavily')), 'sheet shows summary, exact detail, audiences');
ok(await page.evaluate(() => { const r = document.querySelector('#egress').getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + 20); return !!e?.closest('#egress'); }), 'sheet is on top of the open Files panel');
await page.screenshot({ path: SHOTS + 'egress-desktop-sheet.png' });
await page.click('#egress-deny'); await closed(page);
p = await prompt(page);
ok(searches === 0, `Deny sent nothing (web requests: ${searches})`);
ok(p.summary.includes('banana slug'), 'second request prompts separately (queued one at a time)');
await page.click('#egress-once'); await closed(page);
p = await prompt(page);
ok(searches === 1, `Allow once sent exactly one request (${searches})`);
await page.click('#egress-session'); await closed(page);
await idle(page);
ok(searches === 3, `Allow for this session: third and fourth searches sent (${searches})`);
ok((await page.evaluate(() => window.__opens)) === 3, `fourth search did not prompt (sheets opened: ${await page.evaluate(() => window.__opens)})`);
const sidA = await currentSession(page);
let cards = (await bashCards(page)).filter((c) => c.summary.includes('bayleaf web search'));
const card = cards.at(-1);
ok(card && card.text.includes('denied by the user (nothing was sent)'), 'tool output says the first was denied');
ok(card?.badge && card.badge.includes('Tavily'), `badge with audiences in title: ${JSON.stringify(card?.badge)}`);
ok(card && !card.text.includes('[this call sent data outside the pouch'), 'raw marker line hidden');
await page.evaluate(() => document.querySelector('details.tool:has(summary .egress)')?.setAttribute('open', ''));
await page.locator('details.tool:has(summary .egress)').last().scrollIntoViewIfNeeded();
await page.screenshot({ path: SHOTS + 'egress-desktop-badge.png' });

await page.reload(); await ready(page);
cards = (await bashCards(page)).filter((c) => c.summary.includes('bayleaf web search'));
ok(cards.at(-1)?.badge?.includes('Tavily') && !cards.at(-1).text.includes('[this call sent data outside the pouch'), 'badge survives reload, marker still hidden');
await sessionMenu(page, sidA);
ok(await page.locator('#sheet-actions button', { hasText: 'Stop allowing web search and fetch' }).count() === 1, 'session menu lists the active grant');
await page.keyboard.press('Escape'); await sleep(300);
await openSidebar(page, false);

// New session: prompts again; Esc means deny.
await newSession(page); await sleep(500);
await countOpens(page);
await send(page, ASK('bayleaf web search -n 1 pouch beta new session'));
p = await prompt(page);
ok(p.summary.includes('pouch beta'), 'a new session prompts again');
await page.keyboard.press('Escape'); await closed(page);
await idle(page);
ok(searches === 3, `Esc sent nothing (${searches})`);
cards = await bashCards(page);
ok(cards.some((c) => c.text.includes('denied by the user')) && !cards.some((c) => c.badge), 'denied card: no badge, output says denied');
ok(errors.length === 0, 'no console errors (desktop): ' + errors.slice(0, 3).join(' | '));
await ctx.close();

// ── Phone, same profile: revoke the grant in session A, then it prompts ──
ctx = await launch({ userDataDir: DIR, mobile: true });
await wire(ctx);
page = ctx.pages()[0] ?? await ctx.newPage();
errors = instrument(page, 'm:');
await page.goto(URL); await ready(page);
await pickSession(page, sidA); await sleep(800);
await sessionMenu(page, sidA);
await sheetClick(page, 'Stop allowing web search and fetch'); await sleep(500);
await openSidebar(page, false);
fake = true;
await countOpens(page);
await send(page, ASK('bayleaf web search -n 1 pouch gamma after revoke'));
p = await prompt(page);
ok(p.summary.includes('pouch gamma'), 'revoked grant: prompts again');
const m = await page.evaluate(() => {
  const d = document.querySelector('#egress'), r = d.getBoundingClientRect();
  const btns = [...d.querySelectorAll('menu button')].map((b) => { const q = b.getBoundingClientRect(); return { h: q.height, w: q.width, bottom: q.bottom }; });
  return { r: { l: r.left, t: r.top, w: r.width, h: r.height }, btns, vw: innerWidth, vh: innerHeight, docW: document.documentElement.scrollWidth, dW: d.scrollWidth, dCW: d.clientWidth };
});
log(JSON.stringify(m));
ok(m.r.l === 0 && m.r.t === 0 && Math.round(m.r.w) === m.vw && Math.round(m.r.h) === m.vh, 'phone: sheet is full-screen');
ok(m.btns.length === 3 && m.btns.every((b) => b.h >= 44 && b.w >= 44), 'phone: buttons are >= 44px');
ok(m.btns.every((b) => b.bottom <= m.vh), 'phone: buttons are on screen without scrolling');
ok(m.docW <= m.vw && m.dW <= m.dCW, `phone: no horizontal overflow (doc ${m.docW}, sheet ${m.dW}/${m.dCW})`);
await page.screenshot({ path: SHOTS + 'egress-mobile-sheet.png' });
await page.click('#egress-session'); await closed(page);
await idle(page);
ok(searches === 4 && real === 3, `phone allow sent one (fake) request (web ${searches}, real ${real})`);
await page.locator('details.tool:has(summary .egress)').last().scrollIntoViewIfNeeded();
await page.locator('details.tool:has(summary .egress) summary').last().click(); await sleep(300);
const pw = await page.evaluate(() => document.documentElement.scrollWidth);
ok(pw <= 390, `phone chat: no horizontal overflow (${pw})`);
await page.screenshot({ path: SHOTS + 'egress-mobile-badge.png' });

// Deleting the session deletes its grant.
const hasGrant = () => page.evaluate(async (sid) => {
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  for (const { name } of await indexedDB.databases()) {
    const db = await req(indexedDB.open(name));
    for (const st of db.objectStoreNames) if ((await req(db.transaction(st).objectStore(st).getAllKeys())).map(String).includes('egressGrants:' + sid)) { db.close(); return true; }
    db.close();
  }
  return false;
}, sidA);
ok(await hasGrant(), 'grant stored for session A');
await sessionMenu(page, sidA);
page.dialogQueue.push(true);
await sheetClick(page, 'Delete session'); await sleep(1500);
ok(!(await hasGrant()), 'deleting the session deleted its grant');
ok(errors.length === 0, 'no console errors (phone): ' + errors.slice(0, 3).join(' | '));
await ctx.close();

log(`model requests ${modelReqs}, web requests ${searches} (real ${real})`);
const fails = results.filter(([c]) => !c);
log(`${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
