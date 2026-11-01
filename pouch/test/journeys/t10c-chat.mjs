// Pass 3: message bubbles (D1 look), message toolbar (D11), revert to here with file undo (D12).
import { launch, instrument, sheetClick, sleep, URL, newSession, currentSession, sessionMenu, waitSignedIn, ensurePanel, showChat } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const PROFILE = '/tmp/pouch-qa/p3-chat';
const SHOTS = '/tmp/pouch-qa/shots';
const log = (...a) => console.log(...a.map((x) => typeof x === 'string' && KEY ? x.replaceAll(KEY, '[key]') : x));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); log(c ? 'PASS' : 'FAIL', m); };
let requests = 0;
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ALPHA = 'ALPHA' + rnd(), BRAVO = 'BRAVO' + rnd(), CHARLIE = 'CHARLIE' + rnd(), FILE = `notes-${rnd().toLowerCase()}.txt`;

async function idle(page, timeout = 180_000) {
  const t = Date.now();
  await sleep(800);
  while (Date.now() - t < timeout) {
    if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return;
    await sleep(500);
  }
  throw new Error('never idle');
}
async function say(page, text, n = 1) { await page.fill('#input', text); await page.click('#send'); requests += n; await idle(page); await sleep(800); }
const readWork = (page, name) => page.evaluate(async (n) => {
  try { const d = await navigator.storage.getDirectory(); return await (await (await d.getFileHandle(n)).getFile()).text(); } catch { return null; }
}, name);
const scan = (page, marker) => page.evaluate(async (marker) => {
  const dbs = await indexedDB.databases();
  const hits = [];
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const dec = new TextDecoder();
  const rep = (k, v) => v instanceof Uint8Array ? dec.decode(v) : v instanceof ArrayBuffer ? dec.decode(new Uint8Array(v)) : v;
  for (const { name } of dbs) {
    const db = await req(indexedDB.open(name));
    for (const st of db.objectStoreNames) {
      const s = db.transaction(st).objectStore(st);
      const text = JSON.stringify([await req(s.getAllKeys()), await req(s.getAll())], rep);
      if (text.includes(marker)) hits.push(`${name}/${st}`);
    }
    db.close();
  }
  return { names: dbs.map((d) => d.name), hits };
}, marker);
const texts = (page, sel) => page.$$eval(sel, (b) => b.map((x) => x.textContent));
const style = (page, sel, props) => page.$eval(sel, (e, props) => { const c = getComputedStyle(e); return Object.fromEntries(props.map((p) => [p, c[p]])); }, props);
const barVis = (page, sel) => page.$eval(sel, (m) => getComputedStyle(m.querySelector('.msg-bar')).visibility);

// ── Desktop ──
let ctx = await launch({ userDataDir: PROFILE, fresh: true });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(URL).origin });
let page = ctx.pages()[0] ?? await ctx.newPage();
let errors = instrument(page);
await page.goto(URL);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
await page.click('#auth'); page.dialogQueue.push(KEY); await sheetClick(page, 'Paste a key'); await waitSignedIn(page);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
if (await page.isVisible('#welcome')) await page.click('#welcome button:has-text("Got it")').catch(() => {});
await newSession(page); await sleep(500);
const sid = await currentSession(page);

await say(page, `Remember the code word ${ALPHA}. Without using tools, reply in markdown: one sentence with the word **noted** in bold, then a fenced code block containing x = 1.`, 2);
await say(page, `Use the write tool to create /work/${FILE} containing exactly the line ${BRAVO}. Then reply with one word: written.`, 2);
await say(page, `Use the edit tool on /work/${FILE} to replace ${BRAVO} with ${CHARLIE}. Then reply with one word: edited.`, 2);
ok(await readWork(page, FILE) === CHARLIE || (await readWork(page, FILE))?.trim() === CHARLIE, `file holds ${CHARLIE} after turn 3`);
ok((await page.$$('.msg.user')).length === 3, '3 user messages');

