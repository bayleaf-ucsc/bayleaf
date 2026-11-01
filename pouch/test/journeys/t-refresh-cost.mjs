// Which requests does a plain reload send, and does /usage move?
import { launch, instrument, sleep, URL as PAGE } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const usage = async () => (await (await fetch('https://api.bayleaf.dev/usage', { headers: { Authorization: 'Bearer ' + KEY } })).json()).budgets.find((b) => b.provider === 'sealed').used;
const ctx = await launch({ fresh: true, userDataDir: '/tmp/pouch-qa/refresh-cost' });
const page = ctx.pages()[0] ?? await ctx.newPage();
instrument(page);
const log = [];
page.on('request', (r) => { if (r.url().includes('api.bayleaf.dev')) log.push(`${r.method()} ${new URL(r.url()).pathname}`); });
await page.goto(PAGE);
await page.waitForSelector('#badge.ok, .ok[data-badge], [data-enclave="ok"]', { timeout: 60_000 }).catch(() => {});
await sleep(4000);
console.log('cold load (signed out):', log.splice(0));
// sign in via the stored setting path: paste key flow differs per layout, so set it directly in IndexedDB
await page.evaluate(async (k) => new Promise((res, rej) => {
  const r = indexedDB.open('bayleaf-pouch'); r.onsuccess = () => { const t = r.result.transaction('settings', 'readwrite'); t.objectStore('settings').put(k, 'key'); t.oncomplete = res; t.onerror = rej; };
}), KEY);
for (let i = 1; i <= 3; i++) {
  const before = await usage();
  await page.reload();
  await sleep(9000);
  const after = await usage();
  console.log(`reload ${i}: sealed used ${before} -> ${after};`, log.splice(0).filter((x) => !x.includes('/usage') || true));
}
await ctx.close();
