import { launch, instrument, URL, sleep, rows, waitRow } from './lib.mjs';
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + String(extra).slice(0, 400) : ''}`);
const KEY = process.env.BAYLEAF_API_KEY;

let ctx = await launch({ fresh: true });
let page = ctx.pages()[0] ?? await ctx.newPage();
let errors = instrument(page);
await page.goto(URL);
await page.waitForFunction(() => document.getElementById('badge').textContent !== 'verifying enclave...', null, { timeout: 30000 });

// Sign in
page.dialogQueue.push(KEY);
await page.click('#auth');
await page.locator('#sheet-actions button', { hasText: 'Paste a key' }).click();
await page.waitForFunction(() => document.getElementById('auth').textContent === 'Forget key');
await page.waitForFunction(() => document.getElementById('badge').textContent === 'sealed: enclave verified', null, { timeout: 30000 });
ok('signed in', !(await page.$eval('#send', (b) => b.disabled)), await page.textContent('#status'));

const waitIdle = async (timeout = 180000) => {
  await page.waitForFunction(() => document.getElementById('send').textContent === 'Stop', null, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('send').textContent === 'Send', null, { timeout });
};
const ask = async (text) => { await page.fill('#input', text); await page.click('#send'); await waitIdle(); };
const lastReply = () => page.$$eval('#log .msg.assistant .body', (b) => b.at(-1)?.textContent ?? '');

await page.click('#new');
await sleep(500);
ok('session created', (await page.$$eval('#sessions option', (o) => o.length)) >= 1);

// Pre-create and open the file so we can watch the editor follow
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const d = await (await root.getDirectoryHandle('demo', { create: true }));
  const w = await (await d.getFileHandle('index.html', { create: true })).createWritable(); await w.write('<!-- placeholder -->\n'); await w.close();
});
await page.click('#refresh'); await sleep(300);
await page.click('#tree .row:has(.name[title="/work/demo"])'); await waitRow(page, '/work/demo/index.html');
await page.click('#tree .row:has(.name[title="/work/demo/index.html"])'); await sleep(300);
ok('opened placeholder', (await page.textContent('.cm-content')).includes('placeholder'));

await ask('Overwrite /work/demo/index.html with a small hello-world HTML page (use the write tool), then use bash to count its lines with wc -l. Report the count.');
const tools = await page.$$eval('#log details.tool summary', (s) => s.map((x) => x.textContent));
ok('tool calls render', tools.some((t) => t.startsWith('write')) && tools.some((t) => t.startsWith('bash')), tools.join(' | '));
ok('reply', (await lastReply()).length > 0, await lastReply());
await sleep(500);
const edText = await page.textContent('.cm-content');
ok('editor followed agent edit', !edText.includes('placeholder') && /hello/i.test(edText), edText.slice(0, 120));
await page.screenshot({ path: '/tmp/pouch-qa/shots/desktop-agent.png' });

// Stop mid-run
await page.fill('#input', 'Use bash to run: for i in $(seq 1 200000); do echo $i; done | wc -l. Then write a 30-paragraph essay about bay leaves.');
await page.click('#send');
await page.waitForFunction(() => document.getElementById('send').textContent === 'Stop', null, { timeout: 15000 });
await sleep(4000);
const t0 = Date.now();
await page.click('#send');
await page.waitForFunction(() => document.getElementById('send').textContent === 'Send', null, { timeout: 30000 });
ok('stop works', Date.now() - t0 < 15000, `${Date.now() - t0}ms; status=${await page.textContent('#status')}; last=${(await page.$$eval('#log > *', (n) => n.slice(-2).map((x) => x.textContent))).join(' / ')}`);
const s1 = await page.$eval('#sessions', (s) => s.value);
const s1count = await page.$$eval('#log > *', (n) => n.length);

// After Stop, can we send again?
await ask('Reply with exactly: ready');
ok('send after stop', /ready/i.test(await lastReply()), await lastReply());

// Second session
await page.click('#new'); await sleep(500);
const s2 = await page.$eval('#sessions', (s) => s.value);
ok('second session empty', (await page.$$eval('#log .msg', (n) => n.length)) === 0 && s2 !== s1);
await ask('Reply with exactly the word zucchini.');
ok('session 2 reply', /zucchini/i.test(await lastReply()), await lastReply());
await page.selectOption('#sessions', s1); await sleep(800);
const back = await page.$$eval('#log .msg.user .body', (b) => b.map((x) => x.textContent));
ok('switch restores s1', back.some((t) => t.includes('Overwrite')) && !back.some((t) => t.includes('zucchini')), back.join(' | '));

// Reload restores
await page.reload();
await page.waitForFunction(() => document.getElementById('badge').textContent === 'sealed: enclave verified', null, { timeout: 30000 });
await sleep(800);
const opts = await page.$$eval('#sessions option', (o) => o.map((x) => x.textContent));
const cur = await page.$$eval('#log .msg.user .body', (b) => b.map((x) => x.textContent));
ok('reload restores sessions', opts.length === 2 && cur.length > 0, opts.join(' | ') + ' // ' + cur.join(' | '));
ok('key persisted', (await page.textContent('#auth')) === 'Forget key');

// Session menu: Compact, Rename, Delete
await page.click('#del-session'); await page.locator('#sheet-actions button', { hasText: 'Compact' }).click();
await sleep(2000);
await page.waitForFunction(() => document.getElementById('status').textContent !== 'Compacting...', null, { timeout: 120000 }).catch(() => {});
ok('compact readable', true, `status="${await page.textContent('#status')}" dialogs=${JSON.stringify(page.dialogLog.slice(-1))}`);
page.dialogQueue.push('Renamed session');
await page.click('#del-session'); await page.locator('#sheet-actions button', { hasText: 'Rename' }).click();
await sleep(500);
ok('rename session', (await page.$$eval('#sessions option', (o) => o.map((x) => x.textContent))).includes('Renamed session'));
page.dialogQueue.push(true);
await page.click('#del-session'); await page.locator('#sheet-actions button', { hasText: 'Delete session' }).click();
await sleep(1000);
const after = await page.$$eval('#sessions option', (o) => o.map((x) => x.textContent));
ok('delete session', after.length === 1 && !after.includes('Renamed session'), after.join(' | '));

console.log('dialogs:', page.dialogLog);
console.log('errors:', errors);
await ctx.close();
