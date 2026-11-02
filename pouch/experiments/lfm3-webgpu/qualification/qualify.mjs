// qualify.mjs: one config-driven qualification run of an in-browser (Transformers.js
// on WebGPU) model for Pouch. Replaces run2.mjs (agent-v2) and run-quant.mjs (quant).
//
//   node qualify.mjs <config.json> [--phase agent|perf|all] [--setups a,b] [--tasks t,u]
//                    [--trials 0,1] [--out name] [--fetch] [--fetch-only] [--headed]
//
// It (1) verifies every model and runtime file against the config's sha256s (hard-linking
// a matching copy from ~/.cache/bayleaf-pouch, downloading only with --fetch), (2) serves
// them plus the page on loopback with a strict CSP, (3) drives headless Chrome in a fresh
// temporary profile, and (4) writes results/<out>.json in schema pouch-qualify-v2, with full
// per-trial traces in results/traces/ (gitignored). summarize.mjs prints the tables.
//
// Config (see configs/): { id, model: { lockId } | { repo, revision, dtype, files: [{name,
// bytes, sha256}] }, loadOptions?, runtime?: { expect: { transformers, ort } }, setups: {
// name: { recipe, toolLayer } }, tasks: [names] | "core", heldOut: [names] | "all", trials:
// { greedy, sampled, temperature, top_p }, execution?: { loader, toolFormat },
// measurements?: { sampleMs, abortGB }, stepCap?, maxNew?, budget?, timeoutMs? }.
// Unset limits come from the recipe (profiles: TJS) or the agent-v2 defaults.
// The default phase is all: behavior and performance. Agent-only runs still measure
// trial memory and per-turn latency, throughput and token workload.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir, arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { TASKS, CORE_NAMES, HELD_OUT_NAMES } from './tasks.mjs';
import { resolveSetup } from './recipes.mjs';
import { executionOptions } from './model-adapters.mjs';
import { readMemory, measure, median, generationMetrics } from './measurements.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), POUCH = resolve(HERE, '../../..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes('--' + k);
const configPath = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : join(HERE, 'configs/lfm3-q4f16.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const phase = arg('phase', 'all');
if (!['agent', 'perf', 'all'].includes(phase)) throw Error('phase must be agent, perf or all');
const execution = executionOptions(config.execution);
const intervalMs = +(arg('sample-ms', String(config.measurements?.sampleMs ?? 500)));
const callTimeoutMs = +(arg('timeout-s', '900')) * 1000;
const rssLimitKB = +(arg('abort-gb', String(config.measurements?.abortGB ?? 12))) * 1e9 / 1024;
if (!Number.isFinite(intervalMs) || intervalMs < 50) throw Error('sample-ms must be at least 50');
if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) throw Error('timeout-s must be positive');
if (!Number.isFinite(rssLimitKB) || rssLimitKB <= 0) throw Error('abort-gb must be positive');
const lock = JSON.parse(readFileSync(join(POUCH, 'models.lock.json'), 'utf8'));
const CACHE = join(homedir(), '.cache/bayleaf-pouch');

