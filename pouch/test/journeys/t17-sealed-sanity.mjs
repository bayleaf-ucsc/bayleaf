// One real Sealed turn on the --with-models build (spends 1 request): the Sealed lane still works.
// set -a; source ~/.tokens/bayleaf-api; set +a; node t17-sealed-sanity.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { instrument, waitSignedIn } from './lib.mjs';
const srv = spawn('node', ['/tmp/pouch-qa/local-serve.mjs', '/tmp/pouch-qa/local-build', '8794'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const ctx = await chromium.launchPersistentContext('/tmp/pouch-qa/local-profile-sealed', { headless: true });
const page = ctx.pages()[0];
const errors = instrument(page);
const sealed = [];
ctx.on('request', (r) => { if (/sealed\/v1\/chat/.test(r.url())) sealed.push(r.url()); });
await page.goto('http://127.0.0.1:8794/pouch.html');
await page.click('#auth');
page.dialogQueue.push(process.env.BAYLEAF_API_KEY);
await page.locator('#sheet-actions button', { hasText: 'Paste a key' }).click();
await waitSignedIn(page);
await page.waitForFunction(() => /verified/.test(document.querySelector('#badge').ariaLabel ?? ''), null, { timeout: 60000 });
const opts = await page.$$eval('#model option', (o) => o.map((x) => x.value + (x.disabled ? '(d)' : '')));
await page.fill('#input', 'Reply with just the word OK. Do not use tools.');
await page.press('#input', 'Enter');
await page.waitForFunction(() => document.querySelector('#send-label').textContent === 'Stop', null, { timeout: 30000 }).catch(() => {});
await page.waitForFunction(() => document.querySelector('#send-label').textContent !== 'Stop', null, { timeout: 120000 });
await page.waitForTimeout(500);
const reply = await page.$$eval('#log .msg.assistant', (d) => d.at(-1)?.textContent ?? '');
console.log((/ok/i.test(reply) && sealed.length >= 1 ? 'PASS' : 'FAIL') + ` Sealed turn: ${sealed.length} sealed request(s), model ${await page.$eval('#model', (s) => s.value)}, reply ${JSON.stringify(reply.slice(0, 60))}`);
console.log('options', opts.join(', '));
console.log('errors', JSON.stringify(errors.slice(0, 5)));
await ctx.close(); srv.kill();
