// Add-ons (node), on a fake Cache Storage: the stale-part sweep (old manifests'
// parts, other directories and other revisions' chunks removed; current pins'
// keys, a not-yet-installed entry's reusable parts and everything during an
// install kept) and the update notice's line from a published SHA256SUMS.
//   node test/addons-sweep-node.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

// A minimal CacheStorage: what src/assets.ts openStore uses (has, open, delete; match, put, delete, keys).
const caches = new Map();
globalThis.caches = {
  has: async (n) => caches.has(n),
  delete: async (n) => caches.delete(n),
  keys: async () => [...caches.keys()],
  open: async (n) => {
    if (!caches.has(n)) caches.set(n, new Map());
    const c = caches.get(n);
    return {
      match: async (u) => { const b = c.get(String(u)); return b ? new Response(b) : undefined; },
      put: async (u, r) => { c.set(String(u), Buffer.from(await r.arrayBuffer())); },
      delete: async (u) => c.delete(String(u)),
      keys: async () => [...c.keys()].map((u) => new Request(u)),
    };
  },
};
const { buildLock, createAddons, originBackend, gatewayBackend, updateLine, ORIGIN_STORE, GATEWAY_STORE } = await import('../src/addons.ts');
const { openStore } = await import('../src/assets.ts');
const { Tasks } = await import('../src/ns/tasks.ts');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const H = (b) => createHash('sha256').update(b).digest('hex');
const C = 64 * 1024;

// An origin build of one tool: parts of 4 KiB; same: bytes reused from an older build.
function originBuild(dir, body) {
  const parts = [];
  for (let i = 0; i < body.length; i += 4096) { const p = body.subarray(i, i + 4096); parts.push({ path: H(p) + '.bin', bytes: p.length, sha256: H(p), body: p }); }
  const m = { format: 2, files: [{ name: 'worker.js', role: 'worker', bytes: body.length, sha256: H(body), parts: parts.map(({ body: _, ...x }) => x) }] };
  const mbytes = Buffer.from(JSON.stringify(m)), name = `manifest.${H(mbytes).slice(0, 16)}.json`;
  return { pin: { dir, manifest: name, sha256: H(mbytes), bytes: body.length }, served: new Map([[name, mbytes], ...parts.map((p) => [p.path, p.body])]), manifest: m, parts };
}
const weights = (rev) => { const cfg = Buffer.from(`{"rev":"${rev}"}`), w = randomBytes(2 * C + 5); return { pin: { id: 'tiny', label: 'Tiny', repo: 'org/tiny', revision: rev.repeat(40), license: 'x', files: [{ name: 'config.json', bytes: cfg.length, sha256: H(cfg) }, { name: 'w.bin', bytes: w.length, sha256: H(w) }] }, served: { 'config.json': cfg, 'w.bin': w } }; };
const fetchFor = (origin, gw, { slow = 0 } = {}) => async (url, init = {}) => {
  const u = String(url);
  if (slow) await new Promise((r) => setTimeout(r, slow));
  if (u.includes('/resolve/')) { const name = decodeURIComponent(u.split('/resolve/')[1].split('/').slice(1).join('/')), b = gw[name]; const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? ''); return new Response(b.subarray(+m[1], +m[2] + 1), { status: 206 }); }
  if (u.endsWith('/catalog')) return new Response('{"releases":[]}');
  const b = origin.get(u.split('/').pop()); return b ? new Response(b) : new Response('', { status: 404 });
};
function service(defs, origin, gw, opts = {}) {
  const fetchImpl = fetchFor(origin, gw, opts);
  return createAddons({ entries: defs, tasks: new Tasks(), online: () => true, approve: async () => true, ...(opts.otherBuilds ? { otherBuilds: opts.otherBuilds } : {}),
    backend: (d) => ('origin' in d.files ? originBackend(d.files.origin, { fetchImpl, base: () => 'https://pouch.test/' }) : gatewayBackend(d.files.gateway, { fetchImpl, gateway: 'https://gw.test/hf', chunk: C })) });
}
const keysOf = async (name) => (await openStore(name, { create: false })).keys();
const tool = (pin, id = 'tool') => ({ id, label: id, kind: 'tool', files: { origin: pin }, license: 'MIT' });
const model = (pin) => ({ id: 'tiny', label: 'Tiny', kind: 'model', files: { gateway: pin }, license: 'x', extraLicense: true });

