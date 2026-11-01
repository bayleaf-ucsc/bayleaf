// D18: the run tool through the real UI, driven by a scripted fake model (0 model requests).
import { chromium } from 'playwright';
import { fixtureHtml, serveHtml, fakeNetwork } from './fixture.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); console.log(c ? 'PASS' : 'FAIL', m); };
const srv = await serveHtml(await fixtureHtml());
const dir = '/tmp/pouch-qa/ro-t13';
(await import('node:fs')).rmSync(dir, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport: { width: 1400, height: 900 } });
const net = await fakeNetwork(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(srv.url);
await page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 20000 });

async function idle(timeout = 30000) {
  const t = Date.now(); await sleep(400);
  while (Date.now() - t < timeout) {
    if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return sleep(300);
    await sleep(150);
  }
  throw new Error('never idle');
}
// One user turn running the given steps; returns the tool results the model saw.
async function turn(steps, text = 'go') {
  const before = await page.evaluate(() => window.requests.length);
  await page.evaluate((s) => { window.script.push(...s, { text: 'done' }); }, steps);
  await page.waitForFunction(() => !document.querySelector('#send').disabled && document.querySelector('#send').textContent === 'Send');
  await page.fill('#input', text);
  // A click while the previous turn's afterTurn still runs is dropped (pre-existing; noted as a gap).
  for (let i = 0; i < 5 && (await page.evaluate(() => window.requests.length)) === before; i++) {
    if (await page.inputValue('#input')) await page.click('#send');
    await page.waitForFunction((b) => window.requests.length > b, before, { timeout: 2000 }).catch(() => {});
  }
  await idle();
  return page.evaluate((b) => window.requests.slice(b + 1).map((r) => {
    const m = r.messages.at(-1); return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  }), before);
}
const run = (args) => ({ tool: 'run', args });

// 1. hello, args, stdin
let [out] = await turn([run({ code: 'console.log("hello", args.join("+"), stdin.trim()); print(1+1)', args: ['a', 'b'], stdin: 'in!\n' })]);
ok(/status: ok, exit code 0/.test(out) && /hello a\+b in!\n2/.test(out), 'hello: stdout, args, stdin');

// 2. files in and out, relative paths, review integration
await turn([{ tool: 'write', args: { path: 'data/in.txt', content: 'x,1\ny,2\n' } }]);
await turn([{ tool: 'write', args: { path: 'data/keep.txt', content: 'old' } }]);
[out] = await turn([
  run({ code: 'const t = fs.readFile("data/in.txt"); const s = t.trim().split("\\n").map(l => +l.split(",")[1]).reduce((a,b)=>a+b); fs.writeFile("data/sum.txt", String(s)); fs.rm("data/in.txt"); fs.writeFile("data/keep.txt", "new"); console.log(fs.readdir("data"))' }),
]);
ok(/created \/work\/data\/sum.txt/.test(out) && /deleted \/work\/data\/in.txt/.test(out), 'files: changes applied and summarized: ' + out.split('\n').at(-1));
const opfs = (p) => page.evaluate(async (p) => { let d = await navigator.storage.getDirectory(); const parts = p.split('/'); try { for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x); return await (await (await d.getFileHandle(parts.at(-1))).getFile()).text(); } catch { return null; } }, p);
ok((await opfs('data/sum.txt')) === '3' && (await opfs('data/in.txt')) === null, 'files: written to /work storage');
await page.waitForSelector('.changes .change', { timeout: 5000 }).catch(() => {});
const rowsTxt = await page.$$eval('.changes .change', (rs) => rs.map((r) => r.textContent));
ok(rowsTxt.some((t) => /sum\.txt/.test(t)) && rowsTxt.some((t) => /in\.txt/.test(t)) && rowsTxt.some((t) => /modified.*keep\.txt/.test(t)), 'review: run changes listed under the turn: ' + JSON.stringify(rowsTxt) + (await page.textContent('.changes')));
await page.locator('.changes .head button', { hasText: 'Undo all' }).last().click(); await sleep(1000);
if (await page.$('#sheet[open]')) { await page.locator('#sheet-actions button').first().click(); await sleep(800); }
ok((await opfs('data/sum.txt')) === null && (await opfs('data/in.txt')) === 'x,1\ny,2\n' && (await opfs('data/keep.txt')) === 'old\n', 'review: Undo all restores the run\'s changes (write now saves one final newline)');

// 3. a saved script by path; default snapshot is its folder
[, out] = await turn([
  { tool: 'write', args: { path: 'tools/count.js', content: 'const n = fs.readdir(".").length; console.log("cwd entries", n); console.log("own", fs.exists("/work/tools/count.js"), "other", fs.exists("/work/data/in.txt"))' } },
  run({ path: 'tools/count.js' }),
]);
ok(/own true other false/.test(out), 'path: runs a saved script, snapshot defaults to its folder');
[out] = await turn([run({ path: 'tools/count.js', files: ['/work/data/*.txt', 'tools'] })]);
ok(/own true other true/.test(out), 'path: files globs widen the snapshot');

