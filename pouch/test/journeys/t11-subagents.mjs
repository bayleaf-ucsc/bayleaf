// Subagents (D15/D16) end to end against the real Sealed lane (glm-5-3).
// Budget: < 30 model requests, <= 3 real web searches (searches are faked here).
// Scenario 3 (cap, no nesting) is covered by test/subagents-node.mjs with a fake model.
import { launch, instrument, sleep, URL, newSession, currentSession, sessionMenu, sheetClick, waitSignedIn, pickSession } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const PROFILE = '/tmp/pouch-qa/sa-profile';
const SHOTS = '/tmp/pouch-qa/shots';
const log = (...a) => console.log(...a.map((x) => typeof x === 'string' && KEY ? x.replaceAll(KEY, '[key]') : x));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); log(c ? 'PASS' : 'FAIL', m); };
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ZA = 'ZEBRA' + rnd(), ZB = 'YAK' + rnd();
let modelReqs = 0, searches = 0;
const T0 = Date.now(), at = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

async function wire(ctx) {
  await ctx.route('https://api.bayleaf.dev/**', (r) => {
    const u = r.request().url();
    if (u.includes('/web/')) {
      searches++;
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ results: [{ title: 'Durable agents in the browser (fake result)', url: 'https://example.com/durable', snippet: 'fulfilled by the test' }] }) });
    }
    if (/chat\/completions/.test(u) && r.request().method() === 'POST') { modelReqs++; log(`  [req ${modelReqs} at ${at()}]`); }
    return r.continue();
  });
}
const parentIdle = async (page) => !(await page.$('#egress[open]')) && (await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'));
async function idle(page, timeout = 180_000) {
  const t = Date.now(); await sleep(800);
  while (Date.now() - t < timeout) { if (await parentIdle(page)) return; await sleep(400); }
  throw new Error('never idle');
}
async function waitFor(fn, timeout = 240_000, step = 500) {
  const t = Date.now();
  while (Date.now() - t < timeout) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}
const send = async (page, text) => { await page.fill('#input', text); await page.click('#send'); };
const card = (page, name) => page.locator(`.subagent:has(.sa-name:text-is("${name}"))`);
const cardStatus = (page, name) => card(page, name).locator('.sa-status').first().textContent().catch(() => null);
const reports = (page, name) => page.$$eval('.msg.report', (rs, n) => rs.filter((r) => r.querySelector('.sa-report-head')?.textContent.includes(`Subagent ${n} `)).map((r) => ({ head: r.querySelector('.sa-report-head').textContent, text: r.textContent })), name);
const readNested = (page, parts) => page.evaluate(async (parts) => {
  try { let d = await navigator.storage.getDirectory(); for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p); return await (await (await d.getFileHandle(parts.at(-1))).getFile()).text(); } catch { return null; }
}, parts);
const writeProj = (page, files) => page.evaluate(async (files) => {
  const root = await navigator.storage.getDirectory();
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/'); let d = root;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(text); await w.close();
  }
}, files);
const scan = (page, marker) => page.evaluate(async (marker) => {
  const dbs = await indexedDB.databases(); const hits = [];
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const dec = new TextDecoder();
  const rep = (k, v) => v instanceof Uint8Array ? dec.decode(v) : v instanceof ArrayBuffer ? dec.decode(new Uint8Array(v)) : v;
  for (const { name } of dbs) {
    const db = await req(indexedDB.open(name));
    for (const st of db.objectStoreNames) {
      const s = db.transaction(st).objectStore(st);
      if (JSON.stringify([await req(s.getAllKeys()), await req(s.getAll())], rep).includes(marker)) hits.push(`${name}/${st}`);
    }
    db.close();
  }
  return { names: dbs.map((d) => d.name), hits };
}, marker);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

let ctx = await launch({ userDataDir: PROFILE, fresh: true });
await wire(ctx);
let page = ctx.pages()[0] ?? await ctx.newPage();
let errors = instrument(page);
await page.goto(URL);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
await page.click('#auth'); page.dialogQueue.push(KEY); await sheetClick(page, 'Paste a key'); await waitSignedIn(page);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
if (await page.isVisible('#welcome')) await page.click('#welcome button:has-text("Got it")').catch(() => {});
await writeProj(page, {
  'proj/README.md': `# Ledger\nA tiny bookkeeping service. Internal codename ${ZA}.\n`,
  'proj/src/main.js': "import { route } from './api.js';\nimport { open } from './db.js';\nconst db = open('ledger.sqlite');\nexport function start() { return route(db); }\n",
  'proj/src/api.js': "export function route(db) {\n  return { get: (id) => db.find(id), post: (row) => db.insert(row) };\n}\n",
  'proj/src/db.js': "export function open(path) {\n  const rows = new Map();\n  return { find: (id) => rows.get(id), insert: (r) => rows.set(r.id, r) };\n}\n",
});

