// A reload must never spend Sealed requests by itself. Counts POST /sealed/v1/*
// across 3 reloads after (a) a finished turn, (b) a reload mid-run of the
// parent, (c) a reload while a child runs. Expect 0 from the reloads.
import { launch, instrument, sleep, URL, newSession, currentSession, sheetClick, waitSignedIn } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const log = (...a) => console.log(...a.map((x) => typeof x === 'string' && KEY ? x.replaceAll(KEY, '[key]') : x));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); log(c ? 'PASS' : 'FAIL', m); };
let posts = 0;
const ctx = await launch({ userDataDir: '/tmp/pouch-qa/sa-reload', fresh: true });
await ctx.route('https://api.bayleaf.dev/**', (r) => {
  const q = r.request();
  if (q.method() === 'POST' && /\/sealed\/v1\//.test(q.url())) { posts++; log(`  [POST ${posts} ${new globalThis.URL(q.url()).pathname}]`); }
  return r.continue();
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = instrument(page);
const idle = async (timeout = 180_000) => {
  const t = Date.now(); await sleep(800);
  while (Date.now() - t < timeout) { if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return; await sleep(400); }
  throw new Error('never idle');
};
const waitFor = async (fn, timeout = 120_000) => { const t = Date.now(); while (Date.now() - t < timeout) { const v = await fn(); if (v) return v; await sleep(300); } return null; };
const send = async (t) => { await page.fill('#input', t); await page.click('#send'); };
async function reload3(label) {
  const before = posts;
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.waitForSelector('#badge.ok', { timeout: 60_000 });
    await sleep(6000);
  }
  ok(posts === before, `${label}: ${posts - before} POSTs across 3 reloads`);
}
await page.goto(URL);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
await page.click('#auth'); page.dialogQueue.push(KEY); await sheetClick(page, 'Paste a key'); await waitSignedIn(page);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
if (await page.isVisible('#welcome')) await page.click('#welcome button:has-text("Got it")').catch(() => {});

// (a) finished turn (1 request + 1 title)
await newSession(page); await sleep(400);
await send('Without tools, reply with just the word: pong');
await idle(); await sleep(5000); // let the automatic title finish
await reload3('(a) after a finished turn');

// (b) reload mid-run of the parent
await newSession(page); await sleep(400);
const sidB = await currentSession(page);
const p0 = posts;
await send('Without tools, write a 600-word story about a lighthouse keeper.');
await waitFor(async () => posts > p0 && (await page.$('.msg.assistant.streaming')));
await sleep(1500);
await reload3('(b) reload mid-run of the parent');
ok(await currentSession(page) === sidB, 'same session');
const note = await page.$('.notice:has-text("page reloaded while Pouch was working") button:has-text("Resume")');
ok(!!note, 'parent shows "page reloaded ... Resume"');
ok((await page.textContent('#send')) === 'Send', 'parent idle after reload (not resumed)');
await page.screenshot({ path: '/tmp/pouch-qa/shots/subagent-reload-parent.png' });

// (c) reload while a child runs
await newSession(page); await sleep(400);
await send('Use the subagent tool (action spawn, background, name "reader") with this task: "Write a 500-word essay about tides to /work/.subagents/reader.md, then report." Then reply only: spawned.');
const st = () => page.locator('.subagent:has(.sa-name:text-is("reader")) .sa-status').first().textContent().catch(() => null);
await waitFor(async () => (await st()) === 'running');
await idle();
await sleep(1000);
ok((await st()) === 'running', 'child running before reload');
await reload3('(c) reload while a child runs');
ok((await st()) === 'interrupted', `child card interrupted (${await st()})`);
ok(!!(await page.$('.subagent:has(.sa-name:text-is("reader")) button:has-text("Resume")')), 'child card offers Resume');
ok(!!(await page.$('.msg.report:has-text("interrupted")')), 'parent transcript notes the interruption');
await page.screenshot({ path: '/tmp/pouch-qa/shots/subagent-reload-child.png' });
const errs = errors.filter((e) => !/favicon|ERR_|net::/.test(e));
ok(errs.length === 0, `no console errors (${errs.slice(0, 3).join(' | ')})`);
log(`TOTAL sealed POSTs: ${posts}`);
await ctx.close();
const failed = results.filter(([c]) => !c);
log(failed.length ? `${failed.length} FAILED` : 'ALL PASS');
process.exit(failed.length ? 1 : 0);
