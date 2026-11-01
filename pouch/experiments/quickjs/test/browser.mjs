// Playwright check of dist/index.html in headless Chromium.
//   node build.mjs && node test/browser.mjs
// Serves dist/ on a free local port, drives run/timeout/cancel/oom/apply, and
// fails on any CSP violation or any request other than the page itself.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { launch, instrument } from '/tmp/pouch-qa/lib.mjs';

const html = readFileSync(new URL('../dist/index.html', import.meta.url));
const server = createServer((req, res) => {
  if (req.url !== '/index.html') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const ctx = await launch({ userDataDir: '/tmp/pouch-qa/qjs-profile', fresh: true });
const page = await ctx.newPage();
const errors = instrument(page, 'page');
const requests = [];
ctx.on('request', (r) => requests.push(r.url()));
await page.addInitScript(() => {
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
});

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
async function runPreset(name, { time = 2000, mem = 32, cancelAfter } = {}) {
  await page.click(`button[data-preset="${name}"]`);
  await page.fill('#time', String(time)); await page.fill('#mem', String(mem));
  const t = Date.now();
  await page.click('#run');
  if (cancelAfter) { await page.waitForTimeout(cancelAfter); await page.click('#cancel'); }
  await page.waitForFunction(() => document.querySelector('#status').textContent !== 'running', null, { timeout: 30000 });
  return { status: await page.textContent('#status'), out: await page.textContent('#out'), changes: await page.textContent('#changes'), ms: Date.now() - t };
}

await page.goto(url);
let r = await runPreset('hello');
check('run hello', r.status.startsWith('ok') && r.out.includes('hello from QuickJS ["demo"] 0') && r.out.includes('notes.md 14'), `${r.status} ${r.ms} ms`);

r = await runPreset('write');
check('proposed changes', r.changes.includes('create /out/count.json') && r.changes.includes('modify /src/notes.md') && r.changes.includes('delete /src/old.txt'), r.changes.replace(/\n/g, '; '));
await page.click('#apply');
let files = await page.textContent('#files');
check('apply clean', files.includes('/out/count.json') && !files.includes('/src/old.txt'), files.replace(/\n/g, '; '));

r = await runPreset('write'); // old.txt is gone now, so rm throws: an error, no changes
check('guest error surfaces', r.status.startsWith('error') && r.out.includes('ENOENT'), r.status);
await page.fill('#code', 'fs.writeFile("/src/notes.md", "from guest")');
await page.click('#run');
await page.waitForFunction(() => !document.querySelector('#apply').disabled);
await page.click('#touch');
await page.click('#apply');
check('apply conflict', (await page.textContent('#changes')).includes('conflict /src/notes.md: file changed since the snapshot'));

r = await runPreset('loop', { time: 500 });
check('timeout', r.status.startsWith('timeout'), `${r.status} ${r.ms} ms`);

r = await runPreset('loop', { time: 60000, cancelAfter: 400 });
check('cancel', r.status.startsWith('cancelled') && r.ms < 3000, `${r.status} ${r.ms} ms`);

r = await runPreset('oom', { mem: 16 });
check('oom', r.status.startsWith('oom'), `${r.status} ${r.ms} ms`);

r = await runPreset('escape');
check('no host globals in guest', r.out.startsWith('undefined undefined undefined undefined') && r.out.includes("could not load module 'x'"), r.out.replace(/\n/g, '; '));

r = await runPreset('hello');
check('page stays usable after oom/cancel', r.status.startsWith('ok'));

const violations = await page.evaluate(() => window.__violations);
check('no CSP violations during the demo', violations.length === 0, violations.join('; '));
const others = requests.filter((u) => u !== url && !u.startsWith('blob:') && !u.startsWith('data:'));
check('no network besides the page', others.length === 0, others.join(' ') || `${requests.length} request(s): ${[...new Set(requests.map((u) => u.split(':')[0]))].join(',')}`);
check('no console errors', errors.length === 0, errors.join('; '));

// Policy probe (after the checks above, since it violates CSP on purpose):
// a blob: worker inherits the page's policy, so eval and foreign fetches stay
// blocked inside it while wasm compiles. The page itself still forbids eval.
const probe = await page.evaluate(async () => {
  const src = `
    const out = {};
    try { eval('1'); out.eval = 'allowed'; } catch (e) { out.eval = e.name; }
    try { new Function('return 1'); out.fn = 'allowed'; } catch (e) { out.fn = e.name; }
    try { await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); out.wasm = 'compiled'; } catch (e) { out.wasm = e.name; }
    try { await fetch('https://example.com/'); out.fetch = 'allowed'; } catch (e) { out.fetch = e.name; }
    postMessage(out);`;
  const w = new Worker(URL.createObjectURL(new Blob([`(async () => {${src}})()`], { type: 'text/javascript' })));
  const worker = await new Promise((res) => { w.onmessage = (e) => res(e.data); });
  w.terminate();
  let pageEval; try { (0, eval)('1'); pageEval = 'allowed'; } catch (e) { pageEval = e.name; }
  // A refused worker fails asynchronously (error event), not in the constructor.
  const dataWorker = await new Promise((res) => {
    try {
      const d = new Worker('data:text/javascript,postMessage(1)');
      d.onmessage = () => { d.terminate(); res('allowed'); };
      d.onerror = () => res('refused');
      setTimeout(() => res('no answer'), 2000);
    } catch (e) { res(e.name); }
  });
  return { worker, pageEval, dataWorker };
});
check('worker inherits CSP: eval blocked', probe.worker.eval === 'EvalError' && probe.worker.fn === 'EvalError', JSON.stringify(probe.worker));
check('worker inherits CSP: wasm ok, foreign fetch blocked', probe.worker.wasm === 'compiled' && probe.worker.fetch === 'TypeError');
check('page eval still blocked', probe.pageEval === 'EvalError', probe.pageEval);
check('data: worker blocked', probe.dataWorker === 'refused' || probe.dataWorker === 'SecurityError', probe.dataWorker);
check('probe made no request', !requests.some((u) => u.includes('example.com')), requests.filter((u) => u.includes('example')).join(' '));

await ctx.close();
server.close();
console.log(failures ? `${failures} FAIL` : 'ALL PASS');
process.exit(failures ? 1 : 0);
