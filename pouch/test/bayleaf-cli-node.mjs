// Node check of the bayleaf command: help, fail-closed denial (fetch is
// wrapped to prove nothing is sent), and live read-only calls when approved.
// Run: set -a; source ~/.tokens/bayleaf-api; set +a; node test/bayleaf-cli-node.mjs [--live]
import { Bash, defineCommand, InMemoryFs } from 'just-bash';
import { bayleafCommands } from '../src/bayleaf-cli.ts';

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

// 3. Replies, against a stub origin: a JSON object reads as the route's shape;
// a 204 or a body that is not a JSON object fails clearly where fields are read,
// and stays acceptable where the reply is printed whole or ignored.
{
  const STUB = 'https://stub.invalid';
  const replies = { '/sandbox/poke': () => new Response('<html>gateway</html>', { status: 200 }), '/inboxes/limits': () => new Response('plain'),
    '/sandbox/expose/8000': () => new Response(null, { status: 204 }), '/sandbox': () => new Response(null, { status: 204 }),
    '/inboxes': () => Response.json({ inboxes: [], owner_usage: { bytes: 1, limit_bytes: 2 } }) };
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).startsWith(STUB) ? replies[String(url).slice(STUB.length)]() : before(url, init);
  const sh = new Bash({ fs, cwd: '/work', defenseInDepth: false,
    customCommands: bayleafCommands(defineCommand, { bayleafCredential: () => 'sk-bayleaf-stub', approveEgress: async () => true }, { base: STUB }) });
  const check = async (cmd, exit, re) => {
    const r = await sh.exec(cmd);
    if (r.exitCode !== exit || !re.test(r.stdout + r.stderr)) { console.error(`FAIL ${cmd}: exit ${r.exitCode}\n${r.stdout}${r.stderr}`); process.exitCode = 1; }
    else console.log(`ok   ${cmd}`);
  };
  await check('bayleaf sandbox poke', 1, /unexpected reply from BayLeaf \(not a JSON object\): <html>gateway<\/html>/);
  await check('bayleaf sandbox status', 1, /unexpected reply from BayLeaf \(HTTP 204/);
  await check('bayleaf inbox limits', 0, /"raw": "plain"/);
  await check('bayleaf sandbox preview unexpose 8000', 0, /revoked preview for port 8000/);
  await check('bayleaf inbox list', 0, /no inboxes\nstored: 1 of 2 bytes/);
  await check('bayleaf web search -n 3', 2, /give a search query/);
  await check('bayleaf help web about', 0, /^bayleaf web: Search the web/);
  globalThis.fetch = before;
}

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
