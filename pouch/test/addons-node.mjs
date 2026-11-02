// Add-ons (node): the registry built from this build's pins, the consent tiers,
// the strings agents read, the `addons` command (install, consent, /task
// install with stop and resume, remove, verify, install --all), ensure() for
// workers, hidden parts, device refusal and offline.   node test/addons-node.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// This build's pins, as build.mjs defines them, set before any module reads them.
const H0 = (b) => createHash('sha256').update(b).digest('hex');
const built = existsSync('dist/runtime/pdf');
const pinOf = (group) => {
  const dir = `runtime/${group}/`, manifest = readdirSync('dist/' + dir).find((f) => f.startsWith('manifest.'));
  const body = readFileSync(`dist/${dir}${manifest}`);
  return { dir, manifest, sha256: H0(body), bytes: JSON.parse(body).totalBytes };
};
const lock = JSON.parse(readFileSync('models.lock.json', 'utf8')).models[0];
if (built) {
  globalThis.POUCH_PDF_RUNTIME = pinOf('pdf'); globalThis.POUCH_LIBAV_RUNTIME = pinOf('libav'); globalThis.POUCH_DUCKDB_RUNTIME = pinOf('duckdb');
  globalThis.LOCAL_MODEL = { ...lock, bytes: lock.files.reduce((n, f) => n + f.bytes, 0), runtime: pinOf('transformers') };
  const asr = JSON.parse(readFileSync('models.lock.json', 'utf8')).models.find((m) => m.kind === 'speech-to-text');
  globalThis.POUCH_PARAKEET = { model: { id: asr.id, label: asr.label, repo: asr.repo, revision: asr.revision, license: asr.license, attribution: asr.attribution, runs: asr.runs,
    files: asr.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }, encoder: asr.encoder, decoder: asr.decoder, vocab: asr.vocab, runtime: pinOf('parakeet') };
}
const { QUIET_MAX, askTitle, createAddons, gatewayBackend, originBackend, say, sizeText, tierOf } = await import('../src/addons.ts');
const { addonsCommands, HELP } = await import('../src/addons-cli.ts');
const { installLines } = await import('../src/pdf.ts');
const { Tasks, TaskFs } = await import('../src/ns/tasks.ts');
const { REGISTRY } = await import('../src/addons-registry.ts');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const H = (b) => createHash('sha256').update(b).digest('hex');
const MiB = 2 ** 20, C = 64 * 1024;

