// Node check of the bayleaf command: help, fail-closed denial (fetch is
// wrapped to prove nothing is sent), and live read-only calls when approved.
// Run: set -a; source ~/.tokens/bayleaf-api; set +a; node test/bayleaf-cli-node.mjs [--live]
import { Bash, defineCommand, InMemoryFs } from 'just-bash';
import { bayleafCommands } from '../src/bayleaf-cli.js';

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => { calls.push(`${init?.method} ${String(url).replace(/^https:\/\/api\.bayleaf\.dev/, '')}`); return realFetch(url, init); };
const key = process.env.BAYLEAF_API_KEY || null;
const redact = (s) => (key ? s.split(key).join('<key>') : s);
const fs = new InMemoryFs();
await fs.mkdir('/work', { recursive: true });
const shell = (hooks) => new Bash({ fs, cwd: '/work', customCommands: bayleafCommands(defineCommand, hooks), defenseInDepth: false });
const show = async (label, sh, cmd) => {
  const r = await sh.exec(cmd);
  console.log(`--- ${label}: ${cmd} -> exit ${r.exitCode}\n${redact(r.stdout).slice(0, 900)}${r.stderr ? '[stderr] ' + redact(r.stderr).slice(0, 600) : ''}`);
  return r;
};

// 1. Denial and fail-closed: no approveEgress hook, then a hook that says no.
for (const [label, hooks] of [['no hook', { bayleafCredential: () => key }], ['hook denies', { bayleafCredential: () => key, approveEgress: async () => false }]]) {
  const before = calls.length;
  await show(label, shell(hooks), 'bayleaf web search secret query; bayleaf sandbox files put - /tmp/x <<< private');
  console.log(`fetch calls during "${label}": ${calls.length - before}`);
}
// 2. No key: key-only commands refuse before asking.
let asked = 0;
await show('no key', shell({ bayleafCredential: () => null, approveEgress: async () => (asked++, false) }), 'bayleaf sandbox status');
console.log('approval prompts for keyless sandbox status:', asked);

if (process.argv.includes('--live')) {
  const events = [];
  const yes = { bayleafCredential: () => key, approveEgress: async (r) => (console.log(`[approve] ${r.service}: ${r.summary} | to: ${r.audiences.join('; ')}`), true), onEgress: (e) => events.push(`${e.method} ${e.path} ${e.status}`) };
  const sh = shell(yes);
  await show('live', sh, 'bayleaf status');
  await show('live', sh, 'bayleaf web search -n 3 UC Santa Cruz banana slug mascot');
  await show('live', sh, 'bayleaf web fetch -o page.md https://example.com && head -5 page.md && bayleaf web fetch -o page.md https://example.com');
  await show('live', sh, 'bayleaf web fetch https://example.invalid/nothing');
  const st = await show('live', sh, 'bayleaf sandbox status --json');
  await show('live', sh, 'bayleaf inbox list');
  await show('live', sh, 'bayleaf inbox limits | head -5');
  await show('campus pass', shell({ ...yes, bayleafCredential: () => null }), 'bayleaf status; bayleaf web search -n 2 open webui');
  if (JSON.parse(st.stdout || '{}').state === 'started') {
    await sh.exec(`printf 'line one\\nline two é\\n' > up.txt`);
    await show('roundtrip', sh, 'bayleaf sandbox files put up.txt /home/daytona/workspace/pouch-cli-test.txt && bayleaf sandbox files get /home/daytona/workspace/pouch-cli-test.txt down.txt && diff up.txt down.txt && echo SAME && bayleaf sandbox files get /home/daytona/workspace/pouch-cli-test.txt down.txt');
    await show('roundtrip cleanup', sh, 'bayleaf sandbox exec rm -f /home/daytona/workspace/pouch-cli-test.txt && bayleaf sandbox exec -w /tmp "pwd; ls /home/daytona/workspace | grep -c pouch-cli-test || true"');
  } else console.log('sandbox not started: skipped files round trip (would wake or create compute)');
  console.log('egress events:', events);
}
