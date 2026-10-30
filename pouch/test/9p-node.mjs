// 9P2000: codec round-trips, and a client mounted over a MessageChannel to a
// server exporting a namespace subtree (walk, create, read, write, remove,
// stat, wstat, readdir, errors, flush, commit hook, 1k-file listing).
// Run: node test/9p-node.mjs
import assert from 'node:assert/strict';
import { InMemoryFs, Bash } from 'just-bash';
import { Namespace, codeOf } from '../src/ns/namespace.js';
import { encode, decode, packStats, unpackStats, serve, Client, NinepFs, DMDIR, QTDIR, NOTAG } from '../src/ns/9p.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok', name); }
const rejects = async (p, code) => { try { await p; } catch (e) { assert.equal(codeOf(e), code, e.message); return e; } assert.fail(`expected ${code}`); };
const qid = { type: QTDIR, version: 7, path: 2 ** 40 + 5 };
const stat = { type: 0, dev: 0, qid, mode: (DMDIR | 0o755) >>> 0, atime: 1, mtime: 2, length: 0, name: 'dir', uid: 'pouch', gid: 'pouch', muid: '' };

await test('codec round-trips every message shape', () => {
  const msgs = [
    { type: 'Tversion', tag: NOTAG, msize: 8192, version: '9P2000' },
    { type: 'Rversion', tag: NOTAG, msize: 8192, version: '9P2000' },
    { type: 'Tattach', tag: 1, fid: 0, afid: 0xffffffff, uname: 'pouch', aname: '' },
    { type: 'Rattach', tag: 1, qid },
    { type: 'Rerror', tag: 2, ename: 'ENOENT: no such file, walk \'/x\'' },
    { type: 'Tflush', tag: 3, oldtag: 2 }, { type: 'Rflush', tag: 3 },
    { type: 'Twalk', tag: 4, fid: 0, newfid: 1, wnames: ['work', 'ünïcode.txt'] }, { type: 'Rwalk', tag: 4, qids: [qid, qid] },
    { type: 'Topen', tag: 5, fid: 1, mode: 0x11 }, { type: 'Ropen', tag: 5, qid, iounit: 8168 },
    { type: 'Tcreate', tag: 6, fid: 1, name: 'n', perm: 0o644, mode: 1 }, { type: 'Rcreate', tag: 6, qid, iounit: 8168 },
    { type: 'Tread', tag: 7, fid: 1, offset: 2 ** 33, count: 100 }, { type: 'Rread', tag: 7, data: new Uint8Array([1, 2, 3]) },
    { type: 'Twrite', tag: 8, fid: 1, offset: 0, data: new Uint8Array([9]) }, { type: 'Rwrite', tag: 8, count: 1 },
    { type: 'Tclunk', tag: 9, fid: 1 }, { type: 'Rclunk', tag: 9 }, { type: 'Tremove', tag: 10, fid: 1 }, { type: 'Rremove', tag: 10 },
    { type: 'Tstat', tag: 11, fid: 1 }, { type: 'Rstat', tag: 11, stat }, { type: 'Twstat', tag: 12, fid: 1, stat }, { type: 'Rwstat', tag: 12 },
  ];
  for (const m of msgs) assert.deepEqual(decode(encode(m)), m, m.type);
  // Known bytes: Tversion msize 8192 "9P2000", as in the 9P manual.
  assert.deepEqual([...encode(msgs[0])], [19, 0, 0, 0, 100, 0xff, 0xff, 0, 32, 0, 0, 6, 0, 57, 80, 50, 48, 48, 48]);
  assert.deepEqual(unpackStats(packStats([stat, { ...stat, name: 'b' }])).map((s) => s.name), ['dir', 'b']);
  assert.throws(() => decode(new Uint8Array([9, 0, 0, 0, 100, 0, 0])), /size field/);
});

async function pair(fs, opts = {}) {
  const { port1, port2 } = new MessageChannel();
  const server = serve(port1, fs, opts);
  const client = await new Client(port2, { msize: opts.clientMsize ?? 8192 }).connect();
  return { server, client, remote: new NinepFs(client), close: () => { client.close(); server.close(); } };
}
const tree = async () => {
  const ns = new Namespace();
  ns.mount(new InMemoryFs(), '/');
  const work = new InMemoryFs();
  await work.mkdir('/src', { recursive: true });
  await work.writeFile('/src/a.js', 'let a = 1;\n');
  ns.mount(work, '/work', { label: 'opfs' });
  ns.mount(new InMemoryFs(), '/pouch');
  await ns.writeFile('/pouch/secret.md', 'not exported');
  return ns;
};

