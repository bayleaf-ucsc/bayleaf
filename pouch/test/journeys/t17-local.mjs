// t17: Pouch's Local lane in real headless Chrome (WebGPU), against a local static
// server of a --with-models build. No Sealed inference: api.bayleaf.dev is faked
// (model list, usage) and everything else external is aborted and logged.
// node t17-local.mjs [phase,...]   phases: main tamper import (default: all)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, linkSync, copyFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { instrument, newSession as newSession0, ensurePanel, currentSession } from './lib.mjs';
// Wait until the new session exists, or a fast Enter races its creation ("Session changed").
async function newSession(page) { const was = await currentSession(page); await newSession0(page); for (let i = 0; i < 50 && (await currentSession(page)) === was; i++) await sleep(100); await sleep(200); }

const BUILD = process.env.BUILD ?? '/tmp/pouch-qa/local-build';
const phases = (process.argv[2] ?? 'main,tamper,import').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); console.log(c ? 'PASS' : 'FAIL', m); appendFileSync('/tmp/pouch-qa/t17-local.log', `${c ? 'PASS' : 'FAIL'} ${m}\n`); };
const info = (m) => { console.log('INFO', m); appendFileSync('/tmp/pouch-qa/t17-local.log', `INFO ${m}\n`); };
const html = readFileSync(join(BUILD, 'pouch.html'), 'utf8');
const MODEL_DIR = readdirSync(join(BUILD, 'models'))[0];
const LOCAL_ID = 'local:' + MODEL_DIR;
const manifestName = readdirSync(join(BUILD, 'models', MODEL_DIR)).find((n) => n.startsWith('manifest.'));
const manifest = JSON.parse(readFileSync(join(BUILD, 'models', MODEL_DIR, manifestName), 'utf8'));
const nFiles = readdirSync(join(BUILD, 'models', MODEL_DIR)).length;

