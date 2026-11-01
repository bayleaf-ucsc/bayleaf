// node --test test/   (from experiments/quickjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { runRequest, sha256 } from '../src/core.js';
import { runInWorker, applyChanges, snapshot, MemFS } from '../src/host.js';

const quickjs = await newQuickJSWASMModuleFromVariant(variant);
const run = (code, extra = {}) => runRequest(quickjs, { code, ...extra });
const text = (b) => new TextDecoder().decode(b);

// worker_threads dressed as a Web Worker, so host.js runs unchanged.
const makeWorker = () => {
  const w = new Worker(new URL('./node-worker.mjs', import.meta.url));
  const o = { postMessage: (m) => w.postMessage(m), terminate: () => w.terminate() };
  w.on('message', (data) => o.onmessage?.({ data }));
  w.on('error', (e) => o.onerror?.(e));
  return o;
};

test('hello world', async () => {
  const r = await run('console.log("hello", 1 + 1); console.error("warn")');
  assert.equal(r.status, 'ok');
  assert.equal(r.stdout, 'hello 2\n');
  assert.equal(r.stderr, 'warn\n');
});

test('args, stdin and promise jobs', async () => {
  const r = await run('(async () => print(args.join(","), stdin.trim()))()', { args: ['a', 'b'], stdin: 'in\n' });
  assert.equal(r.stdout, 'a,b in\n');
});

test('snapshot reads and writes become proposed changes', async () => {
  const fs = new MemFS({ '/src/a.txt': 'abc', '/src/old.txt': 'bye', '/keep.txt': 'same' });
  const files = await snapshot(fs, ['/src/a.txt', '/src/old.txt', '/keep.txt']);
  const r = await run(`
    fs.writeFile('src/a.txt', fs.readFile('/src/a.txt').toUpperCase());
    fs.writeFile('/out/b.bin', new Uint8Array([0, 255, 7]));
    fs.rm('/src/old.txt');
    fs.writeFile('/keep.txt', 'same');
    print(fs.readdir('/'), fs.readdir('/src'), fs.exists('/out'), fs.readBytes('/out/b.bin')[1]);
  `, { files });
  assert.equal(r.status, 'ok', r.message);
  assert.equal(r.stdout, '["keep.txt","out","src"] ["a.txt"] true 255\n');
  assert.deepEqual(r.changes.map((c) => [c.path, c.op]), [['/out/b.bin', 'create'], ['/src/a.txt', 'modify'], ['/src/old.txt', 'delete']]);
  const mod = r.changes.find((c) => c.op === 'modify');
  assert.equal(mod.baseHash, files[0].hash);
  assert.equal(text(mod.bytes), 'ABC');
  assert.deepEqual([...r.changes[0].bytes], [0, 255, 7]);
  // Nothing was written to the real fs yet.
  assert.equal(await fs.readFile('/src/a.txt'), 'abc');
});

test('missing file is a guest error', async () => {
  const r = await run('fs.readFile("/nope")');
  assert.equal(r.status, 'error');
  assert.match(r.message, /ENOENT/);
});

test('output is truncated at maxOutputBytes', async () => {
  const r = await run('for (let i = 0; i < 1000; i++) print("x".repeat(99))', { limits: { maxOutputBytes: 1000 } });
  assert.equal(r.status, 'ok');
  assert.equal(r.truncated, true);
  assert.equal(r.stdout.length, 1000);
});

test('file limits', async () => {
  const big = await run('fs.writeFile("/a", "x".repeat(2000))', { limits: { maxFileBytes: 1000 } });
  assert.match(big.message, /EFBIG/);
  const many = await run('for (let i = 0; i < 5; i++) fs.writeFile("/f" + i, "")', { limits: { maxFiles: 3 } });
  assert.match(many.message, /EMFILE/);
  await assert.rejects(run('1', { files: [{ path: '/x', bytes: new Uint8Array(2000) }], limits: { maxFileBytes: 1000 } }), /maxFileBytes/);
});

test('infinite loop times out, even if the guest catches the interrupt', async () => {
  const r = await run('for (;;) { try { for (;;) {} } catch (e) {} }', { limits: { timeMs: 200 } });
  assert.equal(r.status, 'timeout');
  assert.equal(r.exitCode, 124);
  assert.ok(r.ms >= 200 && r.ms < 1500, `ms ${r.ms}`);
});

test('memory blowup is oom', async () => {
  const r = await run('const a = []; for (;;) a.push("y".repeat(1e5) + a.length)', { limits: { memoryBytes: 8 << 20 } });
  assert.equal(r.status, 'oom', r.message);
  assert.equal(r.exitCode, 137);
});

test('deep recursion is a stack error, not a crash', async () => {
  const r = await run('const f = (n) => f(n + 1) + 1; f(0)');
  assert.equal(r.status, 'error');
  assert.match(r.message, /stack/i);
});

test('exit() stops the run with its code', async () => {
  const r = await run('print(1); try { exit(3) } catch {} print(2)');
  assert.deepEqual([r.status, r.exitCode, r.stdout], ['exit', 3, '1\n']);
});

