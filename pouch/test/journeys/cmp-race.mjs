// Probe: a second send the instant the first turn's view goes idle must never be lost.
import { chromium } from 'playwright';
import { fixtureHtml, serveHtml, fakeNetwork } from './fixture.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = await serveHtml(await fixtureHtml());
const dir = '/tmp/pouch-qa/cmp-race'; (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(dir, { headless: true }); await fakeNetwork(ctx);
const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(srv.url); await page.waitForFunction(() => !document.querySelector('#send').disabled);
let lost = 0, raced = 0;
for (let i = 0; i < 12; i++) {
  await page.evaluate((i) => { window.titleDelay = i % 3 === 0 ? 300 : 0; window.script.push({ text: 'a' + i }, { text: 'b' + i }); }, i);
  if (i % 4 === 0) { await page.click('#new-top'); await sleep(300); }
  await page.fill('#input', 'first ' + i); await page.click('#send');
  await page.waitForFunction(() => document.querySelector('#send').textContent !== 'Stop' && !document.querySelector('.msg.assistant.streaming') && document.querySelector('.msg.assistant'), null, { timeout: 10000 });
  await page.fill('#input', 'second ' + i); await page.press('#input', 'Enter');
  const st = await page.textContent('#status'); if (/still running/.test(st)) raced++;
  await page.waitForFunction((i) => [...document.querySelectorAll('.msg.user .body')].some((b) => b.textContent === 'second ' + i) || (document.querySelector('#input').value === 'second ' + i), i, { timeout: 15000 }).catch(() => { lost++; });
  await page.waitForFunction(() => document.querySelector('#send').textContent === 'Send', null, { timeout: 15000 }).catch(() => {});
  await sleep(150);
}
console.log(`lost=${lost} raceStatus=${raced} errors=${errs.length}`);
await ctx.close(); srv.close(); process.exit(lost ? 1 : 0);
