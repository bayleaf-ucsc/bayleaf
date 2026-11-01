// Campus Pass, no key: an agent run with tools, and every inference body must be ciphertext.
import { launch, instrument, sleep, URL as PAGE } from './lib.mjs';
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const ctx = await launch({ fresh: true, userDataDir: '/tmp/pouch-qa/profile-campus' });
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = instrument(page);
const bodies = [];
const hosts = new Set();
page.on('request', (r) => {
  hosts.add(new URL(r.url()).host);
  if (r.url().includes('/sealed/v1/chat/completions') && r.method() === 'POST') {
    const b = r.postDataBuffer();
    let json = false; try { JSON.parse(b.toString('utf8')); json = true; } catch {}
    bodies.push({ len: b.length, json, plaintextLeak: b.toString('latin1').includes('hello.txt'), auth: (r.headers().authorization ?? '').replace(/sk-bayleaf-\S+/, 'sk-bayleaf-[KEY]') });
  }
});
await page.goto(PAGE);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
ok((await page.textContent('#auth')) === 'Sign in', 'no key stored');
await page.click('#new'); await sleep(500);
await page.fill('#input', 'Use the write tool to create hello.txt containing "hi from campus", then use bash to cat it. Reply with its contents.');
await page.click('#send');
const t = Date.now();
await sleep(1000);
while (Date.now() - t < 180_000 && (await page.textContent('#send')) !== 'Send') await sleep(500);
const tools = await page.$$eval('details.tool summary', (s) => s.map((x) => x.textContent));
const reply = await page.$$eval('.msg.assistant .body', (b) => b.at(-1)?.textContent ?? '');
console.log('tools:', tools, '\nreply:', reply.slice(0, 200), '\nstatus:', await page.textContent('#status'));
ok(tools.some((x) => /write/.test(x)) && tools.some((x) => /bash/.test(x)), 'tool calls ran under Campus Pass');
ok(/hi from campus/.test(reply), 'reply has file contents');
console.log('inference requests:', JSON.stringify(bodies));
ok(bodies.length > 0 && bodies.every((b) => !b.json && !b.plaintextLeak), 'every inference body is ciphertext');
ok(bodies.every((b) => b.auth === 'Bearer campus'), 'bearer is campus');
console.log('hosts contacted:', [...hosts]);
ok([...hosts].every((h) => h === 'api.bayleaf.dev' || h === '127.0.0.1:8742'), 'only api.bayleaf.dev (plus the local page server)');
console.log('errors:', errors);
await ctx.close();
