import { launch, instrument, sleep, URL as PAGE } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const usage = async () => (await (await fetch('https://api.bayleaf.dev/usage', { headers: { Authorization: 'Bearer ' + KEY } })).json()).budgets.find((b) => b.provider === 'sealed').used;
const ctx = await launch({ fresh: true, userDataDir: '/tmp/pouch-qa/refresh-cost2' });
const page = ctx.pages()[0] ?? await ctx.newPage();
instrument(page);
const log = [];
page.on('request', (r) => { if (r.url().includes('/sealed/v1/')) log.push(`${r.method()} ${new URL(r.url()).pathname}`); });
await page.goto(PAGE);
await page.evaluate(async (k) => new Promise((res, rej) => { const r = indexedDB.open('bayleaf-pouch'); r.onsuccess = () => { const t = r.result.transaction('settings', 'readwrite'); t.objectStore('settings').put(k, 'key'); t.oncomplete = res; t.onerror = rej; }; }), KEY);
await page.reload(); await sleep(6000);
await page.fill('#input', 'Reply with one word: hello.'); await page.keyboard.press('Enter');
await sleep(20000);
console.log('after one finished turn (+ autoname):', log.splice(0).length, 'inference POSTs');
for (let i = 1; i <= 2; i++) { const b = await usage(); await page.reload(); await sleep(10000); console.log(`reload after finished turn ${i}: ${b} -> ${await usage()}; POSTs`, log.splice(0).length); }
await page.fill('#input', 'Use bash to run: for i in $(seq 1 3); do echo $i; done. Then write a 300 word story.'); await page.keyboard.press('Enter');
await sleep(2500);
console.log('mid-run POSTs before reload:', log.splice(0).length);
await page.reload(); await sleep(12000);
console.log('reload during a run: POSTs', log.splice(0).length);
for (let i = 1; i <= 3; i++) { const b = await usage(); await page.reload(); await sleep(12000); console.log(`later reload ${i}: ${b} -> ${await usage()}; POSTs`, log.splice(0).length); }
await ctx.close();
