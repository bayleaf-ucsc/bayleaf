// Investigate and steer a working subagent (JOURNEYS S1-S5, D21 chevron) in
// the real page, with a scripted fake model (Tinfoil replaced at bundle time;
// every network request is answered locally or aborted, so no Sealed request
// is ever made). The fake answers the parent from window.script and a
// subagent (recognised by its system prompt) from window.childScript; a step
// with `gate` waits until window.gates[gate] is set, so the test decides when
// each child step ends, and `slow` streams its text in pieces.
// Checks: tray and card disclosure orientation in both states; the card's
// transcript appears the moment it is opened, live and after the child
// finished; nested session rows with live state; the subagent view streams;
// a steering message reaches the model in its next request, is marked in both
// views, and is quoted in the parent's report; the composer refuses after the
// child finished; Stop from the subagent view.
// Run: node test/subagent-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-sa-'));
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });

const stub = `
window.requests = []; window.childRequests = []; window.script = []; window.childScript = []; window.gates = {};
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (delta, finish = null) => ({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] });
const sse = (deltas, slow = 0, signal) => new Response(new ReadableStream({ async start(c) {
  for (const d of deltas) { if (signal?.aborted) return c.error(new DOMException('Aborted', 'AbortError')); c.enqueue(enc.encode('data: ' + JSON.stringify(d) + '\\n\\n')); if (slow) await sleep(slow); }
  c.enqueue(enc.encode('data: [DONE]\\n\\n')); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Fake title' } }] }) } };
    this.secureClient = { fetch: async (url, init) => {
      const b = JSON.parse(init.body);
      const child = JSON.stringify(b.messages[0] ?? '').includes('You are a subagent named');
      (child ? window.childRequests : window.requests).push(b);
      const step = (child ? window.childScript : window.script).shift() ?? { text: 'done' };
      while (step.gate && !window.gates[step.gate]) {
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await sleep(30);
      }
      if (step.text) {
        const parts = step.slow ? step.text.match(/.{1,6}/gs) : [step.text];
        return sse([chunk({ role: 'assistant', content: '' }), ...parts.map((p) => chunk({ content: p })), chunk({}, 'stop')], step.slow, init.signal);
      }
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
const T = { timeout: 15000 };
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
  const userTexts = (b) => b.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : m.content.map((c) => c.text ?? '').join('')).join('\n');

  // A parent turn that spawns "scout"; scout's three steps wait on gates.
  await page.evaluate(() => {
    window.script.push({ calls: [['subagent', { action: 'spawn', name: 'scout', task: 'Look around /work and report.' }]] }, { text: 'Started scout.' }, { text: 'Thanks for the report.' });
    window.childScript.push({ gate: 'g1', calls: [['bash', { command: 'echo one' }]] }, { gate: 'g2', calls: [['bash', { command: 'echo two' }]] }, { gate: 'g3', slow: 60, text: 'Scout final answer: all good here, nothing more to add at all.' });
  });
  await page.fill('#input', 'go');
  await page.click('#send');
  await page.waitForFunction(() => window.requests.length >= 2 && window.childRequests.length >= 1 && document.getElementById('send-label').textContent === 'Send', null, T);
  await page.waitForSelector('#tray:not([hidden]) .tray-row[data-kind="subagent"]', T);

  // 1. Tray chevron: open points down (folds down), collapsed points up (opens upward).
  const chevron = () => page.evaluate(() => { const t = document.getElementById('tray-toggle'); return { points: t.dataset.points, expanded: t.ariaExpanded, transform: getComputedStyle(t.querySelector('svg')).transform }; });
  await page.waitForTimeout(200);
  let ch = await chevron();
  assert.equal(ch.points, 'down'); assert.equal(ch.expanded, 'true');
  assert.match(ch.transform, /^matrix\(-1, .*0, -1/, 'open tray: up-chevron rotated 180deg (points down)');
  await page.click('#tray-toggle'); await page.waitForTimeout(200);
  ch = await chevron();
  assert.equal(ch.points, 'up'); assert.equal(ch.expanded, 'false');
  assert.ok(ch.transform === 'none' || /^matrix\(1, 0, 0, 1/.test(ch.transform), 'collapsed tray: chevron points up, got ' + ch.transform);
  await page.click('#tray-toggle');
  ok('tray chevron: down while open, up while collapsed');

  // 2. Card disclosure: content appears in the same task as the click, live.
  await page.evaluate(() => { window.gates.g1 = true; });
  await page.waitForFunction(() => window.childRequests.length >= 2, null, T);
  await page.waitForTimeout(300);
  // 'toggle' fires one task after the click; 40 ms is well inside the 1 s re-render tick.
  const opened = await page.evaluate(async () => {
    const d = document.querySelector('.subagent details.sa-log');
    const closedMarker = getComputedStyle(d.querySelector('summary')).display;
    d.querySelector('summary').click();
    await new Promise((r) => setTimeout(r, 40));
    return { closedMarker, open: d.open, text: d.querySelector('.sa-items')?.textContent ?? null };
  });
  assert.equal(opened.closedMarker, 'list-item', 'card disclosure keeps the native twisty (right closed, down open)');
  assert.ok(opened.open && opened.text, 'card body exists right after the click');
  assert.match(opened.text, /Task[\s\S]*Look around[\s\S]*bash: echo one/);
  ok('card disclosure shows the transcript at once while the child runs (compact tool line)');

  // 3. Session panel: the child nested under its session, live state, links.
  if ((await page.getAttribute('#flipper', 'aria-expanded')) !== 'true') await page.click('#flipper');
  await page.waitForSelector('#session-list .session .s-children .s-child', T);
  assert.equal(await page.textContent('#session-list .s-child .s-child-name'), 'scout');
  assert.equal(await page.textContent('#session-list .s-child .s-child-state'), 'working');
  assert.ok(await page.$('.subagent .sa-acts button[aria-label="Open subagent scout"]'), 'card has Open');
  assert.ok(await page.$('.tray-row[data-kind="subagent"] button.tray-text'), 'tray row links to the child');
  await page.screenshot({ path: join(shots, 'steer-1-session-panel.png') });
  ok('session panel nests the running child with state "working"; card and tray link to it');

  // 4. Open its view from the tray: header, mounts, and a live transcript.
  await page.click('.tray-row[data-kind="subagent"] button.tray-text');
  await page.waitForSelector('#log.child-view .sa-view-head', T);
  const head = await page.textContent('.sa-view-head');
  assert.match(head, /scout/); assert.match(head, /subagent of/); assert.match(head, /Look around/);
  const mounts = await page.$$eval('.sa-view-head .sa-mounts code', (n) => n.map((x) => x.textContent));
  assert.ok(mounts.some((m) => m.startsWith('/work')), 'mounts listed: ' + mounts.join(', '));
  assert.ok(!mounts.some((m) => m.startsWith('/task')), 'a subagent has no /task');
  await page.waitForSelector('#session-list .s-child-open[aria-current="true"]', T);
  assert.match(await page.getAttribute('#input', 'placeholder'), /^Steer scout/);
  assert.match(await page.textContent('#log'), /echo one/);
  ok('subagent view: labeled with parent, task and mounts; tool calls shown');

  // 5. Steer while it waits on its second request; it must arrive in the next one.
  await page.fill('#input', 'Please also check README.md');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => document.getElementById('input').value === '', null, T);
  assert.ok(!userTexts((await page.evaluate(() => window.childRequests))[1]).includes('check README'), 'not in the request already in flight');
  await page.evaluate(() => { window.gates.g2 = true; });
  await page.waitForFunction(() => window.childRequests.length >= 3, null, T);
  const third = await page.evaluate(() => window.childRequests[2]);
  assert.match(userTexts(third), /Message from the user[\s\S]*Please also check README\.md/);
  await page.waitForSelector('#log.child-view .msg.user.steer', T);
  assert.match(await page.textContent('#log .msg.user.steer'), /You, while it worked[\s\S]*Please also check README/);
  assert.match(await page.textContent('#log'), /echo two/, 'the view followed the second step live');
  ok('steering text reached the model in its next request and shows marked in the view');

  // 6. The final answer streams into the open view.
  await page.evaluate(() => { window.gates.g3 = true; });
  await page.waitForSelector('#log.child-view .msg.assistant.streaming', T);
  await page.screenshot({ path: join(shots, 'steer-2-subagent-view.png') });
  ok('subagent view streams the reply as it arrives');

  // 7. Finished: the composer refuses and offers the way back; the parent is told.
  await page.waitForFunction(() => document.getElementById('input').disabled, null, T);
  assert.match(await page.getAttribute('#input', 'placeholder'), /scout has finished/);
  assert.ok(await page.isDisabled('#send'));
  assert.match(await page.textContent('#log .sa-ended'), /finished[\s\S]*Back to/);
  await page.waitForFunction(() => window.requests.length >= 3, null, T);
  const report = userTexts(await page.evaluate(() => window.requests[2]));
  assert.match(report, /The user steered this subagent[\s\S]*"Please also check README\.md"/);
  await page.waitForFunction(() => document.querySelector('#session-list .s-child-state')?.textContent === 'done', null, T);
  ok('after finish: composer disabled with a reason, report quotes the steering, sidebar says done');

  // 8. Back in the parent: the card shows the compact transcript and the final answer.
  await page.click('#log .sa-ended button');
  await page.waitForSelector('#log:not(.child-view) .subagent', T);
  assert.equal(await page.getAttribute('#input', 'placeholder'), 'Ask Pouch. @ for files, $ for skills, / for commands');
  assert.ok(!(await page.isDisabled('#input')));
  await page.waitForSelector('.subagent details.sa-log[open] .sa-final', T);
  const card = await page.textContent('.subagent details.sa-log');
  assert.match(card, /steered by you once/);
  assert.match(card, /You, while it worked[\s\S]*Please also check README/);
  assert.match(card, /Final answer[\s\S]*Scout final answer/);
  assert.equal(await page.$$eval('.subagent .sa-items details.tool', (n) => n.length), 0, 'tool calls are one line each');
  const reopened = await page.evaluate(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 40));
    const d = document.querySelector('.subagent details.sa-log');
    d.querySelector('summary').click(); await tick(); // close
    d.querySelector('.sa-items')?.remove(); // as a fresh render would have it
    d.querySelector('summary').click(); await tick(); // open again, after the child finished
    return d.querySelector('.sa-final')?.textContent ?? null;
  });
  assert.match(reopened ?? '', /Scout final answer/);
  await page.locator('.subagent').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'steer-3-parent-card.png') });
  ok('parent card: compact transcript, steering marked, final answer prominent, opens after finish');

  // 9. Stop from the subagent view (opened from the session panel).
  await page.evaluate(() => {
    window.script.push({ calls: [['subagent', { action: 'spawn', name: 'stopper', task: 'Wait forever.' }]] }, { text: 'Started stopper.' });
    window.childScript.push({ gate: 'never', calls: [['bash', { command: 'echo never' }]] });
  });
  const before = await page.evaluate(() => window.childRequests.length);
  await page.fill('#input', 'again');
  await page.click('#send');
  await page.waitForFunction((n) => window.childRequests.length > n, before, T);
  await page.click('#session-list .s-child[data-child] .s-child-open >> text=stopper');
  await page.waitForSelector('#log.child-view .sa-view-head', T);
  assert.match(await page.textContent('.sa-view-head .sa-name'), /stopper/);
  const t0 = Date.now();
  await page.click('.sa-view-head button.danger');
  await page.waitForFunction(() => /stopped/.test(document.querySelector('.sa-view-head .sa-status')?.textContent ?? ''), null, T);
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(await page.isDisabled('#input'));
  ok(`Stop from the subagent view (${Date.now() - t0} ms), composer then disabled`);

  assert.deepEqual(errors, []);
  ok('no page errors');
  console.log(`\n${passed} passed; screenshots in ${shots}`);
} finally {
  await context.close();
  server.close();
}