test('soft cancel through the interrupt handler', async () => {
  let n = 0;
  const r = await runRequest(quickjs, { code: 'for (;;) {}' }, { shouldCancel: () => ++n > 50 });
  assert.equal(r.status, 'cancelled');
});

test('no escape hatches: network, modules, host objects', async () => {
  const r = await run(`
    print([typeof fetch, typeof require, typeof process, typeof XMLHttpRequest, typeof WebAssembly,
           typeof setTimeout, typeof postMessage, typeof self, typeof importScripts, typeof std, typeof os].join(","));
    // Settles after the synchronous prints, so it is the last line.
    import("os").then(() => print("imported"), (e) => print("import:", String(e)));
    print(Object.getOwnPropertyNames(globalThis).filter((k) => !/^[A-Z]/.test(k)).sort().join(","));
    // The constructor chain stays inside the guest realm.
    print(typeof (function(){}).constructor("return globalThis.fetch")());
  `);
  assert.equal(r.status, 'ok', r.message);
  const [kinds, globals, ctorFetch, imp] = r.stdout.trim().split('\n');
  assert.equal(kinds, Array(11).fill('undefined').join(','));
  assert.match(globals, /^args,console,decodeURI/);
  assert.doesNotMatch(globals, /fetch|require|process|postMessage/);
  assert.equal(ctorFetch, 'undefined');
  assert.match(imp, /^import: /);
});

test('static import is refused', async () => {
  const r = await run('import fs from "fs"');
  assert.equal(r.status, 'error');
});

test('fs object is frozen, host functions unreachable', async () => {
  const r = await run('fs.readFile = () => "pwned"; print(fs.readFile === undefined, Object.isFrozen(fs))');
  assert.equal(r.stdout, 'false true\n');
});

test('worker: run, result, transferred bytes', async () => {
  const r = await runInWorker(makeWorker, { code: 'fs.writeFile("/o.txt", "hi"); print("w")' });
  assert.equal(r.status, 'ok', r.message);
  assert.equal(r.stdout, 'w\n');
  assert.equal(text(r.changes[0].bytes), 'hi');
});

test('worker: cancellation mid-run terminates', async () => {
  const ac = new AbortController();
  const p = runInWorker(makeWorker, { code: 'for (;;) {}', limits: { timeMs: 60000 } }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  const t = performance.now();
  const r = await p;
  assert.equal(r.status, 'cancelled');
  assert.ok(performance.now() - t < 2000);
});

test('worker: soft timeout wins before the hard stop', async () => {
  const r = await runInWorker(makeWorker, { code: 'for (;;) {}', limits: { timeMs: 200 } });
  assert.equal(r.status, 'timeout');
  assert.doesNotMatch(r.message, /hard stop/);
});

test('apply: clean apply', async () => {
  const fs = new MemFS({ '/a': 'one', '/d': 'gone' });
  const files = await snapshot(fs, ['/a', '/d']);
  const r = await run('fs.writeFile("/a", "two"); fs.writeFile("/n", "new"); fs.rm("/d")', { files });
  const out = await applyChanges(fs, r.changes);
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.applied.length, 3);
  assert.equal(await fs.readFile('/a'), 'two');
  assert.equal(await fs.readFile('/n'), 'new');
  assert.equal(await fs.exists('/d'), false);
});

test('apply: conflicts on modified base, create-over-existing, delete', async () => {
  const fs = new MemFS({ '/a': 'one', '/d': 'gone', '/d2': 'gone too', '/ok': 'x' });
  const files = await snapshot(fs, ['/a', '/d', '/d2', '/ok']);
  const r = await run('fs.writeFile("/a", "two"); fs.writeFile("/n", "new"); fs.rm("/d"); fs.rm("/d2"); fs.writeFile("/ok", "y")', { files });
  // Meanwhile, someone else edits the filesystem.
  await fs.writeFile('/a', 'edited');
  await fs.writeFile('/n', 'mine');
  await fs.writeFile('/d', 'changed');
  await fs.rm('/d2');
  const before = new Map(fs.files);
  const atomic = await applyChanges(fs, r.changes, { atomic: true });
  assert.equal(atomic.applied.length, 0);
  assert.deepEqual(fs.files, before);
  const out = await applyChanges(fs, r.changes);
  assert.deepEqual(out.conflicts.map((c) => [c.path, c.reason]), [
    ['/a', 'file changed since the snapshot'],
    ['/d', 'file changed since the snapshot'],
    ['/d2', 'file was deleted since the snapshot'],
    ['/n', 'file was created since the snapshot'],
  ]);
  assert.deepEqual(out.applied, [{ path: '/ok', op: 'modify' }]);
  assert.equal(await fs.readFile('/a'), 'edited');
  assert.equal(await fs.readFile('/n'), 'mine');
  assert.equal(await fs.readFile('/ok'), 'y');
});

test('hashes are content hashes', async () => {
  assert.equal(await sha256(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
