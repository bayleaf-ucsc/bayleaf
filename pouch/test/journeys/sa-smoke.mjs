import { launch, instrument, sleep } from './lib.mjs';
const ctx = await launch({ userDataDir: '/tmp/pouch-qa/sa-smoke', fresh: true });
const page = ctx.pages()[0]; const errs = instrument(page);
await page.goto('http://127.0.0.1:8760/pouch.html'); await sleep(4000);
console.log('errors', errs);
await ctx.close();
