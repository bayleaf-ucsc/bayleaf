// Namespace semantics: bind/mount flags, unions, read-only members, copy-up,
// whiteouts, capability subsets, /task files and just-bash over a namespace.
// Run: node test/ns-node.mjs
import assert from 'node:assert/strict';
import { InMemoryFs, Bash } from 'just-bash';
import { Namespace, subset, codeOf } from '../src/ns/namespace.js';
import { SeedFs } from '../src/ns/seed.js';
import { Tasks, TaskFs } from '../src/ns/tasks.js';

const enc = new TextEncoder();
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok', name); }
const rejects = async (p, code) => { try { await p; } catch (e) { assert.equal(codeOf(e), code, e.message); return e; } assert.fail(`expected ${code}`); };
const memWith = async (files) => { const m = new InMemoryFs(); for (const [p, t] of Object.entries(files)) { await m.mkdir(p.replace(/\/[^/]+$/, '') || '/', { recursive: true }); await m.writeFile(p, t); } return m; };

await test('mount replace, child mount points listed, longest prefix wins', async () => {
  const ns = new Namespace();
  ns.mount(await memWith({ '/a.txt': 'root' }), '/', { label: 'mem' });
  ns.mount(await memWith({ '/x.txt': 'work' }), '/work', { label: 'opfs' });
  assert.deepEqual(await ns.readdir('/'), ['a.txt', 'work']);
  assert.equal(await ns.readFile('/work/x.txt'), 'work');
  await rejects(ns.readFile('/a/b'), 'ENOENT');
  await rejects(ns.rm('/work'), 'EBUSY');
});

await test('union before/after: first match, merged listing, create in first writable', async () => {
  const ns = new Namespace();
  const a = await memWith({ '/same': 'A', '/onlyA': 'a' }), b = await memWith({ '/same': 'B', '/onlyB': 'b' });
  ns.mount(a, '/u');
  ns.mount(b, '/u', { flag: 'after' });
  assert.equal(await ns.readFile('/u/same'), 'A');
  assert.deepEqual(await ns.readdir('/u'), ['onlyA', 'onlyB', 'same']);
  ns.mount(b, '/v'); ns.mount(a, '/v', { flag: 'before' });
  assert.equal(await ns.readFile('/v/same'), 'A');
  await ns.writeFile('/u/new', 'n');
  assert.equal(await a.readFile('/new'), 'n');
});

await test('bind copies the current union; clone is independent', async () => {
  const ns = new Namespace();
  ns.mount(await memWith({ '/src/m.js': 'm' }), '/work');
  ns.bind('/work/src', '/s');
  assert.equal(await ns.readFile('/s/m.js'), 'm');
  const c = ns.clone();
  c.unmount('/s');
  assert.equal(await ns.readFile('/s/m.js'), 'm');
  await rejects(c.readFile('/s/m.js'), 'ENOENT');
});

await test('read-only mount refuses writes with EROFS', async () => {
  const ns = new Namespace();
  ns.mount(await memWith({ '/f': 'x' }), '/ro', { readOnly: true });
  await rejects(ns.writeFile('/ro/f', 'y'), 'EROFS');
  await rejects(ns.rm('/ro/f'), 'EROFS');
  await rejects(ns.mkdir('/ro/d'), 'EROFS');
});

const seed = () => new SeedFs([
  { path: 'starter/README.md', dir: false, data: enc.encode('seed readme\n') },
  { path: 'starter/src/main.js', dir: false, data: enc.encode('seed main\n') },
  { path: 'starter/src/util.js', dir: false, data: enc.encode('seed util\n') },
], 'starter.zip');

await test('seed layer: deep union, user wins, copy-up, refused rm without whiteouts', async () => {
  const user = await memWith({ '/README.md': 'mine\n' });
  const ns = new Namespace();
  ns.mount(user, '/work', { label: 'opfs' });
  ns.mount(seed(), '/work', { flag: 'after', readOnly: true, label: 'seed' });
  assert.equal(await ns.readFile('/work/README.md'), 'mine\n');
  assert.deepEqual(await ns.readdir('/work'), ['README.md', 'src']);
  await ns.writeFile('/work/src/new.js', 'n'); // creates src in the user layer
  assert.deepEqual(await ns.readdir('/work/src'), ['main.js', 'new.js', 'util.js']); // deep union keeps the seed's files
  await ns.writeFile('/work/src/main.js', 'edited');
  assert.equal(await user.readFile('/src/main.js'), 'edited');
  assert.equal(await ns.readFile('/work/src/main.js'), 'edited');
  const e = await rejects(ns.rm('/work/src/util.js'), 'EROFS');
  assert.match(e.message, /read-only layer/);
});

await test('whiteouts: rm hides a seed file, recreate clears it, rm -r hides a folder', async () => {
  const user = new InMemoryFs();
  const saved = [];
  const ns = new Namespace();
  ns.mount(user, '/work');
  ns.mount(seed(), '/work', { flag: 'after', readOnly: true });
  ns.whiteouts('/work', [], (l) => saved.push(l));
  await ns.rm('/work/src/util.js');
  assert.deepEqual(await ns.readdir('/work/src'), ['main.js']);
  assert.ok(!(await ns.exists('/work/src/util.js')));
  assert.deepEqual(saved.at(-1), ['/src/util.js']);
  await ns.writeFile('/work/src/util.js', 'back');
  assert.equal(await ns.readFile('/work/src/util.js'), 'back');
  assert.deepEqual(saved.at(-1), []);
  await ns.writeFile('/work/src/main.js', 'mine'); // in both layers now
  await ns.rm('/work/src', { recursive: true });
  assert.ok(!(await ns.exists('/work/src')));
  await ns.mkdir('/work/src');
  assert.deepEqual(await ns.readdir('/work/src'), []); // opaque: seed children stay hidden
});