await t('sweep: old manifests\' parts, other directories and other revisions go; current keys and reused parts stay', async () => {
  const shared = randomBytes(4096);
  const v1 = originBuild('runtime/tool/', Buffer.concat([shared, randomBytes(9000)])), v2 = originBuild('runtime/tool/', Buffer.concat([shared, randomBytes(5000)]));
  const gone = originBuild('runtime/gone/', randomBytes(3000)), w1 = weights('a'), w2 = weights('b');
  // An older build installed v1, a retired tool and revision a.
  const old = service([tool(v1.pin), tool(gone.pin, 'gone'), model(w1.pin)], new Map([...v1.served, ...gone.served]), w1.served);
  for (const id of ['tool', 'gone', 'tiny']) await (await old.install(id, { by: 'user' })).promise;
  // The running build names v2 and revision b.
  const now = service([tool(v2.pin), model(w2.pin)], new Map(v2.served), w2.served);
  const dry = await now.sweep({ dry: true });
  assert.equal(dry.skipped, false); assert.ok(dry.bytes > 0);
  assert.ok((await keysOf(ORIGIN_STORE)).includes('runtime/tool/' + v1.pin.manifest), 'dry run deletes nothing');
  // Before v2 is installed its directory's parts stay (the shared one will be reused); the old manifest and the retired tool go.
  const r1 = await now.sweep();
  let keys = await keysOf(ORIGIN_STORE);
  assert.ok(!keys.includes('runtime/tool/' + v1.pin.manifest) && !keys.some((k) => k.startsWith('runtime/gone/')));
  assert.ok(keys.includes('runtime/tool/' + v1.parts[0].path), 'a part the new build may reuse is kept');
  assert.ok(!(await keysOf(GATEWAY_STORE)).some((k) => k.startsWith('org/tiny@' + 'a'.repeat(40))), 'revision a is gone');
  assert.ok(r1.keys > 0);
  await (await now.install('tool', { by: 'user' })).promise;
  await (await now.install('tiny', { by: 'user' })).promise;
  // Installed: exactly v2's parts stay.
  await now.sweep();
  keys = await keysOf(ORIGIN_STORE);
  const want = new Set(['runtime/tool/' + v2.pin.manifest, ...v2.parts.map((p) => 'runtime/tool/' + p.path)]);
  assert.deepEqual(new Set(keys), want);
  assert.equal(await now.verify('tool').then((v) => v.files), 1);
  assert.equal(await now.verify('tiny').then((v) => v.files), 2, 'current gateway files intact');
  assert.equal((await now.sweep({ dry: true })).bytes, 0, 'nothing left to free');
});
await t('sweep: never during an install; a store whose backend cannot say what it owns is left whole', async () => {
  const v = originBuild('runtime/slow/', randomBytes(20000)), stale = originBuild('runtime/stale/', randomBytes(3000));
  await (await service([tool(stale.pin, 'stale')], stale.served, {}).install('stale', { by: 'user' })).promise;
  const svc = service([tool(v.pin, 'slow')], v.served, {}, { slow: 30 });
  const r = await svc.install('slow', { by: 'user' });
  assert.deepEqual(await svc.sweep(), { skipped: true, blocked: 'install', bytes: 0, keys: 0 });
  assert.ok((await keysOf(ORIGIN_STORE)).some((k) => k.startsWith('runtime/stale/')), 'nothing deleted during an install');
  await r.promise;
  const blind = createAddons({ entries: [tool(v.pin, 'slow')], tasks: new Tasks(), backend: (d) => ({ ...originBackend(d.files.origin), owns: undefined }) });
  const before = await keysOf(ORIGIN_STORE);
  await blind.sweep(); // (its build names no gateway entry, so that store's files do go)
  assert.deepEqual(await keysOf(ORIGIN_STORE), before, 'origin store untouched');
  assert.equal((await service([tool(v.pin, 'slow')], v.served, {}).sweep()).keys > 0, true, 'with ownership known, the stale tool goes');
});
// A fake navigator.locks: every tab's requests in one list (what query() reports as held).
function fakeLocks(held = []) {
  return { held, request: async (name, { mode }, cb) => { held.push({ name, mode }); return cb(); }, query: async () => ({ held: [...held] }) };
}
await t('sweep waits while another tab runs a different build (Web Locks); this build alone, it sweeps', async () => {
  const v = originBuild('runtime/lk/', randomBytes(6000)), stale = originBuild('runtime/lk-old/', randomBytes(3000));
  await (await service([tool(stale.pin, 'old')], stale.served, {}).install('old', { by: 'user' })).promise;
  const has = async () => (await keysOf(ORIGIN_STORE)).some((k) => k.startsWith('runtime/lk-old/'));
  // Another tab holds an older build's lock.
  const locks = fakeLocks([{ name: 'pouch-build:' + 'b'.repeat(64), mode: 'shared' }]), lock = buildLock(locks);
  lock.hold('a'.repeat(64));
  const svc = service([tool(v.pin, 'lk')], v.served, {}, { otherBuilds: () => lock.others() });
  assert.equal(await lock.others(), 1);
  const auto = await svc.sweep({ auto: true });
  assert.equal(auto.blocked, 'other build'); assert.equal(auto.bytes, 0, 'boot: skipped silently, nothing measured');
  const settings = await svc.sweep();
  assert.equal(settings.blocked, 'other build'); assert.ok(settings.bytes > 0, 'Settings: what closing it would free');
  assert.ok(await has(), 'nothing deleted while the other build is open');
  // An unknown page (no pinned copy) also blocks; this page's own unknown lock does not.
  const u = buildLock(fakeLocks()); u.hold(null);
  assert.equal(await u.others(), 0, 'only this page, hash unknown: sweeps');
  const u2 = fakeLocks([{ name: 'pouch-build:unknown', mode: 'shared' }]), l2 = buildLock(u2); l2.hold('a'.repeat(64));
  assert.equal(await l2.others(), 1, 'another page of unknown build blocks');
  // The other tab closes: only this build's locks (two tabs of it) remain.
  locks.held.splice(0, 1); locks.held.push({ name: 'pouch-build:' + 'a'.repeat(64), mode: 'shared' });
  assert.equal(await lock.others(), 0);
  const r = await svc.sweep({ auto: true });
  assert.equal(r.skipped, false); assert.ok(r.keys > 0);
  assert.ok(!(await has()), 'swept once only this build is open');
  // No Web Locks: boot skips; Settings sweeps and says it could not check.
  assert.equal(await buildLock(undefined).others(), null);
  await (await service([tool(stale.pin, 'old')], stale.served, {}).install('old', { by: 'user' })).promise;
  const blind = service([tool(v.pin, 'lk')], v.served, {}, { otherBuilds: () => buildLock(undefined).others() });
  assert.equal((await blind.sweep({ auto: true })).blocked, 'unchecked');
  assert.ok(await has());
  const manual = await blind.sweep();
  assert.ok(manual.unchecked && manual.keys > 0 && !(await has()));
});
await t('update notice: which installed add-ons a published build changes, what each fetches, asked ones ask again', async () => {
  const shared = randomBytes(4096), v1 = originBuild('runtime/u/', Buffer.concat([shared, randomBytes(8000)])), v2 = originBuild('runtime/u/', Buffer.concat([shared, randomBytes(3000)]));
  const big = originBuild('runtime/big/', randomBytes(5000)), w = weights('c');
  const code = { ...tool(big.pin, 'code'), hidden: true };
  const svc = service([tool(v1.pin, 'u'), code, { ...model(w.pin), needs: ['code'] }], new Map([...v1.served, ...big.served]), w.served);
  for (const id of ['u', 'tiny']) await (await svc.install(id, { by: 'user' })).promise;
  const sums = { 'pouch.html': 'x', ['runtime/u/' + v2.pin.manifest]: v2.pin.sha256, ['runtime/big/' + big.pin.manifest]: big.pin.sha256 };
  const read = async (p) => { assert.equal(p, 'runtime/u/' + v2.pin.manifest); return v2.manifest; };
  const changes = await svc.updateChanges(sums, read);
  const u = changes.find((c) => c.id === 'u');
  assert.equal(u.change, 'changed');
  assert.equal(u.bytes, v2.parts.slice(1).reduce((s, p) => s + p.bytes, 0), 'the reused part is not counted');
  assert.equal(changes.find((c) => c.id === 'tiny').change, 'unchanged');
  assert.equal(updateLine(changes), `This update changes u: ${(u.bytes / 2 ** 20).toFixed(1)} MiB to fetch; Tiny unchanged. (Tiny: only the code from Pouch's origin is compared; a weights change shows after updating.)`);
  assert.equal(updateLine([{ label: 'DuckDB-Wasm', tier: 'asked', change: 'changed', bytes: 2 * 2 ** 20, weights: false }, { label: 'pdf.js', tier: 'quiet', change: 'removed', bytes: 0, weights: false }]),
    'This update changes DuckDB-Wasm: 2.0 MiB to fetch (asks again); pdf.js: not in the new build.');
  assert.equal(updateLine([]), '');
});
console.log(`\n${n} passed`);
