// Real local inference: the Localhost provider in the built page (dist/, served on
// POUCH_URL, default the preview http://127.0.0.1:8742) against a real oMLX on
// 127.0.0.1:12348, with the five agent tasks of experiments/lfm3-webgpu (tree, edit,
// feature, rename, config) through both transports. api.bayleaf.dev is blocked, so this
// also shows Localhost needs no BayLeaf at all: zero Sealed requests by construction.
// The key is read from ~/.omlx/settings.json and never printed. oMLX must allow the
// page origin in server.cors_origins.
// Run: node test/localhost-omlx.mjs MODEL[,MODEL] [completions,responses] [task,task]
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const POUCH = process.env.POUCH_URL || 'http://127.0.0.1:8742/pouch.html';
const OMLX = 'http://127.0.0.1:12348';
const KEY = JSON.parse(readFileSync(homedir() + '/.omlx/settings.json', 'utf8')).auth.api_key;
const modelsArg = (process.argv[2] ?? 'MiniCPM5-2B-oQ8').split(',');
const transports = (process.argv[3] ?? 'completions,responses').split(',');
const only = process.argv[4]?.split(',');
const out = process.env.POUCH_RESULTS || '/tmp/pouch-qa/omlx-results';
mkdirSync(out, { recursive: true });

// The qualification tasks from experiments/lfm3-webgpu/qualification/tasks.mjs
// (read only; run2.mjs was retired), the five agent tasks. tasks.mjs keys files
// by absolute path (/work/...) and grades (files, { trace }, answer); this page
// harness seeds relative paths and records tool names, so adapt both ways.
import { TASKS, FIVE } from '../experiments/lfm3-webgpu/qualification/tasks.mjs';
const rel = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/^\/work\//, ''), v]));
const abs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => ['/work/' + k, v]));
const traceOf = (calls) => ({ trace: calls.map((name) => ({ call: { function: { name } } })) });
const tasks = FIVE.map((n) => TASKS[n]).map((t) => ({ name: t.name, files: rel(t.files), prompt: t.prompt,
  check: (f, calls, ans) => t.check(abs(f), traceOf(calls), ans),
  ...(t.lenient ? { lenient: (f) => t.lenient(abs(f), traceOf([]), '') } : {}) }))
  .filter((t) => !only || only.includes(t.name));