// ── Fakes: an origin serving content-hash parts, and a gateway serving byte ranges ──
let dirs = 0;
function originAddon(id, bytes, extra = {}) {
  const body = randomBytes(bytes), PART = 4096, parts = [];
  for (let i = 0; i < body.length; i += PART) { const p = body.subarray(i, i + PART); parts.push({ path: H(p) + '.bin', bytes: p.length, sha256: H(p), body: p }); }
  const manifest = Buffer.from(JSON.stringify({ format: 2, files: [{ name: 'worker.js', role: 'worker', bytes: body.length, sha256: H(body), parts: parts.map(({ body: _, ...x }) => x) }] }));
  const served = new Map([['manifest.0123456789abcdef.json', manifest], ...parts.map((p) => [p.path, p.body])]);
  const pin = { dir: `runtime/t${dirs++}/`, manifest: 'manifest.0123456789abcdef.json', sha256: H(manifest), bytes: body.length };
  return { def: { id, label: id, kind: 'tool', files: { origin: pin }, license: 'MIT', usedBy: [`${id}-cmd`], ...extra }, served, body };
}
function gatewayAddon(id, extra = {}) {
  const cfg = Buffer.from('{"a":1}'), weights = randomBytes(4 * C + 7);
  const pin = { id, label: `Model ${id}`, repo: `org/${id}`, revision: 'a'.repeat(40), license: 'Apache-2.0 (test)',
    files: [{ name: 'config.json', bytes: cfg.length, sha256: H(cfg) }, { name: 'onnx/model.onnx_data', bytes: weights.length, sha256: H(weights) }] };
  return { def: { id, label: `Model ${id}`, kind: 'model', files: { gateway: pin }, license: pin.license, extraLicense: true, provider: 'Transformers.js', ...extra },
    served: { 'config.json': cfg, 'onnx/model.onnx_data': weights } };
}
function net(origins, gateways, log = [], { slow = 0 } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    log.push(u);
    if (init.signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
    if (slow) await new Promise((r) => setTimeout(r, slow));
    if (init.signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
    if (u.endsWith('/catalog')) return new Response(JSON.stringify({ releases: [] }));
    if (u.includes('/resolve/')) {
      const path = decodeURIComponent(u.split('/resolve/')[1].split('/').slice(1).join('/'));
      const repo = u.split('/resolve/')[0].split('/').pop(), body = gateways[repo]?.[path]; // org/<id>
      if (!body) return new Response('no', { status: 404 });
      const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? '');
      return new Response(Buffer.from(body.subarray(+m[1], +m[2] + 1)), { status: 206 });
    }
    const name = u.split('/').pop();
    const b = origins.map((o) => o.get(name)).find(Boolean);
    return b ? new Response(b) : new Response('', { status: 404 });
  };
}
// A service over the fakes; answer: the sheet's answer (null: no approve hook).
function setup(list, { answer = true, online = true, log = [], slow = 0, device = {} } = {}) {
  const tasks = new Tasks({ keep: 50 }), asked = [];
  const fetchImpl = net(list.filter((x) => x.served instanceof Map).map((x) => x.served), Object.fromEntries(list.filter((x) => !(x.served instanceof Map)).map((x) => [x.def.id, x.served])), log, { slow });
  const backend = (d) => ('origin' in d.files ? originBackend(d.files.origin, { fetchImpl, base: () => 'https://pouch.test/' }) : gatewayBackend(d.files.gateway, { fetchImpl, gateway: 'https://gw.test/hf', chunk: C }));
  const entries = list.map((x) => (device[x.def.id] ? { ...x.def, device: device[x.def.id] } : x.def));
  const state = { answer, online };
  const addons = createAddons({ entries, tasks, backend, online: () => state.online, approve: answer === null ? undefined : async (req) => { asked.push(req); return state.answer; } });
  return { addons, tasks, asked, log, state };
}
async function sh(addons, args, who = { by: 'user', via: 'terminal' }) {
  let fn; addonsCommands((name, f) => { fn = f; return name; }, addons, who);
  return fn(args, {});
}
const agent = { by: 'agent', sid: 1, name: 'main (a1)' };

