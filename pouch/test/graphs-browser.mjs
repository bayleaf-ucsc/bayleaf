// Agent graphs in the real page (JOURNEYS G1-G12), with the scripted fake in
// test/graph-fixture.js bundled in place of Tinfoil: every network request is
// answered locally or aborted, so no Sealed request is ever made. Rules are
// keyed by session (subagent name or "main") and by what reached it since its
// last reply; gates let the test decide when a step ends. Asserts what each
// session's next request contains, and what the page shows.
// Run: node test/graphs-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-graph-'));
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
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('#badge.ok');
  await page.selectOption('#model', 'fake').catch(() => {});
  await page.click('#welcome button >> text=Got it').catch(() => {});
  const seen = (who) => page.evaluate((w) => window.fake.seen(w), who);
  const nReq = (who) => page.evaluate((w) => window.fake.requests[w]?.length ?? 0, who);
  const rule = (r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r);
  const send = async (text) => { await page.fill('#input', text); await page.press('#input', 'Enter'); };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  // The sessions sidebar overlays the chat at this width with a panel open, and closes on a click into the chat (like the phone drawer).
  const sideOpen = async () => { if ((await page.getAttribute('#flipper', 'aria-expanded')) !== 'true') await page.click('#flipper'); };
  const lastReply = () => page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? '');

  // G1. The draft is in /work and open in the editor; $panel completes the bundled skill.
  await rule({ who: 'main', when: '/setup/.test(c.since)', reply: [['write', { path: '/work/essay.md', content: ESSAY }]] });
  await rule({ who: 'main', when: '/Wrote|Successfully|bytes/i.test(c.since)', reply: 'Wrote essay.md.' });
  await send('setup the essay');
  await idle();
  await page.click('#tree .row[data-path="/work/essay.md"]');
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Walkable towns'), null, T);
  await page.fill('#input', '$pan');
  await page.waitForSelector('#ac:not([hidden]) >> text=panel', T);
  await page.press('#input', 'Enter');
  assert.match(await page.inputValue('#input'), /^Use the panel skill\. $/);
  ok('G1: essay.md open in the editor; "$pan" completes the bundled panel skill');

  // G2-G7: the panel. judge-evidence waits on a gate so the user can steer it (G6).
  await page.evaluate(() => window.panelRules(window.fake, { judgeGate: (j) => (j === 'evidence' ? 'ev' : null) }));
  await page.type('#input', 'review this draft');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => window.fake.requests['judge-audience']?.length >= 1 && window.fake.requests['judge-evidence']?.length >= 1, null, T);
  const mainSys = await page.evaluate(() => window.fake.requests.main.at(-1).messages[0].content);
  assert.match(mainSys, /panel: Review a draft with a panel/, 'panel skill listed in main\'s prompt');
  assert.match(mainSys, /message each other by id[\s\S]*You are main \(s1\)/, 'graph gloss in main\'s prompt');
  await page.waitForFunction(() => window.fake.seen('main').includes('(id s6)'), null, T);
  const spawnOut = await seen('main');
  assert.match(spawnOut, /Started subagent "chair" \(id s2\)/);
  assert.match(spawnOut, /Started subagent "judge-audience" \(id s6\)/);
  const chairSys = await page.evaluate(() => window.fake.requests.chair[0].messages[0].content);
  assert.match(chairSys, /"chair" \(id s2\)[\s\S]*"main" \(id s1\)[\s\S]*do not poll/);
  ok('G2/G3: chair spawned first (s2), four judges (s3-s6); ids in spawn results and child prompts');

  // G6: the session panel shows the tree and states; open judge-evidence and steer it.
  if ((await page.getAttribute('#flipper', 'aria-expanded')) !== 'true') await page.click('#flipper');
  await page.waitForFunction(() => document.querySelectorAll('#session-list .s-child').length === 5, null, T);
  await sideOpen(); await page.click('#session-list .s-child .s-child-open >> text=judge-evidence');
  await page.waitForSelector('#log.child-view .sa-view-head', T);
  assert.match(await page.textContent('.sa-view-head .sa-more .sa-meta'), /^s4 · subagent of/);
  await send('Be strict about sources.');
  await page.waitForFunction(() => document.getElementById('input').value === '', null, T);
  await page.evaluate(() => { window.fake.gates.ev = true; });
  await page.waitForFunction(() => window.fake.requests['judge-evidence']?.length >= 2, null, T);
  assert.match(await page.evaluate(() => JSON.stringify(window.fake.requests['judge-evidence'][1].messages.slice(-2))), /Message from the user[\s\S]*Be strict about sources/);
  ok('G6: five nested rows with states; the user steered judge-evidence (s4) mid-graph; its next request carried it');

  // G4, G5, G7: fan-in, the peer exchange, one review to main.
  await page.waitForFunction(() => /The panel suggests/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? '') || document.querySelector('#log.child-view'), null, T);
  await page.click('#log .sa-back').catch(() => {});
  await page.waitForFunction(() => /The panel suggests/.test([...document.querySelectorAll('#log .msg.assistant .body')].map((b) => b.textContent).join('\n')), null, { timeout: 20000 });
  const chairSeen = await seen('chair');
  for (const [i, j] of ['argument', 'evidence', 'clarity', 'audience'].entries()) assert.ok(chairSeen.includes(`[from judge-${j} (s${i + 3})] RAW-${j}`), 'fan-in from ' + j);
  assert.match(chairSeen, /- s4 judge-evidence: (running|finished), parent s1/);
  assert.ok((await seen('judge-evidence')).includes('[from judge-argument (s3)] RAW-argument-peer') && (await seen('judge-argument')).includes('[from judge-evidence (s4)] RAW-evidence-peer'));
  const mainSeen = await seen('main');
  assert.match(mainSeen, /\[from chair \(s2\)\] Prioritized review/);
  assert.doesNotMatch(mainSeen, /RAW-/, 'no judge raw output in main\'s requests');
  ok('G4/G5/G7: tagged fan-in, list, s3<->s4 peer exchange, one review in main; no RAW- text in any main request');
  await page.waitForSelector('#log .msg.user.from .msg-from >> text=from chair (s2)', T);
  ok('G7: the chair\'s message shows in main labeled "from chair (s2)"');

  // G9: the chair's transcript shows incoming messages by sender; cards show edge counts.
  await page.waitForFunction(() => [...document.querySelectorAll('#session-list .s-child-state')].every((s) => s.textContent !== 'working'), null, T);
  const chairCard = page.locator('.subagent[data-child]', { has: page.locator('.sa-name', { hasText: /^chair$/ }) });
  assert.match((await chairCard.locator('.sa-edges li').allTextContents()).join(' · '), /from main \(s1\) 1 · from judge-argument \(s3\) 2 · from judge-evidence \(s4\) 2 · from judge-clarity \(s5\) 1 · from judge-audience \(s6\) 1 · to main \(s1\) 1 · to judge-argument \(s3\) 1 · to judge-evidence \(s4\) 1/);
  assert.ok(await page.$('#session-list .s-child .s-child-msgs'), 'message counts on sidebar rows');
  await sideOpen(); await page.click('#session-list .s-child .s-child-open >> text=chair');
  await page.waitForSelector('#log.child-view .msg.user.from', T);
  const labels = await page.$$eval('#log.child-view .msg.user.from .sa-who', (n) => n.map((x) => x.textContent));
  for (const want of ['from main (s1)', 'from judge-argument (s3)', 'from judge-evidence (s4)', 'from judge-clarity (s5)', 'from judge-audience (s6)']) assert.ok(labels.includes(want), `chair transcript labels ${want}: ${labels}`);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.locator('#log .msg.user.from').nth(1).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'graphs-1-chair-transcript.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('#log .sa-back');
  ok('G9: chair transcript labels each incoming message by sender; card and sidebar show per-edge counts');

  // G8: "apply 1 and 3": main edits while the user types in the editor; the conflict bar handles it.
  await rule({ who: 'main', when: '/apply 1 and 3/.test(c.since)', gate: 'edit', reply: [['edit', { path: '/work/essay.md', edits: [{ oldText: 'Towns should be walkable.', newText: 'Thesis: towns should be walkable.' }, { oldText: 'A second example about parking.\n\n', newText: '' }] }]] });
  await rule({ who: 'main', when: '/essay\\.md/.test(c.since)', reply: 'Applied 1 and 3.' });
  await send('apply 1 and 3');
  await page.waitForFunction(() => window.fake.requests.main.some((b) => JSON.stringify(b.messages.at(-1)).includes('apply 1 and 3')), null, T);
  await page.click('.cm-content');
  await page.keyboard.press('Control+End'); await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('\nMy own closing line.');
  await page.evaluate(() => { window.fake.gates.edit = true; });
  await page.waitForSelector('#conflict-bar:not([hidden])', T);
  await idle();
  const toolOut = await page.evaluate(() => JSON.stringify(window.fake.requests.main.at(-1).messages.at(-1)));
  assert.doesNotMatch(toolOut, /error|failed/i, 'the edit applied: ' + toolOut.slice(0, 200));
  ok('G8: main applied 1 and 3 while the user typed; the conflict bar appeared');
  await page.click('#conflict-bar button >> text=/Keep mine|Take theirs/').catch(() => {});

  // Caps: a scripted ping-pong between s3 and s4 is refused at the pair cap, visibly in the tray.
  await rule({ who: 'main', when: '/ping/.test(c.since)', reply: [['subagent', { action: 'message', to: 's3', text: 'Ping-pong with s4 until refused.' }]] });
  await rule({ who: 'main', when: '/woke it|Sent to/.test(c.since)', reply: 'Started the exchange.' });
  for (let i = 0; i < 9; i++) {
    await rule({ who: 'judge-argument', when: '!/Not sent/.test(c.since)', reply: [['agents', { action: 'message', to: 's4', text: 'ping ' + i }]] });
    await rule({ who: 'judge-evidence', when: '!/Not sent/.test(c.since)', reply: [['agents', { action: 'message', to: 's3', text: 'pong ' + i }]] });
  }
  await rule({ who: '*', when: '/Not sent/.test(c.since)', reply: 'Stopping: limit reached.' });
  await rule({ who: '*', when: '/Not sent/.test(c.since)', reply: 'Stopping: limit reached.' });
  await send('ping');
  await page.waitForSelector('#tray:not([hidden]) .tray-row[data-kind="cap"]', T);
  assert.match(await page.textContent('#tray-count'), /Message limit: [12]/);
  assert.match(await page.getAttribute('.tray-row[data-kind="cap"] .tray-text', 'title'), /exchanged 8 messages/);
  assert.match((await seen('judge-argument')) + (await seen('judge-evidence')), /Not sent: s[34] and s[34] have exchanged 8 messages/);
  await page.waitForTimeout(300);
  while (await page.$('.tray-row[data-kind="cap"] .tray-stop')) await page.click('.tray-row[data-kind="cap"] .tray-stop');
  await page.waitForFunction(() => !document.querySelector('.tray-row[data-kind="cap"]'), null, T);
  await page.waitForFunction(() => [...document.querySelectorAll('#session-list .s-child-state')].every((s) => s.textContent !== 'working'), null, T);
  ok('caps: ping-pong refused at 8 per pair; tray shows "Message limit" with the reason, the sender read a tool error; Dismiss');

  // G10: main waits on a working subagent; the user writes; the wait returns at once.
  await idle();
  await rule({ who: 'main', when: '/slow job/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'slow', task: 'A slow job.' }]] });
  await rule({ who: 'main', when: '/Started subagent "slow" \\(id s7\\)/.test(c.since)', reply: [['subagent', { action: 'join', ids: ['s7'] }]] });
  await rule({ who: 'slow', gate: 'slow', reply: [['bash', { command: 'echo working' }]] });
  await rule({ who: 'slow', gate: 'slow2', reply: 'SLOW-DONE: the slow result.' });
  await rule({ who: 'main', when: "/detached: slow \\(s7\\) continues in the background; the user said: 'what about lunch\\?'/.test(c.since) && /what about lunch/.test(c.since)", reply: [['subagent', { action: 'message', to: 's7', text: 'Also count the parking spaces.' }]] });
  await rule({ who: 'main', when: '/Sent to slow \\(s7\\)/.test(c.since)', reply: 'Lunch: soup. slow keeps working; I asked it to count parking too.' });
  await rule({ who: 'main', when: '/SLOW-DONE/.test(c.since)', reply: 'slow finished: the slow result.' });
  await send('slow job please');
  await page.waitForSelector('.tray-row[data-kind="subagent"] .tray-bg', T);
  assert.match(await page.textContent('.tray-row[data-kind="subagent"] .tray-origin'), /main waits on s7/);
  assert.ok(await page.locator('.tray-row[data-kind="subagent"] .tray-bg').isVisible() && (await page.locator('.tray-row[data-kind="subagent"] .tray-bg').boundingBox()).x + 40 < 620, 'Background button inside the chat column');
  // D25: with a draft, the split button's Steer (Enter, the default) says it detaches.
  await page.fill('#input', 'what about lunch?');
  assert.match(await page.getAttribute('#sendmode-main', 'aria-label'), /Steer: .*\(Enter\)[\s\S]*Steering will detach slow/);
  await page.screenshot({ path: join(shots, 'graphs-2-tray-detach.png') });
  const t0 = Date.now();
  await send('what about lunch?');
  await page.waitForFunction(() => /Lunch: soup/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), null, T);
  const dt = Date.now() - t0;
  assert.match(await page.textContent('#log'), /what about lunch\?/);
  assert.equal(await page.textContent('#session-list .s-child .s-child-open:has-text("slow") .s-child-state'), 'working', 'detaching never stops it');
  ok(`G10: user message during a join detached it (${dt} ms); main answered; slow (s7) still working`);

  // G11: main's message shows in the sub's transcript as from main (s1); its report arrives later.
  await sideOpen(); await page.click('#session-list .s-child .s-child-open >> text=slow');
  await page.waitForSelector('#log.child-view .msg.user.from .sa-who >> text=from main (s1)', { timeout: 15000 }).catch(async () => {
    await page.evaluate(() => { window.fake.gates.slow = true; });
    await page.waitForSelector('#log.child-view .msg.user.from .sa-who >> text=from main (s1)', T);
  });
  await page.evaluate(() => { window.fake.gates.slow = true; window.fake.gates.slow2 = true; });
  assert.match(JSON.stringify(await page.evaluate(() => window.fake.requests.slow.at(-1).messages.slice(-2))), /\[from main \(s1\)\] Also count the parking/);
  await page.click('#log .sa-back');
  await page.waitForFunction(() => /slow finished/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), null, T);
  assert.match(await seen('main'), /SLOW-DONE/);
  ok('G11: main messaged slow (shown "from main (s1)" in its view, in its next request); its report arrived later and started a turn: nothing lost');

  // G12: a foreground spawn; the tray's Background button detaches it.
  await idle();
  await rule({ who: 'main', when: '/fg job/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'fg', task: 'A foreground job.', background: false }]] });
  await rule({ who: 'main', when: '/detached: fg \\(s8\\) continues in the background; the user sent it to the background/.test(c.since)', reply: 'OK, fg runs in the background.' });
  await rule({ who: 'fg', gate: 'fg', reply: 'FG-DONE.' });
  await rule({ who: 'main', when: '/FG-DONE/.test(c.since)', reply: 'fg reported.' });
  await send('fg job');
  await page.waitForSelector('.tray-row[data-kind="subagent"] .tray-bg', T);
  await page.click('.tray-row[data-kind="subagent"] .tray-bg');
  await page.waitForFunction(() => /fg runs in the background/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), null, T);
  assert.equal(await page.$('.tray-row[data-kind="subagent"] .tray-bg'), null, 'no Background once main stopped waiting');
  assert.ok(await page.$('.tray-row[data-kind="subagent"]'), 'fg still running in the tray');
  await page.evaluate(() => { window.fake.gates.fg = true; });
  await page.waitForFunction(() => /fg reported/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), null, T);
  ok('G12: Background on a foreground spawn: main went on ("the user sent it to the background"), fg kept running and reported');

  // Scope: a new session cannot reach the first one's subagents.
  await idle();
  const before = await page.evaluate(() => document.querySelectorAll('#session-list .session').length);
  await page.fill('#input', '/new'); await page.press('#input', 'Escape'); await page.press('#input', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#session-list .session').length > n || !document.querySelector('#log .subagent'), before, T);
  await rule({ who: 'main', when: '/other scope/.test(c.since)', reply: [['subagent', { action: 'message', to: 's2', text: 'hello' }]] });
  await rule({ who: 'main', when: '/No session/.test(c.since)', reply: 'That id is not in this session.' });
  await send('other scope: message s2');
  await page.waitForFunction(() => /not in this session/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), null, T);
  assert.match(await seen('main'), /No session "s2" in this scope[\s\S]*Messages never leave this scope/);
  ok('scope: from a new session, s2 is unknown; messaging it is refused with a clear error');

  const unmatched = await page.evaluate(() => window.fake.unmatched.filter((u) => u.who === 'main'));
  assert.deepEqual(unmatched, [], 'main made no unscripted requests');
  assert.deepEqual(errors, []);
  ok('no page errors; main made no unscripted requests');
  console.log(`\n${passed} passed; screenshots in ${shots}`);
} finally {
  await context.close();
  server.close();
}