// ── 1 + 4. Background codebase exploration, then a reload while it runs ──
await newSession(page); await sleep(400);
const sidA = await currentSession(page);
const r0 = modelReqs;
await send(page, `Use the subagent tool (action spawn, background, name "explorer") with this task: "Explore /work/proj (list it, read each file under it), then write a short architecture summary to /work/.subagents/explorer.md and report the entry point." Meanwhile, in your reply, tell me one short joke. Do not wait for the subagent. (Codename for later: ${ZA}.)`);
const spawned = await waitFor(async () => (await page.$('.subagent')) && (await cardStatus(page, 'explorer')), 120_000, 300);
ok(spawned === 'running', `card shows running (${spawned}) at ${at()}`);
await idle(page);
const jokeAt = Date.now();
const stAtJoke = await cardStatus(page, 'explorer');
const lastReply = await page.$$eval('.msg.assistant .body', (b) => b.at(-1)?.textContent ?? '');
ok(stAtJoke === 'running', `parent answered (joke) while child still running (${stAtJoke}) at ${at()}: "${lastReply.slice(0, 90)}"`);
ok(await parentIdle(page), 'composer is Send (parent not busy) while child runs');
await page.screenshot({ path: `${SHOTS}/subagent-running.png` });
// Expand the live transcript.
await card(page, 'explorer').locator('.sa-log > summary').click();
await sleep(1500);
const items = await card(page, 'explorer').locator('.sa-items > *').count();
ok(items >= 1, `live transcript shows ${items} items`);
ok(await page.$eval('#session-list .session[aria-current="true"] .s-kids', (e) => e.textContent).catch(() => null) === '1', 'sidebar badge shows 1 running subagent');
// Reload mid-run (scenario 4).
const before = await cardStatus(page, 'explorer');
log(`reloading while explorer is ${before} at ${at()}`);
await page.reload();
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
await sleep(1500);
ok(await currentSession(page) === sidA, 'same session after reload');
const after = await cardStatus(page, 'explorer');
log(`after reload: ${after}`);
// A reload spends nothing by itself: the child is interrupted; Resume continues it.
ok(after === 'interrupted' || after === 'finished', `after reload explorer is interrupted (or had finished): ${after}`);
if (after === 'interrupted') await card(page, 'explorer').locator('button:has-text("Resume")').click();
const fin = await waitFor(async () => { const s = await cardStatus(page, 'explorer'); return s && s !== 'running' ? s : null; }, 300_000, 1000);
ok(fin === 'finished', `explorer settled after reload: ${fin} at ${at()}`);
const reps = await waitFor(async () => { const r = await reports(page, 'explorer'); return r.length ? r : null; }, 60_000);
await idle(page);
await sleep(3000);
const reps2 = await reports(page, 'explorer');
ok(reps2.filter((r) => /finished/.test(r.head)).length === 1, `exactly one finished explorer report after reload (${reps2.length}): ${reps2[0]?.head}`);
const summary = await readNested(page, ['.subagents', 'explorer.md']);
ok(summary && summary.length > 40, `summary file exists (${summary?.length ?? 0} chars)`);
const changes = await card(page, 'explorer').locator('.changes .change').count();
ok(changes >= 1, `child card lists ${changes} changed file(s) with Diff/Undo`);
await page.screenshot({ path: `${SHOTS}/subagent-finished.png` });
await send(page, 'Without using any tools: according to the explorer\'s report, which file is the entry point? One sentence.');
await idle(page);
const use = await page.$$eval('.msg.assistant .body', (b) => b.at(-1)?.textContent ?? '');
ok(/main\.js/.test(use), `parent used the report next turn: "${use.slice(0, 120)}"`);
log(`scenario 1+4 requests: ${modelReqs - r0}`);

