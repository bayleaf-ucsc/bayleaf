// Upgrade across the ubiquitous-language realignment (LANGUAGE.md,
// 2026-10-31): a profile made by the build before it (s-handles, the
// follow-up mode saved as "queue", subagent rows, peer messages and a watch
// owned by "s1") must read correctly in the new build on the same origin.
// Both builds are bundled from source with the scripted fake in place of
// Tinfoil (test/graph-fixture.js), so no Sealed request is made:
//   POUCH_OLD_TREE  a checkout of the old build's pouch/ (default
//                   /tmp/pouch-qa/ul/basetree, a copy of ec88ab0 with node_modules linked)
// Run: node test/upgrade-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const oldRoot = process.env.POUCH_OLD_TREE || '/tmp/pouch-qa/ul/basetree';
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-upgrade-'));

const stub = `
import { createFake } from './test/graph-fixture.js';
window.fake = createFake();
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Fake title' } }] }) } };
    this.secureClient = { fetch: (u, i) => window.fake.fetch(u, i) };
  }
  async ready() {} async getVerificationDocument() { return { securityVerified: true }; }
}`;
async function page(tree) {
  const worker = (await build({ entryPoints: [join(tree, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
  const bundled = await build({ entryPoints: [join(tree, 'src/main.js')], bundle: true, write: false, format: 'iife', nodePaths: [join(root, 'node_modules')],
    define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
    alias: { 'node:zlib': join(tree, 'src/shims/zlib.js'), zlib: join(tree, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') },
    plugins: [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js', resolveDir: tree })); } }] });
  let html = readFileSync(join(tree, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
  return html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
}
const OLD = await page(oldRoot), NEW = await page(root);
let html = OLD;
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };
const errors = [];
const T = { timeout: 20000 };

async function open() {
  const context = await pw.chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
  await context.route('https://**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    return r.abort();
  });
  const p = context.pages()[0] ?? await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push('console: ' + m.text().slice(0, 300)); });
  await p.goto(url);
  await p.waitForSelector('#badge.ok', T);
  await p.selectOption('#model', 'fake').catch(() => {});
  await p.click('#welcome button >> text=Got it', { timeout: 2000 }).catch(() => {});
  const rule = (r) => p.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r);
  const idle = () => p.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  const send = async (text) => { await p.fill('#input', text); await p.press('#input', 'Enter'); };
  const seen = (who) => p.evaluate((w) => window.fake.seen(w), who);
  return { context, p, rule, idle, send, seen };
}

let ctx;
try {
  // ── The old build makes the profile ──────────────────────────────
  ctx = await open();
  let { p, rule, idle, send } = ctx;
  await rule({ who: 'main', when: "/start the scout/.test(c.since)", reply: [['watch', { action: 'watch', paths: ['/work/w.txt'], note: 'old watch' }], ['subagent', { action: 'spawn', name: 'scout', task: 'Scout the files, then message main.' }]] });
  await rule({ who: 'main', when: '/Started subagent "scout"/.test(c.since)', reply: 'Spawned the scout.' });
  await rule({ who: 'scout', when: 'c.n === 1', reply: [['agents', { action: 'message', to: 's1', text: 'hello from scout' }]] });
  await rule({ who: 'scout', when: 'c.n === 2', reply: 'Scout report: two files.' });
  await rule({ who: 'main', sticky: true, when: "/hello from scout/.test(c.since) && !/Subagent report/.test(c.since)", reply: 'Got the hello.' });
  await rule({ who: 'main', sticky: true, when: '/Subagent report/.test(c.since)', reply: 'Report noted.' });
  await send('Please start the scout.');
  // It delivered its work by message, so its report is quiet (no main turn).
  await p.waitForFunction(() => /Got the hello\./.test(document.getElementById('log').textContent) && window.fake.requests.scout?.length === 2 && /finished/.test(document.querySelector('.s-child-state')?.textContent ?? ''), null, T);
  await idle();
  // The follow-up mode, saved the old way.
  await p.evaluate(() => { const s = document.getElementById('send-mode'); s.value = 'queue'; s.dispatchEvent(new Event('change')); });
  const oldDisplay = await p.evaluate(() => JSON.parse(localStorage.getItem('pouch.display')));
  assert.equal(oldDisplay.sendMode, 'queue');
  const oldLog = await p.textContent('#log');
  assert.match(oldLog, /scout \(s2\)|\(s2\)/, 'the old build labels with s-handles');
  // A second session, plain.
  await p.click('#new-top');
  await p.waitForFunction(() => document.getElementById('title').textContent === 'New session', null, T);
  await p.waitForTimeout(300);
  await rule({ who: 'main', when: '/second session/.test(c.since)', reply: 'Plain reply.' });
  await send('A second session, plain.');
  await p.waitForFunction(() => /Plain reply\./.test(document.getElementById('log').textContent), null, T);
  await idle();
  const oldRows = await p.$$eval('#session-list > li.session', (ls) => ls.length);
  assert.equal(oldRows, 2);
  ok('old build: two sessions, a subagent that messaged main (s1) and reported, a watch, follow-up mode saved as "queue"');
  await ctx.context.close(); ctx = null;

  // ── The new build reads it on the same origin ────────────────────
  html = NEW;
  ctx = await open();
  ({ p, rule, idle, send } = ctx);
  assert.equal(await p.$$eval('#session-list > li.session', (ls) => ls.length), 2, 'both sessions listed');
  // Session A is the older one (the list is newest first); finished subagents
  // nest under the session in view.
  if (!(await p.isVisible('#session-list'))) await p.click('#flipper');
  await p.click('#session-list > li.session:nth-child(2) .s-open');
  await p.waitForFunction(() => /Got the hello\./.test(document.getElementById('log').textContent) && document.querySelector('.s-child-open'), null, T);
  const rows = await p.$$eval('#session-list > li.session', (ls) => ls.map((l) => ({ text: l.textContent, kids: [...l.querySelectorAll('.s-child-open')].map((b) => b.title), aria: l.querySelector('.s-children')?.ariaLabel ?? null })));
  const withKid = rows.find((r) => r.kids.length);
  assert.ok(withKid, 'the subagent is nested under its session');
  assert.match(withKid.kids[0], /^Agent scout \(a2\), a subagent of main/);
  assert.match(withKid.aria, /^Agents in /);
  assert.doesNotMatch(JSON.stringify(rows), /\(s\d\)/);
  ok('sidebar: two Sessions, the subagent nested and labeled as an agent with handle a2');

  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('pouch.display')).sendMode), 'followup', 'stored "queue" migrated');
  assert.equal(await p.inputValue('#send-mode'), 'followup');
  ok('settings: the saved "queue" mode reads, and is stored, as Follow-up');

  const log = await p.textContent('#log');
  for (const s of ['Please start the scout.', 'Spawned the scout.', 'hello from scout', 'Got the hello.']) assert.ok(log.includes(s), `thread kept: ${s}`);
  assert.match(log, /scout \(a2\)/, 'the stored peer message reads with its a-handle');
  assert.doesNotMatch(log, /\(s\d\)/, 'no s-handle left in the thread view');
  ok('thread: every old turn is there; the stored message from s2 is labeled scout (a2)');

  // The agents carry on: list shows a-handles, an old handle still routes, the old watch is main's.
  await rule({ who: 'main', when: '/carry on/.test(c.since)', reply: [['subagent', { action: 'list' }], ['watch', { action: 'list' }]] });
  await rule({ who: 'main', when: '/- a2 scout/.test(c.since) && !/old handle/.test(c.since)', reply: [['subagent', { action: 'message', to: 's2', text: 'old handle still works?' }]] });
  await rule({ who: 'scout', sticky: true, when: '/old handle still works/.test(c.since)', reply: 'Yes, it does.' });
  await rule({ who: 'main', sticky: true, when: '/woke it|Sent to scout/.test(c.since) && !/Subagent report from Pouch[\\s\\S]*Yes, it does/.test(c.since)', reply: 'Messaged the scout.' });
  await rule({ who: 'main', sticky: true, when: '/Yes, it does/.test(c.since)', reply: 'All good.' });
  await send('Please carry on.');
  await p.waitForFunction(() => /All good\./.test(document.getElementById('log').textContent), null, T);
  const mainSeen = await ctx.seen('main'), scoutSeen = await ctx.seen('scout');
  assert.match(mainSeen, /- a1 main \(you\)/);
  assert.match(mainSeen, /- a2 scout: /);
  assert.match(mainSeen, /- w1 \/work\/w\.txt: changes by the user; note: old watch/, 'the old watch is listed');
  assert.doesNotMatch(mainSeen.slice(mainSeen.indexOf('- a1 main')), /\(owner main s1\)|owner .* a1/, 'its owner reads as main');
  assert.match(mainSeen, /scout \(a2\) had finished; this message woke it/, 'the old handle s2 routed to a2');
  assert.match(scoutSeen, /\[from main \(a1\)\] old handle still works\?/, 'tagged with the new handle');
  ok('agents: list shows a1 and a2, the s1 watch is main\'s, a message to old handle s2 reached scout (a2) tagged [from main (a1)]');

  // Console noise from the bare test server (sw.js served as HTML) is not a page error.
  assert.deepEqual(errors.filter((e) => !e.startsWith('console: ')), []);
  ok('no page errors');
  console.log(`upgrade-browser: ${passed} passed`);
} catch (e) {
  const dump = await ctx?.p.evaluate(() => ({ unmatched: window.fake.unmatched, log: document.getElementById('log').textContent.slice(-1500), status: document.getElementById('status').textContent, input: document.getElementById('input').value, sessions: [...document.querySelectorAll('#session-list > li')].map((l) => l.textContent), reqs: Object.fromEntries(Object.entries(window.fake.requests).map(([k, v]) => [k, v.length])) })).catch(() => null);
  console.log('DUMP', JSON.stringify(dump, null, 1), errors);
  throw e;
} finally {
  await ctx?.context.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