await test('subset: only named subtrees, same paths, narrowed read-only, private /tmp', async () => {
  const ns = new Namespace();
  ns.mount(await memWith({ '/etc': 'x' }), '/');
  ns.mount(await memWith({ '/a.txt': 'a' }), '/work');
  ns.mount(await memWith({ '/AGENTS.md': 'agents' }), '/pouch');
  const scratch = new InMemoryFs();
  const sub = subset(ns, ['/work', '/pouch:ro'], { scratch });
  assert.deepEqual(await sub.readdir('/'), ['pouch', 'tmp', 'work']);
  await rejects(sub.writeFile('/pouch/AGENTS.md', 'no'), 'EROFS');
  await sub.writeFile('/work/b.txt', 'b');
  assert.equal(await ns.readFile('/work/b.txt'), 'b');
  const only = subset(ns, ['/work'], { scratch: new InMemoryFs() });
  await rejects(only.readFile('/pouch/AGENTS.md'), 'ENOENT');
  await rejects(only.readFile('/etc'), 'ENOENT');
  await only.writeFile('/tmp/t', 't');
  await rejects(ns.readFile('/tmp/t'), 'ENOENT');
  assert.deepEqual(only.describe(), ['/tmp  rw scratch', '/work  rw fs']);
});

await test('/task files: status, ns, log, ctl kill, refusals', async () => {
  const tasks = new Tasks();
  let killed = false;
  const t = tasks.add({ kind: 'run', label: 'main.js', ns: ['/work  rw opfs'], kill: () => { killed = true; t.end('killed'); } });
  const ns = new Namespace();
  ns.mount(new InMemoryFs(), '/');
  ns.mount(new TaskFs(tasks), '/task', { label: 'tasks' });
  assert.deepEqual(await ns.readdir('/task'), [String(t.id)]);
  assert.deepEqual(await ns.readdir(`/task/${t.id}`), ['ctl', 'log', 'ns', 'status']);
  assert.match(await ns.readFile(`/task/${t.id}/status`), /^running \d+\.\ds run main\.js\n$/);
  assert.equal(await ns.readFile(`/task/${t.id}/ns`), '/work  rw opfs\n');
  t.note('loaded 3 files');
  assert.equal(await ns.readFile(`/task/${t.id}/log`), 'loaded 3 files\n');
  const bash = new Bash({ fs: ns, cwd: '/', defenseInDepth: false });
  // just-bash rejects exec when a redirection's write fails (as for any read-only mount).
  const e = await rejects(bash.exec(`echo stop > /task/${t.id}/ctl`), 'EINVAL');
  assert.match(e.message, /ctl accepts one command: kill/);
  const r = await bash.exec(`echo kill > /task/${t.id}/ctl; cat /task/${t.id}/status`);
  assert.equal(r.exitCode, 0, r.stderr); assert.ok(killed); assert.match(r.stdout, /^killed /);
  await rejects(ns.writeFile(`/task/${t.id}/status`, 'x'), 'EROFS');
  await rejects(ns.readFile('/task/99/status'), 'ENOENT');
});

await test('just-bash over a namespace with a seed union', async () => {
  const ns = new Namespace();
  ns.mount(new InMemoryFs(), '/');
  ns.mount(new InMemoryFs(), '/work');
  ns.mount(seed(), '/work', { flag: 'after', readOnly: true });
  ns.whiteouts('/work');
  const bash = new Bash({ fs: ns, cwd: '/work', defenseInDepth: false });
  const r = await bash.exec('find . -type f | sort; echo x >> src/main.js; cat src/main.js; rm README.md; ls; grep -rl seed .');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout, './README.md\n./src/main.js\n./src/util.js\nseed main\nx\nsrc\nsrc/main.js\nsrc/util.js\n');
});

await test('1k-file listing: union and plain mount', async () => {
  const m = new InMemoryFs();
  await m.mkdir('/big');
  for (let i = 0; i < 1000; i++) await m.writeFile(`/big/f${i}.txt`, 'x');
  const ns = new Namespace(); ns.mount(m, '/work');
  let t = performance.now();
  assert.equal((await ns.readdirWithFileTypes('/work/big')).length, 1000);
  const plain = performance.now() - t;
  ns.mount(seed(), '/work', { flag: 'after', readOnly: true });
  t = performance.now();
  assert.equal((await ns.readdirWithFileTypes('/work/big')).length, 1000);
  console.log(`   listing 1000: plain ${plain.toFixed(1)} ms, union ${(performance.now() - t).toFixed(1)} ms; direct ${(t = performance.now(), (await m.readdirWithFileTypes('/big')).length, (performance.now() - t).toFixed(1))} ms`);
});

console.log(`ns-node: ${passed} passed`);
