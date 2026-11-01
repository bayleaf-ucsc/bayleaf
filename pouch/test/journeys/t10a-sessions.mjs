// Pass 1: sessions split, L2 erasure, Shift quick delete, legacy migration.
// Serves /tmp/pouch-qa/serve on POUCH_URL; OLD_HTML is swapped in first to
// make a legacy (shared-database) session on the same origin.
import { copyFileSync } from 'node:fs';
import { launch, instrument, sheetClick, sleep, URL, newSession, currentSession, sessionIds, pickSession, sessionMenu, waitSignedIn, openSidebar } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const SERVE = '/tmp/pouch-qa/serve/pouch.html';
const OLD = process.env.OLD_HTML, NEW = process.env.NEW_HTML;
const log = (...a) => console.log(...a.map((x) => typeof x === 'string' && KEY ? x.replaceAll(KEY, '[key]') : x));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); log(c ? 'PASS' : 'FAIL', m); };
let requests = 0;
const rnd = () => Math.random().toString(36).slice(2, 10).toUpperCase();

async function idle(page, timeout = 180_000) {
  const t = Date.now();
  await sleep(800);
  while (Date.now() - t < timeout) {
    if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return;
    await sleep(500);
  }
  throw new Error('never idle');
}
async function say(page, text, named = true) {
  await page.fill('#input', text);
  await page.click('#send');
  requests += named ? 2 : 1; // the first turn also asks for a title
  await idle(page);
  await sleep(named ? 2500 : 500); // let the auto-name settle
}
async function signIn(page) {
  await page.goto(URL);
  await page.waitForSelector('#badge.ok', { timeout: 60_000 });
  await page.click('#auth');
  page.dialogQueue.push(KEY);
  await sheetClick(page, 'Paste a key');
  await waitSignedIn(page);
  await page.waitForSelector('#badge.ok', { timeout: 60_000 });
}
async function ready(page) {
  await page.waitForSelector('#badge.ok', { timeout: 60_000 });
  await sleep(2000);
}

// Every value of every store of every database, searched for marker.
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

// ── Phase 0: a legacy session made by the old build on this origin ──
const LEG = 'LEGACY-' + rnd();
copyFileSync(OLD, SERVE);
{
  const ctx = await launch({ userDataDir: '/tmp/pouch-qa/p1-a', fresh: true });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  instrument(page);
  await signIn(page);
  await newSession(page); await sleep(500);
  await say(page, `Without tools, reply with exactly: noted ${LEG}`);
  const s = await scan(page, LEG);
  ok(s.hits.some((h) => h.startsWith('bayleaf-pouch-agent/')), `old build stored legacy marker in shared DB (${s.hits})`);
  await ctx.close();
}

// ── Phase 1: the new build ──
copyFileSync(NEW, SERVE);
const ctx = await launch({ userDataDir: '/tmp/pouch-qa/p1-a' });
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = instrument(page);
await page.goto(URL);
await ready(page);
const legacyId = await currentSession(page);
ok(/\bnoted\b/.test(await page.textContent('#log')) && (await page.textContent('#log')).includes(LEG), 'legacy session still readable');
await openSidebar(page);
ok(await page.isVisible(`#session-list .session[data-id="${legacyId}"] .s-legacy`), 'legacy row is marked');

// Two new sessions, one turn each.
const ZA = 'ZEBRA-' + rnd(), ZB = 'YAK-' + rnd();
await newSession(page); await sleep(500);
await say(page, `Without tools, reply with exactly: ok ${ZA}`);
const aId = await currentSession(page);
await newSession(page); await sleep(500);
await say(page, `Without tools, reply with exactly: ok ${ZB}`);
const bId = await currentSession(page);
ok(aId?.startsWith('p-') && bId?.startsWith('p-') && aId !== bId, `new sessions get own ids (${aId}, ${bId})`);
let s = await scan(page, ZA);
ok(s.hits.some((h) => h.startsWith(`bayleaf-pouch-agent-${aId}/`)), `A's transcript in its own DB (${s.hits})`);
ok(!s.hits.some((h) => h.startsWith('bayleaf-pouch-agent/')), 'A not in the legacy DB');
const titles = await page.$$eval('#session-list .s-title', (t) => t.map((x) => x.textContent));
log('titles:', JSON.stringify(titles));