// ── 1. Pin and verify. A lockId takes the model exactly as Pouch ships it.
const shipped = config.model.lockId && lock.models.find((m) => m.id === config.model.lockId);
if (config.model.lockId && !shipped) throw Error(`no ${config.model.lockId} in models.lock.json`);
const model = shipped ? { repo: shipped.repo, revision: shipped.revision, dtype: shipped.dtype, files: shipped.files } : config.model;
const modelDir = shipped ? join(CACHE, 'models', shipped.id, shipped.revision) : join(CACHE, 'qualify', model.repo.replace('/', '--'), model.revision);
const sha256 = async (p) => { const h = createHash('sha256'); await pipeline(createReadStream(p, { highWaterMark: 8 << 20 }), async function* (s) { for await (const b of s) h.update(b); }); return h.digest('hex'); };
const good = async (p, f) => existsSync(p) && statSync(p).size === f.bytes && await sha256(p) === f.sha256;
// A file with the same name and revision elsewhere in the cache (another dtype's run,
// or fetch-models.mjs's copy) is hard-linked if its hash matches: no second download.
function* candidates(name) {
  for (const root of [join(CACHE, 'models'), join(CACHE, 'qualify')]) {
    if (!existsSync(root)) continue;
    for (const a of readdirSync(root)) { const p = join(root, a, model.revision, name); if (existsSync(p)) yield p; }
  }
}
async function ensureModel() {
  for (const f of model.files) {
    const dest = join(modelDir, f.name); mkdirSync(dirname(dest), { recursive: true });
    if (await good(dest, f)) continue;
    let found = false;
    for (const c of candidates(f.name)) if (c !== dest && await good(c, f)) { rmSync(dest, { force: true }); linkSync(c, dest); found = true; break; }
    if (found) { console.log('linked', f.name); continue; }
    if (!flag('fetch')) throw Error(`${f.name} missing or wrong hash in ${modelDir}; rerun with --fetch to download it from ${model.repo}@${model.revision}`);
    const tmp = dest + '.part', res = await fetch(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${f.name}`);
    if (!res.ok) throw Error(`${f.name}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    if (!await good(tmp, f)) throw Error(`${f.name}: downloaded bytes do not match the config's sha256`);
    renameSync(tmp, dest); console.log('fetched', f.name);
  }
}
// The runtime is Pouch's own npm copy, checked against models.lock.json (what ships), or
// against config.runtime.expect versions when qualifying a runtime bump.
const RUNTIME = {
  'transformers.js': join(POUCH, 'node_modules/@huggingface/transformers/dist/transformers.js'),
  'ort-wasm-simd-threaded.asyncify.mjs': join(POUCH, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs'),
  'ort-wasm-simd-threaded.asyncify.wasm': join(POUCH, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'),
};
async function checkRuntime() {
  const v = (p) => JSON.parse(readFileSync(join(POUCH, 'node_modules', p, 'package.json'), 'utf8')).version;
  const got = { transformers: v('@huggingface/transformers'), ort: v('onnxruntime-web') };
  const want = config.runtime?.expect ?? { transformers: lock.runtime['@huggingface/transformers'].version, ort: lock.runtime['onnxruntime-web'].version };
  if (got.transformers !== want.transformers || got.ort !== want.ort) throw Error(`runtime ${JSON.stringify(got)} differs from expected ${JSON.stringify(want)}`);
  const hashes = Object.fromEntries(await Promise.all(Object.entries(RUNTIME).map(async ([k, p]) => [k, await sha256(p)])));
  const pinned = !config.runtime?.expect;
  if (pinned && (hashes['transformers.js'] !== lock.runtime['@huggingface/transformers'].sha256 || hashes['ort-wasm-simd-threaded.asyncify.wasm'] !== lock.runtime['onnxruntime-web'].files[0].sha256)) throw Error('runtime hashes differ from models.lock.json');
  return { ...got, sha256: hashes, matchesLock: pinned };
}

// ── 2. Loopback server. Only these paths exist; CSP allows nothing off-origin.
const STATIC = ['qualify.html', 'qualify-page.js', 'qualify-worker.js', 'model-adapters.mjs', 'tools.bundle.js'];
const TYPES = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', json: 'application/json', jinja: 'text/plain' };
function serve(port) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = null;
    if (path === '/') file = join(HERE, 'qualify.html');
    else if (STATIC.includes(path.slice(1))) file = join(HERE, path.slice(1));
    else if (path.startsWith('/runtime/')) file = RUNTIME[path.slice(9)];
    else if (path.startsWith('/m/model/') && model.files.some((f) => f.name === path.slice(9))) file = join(modelDir, path.slice(9));
    if (!file || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[file.split('.').pop()] ?? 'application/octet-stream', 'Content-Length': statSync(file).size,
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'" });
    if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

// ── 3. Measurement helpers. Apple unified memory: IOAccelerator's system-wide counter
// (noisy: other apps move it) and Chrome RSS summed over this run's profile processes.
let profile;
const mem = () => readMemory(profile);
// Failure taxonomy. load = the model never loaded (every trial of the run gets it).
const classify = (status, pass) => pass ? 'pass' : ({ parse_error: 'parse', round_limit: 'cap', final: 'wrong', timeout: 'timeout' })[status] ?? 'other';
const CLASSES = ['pass', 'parse', 'cap', 'wrong', 'timeout', 'load', 'other'];

// ── 4. Run.
const pick = (v, all) => v === 'core' ? CORE_NAMES : v === 'all' ? all : v ?? [];
const taskNames = arg('tasks')?.split(',') ?? [...pick(config.tasks ?? 'core', CORE_NAMES), ...pick(config.heldOut ?? [], HELD_OUT_NAMES)];
const setupNames = arg('setups')?.split(',') ?? Object.keys(config.setups);
const T = { greedy: 1, sampled: 7, temperature: 0.3, top_p: 0.95, ...config.trials };
// Trial 0 is greedy; trials 1..n sample with seed = trial (Transformers.js's own RNG),
// so a seed replays identically across setups and dtypes up to numerical drift.
const trialPlan = [...Array(T.greedy).fill(null).map(() => ({ seed: null, sampling: null })), ...Array.from({ length: T.sampled }, (_, i) => ({ seed: i + 1, sampling: { temperature: T.temperature, top_p: T.top_p } }))]
  .map((t, i) => ({ ...t, trial: i })).filter((t) => !arg('trials') || arg('trials').split(',').map(Number).includes(t.trial));
const out = arg('out', `${config.id}-${phase}`);
mkdirSync(join(HERE, 'results/traces'), { recursive: true });
const port = +(arg('port', '8769'));
const result = { schema: 'pouch-qualify-v2', at: new Date().toISOString(), config: { path: configPath.replace(POUCH + '/', ''), ...config }, execution, model: { repo: model.repo, revision: model.revision, dtype: model.dtype, download_bytes: model.files.reduce((s, f) => s + f.bytes, 0), files: model.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }, phase,
  machine: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, total_memory_bytes: totalmem() },
  measurements: [], measurementNotes: { rss: 'Sampled Chrome process-tree RSS; shared pages may be double counted. Peaks are sampled lower bounds, not allocator maxima.', gpu: 'System-wide Apple IOAccelerator counter, noisy and not model VRAM. Do not add it to RSS.', prefill: 'input tokens / TTFT, an end-to-end proxy including generation setup, not an isolated kernel timer.', load: 'Loopback files with warm OS page cache, not network download latency.', missing: 'null means unavailable, never zero' } };
const traces = [], network = [], errors = [];
const save = () => {
  writeFileSync(join(HERE, 'results', out + '.json'), JSON.stringify({ ...result, externalRequests: network.filter((u) => !u.startsWith(`http://127.0.0.1:${port}/`)), consoleErrors: errors }, null, 1) + '\n');
  writeFileSync(join(HERE, 'results/traces', out + '.json'), JSON.stringify(traces) + '\n');
};

await ensureModel();
// Stage pinned assets without starting a competing GPU workload. --fetch still
// controls download consent; without it this only verifies existing files.
if (flag('fetch-only')) { console.log(`verified ${model.files.length} pinned files; no browser launched`); process.exit(0); }
result.runtime = await checkRuntime();
result.harnessSha256 = Object.fromEntries(await Promise.all([...STATIC, 'qualify.mjs', 'tasks.mjs', 'recipes.mjs', 'measurements.mjs'].map(async (name) => [name, await sha256(join(HERE, name))])));
const server = await serve(port);
profile = await mkdtemp(join(tmpdir(), 'pouch-qualify-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: config.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: !flag('headed'),
  args: ['--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu', '--enable-features=WebGPU'], viewport: { width: 1000, height: 700 } });
const page = await context.newPage(); page.setDefaultTimeout(+(arg('timeout-s', '900')) * 1000);
context.on('request', (r) => network.push(r.url())); page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let watchdogError = null;
const call = async (action, args = {}) => {
  const invoke = () => page.evaluate(({ action, args }) => window.call(action, args), { action, args });
  let timer;
  const sample = () => {
    const m = mem();
    if (!watchdogError && m.chromeRssKB > rssLimitKB) { watchdogError = `Chrome RSS exceeded ${rssLimitKB * 1024 / 1e9} GB`; context.close().catch(() => {}); }
    return m;
  };
  try {
    const measured = await measure(() => Promise.race([invoke(), new Promise((_, reject) => {
      timer = setTimeout(() => { watchdogError = `Call ${action} timed out after ${callTimeoutMs / 1000} s`; context.close().catch(() => {}); reject(Error(watchdogError)); }, callTimeoutMs);
    })]), { sample, intervalMs });
    result.measurements.push({ action, ...measured.measurement });
    return typeof measured.value === 'object' ? { ...measured.value, measurement: measured.measurement } : measured.value;
  } catch (e) { result.measurements.push({ action, ...e.measurement, error: watchdogError ?? String(e) }); if (watchdogError) e.message = watchdogError; throw e; }
  finally { clearTimeout(timer); }
};
const open = async () => { await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => window.ready); };
const load = () => call('load', { dtype: model.dtype, execution, loadOptions: config.loadOptions });
try {
  result.browser = context.browser()?.version();
  await open(); result.memBefore = mem();
  try { result.load = await load(); } catch (e) { result.loadError = String(e).slice(0, 2000); }
  result.memAfterLoad = mem();
  console.log('load', result.load ? Math.round(result.load.load_ms) + ' ms' : 'FAILED ' + result.loadError?.slice(0, 200));
  if (phase === 'agent' || phase === 'all') {
    result.setups = {};
    for (const sn of setupNames) {
      const s = resolveSetup(config.setups[sn], dirname(configPath));
      const limits = { stepCap: config.stepCap ?? s.defaults.stepCap ?? 8, maxNew: config.maxNew ?? s.defaults.maxNew ?? 384, budget: config.budget ?? s.defaults.budget ?? 7808, timeoutMs: config.timeoutMs ?? 120000 };
      const S = result.setups[sn] = { ...config.setups[sn], recipeSha256: s.recipeSha256, toolLayerSha256: createHash('sha256').update(JSON.stringify(s.layer)).digest('hex'), limits, tasks: {} };
      for (const tn of taskNames) {
        const task = TASKS[tn]; if (!task) throw Error('unknown task ' + tn);
        const row = S.tasks[tn] = { n: 0, ...Object.fromEntries(CLASSES.map((c) => [c, 0])), toolErrors: 0, ms: [], rounds: [], trials: [] };
        for (const t of trialPlan) {
          let cls, r = null;
          if (!result.load) cls = 'load';
          else {
            r = await call('agent', { prompt: task.prompt, files: task.files, recipe: s.recipe, layer: s.layer, sampling: t.sampling, seed: t.seed, ...limits });
            const ans = r.trace.filter((x) => x.text).at(-1)?.text ?? '';
            cls = classify(r.status, r.status === 'final' && !!task.check(r.files, r, ans));
            row.toolErrors += r.trace.filter((x) => typeof x.result === 'string' && x.result.startsWith('ERROR:')).length;
            row.ms.push(Math.round(r.duration_ms)); row.rounds.push(r.rounds);
            traces.push({ setup: sn, task: tn, ...t, cls, ...r });
          }
          const generations = (r?.trace ?? []).filter((g) => Number.isFinite(g.generation_ms)).map(generationMetrics);
          row.n++; row[cls]++; row.trials.push({ trial: t.trial, seed: t.seed, cls, status: r?.status ?? 'load', rounds: r?.rounds ?? 0,
            duration_ms: r?.duration_ms ?? null, measurement: r?.measurement ?? null, generations,
            input_tokens: generations.length ? generations.reduce((n, g) => n + g.input_tokens, 0) : null, output_tokens: generations.length ? generations.reduce((n, g) => n + g.output_tokens, 0) : null });
          console.log(sn, tn, t.trial, cls, r?.status ?? '', r?.rounds ?? '', r ? Math.round(r.duration_ms) : '');
        }
        row.median_ms = median(row.ms); save();
      }
    }
  }
  const lengths = arg('lengths')?.split(',').map(Number) ?? config.lengths;
  if ((phase === 'perf' || phase === 'all') && result.load && lengths) {
    // Long-context sweep: exact prompt lengths, per mode ('oneshot' or 'chunk:<n>'), a fresh
    // page and model load per length so ORT's buffer pool starts empty. A mode stops
    // escalating at its first failure or capped prefill. The shared call wrapper samples
    // memory and kills the browser above --abort-gb (Chrome process-tree RSS).
    // 'tail:<n>' runs the worker's synthetic tail probe instead: one n-token chunk ending at N
    // ('tailgpu:<n>' allocates its zero cache on the GPU).
    const modes = (arg('modes') ?? 'oneshot').split(','), capMs = +(arg('cap-s', '600')) * 1000;
    const repeats = (n) => +(arg('repeats', '0')) || (n <= 8192 ? 3 : 1);
    const ctx = result.perf = { context: {}, lengths, modes, gpuCounterNoisy: true, abortGB: rssLimitKB * 1024 / 1e9, capS: capMs / 1000 };
    let aborted = null;
    page.on('console', (m) => { if (m.text().startsWith('[progress]')) process.stdout.write('\r' + m.text().slice(0, 120) + '   '); });
    for (const mode of modes) {
      const chunk = mode === 'oneshot' ? 0 : +mode.split(':')[1], rows = ctx.context[mode] = [], isTail = mode.startsWith('tail');
      for (const N of lengths) {
        await call('dispose').catch(() => {}); await page.reload(); await page.waitForFunction(() => window.ready); await load();
        let stop = false;
        for (let r = 0; r < repeats(N) && !stop && !aborted; r++) {
          const consoleStart = errors.length;
          const at = new Date().toISOString(); let row;
          // page.evaluate has no timeout of its own: a hung one-shot pass kills the browser.
          try { row = await (isTail ? call('tail', { past: N - chunk, chunk, gpu: mode.startsWith('tailgpu') }) : call('context', { length: N, chunk, capMs, label: `${mode} ${N} #${r}` })); }
          catch (e) { aborted = watchdogError; row = { length: N, mode, error: aborted ?? String(e).slice(0, 1500), measurement: e.measurement }; }
          const m = row.measurement;
          Object.assign(row, { repeat: r, at, chromeRssPeakGB: Number.isFinite(m?.chromeRssPeakKB) ? m.chromeRssPeakKB * 1024 / 1e9 : null,
            chromeRssBaseGB: Number.isFinite(m?.before?.chromeRssKB) ? m.before.chromeRssKB * 1024 / 1e9 : null,
            gpuDeltaPeakGB: Number.isFinite(m?.gpuPeakDeltaBytes) ? m.gpuPeakDeltaBytes / 1e9 : null,
            gpuDeltaAfterGB: Number.isFinite(m?.after?.gpuInUseBytes) && Number.isFinite(m?.before?.gpuInUseBytes) ? (m.after.gpuInUseBytes - m.before.gpuInUseBytes) / 1e9 : null,
            console: errors.slice(consoleStart, consoleStart + 10).map((x) => x.slice(0, 400)) });
          rows.push(row); save();
          const { greedyIds, firstTop5, prefillChunksMs, ...brief } = row; process.stdout.write('\n'); console.log(JSON.stringify(brief));
          if (row.error && !flag('keep-going')) stop = true;
        }
        if (stop || aborted) break;
      }
      if (aborted) break;
    }
    ctx.aborted = aborted;
  } else if ((phase === 'perf' || phase === 'all') && result.load) {
    // Cold = first load in this fresh profile (loopback bytes, warm OS page cache: not a
    // network download). Warm = page reload, then load again from Cache Storage.
    const perf = result.perf = { coldLoadMs: Math.round(result.load.load_ms), gpuCounterNoisy: true };
    await call('dispose'); await page.reload(); await page.waitForFunction(() => window.ready);
    perf.warmLoadMs = Math.round((await load()).load_ms); perf.memAfterWarmLoad = mem();
    // Throughput at ~1k and ~4k prompt tokens, 256 forced output tokens, 3 runs each.
    // prefill = input/TTFT; decode = (n-1)/(last token - first token).
    const filler = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}: the lantern project converts temperatures between units for display.`).join('\n');
    perf.rows = [];
    for (const [label, lines] of [['~1k', 62], ['~4k', 250]]) for (let i = 0; i < 3; i++) {
      const g = await call('generate', { messages: [{ role: 'user', content: filler(lines) + '\n\nNow write the numbers from 1 to 200, separated by commas, and nothing else.' }], options: { maxNew: 256, minNew: 256, budget: 1e9 } });
      const row = { label, ...generationMetrics(g), measurement: g.measurement, ...mem() };
      perf.rows.push(row); console.log(JSON.stringify(row)); save();
    }
    for (const label of ['~1k', '~4k']) { const rs = perf.rows.filter((r) => r.label === label); perf[label] = { ttft_ms: median(rs.map((r) => r.ttft_ms)), prefill_tok_s: median(rs.map((r) => r.prefill_tok_s)), decode_tok_s: median(rs.map((r) => r.decode_tok_s)) }; }
    const b = result.memBefore.gpuInUseBytes;
    const rss = result.measurements.map((m) => m.chromeRssPeakKB).filter(Number.isFinite);
    perf.chromeRssPeakGB = rss.length ? Math.max(...rss) * 1024 / 1e9 : null;
    const gpuPeaks = result.measurements.filter((m) => Number.isFinite(m.before?.gpuInUseBytes) && Number.isFinite(m.gpuPeakDeltaBytes)).map((m) => m.before.gpuInUseBytes + m.gpuPeakDeltaBytes);
    perf.gpuLoadDeltaGB = Number.isFinite(b) && Number.isFinite(result.memAfterLoad.gpuInUseBytes) ? (result.memAfterLoad.gpuInUseBytes - b) / 1e9 : null;
    perf.gpuPeakDeltaGB = Number.isFinite(b) && gpuPeaks.length ? (Math.max(...gpuPeaks) - b) / 1e9 : null;
  }
  await call('dispose').catch(() => {});
} catch (e) { result.fatal = String(e).slice(0, 4000); console.error(result.fatal.slice(0, 1000)); }
finally { save(); await context.close(); server.close(); await rm(profile, { recursive: true, force: true }); }
console.log(`wrote results/${out}.json (traces: results/traces/${out}.json); external requests: ${network.filter((u) => !u.startsWith(`http://127.0.0.1:${port}/`)).length}`);
if (result.fatal || result.loadError || watchdogError || network.some((u) => !u.startsWith(`http://127.0.0.1:${port}/`))) process.exitCode = 1;