// ── The registry, built from this build's pins ──
await t('the registry from this build: pdf.js and libav.js quiet; DuckDB, Transformers.js, LFM3, the Parakeet runtime and Parakeet asked; each model needs its hidden code', async () => {
  if (!built) { console.log('  (skipped: run node build.mjs first)'); return; }
  const byId = new Map(REGISTRY.map((d) => [d.id, d]));
  assert.deepEqual(REGISTRY.map((d) => d.id), ['pdfjs', 'libavjs', 'duckdb', 'transformersjs', lock.id, 'parakeet-runtime', 'parakeet-tdt-0.6b-v3']);
  assert.deepEqual(REGISTRY.map((d) => tierOf(d, byId)), ['quiet', 'quiet', 'asked', 'asked', 'asked', 'asked', 'asked']);
  assert.deepEqual(byId.get('duckdb').usedBy, ['duckdb']);
  const pk = byId.get('parakeet-tdt-0.6b-v3');
  assert.ok(byId.get('parakeet-runtime').hidden); assert.deepEqual(pk.needs, ['parakeet-runtime']); assert.equal(pk.kind, 'model');
  assert.equal(pk.license, 'CC-BY-4.0'); assert.match(pk.attribution, /NVIDIA/); assert.match(pk.runs, /only in this browser/); assert.deepEqual(pk.usedBy, ['transcribe']);
  assert.ok(byId.get('transformersjs').hidden);
  assert.deepEqual(byId.get(lock.id).needs, ['transformersjs']);
  const svc = createAddons({ entries: REGISTRY, tasks: new Tasks(), online: () => false });
  const lfm = await svc.status(lock.id);
  assert.match(sizeText(lfm.size), /^1\.1 GB$/, 'one size, code included');
  assert.deepEqual((await svc.list()).map((s) => s.id), ['pdfjs', 'libavjs', 'duckdb', lock.id, 'parakeet-tdt-0.6b-v3'], 'hidden code is not listed alone');
  assert.equal((await svc.status('duckdb')).state, 'not installed');
  assert.equal(svc.resolve('lfm3').id, lock.id, 'unique prefixes');
  assert.equal(svc.resolve('parakeet').id, 'parakeet-tdt-0.6b-v3', 'the hidden runtime does not make `parakeet` ambiguous');
  const pks = await svc.status('parakeet');
  assert.match(sizeText(pks.size), /^1\.3 GB$/, 'one size, runtime included');
  console.log(`  pdf.js ${sizeText(pinOf('pdf').bytes)}, libav.js ${sizeText(pinOf('libav').bytes)}, DuckDB ${sizeText(pinOf('duckdb').bytes)}, Transformers.js ${sizeText(pinOf('transformers').bytes)}, LFM3 ${sizeText(lfm.size)}`);
});
await t('the tier rule: at most 10 MiB, from this origin, no extra license; closure counts', () => {
  const o = (id, bytes, x = {}) => ({ id, label: id, kind: 'tool', files: { origin: { dir: 'd/', manifest: 'm', sha256: 'x', bytes } }, license: 'MIT', ...x });
  const g = { id: 'w', label: 'w', kind: 'model', files: { gateway: { id: 'w', label: 'w', repo: 'r', revision: 'v', license: 'x', files: [{ name: 'a', bytes: 5, sha256: 'x' }] } }, license: 'x' };
  const list = [o('small', QUIET_MAX), o('big', QUIET_MAX + 1), o('cc', 100, { extraLicense: true }), g, o('half', QUIET_MAX / 2, { needs: ['half2'] }), o('half2', QUIET_MAX / 2 + 1)];
  const byId = new Map(list.map((d) => [d.id, d]));
  assert.deepEqual(list.map((d) => tierOf(d, byId)), ['quiet', 'asked', 'asked', 'asked', 'asked', 'quiet'], 'half2 alone is small; with half it is not');
  // DuckDB-Wasm (about 36 MiB, origin) and Parakeet (gateway, CC-BY-4.0) will ask.
  assert.equal(tierOf(o('duckdb', 36 * MiB), byId), 'asked');
});
await t('the strings agents read: state, then the next step, one sentence each', () => {
  const d = { id: 'lfm3-1.7b-q4f16', label: 'LFM3 1.7B' };
  assert.equal(say.notInstalled(d, 1.1e9), 'not installed: LFM3 1.7B (1.1 GB). Run `addons install lfm3-1.7b-q4f16`; the user will be asked.');
  assert.equal(say.installing({ label: 'pdf.js' }, 3.9 * MiB), "installing pdf.js (3.9 MiB, once, from Pouch's own origin)");
  assert.equal(say.offline({ label: 'pdf.js' }, 3.9 * MiB), 'not installed, and the network is not available: pdf.js (3.9 MiB). Try again when online.');
  assert.equal(say.denied(d), 'denied by the user: nothing was installed (LFM3 1.7B).');
  assert.equal(say.stopped(d), 'stopped; `addons install lfm3-1.7b-q4f16` resumes.');
  assert.match(say.notHere(d, 'WebGPU is missing'), /^not available here: WebGPU is missing; nothing was fetched/);
  assert.equal(askTitle({ action: 'install', items: [{ label: 'LFM3 1.7B' }], who: agent }), 'main (a1) asks to install LFM3 1.7B');
  assert.equal(askTitle({ action: 'install', items: [{ label: 'LFM3 1.7B' }], who: { by: 'user' } }), 'Install LFM3 1.7B?');
  assert.equal(askTitle({ action: 'remove', items: [{ label: 'X' }], who: { by: 'agent' } }), 'An agent asks to remove X');
  assert.equal(askTitle({ action: 'install', items: [{ label: 'a' }, { label: 'b' }], who: { by: 'user' } }), 'Install 2 add-ons?');
  assert.match(HELP, /addons install <name> \[--wait\]/);
});