// Tool calls in a request's history, for either transport.
function historyOf(post, transport) {
  let q; try { q = JSON.parse(post ?? '{}'); } catch { return []; }
  if (transport === 'completions') return (q.messages ?? []).flatMap((m) => (m.tool_calls ?? []).map((c) => ({ name: c.function?.name, args: String(c.function?.arguments ?? '').slice(0, 160) })));
  return (q.input ?? []).filter((i) => i.type === 'function_call').map((i) => ({ name: i.name, args: String(i.arguments ?? '').slice(0, 160) }));
}
const omlxStatus = async () => (await fetch(OMLX + '/api/status', { headers: { authorization: `Bearer ${KEY}` } })).json();
const firstPost = {};
// Replays the page's first real request from node to read oMLX's own timings.
async function replay(post, transport) {
  const q = JSON.parse(post); q.stream = true; if (transport === 'completions') q.stream_options = { include_usage: true };
  const t0 = Date.now(); let first = null, usage = null, buf = '';
  const res = await fetch(OMLX + (transport === 'completions' ? '/v1/chat/completions' : '/v1/responses'), { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(q) });
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString();
    for (const line of buf.split('\n').slice(0, -1)) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      let o; try { o = JSON.parse(line.slice(6)); } catch { continue; }
      if (o.model === 'keepalive') continue;
      const d = o.choices?.[0]?.delta;
      if (first == null && (d?.content || d?.reasoning_content || d?.tool_calls || /delta$/.test(o.type ?? ''))) first = Date.now() - t0;
      if (o.usage) usage = o.usage; if (o.type === 'response.completed') usage = o.response.usage;
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
  }
  return { firstTokenMs: first, totalMs: Date.now() - t0, promptTokens: usage?.prompt_tokens ?? usage?.input_tokens, outputTokens: usage?.completion_tokens ?? usage?.output_tokens, genTokPerS: usage?.generation_tokens_per_second ?? null, prefillTokPerS: usage?.prompt_tokens_per_second ?? null, serverTtftS: usage?.time_to_first_token ?? null };
}
const scratch = mkdtempSync(join(tmpdir(), 'pouch-omlx-'));
const browser = await pw.chromium.launch({ headless: true });
const results = [];
// The page's own requests to oMLX, timed: first byte (TTFT includes model load) and size.
try {
  for (const model of modelsArg) for (const transport of transports) for (const task of tasks) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const external = [];
    await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => { external.push(r.request().url()); r.abort(); });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const reqs = [];
    page.on('request', (r) => { if (r.url().startsWith(OMLX) && r.method() === 'POST' && /completions|responses/.test(r.url()) && r.postData() !== '{}') reqs.push({ r, t0: Date.now(), post: r.postData() }); });
    page.on('response', (res) => { const q = reqs.find((x) => x.r === res.request()); if (q) q.tHead = Date.now(); });
    page.on('requestfinished', (r) => { const q = reqs.find((x) => x.r === r); if (q) q.tEnd = Date.now(); });
    const stat0 = await omlxStatus();
    await page.goto(POUCH);
    await page.waitForFunction(() => document.getElementById('lh-test'), null, { timeout: 30000 });
    // Seed /work (OPFS root) and reload so the tree picks it up.
    await page.evaluate(async (files) => {
      const root = await navigator.storage.getDirectory();
      for await (const n of root.keys()) await root.removeEntry(n, { recursive: true });
      for (const [p, text] of Object.entries(files)) {
        const parts = p.split('/'); let d = root;
        for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true });
        const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(text); await w.close();
      }
    }, task.files);
    await page.reload();
    await page.click('#welcome button >> text=Got it', { timeout: 3000 }).catch(() => {});
    await page.click('[data-panel="settings"]');
    await page.fill('#lh-url', OMLX);
    await page.fill('#lh-key', KEY);
    await page.selectOption('#lh-transport', transport);
    await page.click('#lh-test');
    await page.waitForFunction(() => document.querySelector('#model optgroup[label="Localhost"]') || /x /.test(document.getElementById('lh-steps').textContent), null, { timeout: 30000 });
    const steps = await page.$$eval('#lh-steps li', (l) => l.map((x) => x.textContent));
    assert.ok(await page.$('#model optgroup[label="Localhost"]'), steps.join(' | '));
    await page.selectOption('#model', 'localhost:' + model);
    const t0 = Date.now();
    await page.fill('#input', task.prompt);
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Stop', null, { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, { timeout: 15 * 60_000 });
    const ms = Date.now() - t0;
    const files = await page.evaluate(async () => {
      const out = {}; const walk = async (d, pre) => { for await (const [n, h] of d.entries()) { if (n.startsWith('.')) continue; if (h.kind === 'directory') await walk(h, pre + n + '/'); else out[pre + n] = await (await h.getFile()).text(); } };
      await walk(await navigator.storage.getDirectory(), ''); return out;
    });
    await new Promise((r) => setTimeout(r, 500));
    const statusText = await page.textContent('#status');
    // What the model did, from the wire: the last request carries every earlier step.
    const history = historyOf(reqs.at(-1)?.post, transport);
    const calls = history.map((c) => c.name);
    const trace = history;
    const answer = await page.evaluate(() => document.getElementById('messages')?.textContent ?? document.body.textContent);
    const stat1 = await omlxStatus();
    const pass = task.check(files, calls, answer), lenient = task.lenient?.(files);
    const outTok = stat1.total_completion_tokens - stat0.total_completion_tokens, inTok = stat1.total_prompt_tokens - stat0.total_prompt_tokens;
    if (!firstPost[`${model} ${transport}`]) firstPost[`${model} ${transport}`] = reqs[0]?.post;
    const r = { model, transport, task: task.name, pass, lenient: lenient ?? null, ms, requests: reqs.length, inTok, outTok, wallTokPerS: +(outTok / (ms / 1000)).toFixed(1), stepMs: reqs.map((q) => (q.tEnd ?? 0) - q.t0),
      calls, status: statusText.slice(0, 200), external: external.filter((u) => !u.includes('api.bayleaf.dev')).length, sealedBlocked: external.filter((u) => u.includes('api.bayleaf.dev')).length, errors: errors.slice(0, 3) };
    results.push(r);
    console.log(JSON.stringify({ model, transport, task: task.name, pass, lenient, s: (ms / 1000).toFixed(1), requests: reqs.length, wallTokPerS: r.wallTokPerS, inTok, outTok, calls: calls.join(','), status: r.status.slice(0, 120) }));
    writeFileSync(join(out, `${model}-${transport}-${task.name}.json`), JSON.stringify({ ...r, files, trace, answer }, null, 1));
    await context.close();
  }
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
const by = {};
for (const r of results) { const k = `${r.model} ${r.transport}`; (by[k] ??= []).push(r); }
for (const [k, post] of Object.entries(firstPost)) if (post) console.log('replay', k, JSON.stringify(await replay(post, k.split(' ')[1])));
for (const [k, rs] of Object.entries(by)) console.log(`${k}: ${rs.filter((r) => r.pass).length}/${rs.length} pass (${rs.filter((r) => r.pass || r.lenient).length} lenient)`);