function serve(dir, port) {
  const p = spawn('node', ['/tmp/pouch-qa/local-serve.mjs', dir, String(port)], { stdio: 'ignore' });
  return { url: `http://127.0.0.1:${port}/`, stop: () => new Promise((r) => { p.once('exit', r); p.kill(); }) };
}
async function launch(profile, fresh = true) {
  if (fresh) rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu', '--enable-features=WebGPU'], viewport: { width: 1400, height: 900 },
  });
  const net = [];
  ctx.on('request', (r) => net.push({ url: r.url(), t: Date.now() }));
  await ctx.route('https://**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.host === 'api.bayleaf.dev' && u.pathname.endsWith('/models')) return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, endpoints: ['/v1/chat/completions'] }] } });
    if (u.host === 'api.bayleaf.dev' && u.pathname.includes('usage')) return r.fulfill({ json: {} });
    return r.abort();
  });
  return { ctx, net };
}
async function open(ctx, url) {
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.setDefaultTimeout(60_000); globalThis.__page = page;
  const errors = instrument(page);
  page.on('console', (m) => { if (/Local|WebGPU|ort|onnx/i.test(m.text()) && m.type() !== 'debug') errors.push('[console] ' + m.text().slice(0, 200)); });
  await page.goto(url + 'pouch.html');
  await page.waitForSelector(`#model option[value="${LOCAL_ID}"]`, { state: 'attached' });
  await page.evaluate(() => { window.__st = []; new MutationObserver(() => window.__st.push(document.querySelector('#status').textContent)).observe(document.querySelector('#status'), { childList: true, characterData: true, subtree: true }); });
  return { page, errors };
}
const modelReqs = (net, since = 0) => net.filter((r) => r.t >= since && /\/models\//.test(r.url));
const foreign = (net, base) => net.filter((r) => !r.url.startsWith(base) && !r.url.startsWith('blob:') && !r.url.startsWith('data:') && !r.url.startsWith('https://api.bayleaf.dev/'));
async function pickLocal(page) {
  await page.selectOption('#model', LOCAL_ID);
  await page.waitForFunction(() => /^(ready|error)$/.test(document.querySelector('#addons-settings').dataset.tjs ?? '') || /Local is not|Local model:/.test(document.querySelector('#status').textContent), null, { timeout: +(process.env.PICK_MS ?? 600_000) })
    .catch(async (e) => { throw new Error('pickLocal: ' + JSON.stringify(await page.evaluate(() => [document.querySelector('#addons-settings').dataset.tjs, ...window.__st.slice(-3)]))); });
  return page.$eval('#addons-settings', (b) => b.dataset.tjs === 'ready' ? 'ready' : 'error: ' + (b.dataset.error ?? document.querySelector('#status').textContent));
}
async function cacheInfo(page) {
  return page.evaluate(async () => {
    const keys = await caches.keys();
    const c = keys.includes('pouch-local-models') ? (await (await caches.open('pouch-local-models')).keys()).length : 0;
    return { keys, entries: c, usage: (await navigator.storage.estimate()).usage };
  });
}
// /work is the OPFS root.
async function seed(page, files) {
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for await (const n of root.keys()) await root.removeEntry(n, { recursive: true });
    for (const [p, text] of Object.entries(files)) {
      let d = root; const parts = p.replace(/^\/work\//, '').split('/');
      for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true });
      const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(text); await w.close();
    }
  }, files);
}
async function snapshot(page) {
  return page.evaluate(async () => {
    const out = {};
    async function walk(d, pre) { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, pre + n + '/'); else out['/work/' + pre + n] = await (await h.getFile()).text(); } }
    await walk(await navigator.storage.getDirectory(), '');
    return out;
  });
}
async function ask(page, text, { stopAfterText = 0 } = {}) {
  const before = await page.$$eval('#log details.tool', (d) => d.length).catch(() => 0);
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
  // A turn has started once the user's message is in the log; it has ended when Send is back.
  await page.waitForFunction((t) => [...document.querySelectorAll('#log .msg.user')].some((m) => m.textContent.includes(t.slice(0, 40))), text, { timeout: 30_000 })
    .catch(async () => { throw new Error('message not sent: ' + JSON.stringify(await page.evaluate(() => window.__st.slice(-4)))); });
  const t0 = Date.now();
  let stoppedAt = null;
  if (stopAfterText) {
    await page.waitForFunction((n) => (document.querySelector('#log .msg.assistant:last-of-type')?.textContent ?? '').length > n || [...document.querySelectorAll('#log .msg.assistant')].at(-1)?.textContent.length > n, stopAfterText, { timeout: 120_000 });
    stoppedAt = Date.now();
    await page.$eval('#send', (b) => b.click());
  }
  await page.waitForFunction(() => document.querySelector('#send-label').textContent !== 'Stop', null, { timeout: 300_000 });
  await sleep(300);
  const tools = (await page.$$eval('#log details.tool .what', (d) => d.map((x) => x.textContent))).slice(before);
  const reply = await page.$$eval('#log .msg.assistant', (d) => d.at(-1)?.textContent ?? '');
  return { tools, reply, ms: Date.now() - t0, stopMs: stoppedAt && Date.now() - stoppedAt };
}

