import { launch, instrument, rows, rowMore, sheetClick, waitRow, sleep, URL, newSession, currentSession, sessionIds, pickSession, sessionMenu, waitSignedIn, authLabel, ensurePanel, showChat, openSidebar } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const log = (...a) => console.log(...a);
const ok = (c, m) => log(c ? 'PASS' : 'FAIL', m);

async function idle(page, timeout = 180_000) {
  const t = Date.now();
  await sleep(800);
  while (Date.now() - t < timeout) {
    if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return;
    await sleep(500);
  }
  throw new Error('never idle');
}
const lastReply = (page) => page.$$eval('.msg.assistant .body', (b) => b.at(-1)?.textContent ?? '');
async function say(page, text) {
  await page.fill('#input', text);
  await page.click('#send');
  await idle(page);
}

const ctx = await launch({ fresh: true });
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = instrument(page);
await page.goto(URL);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });

// sign in by pasting a key
await page.click('#auth');
page.dialogQueue.push(KEY);
await sheetClick(page, 'Paste a key');
await waitSignedIn(page);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
ok(true, 'signed in with pasted key');

// /work/AGENTS.md through the UI
await rowMore(page, '/work');
page.dialogQueue.push('AGENTS.md');
await sheetClick(page, 'New file here');
await page.waitForSelector('.cm-content');
await page.click('.cm-content');
await page.keyboard.type('Always end every reply with the word PINEAPPLE.');
await page.keyboard.press('ControlOrMeta+s');
await page.waitForFunction(() => document.querySelector('#save').disabled);
await sleep(300);

// session A
await newSession(page);
await sleep(500);
await say(page, 'Without using tools: which skills are listed for you? Reply in one short line.');
const a = await lastReply(page); await sleep(0);
log('A reply:', a.slice(0, 200));
ok(/PINEAPPLE/.test(a), 'obeys /work/AGENTS.md');
ok(/pouch-environment|skill-authoring/.test(a), 'sees skills');
const aId = await currentSession(page);

// session B
await newSession(page);
await sleep(500);
await say(page, 'Reply with exactly: banana split');
const bId = await currentSession(page);
ok(aId !== bId, 'B is a different session');

// rapid switching: the last selection must win
await openSidebar(page);
for (const id of [aId, bId, aId, bId, aId]) { await page.click(`#session-list .session[data-id="${id}"] .s-open`); await sleep(30); }
await sleep(2500);
let text = await page.textContent('#log');
ok(/which skills/.test(text) && !/banana split/.test(text), 'rapid switch lands on A only');
await pickSession(page, bId); await sleep(1500);
text = await page.textContent('#log');
ok(/banana/.test(text) && !/which skills/.test(text), 'switch to B shows B only');
await pickSession(page, aId); await sleep(1000);

// reload restores the last selected session
await page.reload();
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
await sleep(1500);
ok((await currentSession(page)) === aId, 'reload restores last selected session');
ok(/which skills/.test(await page.textContent('#log')), 'reload restores transcript');

// compact via session menu
await sessionMenu(page);
await sheetClick(page, 'Compact now');
await page.waitForFunction(() => !/Compacting/.test(document.querySelector('#status').textContent), null, { timeout: 120_000 });
log('compact status:', await page.textContent('#status'));
ok(!page.isClosed(), 'page alive after compact');

// rename (in place: the sheet's Rename turns the row into a field)
await sessionMenu(page);
await sheetClick(page, 'Rename');
await page.fill('#session-list .title-input', 'Renamed A');
await page.keyboard.press('Enter');
await sleep(400);
ok((await page.textContent('#session-list .session[aria-current="true"] .s-title')) === 'Renamed A' && (await page.textContent('#title')) === 'Renamed A', 'rename');

// second tab
const p2 = await ctx.newPage();
const e2 = instrument(p2, 'tab2 ');
await p2.goto(URL);
await sleep(4000);
log('tab2 status:', await p2.textContent('#status'), '| log:', (await p2.textContent('#log')).slice(0, 120));
ok(/another tab/.test((await p2.textContent('#status')) + (await p2.textContent('#log'))), 'second tab explains lock');
ok((await rows(p2)).includes('/work/AGENTS.md') || (await p2.textContent('#tree')).includes('work'), 'second tab files work');
await p2.close();
await page.bringToFront();

// delete session B
await pickSession(page, bId); await sleep(800);
await sessionMenu(page, bId);
page.dialogQueue.push(true);
await sheetClick(page, 'Delete session');
await sleep(1500);
const opts = await sessionIds(page);
ok(!opts.includes(bId) && opts.includes(aId), 'delete session');

// erase all
page.dialogQueue.push(true);
await page.click('#erase');
await page.waitForLoadState('load');
await page.waitForSelector('#badge', { timeout: 60_000 });
await sleep(3000);
const after = await sessionIds(page);
ok(after.length === 0, 'erase: no sessions');
ok((await authLabel(page)) === 'Sign in', 'erase: key forgotten');
await ensurePanel(page, 'files');
await page.click('#tree .row:has(.name[title="/pouch"])');
await waitRow(page, '/pouch/AGENTS.md');
ok(!(await rows(page)).includes('/work/AGENTS.md'), 'erase: /work emptied, /pouch reseeded');
log('errors:', errors.filter((e) => !/401|Failed to load resource/.test(e)));
await ctx.close();

// mobile
const m = await launch({ mobile: true, fresh: true });
const mp = m.pages()[0] ?? await m.newPage();
const me = instrument(mp, 'm ');
await mp.goto(URL);
await mp.waitForSelector('#badge', { timeout: 60_000 });
await sleep(2000);
for (const tab of ['files', 'editor', 'usage', 'chat']) {
  await mp.click(`#rail button[data-panel=${tab}]`);
  await sleep(300);
  const over = await mp.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
  ok(over <= 0, `mobile ${tab}: no horizontal overflow (${over})`);
  await mp.screenshot({ path: `/tmp/pouch-qa/shots/mobile-${tab}.png` });
}
await mp.click('#rail button[data-panel=chat]');
await mp.fill('#input', 'line one');
await mp.focus('#input');
await mp.keyboard.press('Enter');
ok((await mp.inputValue('#input')).includes('\n'), 'mobile Enter inserts newline');
const sizes = await mp.$$eval('#topbar button, #topbar select, #rail button, .bar button', (bs) => bs.filter((b) => b.offsetParent).map((b) => [b.ariaLabel || b.textContent.trim(), Math.round(b.getBoundingClientRect().height), Math.round(b.getBoundingClientRect().width)]));
log('mobile tap sizes:', JSON.stringify(sizes));
ok(sizes.every(([, h, w]) => h >= 44 && w >= 44), 'mobile: visible top-bar, rail and bar targets >= 44px');
log('mobile errors:', me.filter((e) => !/401|Failed to load resource/.test(e)));
await m.close();