await test('server exports a subtree; client reads, writes, lists, removes', async () => {
  const ns = await tree();
  const commits = [];
  const { remote, client, close } = await pair(ns, { root: '/work', onCommit: (p, op) => commits.push(`${op} ${p}`) });
  assert.equal(client.msize, 8192);
  assert.deepEqual(await remote.readdir('/'), ['src']);
  assert.equal(await remote.readFile('/src/a.js'), 'let a = 1;\n');
  await rejects(remote.readFile('/pouch/secret.md'), 'ENOENT');
  await rejects(remote.readFile('/../pouch/secret.md'), 'ENOENT'); // ".." cannot climb out of the export
  const big = new Uint8Array(50_000).map((_, i) => i % 251); // several Twrite/Tread chunks at msize 8192
  await remote.writeFile('/src/big.bin', big);
  assert.deepEqual(await ns.readFileBuffer('/work/src/big.bin'), big);
  assert.deepEqual(await remote.readFileBuffer('/src/big.bin'), big);
  await remote.writeFile('/src/a.js', 'let a = 2;\n'); // existing file: open OTRUNC
  assert.equal(await ns.readFile('/work/src/a.js'), 'let a = 2;\n');
  await remote.mkdir('/out/deep', { recursive: true });
  assert.ok((await ns.stat('/work/out/deep')).isDirectory);
  const st = await remote.stat('/src/big.bin');
  assert.equal(st.size, 50_000); assert.ok(st.isFile);
  await rejects(remote.readFile('/src'), 'EISDIR');
  await rejects(remote.readdir('/src/a.js'), 'ENOTDIR');
  await remote.rm('/src/big.bin');
  await rejects(ns.stat('/work/src/big.bin'), 'ENOENT');
  await remote.rm('/out', { recursive: true });
  assert.deepEqual(commits, ['write /work/src/big.bin', 'write /work/src/a.js', 'remove /work/src/big.bin', 'remove /work/out/deep', 'remove /work/out']);
  // just-bash over the remote side
  const r = await new Bash({ fs: new Namespace().mount(remote, '/'), cwd: '/', defenseInDepth: false }).exec('echo hi > /src/b.txt && cat /src/*.txt && ls /src');
  assert.equal(r.stdout, 'hi\na.js\nb.txt\n', r.stderr);
  close();
});

await test('errors are clear Rerror strings; read-only export refuses writes', async () => {
  const ns = await tree();
  ns.mount(new InMemoryFs(), '/ro', { readOnly: true });
  const { remote, client, close } = await pair(ns, { root: '/' });
  const e = await rejects(remote.writeFile('/ro/x', 'y'), 'EROFS');
  assert.match(e.message, /^EROFS: read-only file system/);
  await rejects(client.call({ type: 'Tclunk', fid: 999 }), 'EBADF');
  await rejects(client.call({ type: 'Tauth', afid: 5, uname: 'u', aname: '' }), 'EACCES');
  close();
  await rejects(remote.readFile('/work/src/a.js'), 'EPIPE');
});

await test('flushAll answers requests in flight and refuses new ones', async () => {
  const ns = await tree();
  let gate;
  const order = [];
  const commit = async (p, b, op) => { order.push(p); if (p.endsWith('slow')) await new Promise((r) => { gate = r; }); return op === 'remove' ? ns.rm(p) : ns.writeFile(p, b); };
  const { server, remote, close } = await pair(ns, { root: '/work', commit });
  const slow = remote.writeFile('/slow', 'x');
  while (!gate) await new Promise((r) => setTimeout(r, 1));
  server.flushAll('EINTR: interrupted (stopped by the user)');
  gate();
  await rejects(slow, 'EINTR');
  const after = await rejects(remote.writeFile('/later', 'y'), 'EINTR');
  assert.match(after.message, /stopped by the user/);
  await rejects(ns.stat('/work/later'), 'ENOENT');
  assert.deepEqual(order, ['/work/slow']);
  close();
});

await test('client Tflush on abort', async () => {
  const ns = await tree();
  let release;
  const slowFs = Object.create(ns);
  slowFs.readFileBuffer = async (p) => { await new Promise((r) => { release = r; }); return ns.readFileBuffer(p); };
  const { client, close } = await pair(slowFs, { root: '/work' });
  const ac = new AbortController();
  const remote = new NinepFs(client, { signal: ac.signal });
  const p = remote.readFile('/src/a.js');
  while (!release) await new Promise((r) => setTimeout(r, 1));
  ac.abort();
  await rejects(p, 'EINTR');
  release();
  close();
});

await test('1k-file listing and startup over 9P', async () => {
  const ns = new Namespace();
  const m = new InMemoryFs();
  await m.mkdir('/big', { recursive: true });
  for (let i = 0; i < 1000; i++) await m.writeFile(`/big/f${i}.txt`, 'x');
  ns.mount(m, '/work');
  let t = performance.now();
  const { remote, close } = await pair(ns, { root: '/work', clientMsize: 128 << 10 });
  const connect = performance.now() - t;
  t = performance.now();
  assert.equal((await remote.readdirWithFileTypes('/big')).length, 1000);
  const list = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < 100; i++) await remote.readFile(`/big/f${i}.txt`);
  console.log(`   connect ${connect.toFixed(1)} ms; list 1000 ${list.toFixed(1)} ms; 100 small reads ${(performance.now() - t).toFixed(1)} ms`);
  close();
});

console.log(`9p-node: ${passed} passed`);
