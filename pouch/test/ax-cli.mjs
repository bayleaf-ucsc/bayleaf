// AX harness: be the agent inside Pouch from a terminal, with the same system
// prompt and tools the page uses. State lives in real directories so it
// persists across calls (the page uses OPFS and IndexedDB instead).
//
//   node test/ax-cli.mjs --state DIR prompt              system prompt + tool schemas
//   node test/ax-cli.mjs --state DIR call '<json>'       {"tool":"read","args":{"path":"x"}}
//   node test/ax-cli.mjs --state DIR --mount name=/abs/dir[:ro] call ...   simulate a picked folder
//
// The bayleaf command: egress is denied by default, printing to stderr what
// would have been sent; --allow-egress approves every request (and logs it).
// The key comes from $BAYLEAF_API_KEY, or --key-env NAME; --no-key forces
// Campus Pass. Approvals and egress events go to stderr, never the key.
//
// Output is exactly what the model would get back: the tool's text, or "ERROR: ..."
// for a thrown error (the page marks those as error results).
import { InMemoryFs, MountableFs, ReadWriteFs, OverlayFs } from 'just-bash';
import { Type } from 'typebox';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import defaults from '../src/defaults.js';
import { createTools, systemPrompt } from '../src/tools.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const state = opt('--state') ?? '/tmp/pouch-ax';
const allowEgress = args.includes('--allow-egress');
const noKey = args.includes('--no-key');
for (const f of ['--allow-egress', '--no-key']) { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); }
const keyEnv = opt('--key-env') ?? 'BAYLEAF_API_KEY';
const mounts = [];
for (let m; (m = opt('--mount'));) mounts.push(m);
const [cmd, payload] = args;

for (const d of ['work', 'pouch']) mkdirSync(join(state, d), { recursive: true });
if (!existsSync(join(state, 'pouch/AGENTS.md'))) {
  for (const [p, text] of Object.entries(defaults)) {
    mkdirSync(dirname(join(state, 'pouch', p)), { recursive: true });
    writeFileSync(join(state, 'pouch', p), text);
  }
}

const mem = new InMemoryFs();
for (const d of ['/tmp', '/mnt', '/home']) await mem.mkdir(d, { recursive: true });
const fs = new MountableFs({ base: mem });
fs.mount('/work', new ReadWriteFs({ root: join(state, 'work') }));
fs.mount('/pouch', new ReadWriteFs({ root: join(state, 'pouch') }));
const vfsMounts = new Map();
for (const m of mounts) {
  const [, name, dir, ro] = m.match(/^([^=]+)=(.+?)(:ro)?$/);
  await mem.mkdir('/mnt/' + name, { recursive: true });
  fs.mount('/mnt/' + name, ro ? new OverlayFs({ root: dir, readOnly: true, mountPoint: '/' }) : new ReadWriteFs({ root: dir }));
  vfsMounts.set(name, { live: true, readOnly: !!ro });
}
const vfs = { fs, mounts: vfsMounts, changed() {} };
// Node-side defense-in-depth blocks host timers that real-fs adapters use.
// createTools restricts the shell to the browser build's commands (COMMANDS).
const log = (s) => process.stderr.write(s + '\n');
const tools = createTools(vfs, Type, { defenseInDepth: false }, {
  bayleafCredential: () => (noKey ? null : process.env[keyEnv] || null),
  async approveEgress(req) {
    log(`[approve? ${allowEgress ? 'yes' : 'NO (pass --allow-egress)'}] ${req.summary}\n  to: ${req.audiences.join('; ')}\n  ${req.detail.split('\n').join('\n  ')}`);
    return allowEgress;
  },
  onEgress: (e) => log(`[egress] ${e.method} ${e.path} -> ${e.status}`),
});

if (cmd === 'prompt') {
  console.log(await systemPrompt(vfs));
  console.log('\n--- tools ---');
  for (const t of tools) console.log(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }));
} else if (cmd === 'call') {
  const { tool, args: a = {} } = JSON.parse(payload);
  const t = tools.find((x) => x.name === tool);
  if (!t) { console.log(`ERROR: unknown tool ${tool}`); process.exit(0); }
  try { console.log(await t.execute(a, { signal: new AbortController().signal, output() {} })); }
  catch (e) { console.log('ERROR: ' + e.message); }
} else {
  console.log('usage: --state DIR [--mount name=dir[:ro]] [--allow-egress] [--key-env NAME | --no-key] prompt | call <json>');
}
