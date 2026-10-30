// Namespaces in the real page, with a scripted fake model (Tinfoil replaced at
// bundle time; every network request is answered locally or aborted, so no
// Sealed request is ever made). Checks: run reads and writes /work over 9P,
// a narrowed run cannot reach /pouch, a read-only bind refuses writes, the
// tray's Stop flushes a run, `echo kill > /task/<id>/ctl` kills one, /task
// status and ns, the seed layer (union, copy-up, whiteout), and the trust
// panel's mount lists.
// Run: node test/ns-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-ns-'));

// The fake model: each request takes the next step of window.script, either
// tool calls ({ calls: [[name, args], ...] }) or a final answer ({ text }).
const stub = `
window.requests = []; window.script = [];
const enc = new TextEncoder();
const chunk = (delta, finish = null) => ({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] });
const sse = (deltas) => new Response(new ReadableStream({ start(c) { for (const d of deltas) c.enqueue(enc.encode('data: ' + JSON.stringify(d) + '\\n\\n')); c.enqueue(enc.encode('data: [DONE]\\n\\n')); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Fake title' } }] }) } };
    this.secureClient = { fetch: async (url, init) => {
      const b = JSON.parse(init.body); window.requests.push(b);
      const step = window.script.shift() ?? { text: 'done' };
      if (step.text) return sse([chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop')]);
      return sse([chunk({ role: 'assistant', tool_calls: step.calls.map(([name, args], index) => ({ index, id: 'c' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name, arguments: JSON.stringify(args) } })) }), chunk({}, 'tool_calls')]);
    } };
  }
  async ready() {} async getVerificationDocument() { return { securityVerified: true }; }
}`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.js')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') },
  plugins: [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js' })); } }] });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };
const errors = [];
const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
try {
  await context.route('https://**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    return r.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('#badge.ok');
  await page.selectOption('#model', 'fake').catch(() => {});

  // One user turn: queue the steps, send, wait until the model has been asked
  // once per step plus the final answer. Returns the tool results the model saw.
  async function turn(steps, text = 'go') {
    const before = await page.evaluate(() => window.requests.length);
    await page.evaluate((s) => { window.script.push(...s); }, steps);
    await page.fill('#input', text);
    await page.click('#send');
    await page.waitForFunction((n) => window.requests.length >= n && document.getElementById('send-label').textContent === 'Send', before + steps.length, { timeout: 30000 });
    return page.evaluate((n) => window.requests.slice(n).map((b) => b.messages.filter((m) => m.role === 'tool').map((m) => typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('')).slice(-4)), before);
  }
  const last = (results) => results.at(-1);

  // 1. run reads and writes /work over 9P; /task shows it.
  let r = await turn([
    { calls: [['write', { path: 'data.txt', content: 'a\nb\nc\n' }]] },
    { calls: [['run', { code: 'const n = fs.readFile("data.txt").trim().split("\\n").length; fs.writeFile("out.txt", String(n)); fs.writeFile("/tmp/s.txt", "x"); console.log("lines", n);', files: ['data.txt'] }]] },
    { calls: [['bash', { command: 'cat out.txt; echo; ls /task; cat /task/1/status /task/1/ns /task/1/log' }]] },
    { text: 'done' },
  ]);
  const runOut = r[2].at(-1), bashOut = r[3].at(-1);
  assert.match(runOut, /status: ok/); assert.match(runOut, /lines 3/);
  assert.match(runOut, /changes applied \(1\): created \/work\/out\.txt/);
  assert.match(runOut, /1 scratch file\(s\) under \/tmp, discarded/);
  assert.match(bashOut, /^3\n1\ndone \d+\.\ds run const n/m, bashOut);
  assert.match(bashOut, /\/tmp {2}rw scratch\n\/work {2}rw (opfs|memory)/);
  assert.match(bashOut, /read 1 file\(s\), 6 B, over 9P/);
  ok('run reads and writes /work over 9P; /task/1 status, ns, log');

  // 2. Capabilities: a narrowed run cannot reach /pouch; a read-only bind refuses writes.
  r = await turn([
    { calls: [['run', { code: 'print(1)', ns: ['/work'], files: ['/pouch/AGENTS.md'] }]] },
    { calls: [['run', { code: 'print(fs.readFile("/pouch/AGENTS.md").length > 0)', files: ['/pouch/AGENTS.md'] }]] },
    { calls: [['bash', { command: 'mkdir -p sub && echo keep > sub/k.txt' }]] },
    { calls: [['run', { code: 'fs.writeFile("/work/sub/k.txt", "changed")', ns: ['/work/sub:ro'], files: ['/work/sub'] }]] },
    { calls: [['bash', { command: 'cat sub/k.txt; cat /task/3/ns' }]] },
    { text: 'done' },
  ]);
  assert.match(r[1].at(-1), /\/pouch\/AGENTS\.md is outside this run's namespace \(\/work\)/);
  assert.match(r[2].at(-1), /status: ok[\s\S]*true/);
  assert.match(r[4].at(-1), /conflicts, not applied \(1\): \/work\/sub\/k\.txt \(write failed: EROFS/);
  assert.match(r[5].at(-1), /^keep\n\/tmp {2}rw scratch\n\/work\/sub {2}ro .*\(narrowed\)/);
  ok('narrowed run cannot see /pouch; default run reaches it; :ro refuses writes');

  // 3. The tray's Stop flushes a run: its status says stopped, nothing lands.
  await page.evaluate(() => window.script.push(
    { calls: [['run', { code: 'fs.writeFile("never.txt", "x"); while (true) {}' }]] },
    { calls: [['bash', { command: 'ls never.txt 2>&1; for d in /task/*; do cat $d/status; done | grep -c stopped' }]] },
    { text: 'done' }));
  const n0 = await page.evaluate(() => window.requests.length);
  await page.fill('#input', 'loop'); await page.click('#send');
  const stopBtn = page.locator('#tray-list li[data-kind="run"] .tray-stop');
  await stopBtn.waitFor({ timeout: 15000 });
  const origin = await page.locator('#tray-list li[data-kind="run"] .tray-origin').textContent();
  assert.match(origin, /^run, \/task\/\d+$/);
  const title = await page.locator('#tray-list li[data-kind="run"] .tray-text').getAttribute('title');
  assert.match(title, /sees:\n\/tmp {2}rw scratch\n\/work {2}rw/);
  await stopBtn.click();
  await page.waitForFunction((n) => window.requests.length >= n + 3 && document.getElementById('send-label').textContent === 'Send', n0, { timeout: 30000 });
  r = await page.evaluate((n) => window.requests.slice(n).map((b) => b.messages.filter((m) => m.role === 'tool').map((m) => typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('')).at(-1)), n0);
  assert.match(r[1], /Stopped\./);
  assert.match(r[2], /No such file|cannot access|not found/i); assert.match(r[2], /\n1$/);
  ok('tray Stop flushes the run (tray row shows /task id and mounts)');

  // 4. echo kill > /task/<id>/ctl, from a bash call running beside the run.
  r = await turn([
    { calls: [['run', { code: 'while (true) {}' }], ['bash', { command: 'sleep 0.8; for d in /task/*; do grep -q "^running .* run " $d/status && echo kill > $d/ctl; done; sleep 0.2; for d in /task/*; do cat $d/status; done | grep -c killed' }]] },
    { text: 'done' },
  ]);
  const kill = r[1];
  assert.ok(kill.some((t) => /Killed through \/task\/\d+\/ctl\./.test(t)), kill.join('\n---\n'));
  assert.ok(kill.some((t) => /^1$/.test(t.trim())), kill.join('\n---\n'));
  ok('echo kill > /task/<id>/ctl stops a running run');

  // 5. Seed layer: /seed stacks /work over a tar; union, copy-up, whiteout, /seed off.
  await turn([{ calls: [['bash', { command: 'mkdir -p /tmp/s/lib && echo seed-a > /tmp/s/lib/a.txt && echo seed-b > /tmp/s/lib/b.txt && echo seed-readme > /tmp/s/README.md && tar -cf /work/starter.tar -C /tmp/s . && echo mine > README.md' }]] }, { text: 'ok' }]);
  await page.fill('#input', '/seed starter.tar'); await page.press('#input', 'Enter');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('stacked over starter.tar'));
  r = await turn([
    { calls: [['bash', { command: 'cat README.md lib/a.txt; echo more >> lib/a.txt; rm lib/b.txt; ls lib; rm README.md; test -e README.md || echo gone' }]] },
    { calls: [['run', { code: 'print(fs.readFile("/work/lib/a.txt"))', files: ['/work/lib'] }]] },
    { text: 'done' },
  ]);
  assert.equal(r[1].at(-1), 'mine\nseed-a\na.txt\ngone'); // rm of a file in both layers hides both
  assert.match(r[2].at(-1), /seed-a\nmore/);
  ok('seed layer: user file wins, append copies up, rm leaves a whiteout, run sees the union');

  // 6. Trust panel lists the mount tables.
  await page.click('#rail [data-panel="trust"]');
  await page.waitForFunction(() => document.getElementById('ns-facts').textContent.includes('/task/'));
  const facts = await page.textContent('#ns-facts');
  assert.match(facts, /\/work {2}rw (opfs|memory), ro seed starter\.tar/);
  assert.match(facts, /\/task {2}rw tasks/);
  assert.match(facts, /\/task\/3: run .*\(done\)[\s\S]*\/work\/sub {2}ro/);
  assert.equal(await page.isVisible('#seed-remove'), true);
  await page.click('#seed-remove');
  await page.waitForFunction(() => !document.getElementById('ns-facts').textContent.includes('seed'));
  ok('trust panel shows the agent and task mount tables; seed layer removable');

  // 7. A subagent works in its declared namespace over 9P: no /pouch, private /tmp, /work shared.
  r = await turn([
    { calls: [['subagent', { action: 'spawn', task: 'look around', name: 'looker', background: false, ns: ['/work'] }]] },
    { calls: [['bash', { command: 'ls /; echo sub > /tmp/t.txt; echo from-sub > sub-wrote.txt; cat /pouch/AGENTS.md 2>&1 | head -1' }]] },
    { text: 'child report' },
    { calls: [['bash', { command: 'cat sub-wrote.txt; test -e /tmp/t.txt || echo private-tmp; for d in /task/*; do cat $d/status; done | grep subagent' }]] },
    { text: 'done' },
  ]);
  const child = r[2].at(-1), parent = r[4].at(-1);
  assert.match(child, /^tmp\nwork\n/, child);
  assert.match(child, /No such file or directory/);
  assert.match(parent, /^from-sub\nprivate-tmp\ndone [\d.]+s subagent looker/m, parent);
  ok('subagent sees only its declared namespace over 9P; writes land in /work');

  assert.deepEqual(errors, []);
  console.log(`ns-browser: ${passed} passed`);
} finally {
  await context.close();
  server.close();
}
