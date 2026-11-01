import { launch, sleep } from './lib.mjs';
const ctx = await launch({ userDataDir: '/tmp/pouch-qa/review-profile' });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(process.env.POUCH_URL); await sleep(5000);
const t = await page.textContent('#log');
let i = -1; while ((i = t.indexOf('\\n', i + 1)) >= 0) console.log('CTX:', JSON.stringify(t.slice(Math.max(0, i - 80), i + 40)));
await ctx.close();