// Switch and reload.
await pickSession(page, aId); await sleep(1200);
ok((await page.textContent('#log')).includes(ZA) && !(await page.textContent('#log')).includes(ZB), 'switch to A shows A');
await page.reload(); await ready(page);
ok((await currentSession(page)) === aId && (await page.textContent('#log')).includes(ZA), 'reload restores A');

// Shift quick delete of A: no confirm.
await openSidebar(page);
await page.keyboard.down('Shift');
await sleep(100);
ok(await page.isVisible(`#session-list .session[data-id="${aId}"] .s-trash`), 'Shift shows trash');
const before = page.dialogLog.length;
await page.click(`#session-list .session[data-id="${aId}"] .s-trash`);
await page.keyboard.up('Shift');
await sleep(1500);
ok(page.dialogLog.length === before, 'quick delete asked nothing');
ok(!(await page.isVisible('#session-list .s-trash')), 'Shift up hides trash');
ok(!(await sessionIds(page)).includes(aId), 'A gone from list');
s = await scan(page, ZA);
ok(s.hits.length === 0 && !s.names.includes(`bayleaf-pouch-agent-${aId}`), `ZEBRA marker erased (hits: ${s.hits}; dbs: ${s.names.length})`);
s = await scan(page, ZB);
ok(s.hits.length > 0, 'scanner control: YAK still found');
// blur clears Shift
await page.keyboard.down('Shift'); await sleep(50);
await page.evaluate(() => dispatchEvent(new Event('blur')));
await sleep(50);
ok(!(await page.isVisible('#session-list .s-trash')), 'blur clears quick delete');
await page.keyboard.up('Shift');

// Menu delete of the legacy session: confirm, then the legacy DB is dropped.
await sessionMenu(page, legacyId);
page.dialogQueue.push(true);
await sheetClick(page, 'Delete session');
await sleep(2000);
ok(/legacy|per-session storage/i.test(page.dialogLog.at(-1) ?? ''), `menu delete confirmed (${page.dialogLog.at(-1)?.slice(0, 60)})`);
s = await scan(page, LEG);
ok(s.hits.length === 0 && !s.names.includes('bayleaf-pouch-agent'), `legacy marker and DB gone (hits: ${s.hits})`);

// A third session deleted from the menu: also erased.
const ZC = 'KOALA-' + rnd();
await newSession(page); await sleep(500);
await say(page, `Without tools, reply with exactly: ok ${ZC}`, true);
const cId = await currentSession(page);
await sessionMenu(page, cId);
page.dialogQueue.push(true);
await sheetClick(page, 'Delete session');
await sleep(2000);
s = await scan(page, ZC);
ok(s.hits.length === 0, `KOALA marker erased after menu delete (hits: ${s.hits})`);
ok(JSON.stringify(await sessionIds(page)) === JSON.stringify([bId]), 'only B left');

// Remaining session works after reload.
await page.reload(); await ready(page);
ok((await currentSession(page)) === bId && (await page.textContent('#log')).includes(ZB), 'B restored after reload');
await say(page, 'Without tools, reply with exactly: still here', false);
ok(/still here/i.test(await page.$$eval('.msg.assistant .body', (b) => b.at(-1)?.textContent ?? '')), 'B answers after reload');

// Second tab: B's database is held here, so the other tab says why.
const p2 = await ctx.newPage();
instrument(p2, 'tab2 ');
await p2.goto(URL); await sleep(4000);
const t2 = (await p2.textContent('#status')) + ' ' + (await p2.textContent('#log'));
log('tab2:', t2.slice(0, 160));
ok(/another tab/.test(t2), 'second tab explains lock');
await p2.close();

// Erase all removes every database.
page.dialogQueue.push(true);
await page.click('#erase');
await page.waitForLoadState('load'); await sleep(3000);
s = await scan(page, ZB);
ok(s.hits.length === 0 && !s.names.some((n) => n.startsWith('bayleaf-pouch-agent')), `erase all: no agent DBs (${s.names})`);
log('errors:', errors.filter((e) => !/401|Failed to load resource/.test(e)));
log('model requests (est.):', requests);
await ctx.close();
log(`SUMMARY ${results.filter((r) => r[0]).length}/${results.length} pass`);
