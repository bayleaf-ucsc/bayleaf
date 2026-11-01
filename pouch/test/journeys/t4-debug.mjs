import { launch, instrument, sleep, URL } from './lib.mjs';
const ctx = await launch({});
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = instrument(page);
page.on('console', (m) => { if (m.type() === 'log') console.log('[page]', m.text()); });
await page.goto(URL);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
await sleep(2000);
const opts = await page.$$eval('#sessions option', (o) => o.map((x) => [x.value, x.textContent, x.selected]));
console.log('options', JSON.stringify(opts));
console.log('log0', (await page.textContent('#log')).slice(0, 150));
for (const [id, title] of opts) {
  const t = Date.now();
  await page.selectOption('#sessions', id);
  let txt = '';
  for (let i = 0; i < 100; i++) { txt = await page.textContent('#log'); if (!/Ask Pouch|Starting/.test(txt) && txt.length > 5) break; await sleep(100); }
  console.log(title, Date.now() - t, 'ms ->', txt.slice(0, 120).replace(/\n/g, ' '));
}
console.log('AGENTS.md row?', await page.$$eval('#tree .row .name', (n) => n.map((x) => x.title).filter((t) => /AGENTS/.test(t))));
await page.click('#tree .row:has(.name[title="/work/AGENTS.md"])').catch((e) => console.log('no row', e.message.slice(0, 80)));
await sleep(800);
console.log('editor text:', await page.textContent('.cm-content').catch(() => '?'));
await page.click('#del-session');
await sleep(500);
console.log('sheet open?', await page.$eval('#sheet', (d) => d.open), await page.textContent('#sheet-title'));
console.log('errors', errors);
await ctx.close();