// Styles: user bubble, assistant text, tool pill.
const u = await style(page, '.msg.user .body', ['backgroundColor', 'borderTopLeftRadius', 'maxWidth', 'width']);
const uBox = await page.$eval('.msg.user .body', (b) => { const r = b.getBoundingClientRect(), l = document.querySelector('#log').getBoundingClientRect(); return { right: l.right - r.right, left: r.left - l.left, w: r.width, lw: l.width }; });
const a = await style(page, '.msg.assistant .body.md', ['backgroundColor', 'borderTopLeftRadius']);
const t = await style(page, 'details.tool', ['backgroundColor', 'borderTopLeftRadius', 'fontSize']);
const aSize = await style(page, '.msg.assistant .body.md', ['fontSize']);
log('styles', JSON.stringify({ u, uBox, a, t, aSize }));
ok(u.backgroundColor !== 'rgba(0, 0, 0, 0)' && parseFloat(u.borderTopLeftRadius) >= 12, 'user message is a tinted rounded bubble');
ok(uBox.right < uBox.left && uBox.w <= uBox.lw * 0.82, 'user bubble is right-aligned and at most ~80% wide');
ok(a.backgroundColor === 'rgba(0, 0, 0, 0)', 'assistant reply has no bubble background');
ok(parseFloat(t.borderTopLeftRadius) > 50 && t.backgroundColor !== u.backgroundColor && parseFloat(t.fontSize) < parseFloat(aSize.fontSize), 'tool call is a smaller pill in another tone');
ok(!(await page.$('.msg .who')), 'no You/Pouch labels');

// Toolbar: hidden at rest, shown on hover with no height change, on keyboard focus.
await page.mouse.move(5, 5);
const first = '.msg.user >> nth=0';
const h0 = await page.locator(first).evaluate((m) => m.getBoundingClientRect().height);
ok(await page.locator(first).evaluate((m) => getComputedStyle(m.querySelector('.msg-bar')).visibility) === 'hidden', 'toolbar hidden at rest');
await page.locator(first).hover();
ok(await page.locator(first).evaluate((m) => getComputedStyle(m.querySelector('.msg-bar')).visibility) === 'visible', 'toolbar visible on hover');
const h1 = await page.locator(first).evaluate((m) => m.getBoundingClientRect().height);
ok(h0 === h1, `toolbar space reserved (height ${h0} -> ${h1})`);
ok(/\d/.test(await page.locator(first).locator('.msg-bar time').textContent()) && !!(await page.locator(first).locator('.msg-bar time').getAttribute('title')), 'toolbar shows a time with a full timestamp title');
await page.screenshot({ path: `${SHOTS}/chat-desktop-hover.png` });
await page.mouse.move(5, 5);
await page.locator('.msg.assistant >> nth=0').focus();
await page.keyboard.press('Shift+Tab'); // keyboard modality: the user message before it
const focusInfo = await page.evaluate(() => { const m = document.activeElement; return { isMsg: m.classList.contains('msg'), ring: getComputedStyle(m).boxShadow, vis: getComputedStyle(m.querySelector('.msg-bar')).visibility }; });
ok(focusInfo.isMsg && focusInfo.ring !== 'none' && focusInfo.vis === 'visible', `keyboard focus: ring and toolbar (${JSON.stringify(focusInfo)})`);
await page.keyboard.press('Tab');
ok(await page.evaluate(() => document.activeElement.dataset.act === 'copy'), 'Tab reaches Copy');
await page.screenshot({ path: `${SHOTS}/chat-desktop-focus.png` });

// Copy.
await page.locator(first).hover(); await page.locator(first).locator('[data-act="copy"]').click();
const userText = (await texts(page, '.msg.user .body'))[0];
ok(await page.evaluate(() => navigator.clipboard.readText()) === userText, 'Copy on a user message copies its text');
const a0 = page.locator('.msg.assistant >> nth=0');
await a0.hover(); await a0.locator('[data-act="copy"]').click();
const clip = await page.evaluate(() => navigator.clipboard.readText());
ok(/```|\*\*/.test(clip) && !/```/.test(await a0.locator('.body').textContent()), `assistant Copy is the markdown source (${JSON.stringify(clip.slice(0, 60))})`);

// Revert to after turn 1 (its last reply).
const turn1Reply = page.locator('.msg.assistant').filter({ hasText: /noted/i }).last();
await turn1Reply.hover(); await turn1Reply.locator('[data-act="revert"]').click();
await page.waitForSelector('#sheet[open]');
const sheetText = await page.textContent('#sheet-body');
log('sheet:', sheetText.replace(/\s+/g, ' ').slice(0, 300));
ok(await page.isChecked('#revert-files') && sheetText.includes(FILE) && /Also undo changes to 1 file/.test(sheetText), 'confirm sheet: checked file-undo box listing the file');
ok(/later messages? leave/.test(sheetText), 'confirm sheet counts later messages');
await page.screenshot({ path: `${SHOTS}/chat-revert-sheet.png` });
await sheetClick(page, 'Revert');
await page.waitForSelector('.notice.reverted');
await sleep(800);
ok((await page.$$('.msg.user')).length === 1, 'later user messages gone after revert');
ok(!(await page.textContent('#log')).includes(FILE), 'no later tool calls or change blocks visible');
ok(await readWork(page, FILE) === null, 'file back to before turn 2 (absent)');
await page.screenshot({ path: `${SHOTS}/chat-reverted.png` });