// ── The command ──
await t('quiet: install needs no sheet, is a /task install that says so; list and info read state', async () => {
  const pdf = originAddon('pdfjs', 20000);
  const { addons, asked, tasks } = setup([pdf]);
  assert.match((await sh(addons, ['list'])).stdout, /pdfjs\s+tool\s+19\.5 KiB|pdfjs\s+tool\s+0\.0 MiB.*not installed \(installs on first use\)\s+pdfjs-cmd/);
  const r = await sh(addons, ['install', 'pdf', '--wait'], agent);
  assert.equal(r.exitCode, 0, r.stderr); assert.match(r.stdout, /installed pdfjs .* checked against this page's hashes/);
  assert.equal(asked.length, 0, 'quiet: no sheet');
  const task = [...tasks.byId.values()].find((x) => x.kind === 'install');
  assert.match(task.log[0], /^installing pdfjs \(.*, once, from Pouch's own origin\)$/);
  assert.equal(task.status, 'done');
  assert.match((await sh(addons, ['info', 'pdfjs'])).stdout, /state: installed[\s\S]*installs on first use[\s\S]*used by: pdfjs-cmd/);
  assert.match((await sh(addons, ['verify', 'pdfjs'])).stdout, /verified 1 files of pdfjs .* no network used/);
  assert.match((await sh(addons, ['install', 'pdfjs'])).stdout, /already installed/);
});
await t('asked: deny fetches nothing; approve installs as a /task with stop through ctl and resume', async () => {
  const m = gatewayAddon('tiny-q4'), log = [];
  const { addons, asked, tasks, state } = setup([m], { answer: false, log, slow: 5 });
  const denied = await sh(addons, ['install', 'tiny'], agent);
  assert.equal(denied.exitCode, 1); assert.equal(denied.stderr, 'addons: denied by the user: nothing was installed (Model tiny-q4).\n');
  assert.equal(log.filter((u) => u.includes('/resolve/')).length, 0, 'nothing fetched on deny');
  assert.equal(asked[0].who.name, 'main (a1)');
  for (const k of ['bytes', 'license', 'attribution', 'from']) assert.ok(asked[0].items[0][k], `sheet names ${k}`);
  assert.ok(asked[0].location, 'sheet names where it is kept');
  state.answer = true;
  const r = await sh(addons, ['install', 'tiny-q4'], agent);
  assert.match(r.stdout, /installing tiny-q4 as \/task\/(\d+).*echo stop > \/task\/\d+\/ctl/);
  const id = Number(r.stdout.match(/\/task\/(\d+)/)[1]);
  const fs = new TaskFs(tasks, () => null, { sid: 1 });
  assert.match(new TextDecoder().decode(await fs.readFileBuffer(`/${id}/status`)), /running .* install addons install tiny-q4/);
  await fs.writeFile(`/${id}/ctl`, 'stop');
  await tasks.get(id).promise.catch(() => {});
  assert.equal(tasks.get(id).status, 'stopped');
  assert.match(tasks.get(id).log.at(-1), /stopped; `addons install tiny-q4` resumes/);
  assert.ok(!(await new TaskFs(tasks, () => null, { sid: 2 }).readdir('/')).includes(String(id)), 'another session cannot see it');
  const w = await sh(addons, ['install', 'tiny-q4', '--wait']);
  assert.equal(w.exitCode, 0, w.stderr); assert.match(w.stdout, /installed Model tiny-q4/);
  assert.match((await sh(addons, ['list'])).stdout, /tiny-q4\s+model .*installed\s+Transformers\.js provider/);
});
await t('remove: the user frees at once; an agent asks; errors teach; usage is exit 2', async () => {
  const m = gatewayAddon('tiny-q4');
  const { addons, asked, state } = setup([m]);
  await (await addons.install('tiny-q4', { by: 'user' })).promise;
  state.answer = false;
  const r1 = await sh(addons, ['remove', 'tiny-q4'], agent);
  assert.equal(r1.exitCode, 1); assert.match(r1.stderr, /denied by the user: Model tiny-q4 was kept/);
  assert.equal(asked.at(-1).action, 'remove');
  const before = asked.length;
  const r2 = await sh(addons, ['remove', 'tiny-q4']);
  assert.equal(r2.exitCode, 0); assert.match(r2.stdout, /freed .*`addons install tiny-q4` installs it again \(the user will be asked\)/); assert.equal(asked.length, before, 'the user is not asked');
  await assert.rejects(addons.files('tiny-q4'), /not installed: Model tiny-q4 .*Run `addons install tiny-q4`; the user will be asked/);
  assert.match((await sh(addons, ['install', 'nope'])).stderr, /no add-on "nope". Run `addons list`/);
  assert.equal((await sh(addons, ['frob'])).exitCode, 2);
  assert.equal((await sh(addons, ['install', '--frob', 'x'])).exitCode, 2);
});
await t('no approve hook means deny', async () => {
  const { addons } = setup([gatewayAddon('tiny-q4')], { answer: null });
  assert.match((await sh(addons, ['install', 'tiny-q4'])).stderr, /denied by the user/);
});

// ── ensure: what a worker meets before it starts ──
await t('ensure: asked and not installed returns the string at once, no sheet; quiet installs and notes; offline says so', async () => {
  const pdf = originAddon('pdfjs', 9000), big = originAddon('duckdb', 11 * MiB / 64); // tier from the claimed size below
  big.def.size = 36 * MiB;
  const { addons, asked, state } = setup([pdf, big]);
  await assert.rejects(addons.ensure('duckdb', agent), (e) => e.code === 'ENOTINSTALLED' && e.message === 'not installed: duckdb (36 MiB). Run `addons install duckdb`; the user will be asked.');
  assert.equal(asked.length, 0, 'a tool never opens a sheet');
  state.online = false;
  await assert.rejects(addons.ensure('pdfjs', agent), (e) => e.code === 'ENETDOWN' && /^not installed, and the network is not available: pdfjs/.test(e.message));
  state.online = true;
  const notes = [];
  assert.deepEqual(await addons.ensure('pdfjs', agent, { note: (l) => notes.push(l) }), { fresh: true });
  assert.match(notes[0], /^installing pdfjs \(.*, once, from Pouch's own origin\)$/);
  assert.deepEqual(await addons.ensure('pdfjs', agent), { fresh: false });
  const got = await addons.assets('pdfjs').obtain({ network: false });
  assert.equal(H(Buffer.from(await got.files['worker.js'].arrayBuffer())), H(pdf.body));
});
await t('installLines: a quiet install during a command joins its stderr', async () => {
  const lines = installLines(), ctx = {};
  const run = lines.wrap('pdfinfo', async (_a, c) => { lines.note(c, { log: ["installing pdf.js (3.9 MiB, once, from Pouch's own origin)", 'running'] }); return { stdout: 'Pages: 1\n', stderr: '', exitCode: 0 }; });
  assert.equal((await run([], ctx)).stderr, "pdfinfo: installing pdf.js (3.9 MiB, once, from Pouch's own origin)\n");
  assert.equal((await lines.wrap('pdfinfo', async () => ({ stdout: '', stderr: '', exitCode: 0 }))([], {})).stderr, '', 'no install, no line');
});
await t('device refusal: no sheet, nothing fetched; an installed copy is not reported as ready', async () => {
  const m = gatewayAddon('tiny-q4'), log = [];
  const reason = "This browser's WebGPU allows 9 storage buffers per shader; LFM3 needs 10. Use Chrome or Edge, or a BayLeaf Sealed model.";
  let ok = false;
  const { addons, asked } = setup([m], { log, device: { 'tiny-q4': () => (ok ? { ok: true } : { ok: false, reason }) } });
  const r = await sh(addons, ['install', 'tiny-q4']);
  assert.equal(r.exitCode, 1); assert.equal(r.stderr, `addons: not available here: ${reason}; nothing was fetched (Model tiny-q4).\n`);
  assert.equal(asked.length, 0); assert.equal(log.length, 0);
  assert.match((await sh(addons, ['list'])).stdout, /not available here: This browser's WebGPU/);
  ok = true; await (await addons.install('tiny-q4', { by: 'user' })).promise; ok = false;
  assert.match((await sh(addons, ['install', 'tiny-q4'])).stderr, /not available here: .* \(Model tiny-q4 is installed; `addons remove tiny-q4` frees the space\)/);
  assert.match((await sh(addons, ['remove', 'tiny-q4'])).stdout, /freed/, 'Remove is still offered');
});
await t('hidden parts: installed with what needs them, one size, removed with the last one', async () => {
  const code = originAddon('tjs', 30000, { hidden: true }), m = gatewayAddon('tiny-q4', { needs: ['tjs'] });
  const { addons, asked } = setup([code, m]);
  assert.deepEqual((await addons.list()).map((s) => s.id), ['tiny-q4']);
  const s0 = await addons.status('tiny-q4');
  assert.equal(s0.size, 30000 + m.def.files.gateway.files.reduce((a, f) => a + f.bytes, 0));
  assert.equal((await sh(addons, ['install', 'tiny-q4', '--wait'])).exitCode, 0);
  assert.equal(asked.length, 1, 'one sheet for the add-on and its code');
  assert.ok((await addons.status('tjs')).installed);
  const got = await addons.files('tiny-q4', { network: false });
  assert.deepEqual(Object.keys(got), ['tjs', 'tiny-q4']);
  assert.match((await sh(addons, ['info', 'tiny-q4'])).stdout, /ok .* tjs \(needed\)/);
  await addons.remove('tiny-q4', { by: 'user' });
  assert.equal((await addons.status('tjs')).bytes, 0, 'the hidden code goes with it');
});
await t('install --all: quiet ones directly, one combined sheet for the asked ones', async () => {
  const pdf = originAddon('pdfjs', 9000), a = gatewayAddon('m-a'), b = gatewayAddon('m-b');
  const { addons, asked, state } = setup([pdf, a, b], { answer: false });
  const r = await sh(addons, ['install', '--all', '--wait'], agent);
  assert.equal(r.exitCode, 1); assert.match(r.stdout, /installing as \/task\/\d+: addons install pdfjs\ndenied by the user: nothing was installed \(Model m-a, Model m-b\)/);
  assert.equal(asked.length, 1); assert.equal(asked[0].items.length, 2); assert.equal(askTitle(asked[0]), 'main (a1) asks to install 2 add-ons');
  assert.ok((await addons.status('pdfjs')).installed);
  state.answer = true;
  assert.equal((await sh(addons, ['install', '--all', '--wait'])).exitCode, 0);
  assert.equal(asked.length, 2);
  assert.match((await sh(addons, ['install', '--all'])).stdout, /every add-on this device can run is installed/);
});
await t('two installs racing the sheet share one task; a joined job stopping leaves it running', async () => {
  const a = gatewayAddon('m-r');
  const { addons } = setup([a], { slow: 20 });
  const [r1, r2] = await Promise.all([addons.install('m-r', agent), addons.install('m-r', { by: 'user', via: 'Settings' })]);
  assert.equal(r1.task, r2.task, 'the second caller joins after its sheet closes');
  assert.ok(r2.joined);
  const pdf = originAddon('pdfq', 9000), s = setup([pdf], { slow: 20 });
  const own = await s.addons.install('pdfq', { by: 'user', via: 'Settings' }), ctrl = new AbortController();
  const job = s.addons.ensure('pdfq', agent, { signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 5)); ctrl.abort();
  await assert.rejects(job, { name: 'AbortError' });
  assert.equal(own.task.status, 'running', 'the install a joined job left keeps going');
  await own.promise;
  assert.ok((await s.addons.status('pdfq')).installed);
  await r1.promise;
});
console.log(`\n${n} passed`);