// The five agent-v2 tasks (run2.mjs), graded byte-exact.
const base = { '/work/README.md': '# Lantern\nA small temperature converter. src/convert.js is logic, src/ui.js is display.\n', '/work/src/convert.js': 'export function celsiusToFahrenheit(c) {\n  return c * 9 / 5 + 30;\n}\n', '/work/src/ui.js': 'export const label = "Temperature";\n', '/work/docs/notes.txt': 'Keep output concise.\n' };
const fixed = (f) => ({ ...f, '/work/src/convert.js': f['/work/src/convert.js'].replace('+ 30', '+ 32') });
const uiR = 'import { celsiusToFahrenheit } from "./convert.js";\nexport const label = "Temperature";\nexport function show(c) {\n  return label + ": " + celsiusToFahrenheit(c);\n}\n';
const renameFiles = { ...fixed(base), '/work/src/convert.js': 'export function celsiusToFahrenheit(c) {\n  return c * 9 / 5 + 32;\n}\n', '/work/src/ui.js': uiR };
const cfgFiles = { '/work/README.md': base['/work/README.md'], '/work/config.json': '{\n  "precision": 1\n}\n', '/work/src/convert.js': fixed(base)['/work/src/convert.js'], '/work/src/ui.js': 'import config from "../config.json" with { type: "json" };\nimport { celsiusToFahrenheit } from "./convert.js";\nexport function show(c) {\n  return celsiusToFahrenheit(c).toFixed(config.precision);\n}\n' };
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const tasks = [
  { name: 'tree', files: base, prompt: 'Inspect this unfamiliar workspace using tools. List its tree, read the README and source files, then summarize what the project does. Do not change files.',
    check: (f, r) => same(f, base) && r.tools.some((t) => t.startsWith('bash')) && r.tools.filter((t) => t.startsWith('read')).length >= 3 && /convert|temperature|celsius/i.test(r.reply) },
  { name: 'edit', files: base, prompt: 'Read src/convert.js and correct the Celsius-to-Fahrenheit offset from 30 to 32. Change nothing else.', check: (f) => same(f, fixed(base)) },
  { name: 'feature', files: base, prompt: 'Add the exact line export const unit = "F"; followed by a newline to the end of src/ui.js. Create docs/unit.txt with exactly Fahrenheit followed by a newline. Also fix the offset in src/convert.js from 30 to 32. Read files first; change nothing else.',
    check: (f) => same(f, { ...fixed(base), '/work/src/ui.js': base['/work/src/ui.js'] + 'export const unit = "F";\n', '/work/docs/unit.txt': 'Fahrenheit\n' }) },
  { name: 'rename', files: renameFiles, prompt: 'Rename the function celsiusToFahrenheit to toFahrenheit everywhere in the workspace: its definition, imports and calls. Find all uses first. Change nothing else.',
    check: (f) => same(f, Object.fromEntries(Object.entries(renameFiles).map(([k, v]) => [k, v.replaceAll('celsiusToFahrenheit', 'toFahrenheit')]))) },
  { name: 'config', files: cfgFiles, prompt: 'Add a "unit" field with the value "F" to config.json, keeping "precision". Then change show() in src/ui.js so it returns the formatted number followed by a space and config.unit, for example "50.0 F". Read files first. Change nothing else.',
    check: (f) => { try { const c = JSON.parse(f['/work/config.json']); if (JSON.stringify(c) !== '{"precision":1,"unit":"F"}') return false;
      if (!same({ ...f, '/work/config.json': 0, '/work/src/ui.js': 0 }, { ...cfgFiles, '/work/config.json': 0, '/work/src/ui.js': 0 })) return false;
      const ui = f['/work/src/ui.js']; if (!/^import config from "\.\.\/config\.json" with \{ type: "json" \};\nimport \{ celsiusToFahrenheit \} from "\.\/convert\.js";\n/.test(ui)) return false;
      const body = ui.split('\n').slice(2).join('\n').replace(/export /g, '');
      return new Function('config', 'celsiusToFahrenheit', body + '\nreturn show(10);')(c, (x) => x * 9 / 5 + 32) === '50.0 F'; } catch { return false; } } },
];

