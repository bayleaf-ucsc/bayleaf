// t12 with the scripted fake model: a reload must never spend a model request
// by itself, after (a) a finished turn, (b) a reload mid-run of the parent,
// (c) a reload while a child runs. window.requests restarts per page load.
import { chromium } from 'playwright';
import { fixtureHtml, serveHtml, fakeNetwork } from './fixture.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); console.log(c ? 'PASS' : 'FAIL', m); };
const srv = await serveHtml(await fixtureHtml());
const dir = '/tmp/pouch-qa/cmp-t12f';
(await import('node:fs')).rmSync(dir, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport: { width: 1400, height: 900 } });
await fakeNetwork(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const ready = () => page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 20000 });
const idle = async () => { const t = Date.now(); await sleep(300); while (Date.now() - t < 30000) { if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return sleep(200); await sleep(100); } throw new Error('never idle'); };
async function reload3(label) {
  let spent = 0;
  for (let i = 0; i < 3; i++) { await page.reload(); await ready(); await sleep(2500); spent += await page.evaluate(() => window.requests.length); }
  ok(spent === 0, `${label}: ${spent} model requests across 3 reloads`);
}
await page.goto(srv.url); await ready();
await page.evaluate(() => window.script.push({ text: 'pong' }));
await page.fill('#input', 'ping'); await page.click('#send'); await idle();
await reload3('(a) after a finished turn');
await page.click('#new-top'); await sleep(300);
await page.evaluate(() => window.script.push({ slow: 60 }));
await page.fill('#input', 'long story'); await page.click('#send');
await page.waitForSelector('.msg.assistant.streaming'); await sleep(800);
await reload3('(b) reload mid-run of the parent');
ok(!!(await page.$('.notice:has-text("page reloaded while Pouch was working") button:has-text("Resume")')), 'parent offers Resume');
ok((await page.textContent('#send')) === 'Send', 'parent idle after reload');
await page.click('#new-top'); await sleep(300);
await page.evaluate(() => window.script.push({ tool: 'subagent', args: { action: 'spawn', name: 'reader', task: 'Write an essay slowly', background: true } }, { text: 'spawned' }, { when: 'You are a subagent named', slow: 100 }));
await page.fill('#input', 'spawn'); await page.click('#send');
await page.waitForSelector('#tray-list .tray-row[data-kind="subagent"]', { timeout: 10000 });
await idle(); await sleep(500);
await reload3('(c) reload while a child runs');
const st = await page.locator('.subagent:has(.sa-name:text-is("reader")) .sa-status').first().textContent().catch(() => null);
ok(st === 'interrupted', `child card interrupted (${st})`);
ok(await page.evaluate(() => document.querySelector('#tray').hidden), 'tray empty after reload (interrupted child is not running)');
ok(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
await ctx.close(); srv.close();
const failed = results.filter(([c]) => !c);
console.log(failed.length ? `${failed.length} FAILED` : 'ALL PASS');
process.exit(failed.length ? 1 : 0);
