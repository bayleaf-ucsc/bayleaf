// Batch A (play-test fixes) in the real page, on the scripted fake in
// test/graph-fixture.js (no Sealed request is ever made): one-shot panel and
// its request count, the $ cost hint, live spend in the tray, quiet reports
// collapsed with where findings went, Stop all aborting requests in flight,
// the Usage panel's Requests column, /tmp scratch for a read-only /work, the
// inline key field and new-file name.
// Run: node test/batchA-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchA-'));
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
const ESSAY = '# Walkable towns\n\nTowns should be walkable.\n\nWalking cuts car trips by 40%.\n\nEveryone knows my friend in Oakland.\n\nSo plan for feet.\n';
const JUDGES = ['argument', 'evidence', 'clarity', 'audience'];
const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
try {
  await context.route('https://**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname === '/usage') return /sk-bayleaf-bad/.test(r.request().headers().authorization ?? '') ? r.fulfill({ status: 401, json: { error: 'invalid key' } }) : r.fulfill({ json: { sealed: { remaining: 400, limit: 500 } } });
    if (u.pathname.includes('usage') || u.pathname === '/campus-pass') return r.fulfill({ json: {} });
    return r.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('#badge.ok');
  await page.selectOption('#model', 'fake').catch(() => {});
  await page.click('#welcome button >> text=Got it').catch(() => {});
  const rule = (r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r);
  const send = async (text) => { await page.fill('#input', text); await page.press('#input', 'Enter'); };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  // Past the after-turn work too (a send in that gap can become a stranded steer; see the report).
  const settled = async () => { await idle(); await page.waitForTimeout(700); await idle(); };
  const total = () => page.evaluate(() => window.fake.total());
  const lastReply = () => page.evaluate(() => [...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? '');

  // Setup: the draft in /work.
  await rule({ who: 'main', when: '/setup/.test(c.since)', reply: [['write', { path: '/work/essay.md', content: ESSAY }]] });
  await rule({ who: 'main', when: '/Wrote|Successfully|bytes/i.test(c.since)', reply: 'Wrote essay.md.' });
  await send('setup the essay'); await settled();

  // Fix 5: the $ completion shows the skill's declared cost.
  await page.fill('#input', '$pan');
  await page.waitForSelector('#ac:not([hidden]) >> text=panel', T);
  assert.match(await page.textContent('#ac .ac-cost'), /^about 9–12 requests$/);
  await page.press('#input', 'Escape');
  ok('$pan: the completion row says "about 9–12 requests" before anything is sent');

  // Fix 1: the one-shot panel, as the skill now says. Judges wait on a gate so
  // the tray can be read mid-run (fix 5: live spend).
  await rule({ who: 'main', when: '/panel/.test(c.since)', reply: [['read', { path: '/pouch/skills/panel/SKILL.md' }]] });
  await rule({ who: 'main', when: '/oneshot/.test(c.since) && /Panel review/.test(c.since)', reply: JUDGES.map((j) => ['subagent', { action: 'spawn', mode: 'oneshot', background: false, name: `judge-${j}`, task: `Judge only the ${j} of the attached draft.`, files: ['/work/essay.md'] }]) });
  for (const j of JUDGES) await rule({ who: `judge-${j}`, gate: 'judges', reply: `FINDING-${j}: ${j === 'evidence' ? 'paragraph 3 rests on an anecdote' : 'mostly fine'}.` });
  await rule({ who: 'main', when: '(c.since.match(/FINDING-/g) ?? []).length === 4', reply: [['subagent', { action: 'spawn', mode: 'oneshot', background: false, name: 'chair', files: ['/work/essay.md'], task: 'Chair a review panel. Findings: argument, evidence, clarity, audience as given.' }]] });
  await rule({ who: 'chair', reply: 'REVIEW: 1. Replace the Oakland anecdote with data (evidence, argument).' });
  await rule({ who: 'main', when: '/REVIEW:/.test(c.since)', reply: 'The panel suggests:\n1. Replace the Oakland anecdote with data.' });
  const t0 = await total();
  await send('Use the panel skill. Review this draft.');
  await page.waitForFunction(() => (window.fake.requests['judge-audience']?.length ?? 0) >= 1 && (window.fake.requests['judge-argument']?.length ?? 0) >= 1, null, T);
  await page.waitForFunction(() => /^Running 4 · \d+ requests? this turn/.test(document.getElementById('tray-count').textContent), null, T);
  const trayHead = await page.textContent('#tray-count');
  await page.screenshot({ path: join(shots, 'batchA-1-tray-spend.png') });
  await page.evaluate(() => { window.fake.gates.judges = true; });
  await page.waitForFunction(() => /The panel suggests/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), null, T);
  await idle();
  const used = (await total()) - t0;
  assert.equal(used, 9, `panel requests: ${used}`);
  for (const j of JUDGES) assert.equal(await page.evaluate((w) => window.fake.requests[w].length, `judge-${j}`), 1);
  assert.ok(await page.evaluate(() => !(window.fake.requests['judge-evidence'][0].tools?.length)), 'no tools offered to a one-shot');
  const cardMeta = await page.textContent('.subagent[data-child] .sa-meta');
  assert.match(cardMeta, /one-shot/);
  ok(`one-shot panel: ${used} requests (was 41 in the play-test); tray read "${trayHead}" mid-run; cards say one-shot`);

  // Fix 5: the Usage panel rolls subagents into the session row, with Requests.
  await page.click('#rail-usage');
  await page.waitForSelector('#usage-body table.tokens', T);
  const heads = await page.$$eval('#usage-body table.tokens th', (n) => n.map((x) => x.textContent));
  assert.deepEqual(heads.slice(0, 4), ['Session', 'Requests', 'In', 'Out']);
  const row = await page.$$eval('#usage-body table.tokens tr.current td', (n) => n.map((x) => x.textContent));
  assert.ok(Number(row[1]) >= 11, 'the current session counts its subagents\' requests (setup 2 + panel 9): ' + row.join(' | '));
  await page.screenshot({ path: join(shots, 'batchA-2-usage.png') });
  await page.click('#rail-usage');
  ok(`Usage panel: Requests column; the session row reads ${row[1]} requests including its 5 one-shots`);

  // Fix 2: quiet reports (findings sent to a collector by message) collapse
  // into one line that says where they went; no "No report.".
  await rule({ who: 'main', when: '/collect/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'collector', task: 'Collect findings.', report: false }]] });
  await rule({ who: 'collector', reply: 'Waiting.' });
  await rule({ who: 'collector', sticky: true, when: '/\\[from w-/.test(c.since)', reply: 'Noted.' });
  await rule({ who: 'main', when: '/Started subagent "collector"/.test(c.since)', reply: ['a', 'b', 'c'].map((n) => ['subagent', { action: 'spawn', name: `w-${n}`, task: `Send finding ${n} to the collector.` }]) });
  for (const n of ['a', 'b', 'c']) {
    await rule({ who: `w-${n}`, reply: [['agents', { action: 'message', to: 'collector', text: `FINDING ${n}: the thesis is buried in paragraph two.` }]] });
    await rule({ who: `w-${n}`, when: '/Sent to|woke it/.test(c.since)', reply: '' });
  }
  await rule({ who: 'main', when: '/Started subagent "w-c"/.test(c.since)', reply: [['subagent', { action: 'join', ids: ['w-a', 'w-b', 'w-c'] }]] });
  await rule({ who: 'main', when: '/Joined:/.test(c.since)', reply: 'They reported to the collector.' });
  await settled();
  await send('collect findings');
  await page.waitForFunction(() => /reported to the collector/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), null, T);
  await idle();
  await page.waitForTimeout(500);
  const joinOut = await page.evaluate(() => JSON.stringify(window.fake.requests.main.at(-1).messages.at(-1).content));
  assert.match(joinOut, /w-a \(s\d+\) quiet, (fresh|cached \d+s), sent its findings to collector \(s\d+\)/, 'join result names the recipient: ' + joinOut.slice(0, 300));
  const groups = await page.$$eval('#log details.sa-joins > summary', (n) => n.map((x) => x.textContent));
  assert.ok(groups.some((g) => /^Joined 3 subagents: 3 reported to collector \(s\d+\)$/.test(g)), 'one summary line: ' + JSON.stringify(groups));
  assert.doesNotMatch(await page.textContent('#log'), /No report\./);
  // The play-test shape: no join; each one's quiet report arrives on its own.
  await settled();
  await rule({ who: 'main', when: '/again/.test(c.since)', reply: ['a', 'b', 'c'].map((n) => ['subagent', { action: 'message', to: `w-${n}`, text: 'Send it again.' }]) });
  await rule({ who: 'main', when: '/woke it/.test(c.since)', reply: 'Asked them again.' });
  for (const n of ['a', 'b', 'c']) {
    await rule({ who: `w-${n}`, when: '/Send it again/.test(c.since)', reply: [['agents', { action: 'message', to: 'collector', text: `FINDING ${n} again.` }]] });
    await rule({ who: `w-${n}`, when: '/Sent to|woke it/.test(c.since)', reply: '' });
  }
  await send('again please');
  await page.waitForFunction(() => [...document.querySelectorAll('#log details.sa-joins > summary')].some((x) => /^3 subagents finished: 3 reported to collector/.test(x.textContent)), null, T);
  assert.doesNotMatch(await page.textContent('#log'), /No report\./);
  await page.locator('#log details.sa-joins').last().evaluate((d) => { d.open = true; });
  assert.match(await page.locator('#log details.sa-joins').last().textContent(), /Sent its findings to collector \(s\d+\): "FINDING [abc] again\."/);
  await page.locator('#log details.sa-joins').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, 'batchA-3-joins.png') });
  ok(`quiet reports and the join collapse into "${groups.at(-1)}"; separate quiet reports into "3 subagents finished: 3 reported to collector"; inner cards say where findings went, with a preview`);

  // Fix 4: a subagent whose /work is narrowed read-only writes notes to /tmp.
  await rule({ who: 'main', when: '/notes test/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'noter', task: 'Note things.', ns: ['/work/essay.md:ro'] }]] });
  await rule({ who: 'noter', reply: [['write', { path: '/work/noter.md', content: 'notes' }]] });
  await rule({ who: 'noter', when: '/read-only for you/.test(c.since)', reply: [['write', { path: '/tmp/noter.md', content: 'notes' }]] });
  await rule({ who: 'noter', when: '/noter\\.md/.test(c.since) && !/read-only/.test(c.since)', reply: 'Notes in /tmp/noter.md.' });
  await rule({ who: 'main', when: '/Notes in \\/tmp/.test(c.since)', reply: 'noter done.' });
  await settled();
  await send('notes test');
  await page.waitForFunction(() => /noter done/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), null, T);
  const noter = await page.evaluate(() => window.fake.requests.noter.map((b) => JSON.stringify(b.messages)).join('\n'));
  assert.match(await page.evaluate(() => window.fake.requests.noter[0].messages[0].content), /under \/tmp \(your private scratch, lost on reload; \/work is read-only for you/);
  assert.match(noter, /\/work\/noter\.md is read-only for you\. You can write under \/tmp; for example \/tmp\/noter\.md/);
  ok('read-only /work: the subagent prompt points notes to /tmp; a write to /work names /tmp as the writable place');
  await idle();

  // Fix 6: Stop all aborts main's request in flight and a subagent's, and no new request starts.
  await rule({ who: 'main', when: '/stop test/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'slowpoke', task: 'Work slowly.' }]] });
  await rule({ who: 'slowpoke', gate: 'never', reply: 'never' });
  await rule({ who: 'main', when: '/Started subagent "slowpoke"/.test(c.since)', gate: 'never', reply: 'never' });
  const a0 = await page.evaluate(() => window.fake.aborted.length);
  await settled();
  await send('stop test');
  await page.waitForFunction(() => (window.fake.requests.slowpoke?.length ?? 0) >= 1 && !window.fake.pending().some((p) => /gate never/.test(p)), null, T);
  await page.waitForSelector('#tray-stop-all:not([hidden])', T);
  const n0 = await total();
  await page.click('#tray-stop-all');
  await idle();
  await page.waitForTimeout(800);
  const ab = await page.evaluate((a0) => window.fake.aborted.slice(a0).map((a) => a.who), a0);
  assert.ok(ab.includes('main') && ab.includes('slowpoke'), 'aborted in flight: ' + ab.join(','));
  assert.equal(await total(), n0, 'no request after Stop all');
  assert.match(await page.textContent('#status'), /Requests in flight were cancelled/);
  ok('Stop all (shown with main + one subagent working) aborted both requests in flight; no new request started; the status line says so');

  // Fix 7: the inline key field: a bare paste is refused inline, a .env line yields the key, a rejected key says why.
  await page.click('#auth');
  await page.waitForSelector('#sheet[open] #key-input', T);
  await page.fill('#key-input', 'hello there');
  await page.click('#sheet .key-form button[type=submit]');
  assert.match(await page.textContent('#key-why'), /does not contain an sk-bayleaf- key/);
  await page.fill('#key-input', 'BAYLEAF_API_KEY=sk-bayleaf-bad123');
  await page.click('#sheet .key-form button[type=submit]');
  await page.waitForFunction(() => /rejected this key \(HTTP 401\)/.test(document.getElementById('key-why')?.textContent ?? ''), null, T);
  await page.screenshot({ path: join(shots, 'batchA-4-key-rejected.png') });
  await page.evaluate(() => { const i = document.getElementById('key-input'); const dt = new DataTransfer(); dt.setData('text/plain', 'export BAYLEAF_API_KEY=sk-bayleaf-good_Key-9\n'); i.value = ''; i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  assert.equal(await page.inputValue('#key-input'), 'sk-bayleaf-good_Key-9');
  await page.click('#sheet .key-form button[type=submit]');
  await page.waitForSelector('#auth.on', T);
  assert.equal(await page.$('#sheet[open]'), null);
  ok('key: inline field (no prompt/alert); "hello there" refused inline; a pasted .env line yields the key; HTTP 401 shows the reason; a good key signs in');

  // Fix 7: New file here asks for the name inline.
  let dialogs = 0; page.on('dialog', (d) => { dialogs++; d.dismiss(); });
  await page.locator('[aria-label="Actions for work"]').dispatchEvent('click');
  await page.click('#sheet-actions button >> text=New file here');
  await page.waitForSelector('#sheet[open] #name-input', T);
  await page.fill('#name-input', 'inline-made.md');
  await page.press('#name-input', 'Enter');
  await page.waitForSelector('#tree .row[data-path="/work/inline-made.md"]', { ...T, state: 'attached' });
  assert.equal(dialogs, 0, 'no native dialog');
  ok('New file here: the name is asked inline in the sheet; the file appears');

  assert.deepEqual(errors, []);
  ok('no page errors');
  console.log(`\n${passed} passed; screenshots in ${shots}`);
} catch (e) {
  const p = context.pages().at(-1);
  console.log('DEBUG', JSON.stringify(await p?.evaluate(() => ({ who: Object.fromEntries(Object.entries(window.fake.requests).map(([k, v]) => [k, v.length])), unmatched: window.fake.unmatched.slice(-4), pending: window.fake.pending(), tray: document.getElementById('tray-count')?.textContent, status: document.getElementById('status')?.textContent, input: document.getElementById('input').value, send: document.getElementById('send-label').textContent, last: [...document.querySelectorAll('#log .msg')].slice(-2).map((m) => m.textContent.slice(0, 120)) })).catch(() => null)));
  throw e;
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
