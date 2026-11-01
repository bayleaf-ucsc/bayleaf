// Batch E real check: one Localhost session on a real oMLX (MiniCPM5-2B by
// default) in the built page (dist/ on the preview origin): the automatic title
// after the first turn, the sparkle's "Suggest a title", and /compact on a thread
// long enough to summarize. Every request to anywhere but loopback is blocked
// and counted: the claim is zero BayLeaf requests. The key is read from
// ~/.omlx/settings.json and never printed.
// Run: node test/batchE-omlx.mjs [MODEL]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const POUCH = process.env.POUCH_URL || 'http://127.0.0.1:8742/pouch.html';
const OMLX = 'http://127.0.0.1:12348';
const KEY = JSON.parse(readFileSync(homedir() + '/.omlx/settings.json', 'utf8')).auth.api_key;
const MODEL = process.argv[2] ?? 'MiniCPM5-2B-oQ8';
const T = { timeout: 120000 };

const browser = await pw.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const external = [];
await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => { { const u = new URL(r.request().url()); external.push(r.request().method() + ' ' + u.host + u.pathname); } r.abort(); });
const page = await context.newPage();
const posts = [];
page.on('request', (r) => { if (r.url().startsWith(OMLX) && r.method() === 'POST' && r.postData() !== '{}') { const b = JSON.parse(r.postData()); posts.push({ tools: (b.tools ?? []).length, chars: r.postData().length }); } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const idle = () => page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
try {
  await page.goto(POUCH);
  await page.click('#welcome button >> text=Got it', { timeout: 5000 }).catch(() => {});
  await page.click('[data-panel="settings"]');
  await page.fill('#lh-url', OMLX); await page.fill('#lh-key', KEY); await page.selectOption('#lh-transport', 'completions');
  await page.click('#lh-test');
  await page.waitForSelector('#model optgroup[label="Localhost"]', { state: 'attached', timeout: 30000 });
  await page.selectOption('#model', 'localhost:' + MODEL);
  const boot = external.length; // page start-up asks BayLeaf for the Sealed model list (blocked); the session must add nothing
  // A pasted document long enough that compaction has older turns to summarize.
  const doc = Array.from({ length: 900 }, (_, i) => `Note ${i + 1}: the Santa Cruz wharf walk passes the sea lions, the Dream Inn and Lighthouse Point; tide pools at Natural Bridges are best at low tide.`).join('\n');
  await page.fill('#input', 'Here are my walking notes. Reply with one short sentence only.\n\n' + doc);
  await page.press('#input', 'Enter');
  await idle();
  await page.waitForFunction(() => { const t = document.getElementById('title').textContent; return t && t !== 'New session' && !/^Here are my walking/.test(t); }, null, T);
  const auto = await page.textContent('#title');
  const afterAuto = posts.length;
  await page.fill('#input', 'More notes. One more short sentence about Lighthouse Point, please.\n\n' + doc.replaceAll('Note', 'Entry')); await page.press('#input', 'Enter');
  await idle();
  await page.click('#title'); await page.waitForSelector('.title-edit .spark');
  const tip = await page.getAttribute('.title-edit .spark', 'title');
  const n0 = posts.length;
  await page.click('.title-edit .spark');
  await page.waitForFunction((n) => !document.querySelector('.title-edit .spark.working'), null, T);
  const suggested = await page.inputValue('.title-input');
  await page.keyboard.press('Enter');
  assert.equal(posts.length, n0 + 1, 'the sparkle made one request to oMLX');
  const n1 = posts.length;
  await page.fill('#input', '/compact'); await page.press('#input', 'Enter');
  await page.waitForFunction(() => /summarized|Nothing to compact|failed|Compaction/.test(document.getElementById('status').textContent) && !/Compacting/.test(document.getElementById('status').textContent), null, T);
  const compactStatus = await page.textContent('#status');
  // The page re-checks reachability with GET /sealed/models while BayLeaf is blocked (offline
  // detection, README "Offline"): no content, no inference. Anything else would be a leak.
  const recheck = (h) => h === 'GET api.bayleaf.dev/sealed/models';
  const bayleaf = external.slice(boot).filter((h) => h.includes('bayleaf.dev') && !recheck(h));
  const rechecks = external.slice(boot).filter(recheck).length;
  console.log(JSON.stringify({ model: MODEL, autoTitle: auto, sparkTip: tip, suggested, compactStatus, omlxPosts: posts.map((p) => p.tools), titleRequests: posts.filter((p) => !p.tools).length, compactRequests: posts.length - n1, bayleafRequests: bayleaf, reachabilityRechecks: rechecks, atBoot: external.slice(0, boot), errors }, null, 1));
  assert.ok(afterAuto >= 2, 'turn plus automatic title on oMLX');
  assert.match(compactStatus, /Older turns summarized/);
  assert.ok(posts.length > n1, 'compaction asked oMLX');
  assert.equal(bayleaf.length, 0, 'zero BayLeaf requests from the session: ' + bayleaf.join());
  console.log(`ok real Localhost: automatic title, sparkle and /compact all on oMLX; zero BayLeaf requests carrying content (${rechecks} reachability GETs of /sealed/models)`);
} finally { await browser.close(); }
