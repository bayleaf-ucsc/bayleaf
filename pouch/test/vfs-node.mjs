// Node check of the /pouch IndexedDB adapter and the tools, using fake-indexeddb.
// Run: NODE_PATH=/tmp/pouch-scratch/fidb/node_modules node test/vfs-node.mjs
import '/tmp/pouch-scratch/fidb/node_modules/fake-indexeddb/auto/index.mjs';
import { Vfs, DEFAULTS } from '../src/vfs.js';
import defaults from '../src/defaults.js';
import { createTools, systemPrompt } from '../src/tools.js';
import { Type } from 'typebox';
import { Bash } from 'just-bash';
globalThis.navigator ??= {};
Object.assign(DEFAULTS, defaults);
const vfs = new Vfs();
await vfs.init();
console.log('opfsMissing', vfs.opfsMissing);
const [read, write, edit, bash] = createTools(vfs, Type, { defenseInDepth: false }); // fake-indexeddb uses setImmediate, which Node-side defense blocks
console.log(await bash.execute({ command: 'find /pouch; ls /' }, {}));
console.log(await write.execute({ path: 'hello/a.txt', content: 'one\ntwo\nthree' }));
console.log(await edit.execute({ path: 'hello/a.txt', oldText: 'two', newText: 'TWO' }));
console.log(await read.execute({ path: '/work/hello/a.txt', offset: 2, limit: 1 }));
try { await edit.execute({ path: 'hello/a.txt', oldText: 'nope', newText: 'x' }); } catch (e) { console.log('edit error ok:', e.message); }
console.log(await bash.execute({ command: 'echo hi > /pouch/x.txt && cat /pouch/x.txt && grep -rn description /pouch/skills | head -3' }, {}));
const t0 = Date.now();
const r = await new Bash({ fs: vfs.fs, cwd: '/', defenseInDepth: false }).exec(`tar -cf '/tmp/pouch.tar' -C '/' 'pouch'`);
console.log('tar', r.exitCode, r.stderr, Date.now() - t0, 'ms', (await vfs.fs.stat('/tmp/pouch.tar')).size);
console.log((await systemPrompt(vfs)).slice(-600));
console.log(await vfs.list('/'));
