// Runtime boundary guidance (#150), using the real QuickJS engine.
import assert from 'node:assert/strict';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { runRequest } from '../src/run/core.ts';

const engine = await newQuickJSWASMModuleFromVariant(variant);
const run = (code) => runRequest(engine, { code, cwd: '/work' });
const failed = await run("const fs = require('fs'); fs.writeFile('out.txt', 'hello');");
assert.equal(failed.status, 'error');
assert.equal(failed.exitCode, 1);
assert.match(failed.message, /ReferenceError/);
assert.match(failed.message, /Use the global fs \(fs.readFile, fs.writeFile\)/);
assert.deepEqual(failed.changes, []);
const written = await run("fs.writeFile('out.txt', 'hello'); print(fs.readFile('out.txt'));");
assert.equal(written.status, 'ok');
assert.equal(written.stdout, 'hello\n');
assert.equal(written.changes[0].path, '/work/out.txt');
assert.equal((await run('print(typeof require)')).stdout, 'undefined\n');
assert.equal((await run('const require = () => 42; print(require())')).stdout, '42\n');
assert.doesNotMatch((await run('missingName()')).message, /Use the global fs/);
assert.doesNotMatch((await run('throw new Error("require is not defined")')).message, /Use the global fs/);
console.log('PASS: missing require explains global fs; working fs, local require, feature detection and unrelated errors unchanged');