// ── 2. Web research child: approvals name the subagent; deny, then allow; stop ──
await newSession(page); await sleep(400);
const sidB = await currentSession(page);
const r1 = modelReqs, s1 = searches;
await send(page, `Use the subagent tool (action spawn, background, name "webby") with this task: "Run the bash command: bayleaf web search 'durable agent loops ${ZB}' and report the top result title. If it is denied, try exactly once more, then report what happened." Then reply only: spawned.`);
await page.waitForSelector('#egress[open]', { timeout: 180_000 });
const h1 = await page.textContent('#egress-h'), m1 = await page.textContent('#egress-meta');
ok(/Subagent "webby" wants to/.test(h1) && /subagent webby/.test(m1), `sheet names the subagent: "${h1}" / "${m1}"`);
await page.screenshot({ path: `${SHOTS}/subagent-egress.png` });
await page.click('#egress-deny');
ok(searches === s1, 'denied: no /web/ request sent');
const second = await waitFor(() => page.$('#egress[open]'), 120_000);
if (second) { await sleep(200); await page.click('#egress-once'); }
ok(!!second, 'second ask after deny; allowed once');
const wfin = await waitFor(async () => { const s = await cardStatus(page, 'webby'); return s && s !== 'running' ? s : null; }, 180_000, 800);
ok(wfin === 'finished' && searches === s1 + 1, `webby finished (${wfin}), ${searches - s1} search sent`);
await waitFor(async () => (await reports(page, 'webby')).length, 60_000);
await idle(page);
const wrep = await reports(page, 'webby');
ok(wrep.length === 1 && /Durable agents|fake/i.test(wrep[0].text), `webby report in parent: ${wrep[0]?.text.slice(0, 120)}`);
// Stop a child mid-run.
await send(page, 'Use the subagent tool (action spawn, background, name "slowpoke") with this task: "Read each file under /work/proj one at a time with separate read calls, then count their lines with bash, then write a 300-word essay about ledgers to /work/.subagents/slowpoke.md." Then reply only: spawned.');
await waitFor(async () => (await cardStatus(page, 'slowpoke')) === 'running', 120_000, 300);
await idle(page);
await sleep(2500);
await card(page, 'slowpoke').locator('button:has-text("Stop")').click();
const sst = await waitFor(async () => { const s = await cardStatus(page, 'slowpoke'); return s && s !== 'running' ? s : null; }, 60_000, 300);
ok(sst === 'stopped', `Stop button stops the child (${sst})`);
await sleep(1500);
const srep = await reports(page, 'slowpoke');
ok(srep.length === 1 && /stopped/.test(srep[0].head), `parent transcript notes it stopped: ${srep[0]?.head}`);
ok(await parentIdle(page), 'stop report spent no parent request (parent idle)');
await page.screenshot({ path: `${SHOTS}/subagent-stopped.png` });
log(`scenario 2 requests: ${modelReqs - r1}, searches: ${searches - s1}`);

// ── 6. Mobile width: child card usable, no horizontal overflow ──
await page.setViewportSize({ width: 390, height: 844 });
await sleep(800);
await page.evaluate(() => document.querySelector('.subagent')?.scrollIntoView());
ok(await overflow(page) <= 0, `no horizontal overflow at 390px (${await overflow(page)})`);
const box = await card(page, 'webby').boundingBox();
ok(box && box.x >= 0 && box.x + box.width <= 390, `card fits (${box?.x}..${box && box.x + box.width})`);
const msgBtn = card(page, 'webby').locator('button:has-text("Message")');
const mb = await msgBtn.boundingBox();
ok(mb && mb.height >= 24, `Message button tappable (${mb?.height}px)`);
await page.screenshot({ path: `${SHOTS}/subagent-mobile.png` });
await msgBtn.click();
await page.waitForSelector('#sheet[open]');
await page.screenshot({ path: `${SHOTS}/subagent-mobile-message.png` });
await page.click('#sheet-actions button:has-text("Cancel")');
await page.setViewportSize({ width: 1400, height: 900 });
await sleep(500);

// ── 5. Delete the sessions: nothing of parent or child remains ──
let s = await scan(page, ZA);
ok(s.hits.length > 0, `control: ZEBRA marker present before delete (${s.hits})`);
for (const sid of [sidA, sidB]) {
  await sessionMenu(page, sid); page.dialogQueue.push(true); await sheetClick(page, 'Delete session'); await sleep(1500);
}
s = await scan(page, ZA);
ok(s.hits.length === 0, `ZEBRA (parent + explorer) erased (hits: ${s.hits})`);
s = await scan(page, ZB);
ok(s.hits.length === 0, `YAK (webby task) erased (hits: ${s.hits})`);
const keys = await page.evaluate(async () => {
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const out = [];
  for (const { name } of await indexedDB.databases()) {
    const db = await req(indexedDB.open(name));
    for (const st of db.objectStoreNames) out.push(...(await req(db.transaction(st).objectStore(st).getAllKeys())).map(String).filter((k) => k.startsWith('subagents:')));
    db.close();
  }
  return out;
});
ok(keys.length === 0, `no subagents: registry keys left (${keys})`);

const errs = errors.filter((e) => !/favicon|ERR_|net::/.test(e));
ok(errs.length === 0, `no console errors (${errs.slice(0, 3).join(' | ')})`);
log(`TOTAL model requests: ${modelReqs}, web searches (faked): ${searches}`);
await ctx.close();
const failed = results.filter(([c]) => !c);
log(failed.length ? `${failed.length} FAILED` : 'ALL PASS');
process.exit(failed.length ? 1 : 0);