// The model must not see reverted turns.
await say(page, 'What did I ask you in my previous messages? Quote any code words or file names exactly. No tools.', 1);
const reply = (await texts(page, '.msg.assistant .body')).at(-1) ?? '';
log('recall reply:', reply.slice(0, 300));
ok(reply.includes(ALPHA), 'model still sees turn 1');
ok(!reply.includes(BRAVO) && !reply.includes(CHARLIE) && !reply.includes(FILE), 'model does not mention turn 2/3 content');
ok(await page.isVisible('.notice.reverted'), 'Undo notice still available after a new turn');

// Undo the revert (from the session menu this time).
await sessionMenu(page, sid);
const menuLabels = await texts(page, '#sheet-actions button');
ok(menuLabels.some((l) => /^Undo revert to/.test(l)), 'session menu offers Undo revert');
page.dialogQueue.push(true); // "messages you sent since leave the view"
await sheetClick(page, 'Undo revert');
await page.waitForFunction(() => document.querySelectorAll('.msg.user').length === 3, null, { timeout: 15_000 }).catch(() => {});
await sleep(800);
const us = await texts(page, '.msg.user .body');
ok(us.length === 3 && us[1].includes(BRAVO) && us[2].includes(CHARLIE), 'transcript restored');
ok((await readWork(page, FILE))?.trim() === CHARLIE, 'file restored to its state before the revert');
ok(!(await page.$('.notice.reverted')), 'notice gone after undo');
ok((await page.textContent('#log')).includes(FILE), 'change blocks back');
log('dialogs', page.dialogLog);
ok(!page.dialogLog.some((d) => /changed again/.test(d)), 'no false "changed again" warning when turns 2 and 3 are undone together');
await page.screenshot({ path: `${SHOTS}/chat-undone.png` });
await ctx.close();

// ── Mobile, same profile ──
ctx = await launch({ userDataDir: PROFILE, mobile: true });
page = ctx.pages()[0] ?? await ctx.newPage();
errors.push(...instrument(page, 'm'));
await page.goto(URL);
await page.waitForSelector('.msg.user', { timeout: 30_000 }); await sleep(1500);
const mm = page.locator('.msg.assistant').filter({ hasText: /noted/i }).last();
// D23: a turn's final reply has the turn footer: meta always visible, actions shown on tap.
const acts = (m) => getComputedStyle(m.querySelector('.msg-bar .acts') ?? m.querySelector('.msg-bar')).visibility;
ok(await mm.evaluate(acts) === 'hidden', 'mobile: toolbar actions hidden at rest');
await mm.locator('.body').tap();
ok(await mm.evaluate(acts) === 'visible', 'mobile: tap shows toolbar');
const sizes = await mm.locator('.msg-bar button').evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }));
ok([2, 3].includes(sizes.length) && sizes.every(([w, h]) => w >= 44 && h >= 44), `mobile: 44px toolbar targets (${JSON.stringify(sizes)})`);
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#log').scrollWidth <= document.querySelector('#log').clientWidth), 'mobile: no horizontal overflow');
await page.screenshot({ path: `${SHOTS}/chat-mobile-tap.png` });
await page.locator('.msg.user >> nth=0').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/chat-mobile-top.png` });
await ctx.close();

// ── Delete: every fork goes with the session database ──
ctx = await launch({ userDataDir: PROFILE });
page = ctx.pages()[0] ?? await ctx.newPage();
errors.push(...instrument(page, 'd'));
await page.goto(URL);
await page.waitForSelector('.msg.user', { timeout: 30_000 }); await sleep(1000);
// Revert again so a fork and a revert token (with file bytes) exist at delete time.
const r2 = page.locator('.msg.assistant').filter({ hasText: /noted/i }).last();
await r2.hover(); await r2.locator('[data-act="revert"]').click();
await page.waitForSelector('#sheet[open]'); await sheetClick(page, 'Revert');
await page.waitForSelector('.notice.reverted');
const before = await scan(page, CHARLIE);
log('before delete', JSON.stringify(before.hits));
await sessionMenu(page, sid);
page.dialogQueue.push(true);
await sheetClick(page, 'Delete session');
await sleep(1500);
for (const m of [ALPHA, BRAVO, CHARLIE]) {
  const s = await scan(page, m);
  ok(s.hits.length === 0, `after delete, ${m.slice(0, 5)} marker in no store (${s.hits})`);
}
ok(!(await scan(page, 'p-')).names.some((n) => n.includes(sid)), 'session database gone');
await ctx.close();

ok(errors.filter((e) => !/favicon|net::ERR/.test(e)).length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
log(`model requests (approx): ${requests}`);
const fails = results.filter(([c]) => !c);
log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