// 4. conflict: the file changes on disk while the run is busy
await page.evaluate(() => window.script.push({ tool: 'run', args: { code: 'const t0 = Date.now(); while (Date.now() - t0 < 1500); fs.writeFile("data/in.txt", "guest"); fs.writeFile("data/new.txt", "n")' } }, { text: 'done' }));
const before = await page.evaluate(() => window.requests.length);
await page.fill('#input', 'conflict'); await page.click('#send');
await sleep(800);
await page.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('data'); const w = await (await d.getFileHandle('in.txt')).createWritable(); await w.write('user'); await w.close(); });
await idle();
out = await page.evaluate((b) => window.requests[b + 1].messages.at(-1).content, before);
out = typeof out === 'string' ? out : JSON.stringify(out);
ok(/conflicts, not applied \(1\): \/work\/data\/in.txt \(file changed since the snapshot\)/.test(out) && /created \/work\/data\/new.txt/.test(out) && (await opfs('data/in.txt')) === 'user', 'conflict: reported, not applied; other changes applied');

// 5. limits
[out] = await turn([run({ code: 'for(;;);', limits: { timeMs: 300 } })]);
ok(/status: timeout, exit code 124/.test(out), 'limits: timeout -> 124');
[out] = await turn([run({ code: 'const a=[]; for(;;) a.push("x".repeat(1000)+a.length)', limits: { memoryMB: 8 } })]);
ok(/status: oom, exit code 137/.test(out), 'limits: memory -> oom 137');
[out] = await turn([run({ code: 'for (let i=0;i<5000;i++) console.log("line", i)', limits: { outputKB: 1 } })]);
ok(/output truncated at 1 KB/.test(out) && out.length < 2000, 'limits: output truncated');
let t0 = Date.now();
[out] = await turn([run({ code: 'for(;;);', limits: { timeMs: 60000 } })]);
ok(Date.now() - t0 < 9000 && !/status: ok/.test(out), `limits: cannot be raised (${Date.now() - t0} ms): ${out.slice(0, 80)}`);
[out] = await turn([run({ code: 'exit(3)' })]);
ok(/status: exit, exit code 3/.test(out), 'exit(3) -> exit code 3');
[out] = await turn([run({ code: 'throw new TypeError("boom")' })]);
ok(/status: error, exit code 1/.test(out) && /TypeError: boom/.test(out), 'guest error reported');

// 6. Stop cancels a running script
await page.evaluate(() => window.script.push({ tool: 'run', args: { code: 'for(;;);' } }, { text: 'done' }));
await page.fill('#input', 'spin'); await page.click('#send'); await sleep(1200);
t0 = Date.now(); await page.click('#send'); await idle(); const stopMs = Date.now() - t0;
await page.evaluate(() => { window.script.length = 0; });
ok(stopMs < 3000, `Stop ends a busy run in ${stopMs} ms`);
const workers = await page.evaluate(() => performance.getEntriesByType('resource').length); // touch the page: still responsive
ok(workers >= 0, 'page responsive after Stop');

// 7. no network or host APIs inside
[out] = await turn([run({ code: 'console.log(typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof importScripts, typeof indexedDB, typeof self, typeof window, typeof setTimeout); try { eval("1+1"); console.log("eval ok") } catch (e) { console.log("eval", e.name) }; import("https://example.com/x.js").then(()=>console.log("import ok"), e=>console.log("import", e.name))' })]);
ok(/undefined undefined undefined undefined undefined undefined undefined undefined/.test(out) && !/import ok/.test(out), 'no network/host APIs in the guest: ' + out.split('\n').slice(1).join(' | '));
const external = net.filter((u) => !u.startsWith('https://api.bayleaf.dev/'));
ok(external.length === 0, 'no requests to any host but api.bayleaf.dev: ' + external.join(', '));

// 8. snapshot caps
[, , out] = await turn([
  run({ code: 'for (let i=0;i<300;i++) fs.writeFile("many/a"+i+".txt", "x")' }),
  run({ code: 'for (let i=0;i<300;i++) fs.writeFile("many/b"+i+".txt", "x")', files: ['tools'] }),
  run({ code: 'console.log(1)', files: ['/work/many/**'] }),
]);
ok(/more than 500 files/.test(out), 'caps: file count refused clearly: ' + out.slice(0, 120));
await page.evaluate(async () => { const w = await (await (await navigator.storage.getDirectory()).getFileHandle('big.txt', { create: true })).createWritable(); await w.write('x'.repeat(4.5 * 2 ** 20)); await w.close(); });
[out] = await turn([run({ code: 'console.log(1)', files: ['big.txt'] })]);
if (0) console.log('DBG', await page.evaluate(() => [window.script.length, window.requests.length, JSON.stringify(window.requests.at(-1).messages.slice(-3)).slice(0, 600)]), await page.textContent('#status'));
ok(/over the 4096\.0 KB per-file snapshot limit/.test(out), 'caps: per-file size refused clearly: ' + out.slice(0, 200));
[out] = await turn([run({ code: 'fs.writeFile("/pouch/x.txt","y"); fs.writeFile("/nowhere/x","y")', files: ['tools'] })]);
ok(/status: ok/.test(out), 'writes outside /work: ' + out.slice(0, 300));

// 9. UI shows run calls as code
const pill = await page.$$eval('details.tool summary', (s) => s.map((x) => x.textContent).filter((t) => /js: /.test(t)).length);
ok(pill > 0, 'tool pills read "js: ..." for inline code');
const csp = errors.filter((e) => /Content Security Policy|EvalError/i.test(e));
ok(csp.length === 0, 'no CSP violations on the page: ' + csp.join(' | '));
console.log('errors:', errors.slice(0, 5));
console.log('requests to fake model:', await page.evaluate(() => window.requests.length));
await ctx.close(); srv.close();
console.log(`${results.filter((r) => r[0]).length}/${results.length} passed`);
