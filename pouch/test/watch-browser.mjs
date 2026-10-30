// File watches in the real page (JOURNEYS G13-G17), with the scripted fake in
// test/graph-fixture.js bundled in place of Tinfoil: no Sealed request is
// made. Covers by-user filtering, the event text, busy batching vs idle wake,
// user-first ordering, the wake cap and Deliver, once, Stop watching from the
// tray and via /task ctl, subagent scoping, reload re-arm and a closed-tab
// change, and measures the two open AX cases (multi-file drop, rapid saves).
// Run: node test/watch-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-watch-'));
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });

const stub = `
import { createFake, panelRules } from './test/graph-fixture.js';
window.fake = createFake(); window.panelRules = panelRules;
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Fake title' } }] }) } };
    this.secureClient = { fetch: (u, i) => window.fake.fetch(u, i) };
  }
  async ready() {} async getVerificationDocument() { return { securityVerified: true }; }
}`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.js')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') },
  plugins: [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js', resolveDir: root })); } }] });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };
const measured = [];
const errors = [];
const T = { timeout: 15000 };
const ESSAY = '# Walkable towns\n\nTowns should be walkable.\n\nWalking cuts car trips by 40%.\n\nA second example about parking.\n\nSo plan for feet.\n';
const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
try {
  await context.route('https://**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    return r.abort();
  });
  let page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const boot = async () => {
    await page.waitForSelector('#badge.ok');
    await page.selectOption('#model', 'fake').catch(() => {});
    await page.click('#welcome button >> text=Got it').catch(() => {});
  };
  await page.goto(url);
  await boot();
  const seen = (who) => page.evaluate((w) => window.fake.seen(w), who);
  const reqs = (who = 'main') => page.evaluate((w) => (window.fake.requests[w] ?? []).map((b) => b.messages.map((m) => typeof m.content === 'string' ? m.content : (m.content ?? []).map((x) => x.text ?? '').join('')).join('\n---\n')), who);
  const rule = (r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r);
  const send = async (text) => { await page.fill('#input', text); await page.press('#input', 'Enter'); };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  const lastReply = () => page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? '');
  const replyIs = (re) => page.waitForFunction((s) => new RegExp(s).test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), re.source, T);
  // Requests main made because a watch event reached it (the event is the newest input).
  const wakeReqs = () => page.evaluate(() => (window.fake.requests.main ?? []).filter((b) => { const l = b.messages.findLastIndex((m) => m.role === 'assistant'); return b.messages.slice(l + 1).some((m) => String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes('[from files]')); }).length);
  const sinceAll = () => page.evaluate(() => (window.fake.requests.main ?? []).map((b) => { const l = b.messages.findLastIndex((m) => m.role === 'assistant'); return b.messages.slice(l + 1).map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n'); }));
  const nMain = () => page.evaluate(() => window.fake.requests.main?.length ?? 0);
  const trayWatch = () => page.evaluate(() => [...document.querySelectorAll('.tray-row[data-kind="watch"]')].map((r) => r.querySelector('.tray-text').textContent + ' | ' + r.querySelector('.tray-origin').textContent));
  const openEssay = async () => {
    await page.click('#tree .row[data-path="/work/essay.md"]');
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Walkable'), null, T);
  };
  const editAndSave = async (text) => {
    await page.click('.cm-content');
    await page.keyboard.press('Control+End'); await page.keyboard.press('Meta+ArrowDown');
    await page.keyboard.type(text);
    await page.evaluate(() => document.getElementById('save').click());
  };
  const dropFiles = (dir, files) => page.evaluate(({ dir, files }) => {
    const dt = new DataTransfer();
    for (const [n, t] of files) dt.items.add(new File([t], n, { type: 'text/csv' }));
    document.querySelector(`#tree .row[data-path="${dir}"]`).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { dir, files });

  // ── Setup: the essay, written by the agent (no watch yet) ──
  await rule({ who: 'main', when: '/setup/.test(c.since)', reply: [['write', { path: '/work/essay.md', content: ESSAY }]] });
  await rule({ who: 'main', when: '/Wrote/.test(c.since)', reply: 'Wrote essay.md.' });
  await send('setup the essay');
  await replyIs(/Wrote essay\.md/);
  await idle();
  const tools = await page.evaluate(() => window.fake.requests.main.at(-1).tools.map((t) => t.function.name));
  assert.ok(tools.includes('watch'), 'main is offered the watch tool: ' + tools);
  assert.match(await page.evaluate(() => window.fake.requests.main.at(-1).messages[0].content), /The watch tool tells you when files change\. Instead of asking the user/);
  ok('the watch tool is offered to main; the prompt carries the watch gloss');

  // ── G8 context: a panel review first (chair s2, judges s3-s6) ──
  await page.evaluate(() => window.panelRules(window.fake));
  await send('review this draft with the panel');
  await replyIs(/The panel suggests/);
  await idle();
  await page.waitForFunction(() => [...document.querySelectorAll('#session-list .s-child-state')].length === 5 && [...document.querySelectorAll('#session-list .s-child-state')].every((s) => s.textContent !== 'working'), null, { timeout: 20000 });

  // ── G13: main registers watch(essay.md, by user, note) and says so in one line ──
  await rule({ who: 'main', when: '/revise it myself/.test(c.since)', reply: [['watch', { action: 'watch', paths: ['/work/essay.md'], by: 'user', note: 'offer to re-run the panel' }]] });
  await rule({ who: 'main', when: '/Watching \\/work\\/essay\\.md as w1/.test(c.since)', reply: 'I am watching essay.md: save your revision and I will offer to re-run the panel.' });
  await send('Thanks. I will revise it myself.');
  await replyIs(/watching essay\.md/);
  await idle();
  assert.match((await trayWatch()).join('\n'), /Watching essay\.md: offer to re-run the panel \| w1 · changes by you · \/task\/watch\/w1/);
  ok('G13: main watches essay.md (by user, note), says so in one line; tray row with note, path and /task/watch/w1');

  // ── by-user filtering: an agent edit and a run write do not fire ──
  const before = await nMain();
  await rule({ who: 'main', when: '/typo/.test(c.since)', reply: [['edit', { path: '/work/essay.md', edits: [{ oldText: 'So plan for feet.', newText: 'So, plan for feet.' }] }]] });
  await rule({ who: 'main', when: '/Applied/.test(c.since) && /typo/.test(c.all.slice(-800))', reply: [['run', { code: "fs.writeFile('essay.md', fs.readFile('essay.md') + 'Run line.\\n'); print('ok')" }]] });
  await rule({ who: 'main', when: '/changes applied|exit 0|status/.test(c.since)', reply: 'Fixed the typo and appended a line by script.' });
  await send('fix the typo');
  await replyIs(/Fixed the typo/);
  await idle();
  await page.waitForTimeout(600);
  assert.equal(await nMain(), before + 3, 'three requests for the turn, none from the watch');
  assert.equal(await wakeReqs(), 0);
  assert.match(await page.evaluate(() => window.fake.requests.main.at(-2).messages.at(-1).content), /essay\.md/, 'the run did write essay.md');
  ok('by user: main\'s edit and a run script\'s write of essay.md do not fire the watch');

  // ── G14: the user edits in the editor and saves; main wakes with the change summary ──
  // The re-run reuses the idle chair and judges: message + join, no new spawns.
  await rule({ who: 'main', when: '/\\[from files\\] essay\\.md changed by you: lines? /.test(c.since)', reply: 'You changed essay.md. Re-run the whole panel, or only the judges your edit touches (clarity, audience)?' });
  await openEssay();
  await editAndSave('\nA new closing paragraph about trees.\nAnd shade.');
  await replyIs(/Re-run the whole panel/);
  await idle();
  const wake1 = (await reqs()).at(-1);
  const evLine = wake1.match(/\[from files\][^\n]*/)[0];
  assert.match(evLine, /^\[from files\] essay\.md changed by you: lines \d+-\d+ \(\+\d+ -\d+\)$/);
  assert.match(wake1, /\[watch w1, your note: offer to re-run the panel; unwatch w1 to stop\]/);
  assert.doesNotMatch(wake1.split('[from files]').at(-1), /closing paragraph about trees/, 'the event carries no content');
  await page.waitForSelector('#log .msg.from.watch .msg-from >> text=Woken by watch w1: offer to re-run the panel', T);
  await page.screenshot({ path: join(shots, 'watch-woken-turn.png') });
  ok(`G14: an editor save woke main with "${evLine}"; the turn is labeled "Woken by watch w1: offer to re-run the panel"`);

  await rule({ who: 'main', when: '/whole panel/.test(c.since)', reply: [['subagent', { action: 'message', to: 's2', text: 'ROUND2: the user revised essay.md. Ask each judge (s3-s6) to re-judge, join them, then send me the new review.' }]] });
  await rule({ who: 'main', when: '/Sent to chair \\(s2\\)|woke it/.test(c.since)', reply: [['subagent', { action: 'join', ids: ['s2'] }]] });
  await rule({ who: 'main', when: '/Second review/.test(c.since)', reply: 'Second review: the new ending works; the 40% claim still needs a source.' });
  await page.evaluate(() => {
    const f = window.fake, J = ['argument', 'evidence', 'clarity', 'audience'];
    f.rules.unshift({ who: 'chair', when: (c) => c.since.includes('[from main (s1)] ROUND2'), reply: J.map((j, i) => ['agents', { action: 'message', to: `s${i + 3}`, text: `ROUND2: re-judge the ${j} of the revised essay; just reply with your finding.` }]) });
    f.rules.unshift({ who: 'chair', when: (c) => /woke it/.test(c.since) && c.all.includes('ROUND2'), reply: [['agents', { action: 'join', ids: ['s3', 's4', 's5', 's6'] }]] });
    f.rules.unshift({ who: 'chair', when: (c) => /Joined:|quiet/.test(c.since) && c.all.includes('ROUND2'), reply: [['agents', { action: 'message', to: 's1', text: 'Second review: the new ending works; the 40% claim still needs a source.' }]] });
    f.rules.unshift({ who: 'chair', when: (c) => /Sent to main/.test(c.since) && c.all.includes('ROUND2'), reply: 'Sent the second review.' });
    for (const j of J) f.rules.unshift({ who: `judge-${j}`, when: (c) => c.since.includes('[from chair (s2)] ROUND2'), reply: `ROUND2-${j}: fine.` });
  });
  await send('the whole panel please');
  await replyIs(/Second review: the new ending works/);
  await idle();
  const chairAll = (await reqs('chair')).at(-1);
  assert.match(chairAll, /\[from main \(s1\)\] Judges: s3 argument[\s\S]*RAW-evidence/, 'the chair kept its first-round context');
  assert.match(chairAll, /ROUND2-evidence: fine/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#session-list .s-child').length), 5, 'no new subagents');
  ok('G14: the re-run reused the idle chair and judges by message + join (the chair kept its first-round context; still 5 subagents)');

  // ── busy batching: saves while main works join its next step ──
  await rule({ who: 'main', when: '/long task/.test(c.since)', gate: 'busy1', reply: [['bash', { command: 'echo working' }]] });
  await rule({ who: 'main', when: '/working/.test(c.since)', reply: 'Done with the long task.' });
  const wakesBefore = await wakeReqs();
  await send('a long task');
  await page.waitForFunction(() => window.fake.requests.main.at(-1).messages.at(-1).content.includes('long task'), null, T);
  await editAndSave('\nBusy edit one.');
  await page.waitForTimeout(150);
  await editAndSave('\nBusy edit two.');
  await page.waitForTimeout(700); // past the 300 ms settle, so the events are queued for the next step
  await page.evaluate(() => { window.fake.gates.busy1 = true; });
  await replyIs(/Done with the long task/);
  await idle();
  const evs = (await sinceAll()).slice(-3).flatMap((x) => x.match(/\[from files\][^\n]*/g) ?? []);
  assert.equal(await wakeReqs(), wakesBefore + 1, 'one request carried the events (the next step), no extra wake');
  measured.push(`busy batching: 2 saves 150 ms apart during a running turn reached main in its next step (one request) as ${evs.length} event line(s): ${JSON.stringify(evs)}`);
  ok('busy: two saves during a running turn joined its next step, no separate wake');

  // ── user first: a queued user message goes before a watch event ──
  await rule({ who: 'main', when: '/second long task/.test(c.since)', gate: 'busy2', reply: [['bash', { command: 'echo working2' }]] });
  await rule({ who: 'main', when: '/working2/.test(c.since)', reply: 'Done with the second task.' });
  await rule({ who: 'main', when: '/QUEUED-MSG/.test(c.since)', reply: 'Answered your queued message.' });
  const q0 = await nMain();
  await send('second long task');
  await page.waitForFunction(() => window.fake.requests.main.at(-1).messages.at(-1).content.includes('second long task'), null, T);
  await page.fill('#input', 'QUEUED-MSG what about the title?');
  await page.press('#input', 'Alt+Enter');
  await page.waitForSelector('.tray-row[data-kind="queued"]', T);
  await editAndSave('\nEdit while a message is queued.');
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.fake.gates.busy2 = true; });
  await replyIs(/Answered your queued message|You changed/);
  await idle();
  await page.waitForTimeout(500); await idle();
  // Each request's new input (after its last assistant message), in order.
  const sinces = (await page.evaluate(() => (window.fake.requests.main ?? []).map((b) => { const l = b.messages.findLastIndex((m) => m.role === 'assistant'); return b.messages.slice(l + 1).map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n'); }))).slice(q0);
  const iq = sinces.findIndex((x) => x.includes('QUEUED-MSG')), iev = sinces.findIndex((x) => x.includes('[from files]'));
  const sameReqOrder = iq === iev ? sinces[iq].indexOf('QUEUED-MSG') < sinces[iq].indexOf('[from files]') : iq < iev;
  assert.ok(iq >= 0 && iev >= 0 && sameReqOrder, `the queued user message reached main before the watch event (requests ${iq}, ${iev}): ${JSON.stringify(sinces.map((x) => x.slice(0, 80)))}`);
  measured.push(`user-first: the queued message started request ${iq} of that stretch, the watch event arrived in request ${iev}${iq === iev ? ' (same step, after it)' : ''}`);
  ok('user-first: the queued user message went first; the watch event followed it');

  // ── rapid saves (G14 open question): three saves 120 ms apart, main idle ──
  // A user message first, so the wake cap starts over and does not shape the result.
  await rule({ who: 'main', when: '/keep going/.test(c.since)', reply: 'Sure.' });
  await send('keep going'); await replyIs(/^Sure\.$/); await idle();
  await page.evaluate(() => { window.fake.rules.unshift({ who: 'main', sticky: true, when: (c) => /\[from files\]/.test(c.since) && !/QUEUED/.test(c.since.slice(-50)), reply: 'Noted your edit.' }); });
  const w0 = await wakeReqs(), n0 = await nMain();
  for (const i of [1, 2, 3]) { await editAndSave(`\nRapid ${i}.`); await page.waitForTimeout(120); }
  await page.waitForTimeout(1200); await idle();
  const rapid = (await wakeReqs()) - w0;
  const held = await trayWatch();
  const perWake = (await sinceAll()).slice(n0).filter((x) => x.includes('[from files]')).map((x) => (x.match(/\[from files\][^\n]*/g) ?? []).map((l) => l.replace('[from files] essay.md changed by you', '')).join(' + '));
  measured.push(`rapid saves: 3 saves 120 ms apart on an idle main (fake answers at once) gave ${rapid} watch request(s): ${JSON.stringify(perWake)}; tray after: ${JSON.stringify(held)}`);
  assert.equal(rapid, 1, 'rapid saves settle into one wake');
  assert.equal(perWake.length, 1); assert.match(perWake[0], /3 writes/, 'that wake names all three saves: ' + perWake[0]);
  ok(`rapid saves: ${rapid} wake request for 3 saves, all in it`);

  // ── wake cap: 3 wakes without user input, then held in the tray; Deliver ──
  // Count wakes since the user's last message ("the whole panel" turn and later saves).
  for (let i = 0; i < 4 && !(await trayWatch()).some((t) => /not delivered/.test(t)); i++) { await editAndSave(`\nCap ${i}.`); await page.waitForTimeout(700); await idle(); }
  const capRow = (await trayWatch()).find((t) => /not delivered/.test(t));
  assert.ok(capRow, 'a held row appeared: ' + (await trayWatch()));
  assert.match(capRow, /^\d+ changes? to essay\.md, not delivered \| w1/);
  const wb = await wakeReqs();
  await page.click('.tray-row[data-kind="watch"] [data-act="deliver"]');
  await page.waitForFunction((n) => (window.fake.requests.main ?? []).length && true, wb, T);
  await page.waitForTimeout(800); await idle();
  assert.equal(await wakeReqs(), wb + 1, 'Deliver woke main once');
  assert.doesNotMatch((await trayWatch()).join(), /not delivered/);
  ok(`wake cap: after ${3} wakes without user input the tray shows "${capRow.split(' | ')[0]}"; Deliver woke main once`);

  // ── G15: the user said one review is enough: main unwatches instead of offering ──
  await page.evaluate(() => { const f = window.fake; f.rules.splice(0, f.rules.length, ...f.rules.filter((r) => !(r.who === 'main' && r.sticky))); });
  await rule({ who: 'main', when: '/one review is enough/.test(c.since)', reply: 'Understood.' });
  await send('One review is enough for this essay.');
  await idle();
  await rule({ who: 'main', when: '/\\[from files\\]/.test(c.since) && /one review is enough/i.test(c.all)', reply: [['watch', { action: 'unwatch', id: 'w1' }]] });
  await rule({ who: 'main', when: '/Stopped watching/.test(c.since)', reply: 'You said one review is enough, so I stopped watching essay.md.' });
  await editAndSave('\nFinal tweak.');
  await replyIs(/stopped watching essay\.md/);
  await idle();
  assert.deepEqual(await trayWatch(), []);
  ok('G15: after "one review is enough", the next save made main unwatch and say so; the tray row is gone');

  // ── Stop watching from the tray, and via /task ctl ──
  await rule({ who: 'main', when: '/watch notes/.test(c.since)', reply: [['watch', { action: 'watch', paths: ['notes.md'], note: 'tidy notes' }], ['watch', { action: 'watch', paths: ['todo.md'] }]] });
  await rule({ who: 'main', when: '/as w3/.test(c.since)', reply: 'Watching both.' });
  await send('watch notes and todo');
  await idle();
  assert.equal((await trayWatch()).length, 2);
  await page.click('.tray-row[data-kind="watch"]:has-text("notes.md") [data-act="stop"]');
  await page.waitForFunction(() => document.querySelectorAll('.tray-row[data-kind="watch"]').length === 1, null, T);
  await rule({ who: 'main', when: '/stop by ctl/.test(c.since)', reply: [['bash', { command: 'ls /task/watch; cat /task/watch/w3/paths; echo stop > /task/watch/w3/ctl; ls /task/watch' }]] });
  await rule({ who: 'main', when: '/todo\\.md/.test(c.since)', reply: 'Stopped it via ctl.' });
  await send('stop by ctl');
  await idle();
  assert.match((await reqs()).at(-1), /w3\n\/work\/todo\.md/);
  assert.deepEqual(await trayWatch(), []);
  ok('Stop watching from the tray; `echo stop > /task/watch/w3/ctl` unwatches (ls /task/watch lists it first)');

  // ── scope: a subagent cannot watch outside its mounts ──
  await rule({ who: 'main', when: '/scoped helper/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'scoped', task: 'Watch /pouch/AGENTS.md, then /work/data/*.csv.', ns: ['/work/data'] }]] });
  await rule({ who: 'main', when: '/Started subagent "scoped"/.test(c.since)', reply: 'Started scoped.' });
  await rule({ who: 'scoped', reply: [['watch', { action: 'watch', paths: ['/pouch/AGENTS.md'] }]] });
  await rule({ who: 'scoped', when: '/outside what you can see/.test(c.since)', reply: [['watch', { action: 'watch', paths: ['/work/data/*.csv'], by: 'any' }]] });
  await rule({ who: 'scoped', when: '/Watching/.test(c.since)', reply: [['watch', { action: 'unwatch', id: 'w4' }]] });
  await rule({ who: 'scoped', when: '/Stopped watching/.test(c.since)', reply: 'Done.' });
  await rule({ who: 'main', when: '/Subagent report/.test(c.since)', reply: 'scoped finished.' });
  await page.evaluate(async () => { const d = await navigator.storage.getDirectory(); await d.getDirectoryHandle('data', { create: true }); });
  await send('start a scoped helper');
  await page.waitForFunction(() => (window.fake.requests.scoped?.length ?? 0) >= 4, null, T);
  const sc = await seen('scoped');
  assert.match(sc, /\/pouch\/AGENTS\.md is outside what you can see \(\/work\/data, \/tmp\)|outside what you can see \(\/work\/data/);
  assert.match(sc, /Watching \/work\/data\/\*\.csv as w4/);
  assert.ok((await page.evaluate(() => window.fake.requests.scoped[0].tools.map((t) => t.function.name))).includes('watch'), 'subagents get the watch tool');
  await idle();
  ok('scope: a subagent with ns [/work/data] is refused /pouch/AGENTS.md, may watch /work/data/*.csv');

  // ── reload: watches re-armed; a change made while closed fires once ──
  await rule({ who: 'main', when: '/watch reload/.test(c.since)', reply: [['watch', { action: 'watch', paths: ['essay.md'], note: 'reload check' }]] });
  await rule({ who: 'main', when: '/as w5/.test(c.since)', reply: 'Watching essay.md again.' });
  await send('watch reload');
  await idle();
  await page.close();
  // "Closed": change the file underneath Pouch (as another tab or a disk edit would).
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url + '/#x'); // any page of this origin
  await page.evaluate(async () => { const d = await navigator.storage.getDirectory(); const w = await (await d.getFileHandle('essay.md')).createWritable(); await w.write('# Rewritten elsewhere\n'); await w.close(); });
  await page.reload();
  await boot();
  await page.waitForFunction(() => window.fake?.requests?.main?.some((b) => JSON.stringify(b.messages).includes('while it was closed')), null, T).catch(() => {});
  await page.waitForTimeout(800);
  const afterReload = await page.evaluate(() => (window.fake.requests.main ?? []).map((b) => JSON.stringify(b.messages.at(-1))).filter((s) => s.includes('[from files]')));
  assert.equal(afterReload.length, 1, 'one wake after reload: ' + afterReload);
  assert.match(afterReload[0], /essay\.md changed by outside Pouch \(while it was closed\): now 1 line/);
  assert.match((await trayWatch()).join('\n'), /Watching essay\.md: reload check \| w5/);
  await idle();
  await page.reload(); await boot(); await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => (window.fake.requests.main ?? []).length), 0, 'a second reload fires nothing');
  ok('reload: watch w5 re-armed (tray row back); the closed-tab change fired once; a second reload fired nothing');

  // ── G16/G17 in a new session: waiting for CSVs, then they arrive ──
  await page.fill('#input', '/new'); await page.press('#input', 'Escape'); await page.press('#input', 'Enter');
  await page.waitForFunction(() => !document.querySelector('#log .msg'), null, T);
  await page.evaluate(() => { window.fake.rules.length = 0; });
  await rule({ who: 'main', when: '/CSV exports/.test(c.since)', reply: [['bash', { command: 'mkdir -p /work/data && ls /work/data' }], ['watch', { action: 'watch', paths: ['/work/data/*.csv'], once: true, note: 'clean your CSV exports' }]] });
  await rule({ who: 'main', when: '/as w\\d+/.test(c.since) && /once/.test(c.since)', reply: 'Drop the CSV files into /work/data; I am watching for them and will start when they arrive.' });
  await rule({ who: 'main', when: '/\\[from files\\] data\\//.test(c.since)', reply: [['bash', { command: 'ls /work/data' }]] });
  await rule({ who: 'main', when: '/\\.csv/.test(c.since) && !/\\[from files\\]/.test(c.since)', reply: 'Found the files; cleaning them now.' });
  await send('Help me clean my CSV exports. They are not here yet.');
  await replyIs(/watching for them/);
  await idle();
  const waitRow = (await trayWatch()).join('\n');
  assert.match(waitRow, /^Waiting for files in data: clean your CSV exports \| w\d+ · changes by you/);
  assert.ok(await page.$('.tray-row[data-kind="watch"] [data-act="stop"] >> text=Cancel'));
  await page.screenshot({ path: join(shots, 'watch-waiting-for-files.png') });
  ok('G16: main watched /work/data/*.csv once and ended its turn; tray: "Waiting for files in data" with Cancel');

  await page.waitForSelector('#tree .row[data-path="/work/data"]', { ...T, state: 'attached' }).catch(async (e) => { console.log(await page.evaluate(() => [...document.querySelectorAll('#tree .row')].map((r) => r.dataset.path + ':' + r.offsetParent))); throw e; });
  const m0 = await nMain(), wk0 = await wakeReqs();
  await dropFiles('/work/data', [['jan.csv', 'a,b\n1,2\n'], ['feb.csv', 'a,b\n3,4\n'], ['mar.csv', 'a,b\n5,6\n']]);
  await replyIs(/Found the files/);
  await idle();
  const g17 = (await reqs()).slice(m0);
  const announced = [...new Set(g17.join('\n').match(/\[from files\] data\/\w+\.csv/g) ?? [])];
  const listed = /jan\.csv[\s\S]*feb\.csv|feb\.csv[\s\S]*jan\.csv/.test(g17.join('\n'));
  measured.push(`multi-file drop (G16 open question): 3 CSVs dropped at once on a once-watch woke main ${(await wakeReqs()) - wk0} time(s); event lines named ${announced.length} of 3 files (${announced.join(', ')}); ls in the woken turn ${listed ? 'saw all three' : 'did not see all three'}`);
  assert.equal((await wakeReqs()) - wk0, 1, 'once = one wake for the whole drop');
  assert.equal(announced.length, 3, 'all three files in that wake: ' + announced.join(', '));
  assert.deepEqual(await trayWatch(), [], 'once: the watch is gone after its woken turn');
  await page.waitForSelector('#log .msg.from.watch .msg-from >> text=/Woken by watch w\\d+: clean your CSV exports/', T);
  ok('G17: the drop woke main, labeled by its watch; main continued; the once-watch removed itself');

  assert.deepEqual(errors, []);
  ok('no page errors');
  console.log('\nMeasured:\n' + measured.map((m) => '- ' + m).join('\n'));
  console.log(`\n${passed} passed; screenshots in ${shots}`);
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