writeFileSync('/tmp/pouch-qa/t17-local.log', `t17 ${new Date().toISOString()} build ${BUILD} phases ${phases}\n`);
const srv = serve(BUILD, 8790);
await sleep(500);
try {
  if (phases.includes('main')) {
    const { ctx, net } = await launch('/tmp/pouch-qa/local-profile');
    let { page, errors } = await open(ctx, srv.url);
    ok(await page.$eval(`#model option[value="${LOCAL_ID}"]`, (o) => !o.disabled && /Local: LFM3 1.7B \(on this device\)/.test(o.textContent)), 'picker offers "Local: LFM3 1.7B (on this device)" with WebGPU');
    // 1. First load: confirm, download with progress, verify.
    const t0 = Date.now();
    const st = await pickLocal(page);
    const dl = modelReqs(net, t0);
    const progress = await page.evaluate(() => window.__st.filter((s) => /Local: .*\(\d+%\)/.test(s)));
    info(`first load ${(Date.now() - t0) / 1000}s, ${dl.length} model requests, status "${st}"; progress samples ${progress.length}: ${progress.slice(0, 2).join(' | ')} ... ${progress.at(-1)}`);
    ok(st === 'ready', 'first load downloads, verifies and starts the model');
    ok(dl.length === nFiles, `downloaded exactly the ${nFiles} manifest/worker/part files (got ${dl.length})`);
    ok(progress.some((s) => /downloading and checking .* MB of .* MB \(\d+%\)/.test(s)) && progress.some((s) => /\(100%\)|\(99%\)/.test(s)), 'progress shows bytes and percent');
    ok(dialogsInclude(page, /Download the Local model/), 'download asked first (confirm)');
    const c1 = await cacheInfo(page);
    ok(c1.entries === nFiles, `verified parts kept in Cache Storage (${c1.entries} entries, usage ${(c1.usage / 2 ** 30).toFixed(2)} GiB)`);
    // Lane display.
    await page.$eval('#shield-btn', (b) => b.click()); await sleep(300);
    ok(/On this device: nothing sent/.test(await page.textContent('#shield-pop')), 'shield popover: "On this device: nothing sent"');
    await page.keyboard.press('Escape'); await page.$eval('#shield-pop', (p) => { if (!p.hidden) document.querySelector('#shield-btn').click(); }).catch(() => {});
    // 2. Agent tasks in the real app (greedy, n=2 each).
    const apiBefore = net.filter((r) => r.url.startsWith('https://api.bayleaf.dev/')).length;
    const summary = {};
    for (const task of tasks) for (let trial = 1; trial <= 2; trial++) {
      await seed(page, task.files);
      await newSession(page);
      await page.selectOption('#model', LOCAL_ID);
      const r = await ask(page, task.prompt);
      const files = await snapshot(page);
      const pass = !!task.check(files, r);
      (summary[task.name] ??= { pass: 0, n: 0, ms: [] }); summary[task.name].n++; summary[task.name].pass += pass; summary[task.name].ms.push(r.ms);
      info(`${task.name}#${trial} ${pass ? 'pass' : 'FAIL'} ${r.ms}ms tools=[${r.tools.join(' ; ').slice(0, 300)}] reply=${JSON.stringify(r.reply.slice(0, 160))}`);
      if (!pass) info(`  files: ${JSON.stringify(files).slice(0, 700)}`);
    }
    const passes = Object.values(summary).reduce((n, s) => n + s.pass, 0);
    info('tasks ' + JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, s]) => [k, `${s.pass}/${s.n} median ${s.ms.sort((a, b) => a - b)[s.ms.length >> 1]}ms`]))));
    ok(passes >= 8, `agent tasks in the real app: ${passes}/10 byte-exact (agent-v2 v8 greedy: 10/10, pooled 39/40)`);
    const apiAfter = net.filter((r) => r.url.startsWith('https://api.bayleaf.dev/'));
    ok(apiAfter.slice(apiBefore).every((r) => !/chat\/completions|sealed\/v1/.test(r.url)), `no Sealed inference during Local turns (api.bayleaf.dev requests during tasks: ${apiAfter.length - apiBefore}, ${[...new Set(apiAfter.slice(apiBefore).map((r) => new URL(r.url).pathname))].join(', ')})`);
    // 3. Stop interrupts generation; the model still answers afterwards.
    await seed(page, base); await newSession(page); await page.selectOption('#model', LOCAL_ID);
    const s1 = await ask(page, 'Without using any tools, write a 400-word story about a lantern maker.', { stopAfterText: 40 });
    info(`stop: settled ${s1.stopMs}ms after Stop; reply length ${s1.reply.length}`);
    ok(s1.stopMs !== null && s1.stopMs < 5000 && s1.reply.length < 1800, 'Stop interrupts Local generation quickly');
    const s2 = await ask(page, 'Reply with just the word OK. Do not use tools.');
    ok(/ok/i.test(s2.reply), `Local answers after a stop ("${s2.reply.slice(0, 40)}")`);
    // 4. Hints: step cap and repeated failing edit.
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`/work/f${i + 1}.txt`, `value ${i + 1}\n`]));
    await seed(page, many); await newSession(page); await page.selectOption('#model', LOCAL_ID);
    const h1 = await ask(page, 'Read f1.txt, then f2.txt, and so on up to f10.txt: one read tool call per step, in order, never two at once. Then list all ten values.');
    const hint1 = await page.isVisible('#local-hint') ? await page.textContent('#local-hint-text') : '';
    info(`step-cap run: ${h1.tools.length} tools; hint "${hint1}"; reply ${JSON.stringify(h1.reply.slice(0, 120))}`);
    ok(/cap/.test(hint1) || h1.tools.length < 8, 'step-cap hint appears when Local hits 8 steps');
    ok(/cap/.test(hint1) ? /stopped after 8 steps/.test(h1.reply) : true, 'the capped turn says it stopped');
    await seed(page, { '/work/notes.txt': 'hello there\n' }); await newSession(page); await page.selectOption('#model', LOCAL_ID);
    const h2 = await ask(page, 'Use the edit tool on notes.txt to replace the exact text "goodbye world" with "hi". Do not read the file. If the edit fails, try the same edit again exactly as before, once.');
    const hint2 = await page.isVisible('#local-hint') ? await page.textContent('#local-hint-text') : '';
    const failedEdits = h2.tools.filter((t) => t.startsWith('edit')).length;
    info(`fail-twice run: tools=[${h2.tools.join(' ; ')}] hint "${hint2}"`);
    ok(failedEdits < 2 || /failed the same kind of edit twice/.test(hint2), `fail-twice hint appears after 2 failed edits (${failedEdits} edit calls)`);
    if (/Sealed/.test(hint2)) {
      await page.$eval('#local-hint-switch', (b) => b.click());
      ok(!(await page.$eval('#model', (s) => s.value)).startsWith('local:') && /Nothing was sent/.test(await page.textContent('#status')), '"Use Sealed next" only changes the picker');
      await page.selectOption('#model', LOCAL_ID);
    }
    // 5. Usage panel: the Local lane uses no allowance.
    await ensurePanel(page, 'usage');
    await page.waitForSelector('#usage-body .local-usage', { timeout: 10_000 }).catch(() => {});
    const usageText = await page.textContent('#usage-body');
    ok(/Local/.test(usageText) && /no.*allowance|allowance.*not|none of/i.test(usageText), 'usage panel says Local uses no allowance');
    // 6. Reload: zero model downloads, verified from cache.
    await page.close();
    ({ page, errors } = await open(ctx, srv.url));
    await page.selectOption('#model', LOCAL_ID);
    const t1 = Date.now();
    const st2 = await pickLocal(page);
    ok(/ready/.test(st2) && modelReqs(net, t1).length === 0, `reload: model from Cache Storage, ${modelReqs(net, t1).length} model downloads, ${(Date.now() - t1) / 1000}s to ready`);
    // 7. Offline: Local still answers and runs tools.
    await seed(page, base); await newSession(page); await page.selectOption('#model', LOCAL_ID);
    await ctx.setOffline(true);
    const n0 = net.length;
    const off = await ask(page, 'Read src/convert.js and correct the Celsius-to-Fahrenheit offset from 30 to 32. Change nothing else.');
    const offFiles = await snapshot(page);
    ok(same(offFiles, fixed(base)) && off.tools.some((t) => t.startsWith('edit')), `offline: Local answers and edits (tools ${off.tools.join(' ; ')})`);
    ok(net.slice(n0).filter((r) => !r.url.startsWith('blob:')).length === 0, `offline Local turn made no requests (${net.slice(n0).map((r) => r.url).join(', ').slice(0, 200)})`);
    await ctx.setOffline(false);
    // 8. Remove local model frees storage.
    const before = await cacheInfo(page);
    await ensurePanel(page, 'settings');
    await page.$eval('[data-addon^="lfm3"] [data-act="remove"]', (b) => b.click());
    await page.waitForFunction(() => /Local model removed/.test(document.querySelector('#status').textContent));
    ok(!(await cacheInfo(page)).keys.includes('pouch-local-models'), 'Remove deletes the model cache (and does not recreate it)');
    const pick = await page.$eval('#model', (s) => `${s.value} [${[...s.options].map((o) => o.value + (o.disabled ? '(disabled)' : '')).join(', ')}]`);
    ok(!pick.startsWith('local:'), `after removal the picker is back on Sealed (${pick}); a reloaded Local session still shows its own lane`);
    await page.close(); ({ page } = await open(ctx, srv.url));
    const after = await cacheInfo(page);
    info(`remove: usage ${(before.usage / 2 ** 30).toFixed(2)} -> ${(after.usage / 2 ** 30).toFixed(2)} GiB; ${await page.textContent('[data-addon^="lfm3"] .addon-state')}`);
    ok(!after.keys.includes('pouch-local-models') && after.usage < before.usage - 9e8, 'Remove local model deletes the parts and frees storage');
    const bad = foreign(net, srv.url);
    ok(bad.length === 0, `no requests except same-origin and api.bayleaf.dev (${bad.map((r) => r.url).slice(0, 5).join(', ')})`);
    ok(!net.some((r) => /huggingface|jsdelivr|hf\.co/.test(r.url)), 'no CDN or Hugging Face requests');
    info('page errors: ' + JSON.stringify(errors.filter((e) => !/favicon|ERR_FAILED|net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)).slice(0, 8)));
    await ctx.close();
  }

  if (phases.includes('tamper')) {
    // A copy of the build with one part tampered on disk (others hardlinked).
    const T = '/tmp/pouch-qa/local-tamper', dir = join(T, 'models', MODEL_DIR);
    rmSync(T, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    copyFileSync(join(BUILD, 'pouch.html'), join(T, 'pouch.html'));
    const target = manifest.files.find((f) => f.name.endsWith('onnx_data')).parts[3].path;
    for (const n of readdirSync(join(BUILD, 'models', MODEL_DIR))) {
      if (n === target) { const b = readFileSync(join(BUILD, 'models', MODEL_DIR, n)); b[1000] ^= 0xff; writeFileSync(join(dir, n), b); }
      else linkSync(join(BUILD, 'models', MODEL_DIR, n), join(dir, n));
    }
    const bad = serve(T, 8791); await sleep(500);
    const { ctx, net } = await launch('/tmp/pouch-qa/local-profile-tamper');
    let { page } = await open(ctx, bad.url);
    const st = await pickLocal(page);
    const tries = net.filter((r) => r.url.endsWith(target)).length;
    ok(/failed its SHA-256 check twice/.test(st) && !/ready/.test(st), `a tampered part is refused after a refetch ("${st.slice(0, 120)}", ${tries} fetches of it)`);
    const ci = await cacheInfo(page);
    ok(!(await page.evaluate(async (t) => !!(await (await caches.open('pouch-local-models')).match('https://pouch-local.invalid/models/' + t.dir + '/' + t.p)), { dir: MODEL_DIR, p: target })), `the tampered part was never kept (${ci.entries} good parts kept)`);
    const kept = (await cacheInfo(page)).entries;
    await page.close();
    // Same profile, good server: only the missing part is fetched. Then damage a kept part in storage.
    await bad.stop(); // the port must be free before the good copy binds it
    info('bad server stopped');
    const good = serve(BUILD, 8791); await sleep(500); // same origin as the tampered server: same Cache Storage
    info('good server started');
    ({ page } = await open(ctx, good.url));
    info('page open on good server');
    const t0 = Date.now();
    await page.selectOption('#model', LOCAL_ID);
    const st2 = await pickLocal(page);
    const fetched = modelReqs(net, t0).map((r) => r.url.split('/').pop());
    ok(/ready/.test(st2) && fetched.length === nFiles - kept && fetched.includes(target), `resume from a good server fetches only what was not kept: ${fetched.length} = ${nFiles} - ${kept} kept, refused part included; ${st2}`);
    const victim = manifest.files.find((f) => f.name.endsWith('onnx_data')).parts[7].path;
    await page.evaluate(async (k) => { const c = await caches.open('pouch-local-models'); await c.put(k, new Response(new Blob(['corrupted bytes']))); }, `https://pouch-local.invalid/models/${MODEL_DIR}/${victim}`);
    await page.close();
    ({ page } = await open(ctx, good.url));
    const t1 = Date.now();
    await page.selectOption('#model', LOCAL_ID);
    const st3 = await pickLocal(page);
    const refetched = modelReqs(net, t1).map((r) => r.url.split('/').pop());
    const saw = await page.evaluate(() => window.__st.filter((s) => /damaged part/.test(s)).length);
    ok(/ready/.test(st3) && refetched.length === 1 && refetched[0] === victim && saw > 0, `a corrupted cached part is detected, cleared and refetched (${refetched.join(', ')}; "damaged part" shown ${saw}x)`);
    good.stop();
    await ctx.close();
  }

  if (phases.includes('import')) {
    // Load from files (no network): manifest + worker + wasm parts from the folder, model as the ORIGINAL upstream files.
    const { ctx, net } = await launch('/tmp/pouch-qa/local-profile-import');
    let { page } = await open(ctx, srv.url);
    const d = join(BUILD, 'models', MODEL_DIR);
    const wasmParts = manifest.files.find((f) => f.role === 'wasm').parts.map((p) => join(d, p.path));
    const cache = join(homedir(), '.cache/bayleaf-pouch/models', MODEL_DIR, manifest.revision);
    const upstream = manifest.files.filter((f) => f.role === 'model').map((f) => join(cache, f.name));
    await ctx.setOffline(true);
    const n0 = net.length;
    await ensurePanel(page, 'settings');
    await page.setInputFiles('#addon-files', [join(d, manifestName), join(d, manifest.worker.path), ...wasmParts, ...upstream]);
    await page.waitForFunction(() => /Local model loaded from your files|still missing|refused|Pick the/.test(document.querySelector('#status').textContent), null, { timeout: 300_000 });
    const st = await page.textContent('#status');
    ok(/Local model loaded from your files/.test(st), `Load from files (original upstream files + saved runtime parts), offline: "${st}"`);
    await page.selectOption('#model', LOCAL_ID);
    const ready = await pickLocal(page);
    const r = await ask(page, 'Reply with just the word OK. Do not use tools.');
    ok(/ready/.test(ready) && /ok/i.test(r.reply) && net.slice(n0).filter((x) => !x.url.startsWith('blob:')).length === 0, `imported model answers offline with no requests ("${r.reply.slice(0, 30)}")`);
    await ctx.setOffline(false);
    // Erase all removes it.
    const c0 = await cacheInfo(page);
    page.dialogQueue.push(true);
    await page.evaluate(() => document.querySelector('#erase')?.click());
    await page.waitForURL(/#erased|pouch\.html$/, { timeout: 60_000 }).catch(() => {});
    await sleep(1500);
    const c1 = await cacheInfo(page);
    info(`erase: ${c0.entries} -> ${c1.entries} entries, usage ${(c0.usage / 2 ** 30).toFixed(2)} -> ${(c1.usage / 2 ** 30).toFixed(2)} GiB, caches ${JSON.stringify(c1.keys)}`);
    ok(c0.entries > 0 && !c1.keys.includes('pouch-local-models') && c1.usage < c0.usage - 9e8, 'Erase all removes the Local model');
    await ctx.close();
  }
} catch (e) { ok(false, 'fatal: ' + (e.stack ?? e).toString().slice(0, 600)); await globalThis.__page?.screenshot({ path: '/tmp/pouch-qa/t17-fatal.png' }).catch(() => {}); }
finally { srv.stop(); }
function dialogsInclude(page, re) { return page.dialogLog.some((d) => re.test(d)); }
const fails = results.filter(([c]) => !c).length;
console.log(`${results.length - fails}/${results.length} passed`);
appendFileSync('/tmp/pouch-qa/t17-local.log', `${results.length - fails}/${results.length} passed\n`);
process.exit(fails ? 1 : 0);
