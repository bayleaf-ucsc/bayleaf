// Control-plane parity (README "Control plane"): every Interface control that
// acts has a file operation, the file operation works from the terminal and
// (where allowed) from the main agent, and the Interface's handler performs
// that file operation rather than calling the harness directly.
// Run: node test/controlplane-node.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InMemoryFs, Bash } from 'just-bash';
import { Namespace, over, codeOf } from '../src/ns/namespace.js';
import { createControl, createChanges, changesText, usageText, parseIn, parseCtl, why } from '../src/ns/control.js';
import { execScript, tagWrites, noting, commandsOf } from '../src/tools.js';
import { Tasks, TaskFs } from '../src/ns/tasks.js';
import { serve, Client, OREAD } from '../src/ns/9p.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok', name); }

// ── The inventory: one row per acting Interface control ─────────────
// op: the file write that performs it ({sid} 1, {ref} a2, {task} a /task id,
// {watch} w1). agent: what the main agent may do with the same file
// ('ok', or the error code it gets by design). anchor: where its handler is
// in src/main.js (the handler is the next `lines` lines, or a helper it calls).
// via: helpers the handler calls, each of which must itself write a control file.
export const CONTROLS = [
  { id: 'card-stop', what: 'Subagent card: Stop', op: ['/session/{sid}/agents/{ref}/ctl', 'stop'], expect: ['stop', '1', 'a2', { all: false }], agent: 'ok', anchor: 'ariaLabel: `Stop subagent ${name}` });', lines: 2 },
  { id: 'view-stop', what: 'Subagent view: Stop', op: ['/session/{sid}/agents/{ref}/ctl', 'stop'], expect: ['stop', '1', 'a2', { all: false }], agent: 'ok', anchor: 'ariaLabel: `Stop subagent ${c.name}` });', lines: 2 },
  { id: 'card-message', what: 'Subagent card: Message (sheet Send)', op: ['/session/{sid}/agents/{ref}/in', 'message\nlook at b.txt'], expect: ['send', '1', 'a2', 'message', 'look at b.txt'], agent: 'EPERM', anchor: 'function messageChild(c) {', lines: 8 },
  { id: 'card-resume', what: 'Subagent card: Resume', op: ['/session/{sid}/agents/{ref}/in', 'message Continue your task'], expect: ['send', '1', 'a2', 'message', 'Continue your task'], agent: 'EPERM', anchor: 'ariaLabel: `Resume subagent ${name}` });', lines: 2 },
  { id: 'tray-sa-stop', what: 'Tray subagent row: Stop', op: ['/session/{sid}/agents/{ref}/ctl', 'stop'], expect: ['stop', '1', 'a2', { all: false }], agent: 'ok', anchor: 'open: (e) => openChild(sid, c.id, e?.currentTarget),', lines: 1 },
  { id: 'tray-background', what: 'Tray subagent row: Background', op: ['/session/{sid}/agents/{ref}/ctl', 'detach'], expect: ['detach', '1', 'a2'], agent: 'ok', anchor: '...(waited ? { background:', lines: 1 },
  { id: 'tray-run-stop', what: 'Tray run row: Stop', op: ['/task/{task}/ctl', 'kill'], expect: ['kill'], agent: 'ok', anchor: "origin: task ? `run, /task/${task.id}` : 'run'", lines: 1 },
  { id: 'stop-all', what: 'Tray: Stop all', op: ['/session/{sid}/ctl', 'stop'], expect: ['stop', '1', 'a1', { all: true }], agent: 'ok', anchor: 'stopAll: async () => {', lines: 4 },
  { id: 'composer-stop', what: 'Composer: Stop (main)', op: ['/session/{sid}/agents/a1/ctl', 'stop all'], expect: ['stop', '1', 'a1', { all: true }], agent: 'ok', anchor: "$('send').onclick = (e) => {", lines: 7, via: ['stopMain', 'stopChild'] },
  { id: 'esc-stop', what: 'Composer: Esc (main)', op: ['/session/{sid}/agents/a1/ctl', 'stop all'], expect: ['stop', '1', 'a1', { all: true }], agent: 'ok', anchor: "if (e.key === 'Escape' && $('sendmode-menu').hidden) {", lines: 4, via: ['stopMain'] },
  { id: 'stopsend', what: 'Send menu: Stop and send', op: ['/session/{sid}/agents/a1/ctl', 'stop all'], expect: ['stop', '1', 'a1', { all: true }], agent: 'ok', anchor: "if (busy() && mode === 'stopsend') {", lines: 3, via: ['stopMain'] },
  { id: 'steer-main', what: 'Composer: Steer (main)', op: ['/session/{sid}/agents/a1/in', 'steer\nuse tabs'], expect: ['send', '1', 'a1', 'steer', 'use tabs'], agent: 'EPERM', anchor: "if (busy() && mode === 'steer' && !attachments.files.length)", lines: 1, via: ['steerMain'] },
  { id: 'followup-main', what: 'Composer: Follow-up (main, text only)', op: ['/session/{sid}/agents/a1/in', 'followup\nthen tests'], expect: ['send', '1', 'a1', 'followup', 'then tests'], agent: 'EPERM', anchor: "if (busy() && mode === 'steer') announce(", lines: 2, via: ['followUpMain'] },
  { id: 'steer-now-main', what: 'Tray follow-up: Steer now (main)', op: ['/session/{sid}/agents/a1/in', 'steer then tests'], expect: ['send', '1', 'a1', 'steer', 'then tests'], agent: 'EPERM', anchor: "run: () => sendNow(key, true) }", lines: 1, via: ['sendNow', 'steerMain'] },
  { id: 'steer-child', what: 'Subagent view composer: Steer', op: ['/session/{sid}/agents/{ref}/in', 'steer\nskip tests'], expect: ['send', '1', 'a2', 'steer', 'skip tests'], agent: 'EPERM', anchor: 'if (focus) return toChild(raw.trim(), mode);', lines: 1, via: ['toChild'] },
  { id: 'followup-child', what: 'Subagent view composer: Follow-up', op: ['/session/{sid}/agents/{ref}/in', 'followup\nthen report'], expect: ['send', '1', 'a2', 'followup', 'then report'], agent: 'EPERM', anchor: 'if (focus) return toChild(raw.trim(), mode);', lines: 1, via: ['toChild'] },
  { id: 'child-stop-composer', what: 'Subagent view composer: Stop', op: ['/session/{sid}/agents/{ref}/ctl', 'stop'], expect: ['stop', '1', 'a2', { all: false }], agent: 'ok', anchor: "$('send').onclick = (e) => {", lines: 7, via: ['stopChild'] },
  { id: 'child-paused-send', what: 'Tray paused message to a subagent: Send', op: ['/session/{sid}/agents/{ref}/in', 'message\nretry'], expect: ['send', '1', 'a2', 'message', 'retry'], agent: 'EPERM', anchor: 'ariaLabel: `Send paused message to ${cq.name}`', lines: 1 },
  { id: 'child-steer-now', what: 'Tray follow-up to a subagent: Steer now', op: ['/session/{sid}/agents/{ref}/in', 'steer\nretry'], expect: ['send', '1', 'a2', 'steer', 'retry'], agent: 'EPERM', anchor: 'ariaLabel: `Steer now: send to ${cq.name} after its current step`', lines: 4 },
  { id: 'watch-stop', what: 'Tray watch: Stop watching / Cancel', op: ['/task/watch/{watch}/ctl', 'stop'], expect: ['remove', 'w1'], agent: 'ok', anchor: "const what = w.paths.map(shortPath).join(', ');", lines: 4 },
  { id: 'watch-deliver', what: 'Tray watch: Deliver held changes', op: ['/task/watch/{watch}/ctl', 'deliver'], expect: ['deliverHeld', 'w1'], agent: 'ok', anchor: 'ariaLabel: `Deliver ${w.held.length} held changes to the agent`', lines: 1 },
];
// Controls that act but stay direct calls, and why (README "Control plane").
export const DIRECT = [
  { what: 'Composer: Send (a new turn), paused follow-up Send, follow-up with attachments', why: 'starting a turn may create the session and carries attachments held in the page; a file write carries text to an existing session' },
  { what: 'Tray: Cancel a steer, Cancel or Edit a follow-up', why: 'taking back your own unsent words into the composer is editing, not acting on an agent' },
  { what: 'Approval sheet: Allow / Deny (egress)', why: 'consent must not be a file: main can write its own session\'s ctl, so a writable approval file would let an agent approve itself' },
];
// Direct harness calls the Interface may make only inside its driver (the harness side).
const FORBIDDEN = ['agent.subagents.stop(', 'agent.abort(', '.stopCall(', 'subagents.detach(', 'watches.remove(', 'watches.deliverHeld(', 'agent.steer(', 'steerTracked(', 'subagents.stopAll(', 'agent.subagents.message('];
const CTL_CALL = /\bctl\(/;

// ── A fake page: two sessions, main and one subagent each ───────────
function fakePage() {
  const calls = [];
  const agents = {
    1: [{ ref: 'a1', name: 'main', kind: 'main', state: 'working', since: Date.now() - 2000 }, { ref: 'a2', name: 'scout', kind: 'subagent', state: 'running', since: Date.now() - 1000, task: 'read the docs', ns: ['/work  rw opfs'] }],
    2: [{ ref: 'a1', name: 'main', kind: 'main', state: 'idle' }],
  };
  const control = createControl({
    sessions: () => [{ id: 1, title: 'Essay review' }, { id: 2, title: 'Other' }],
    current: () => 1,
    agents: (sid) => agents[sid] ?? [],
    last: (sid, ref) => (ref === 'a2' ? 'Found 3 sources.' : ''),
    usage: (sid) => ({ allowance: { mode: 'key', remaining: 412, limit: 500, resetsAt: new Date('2026-11-02T08:00:00Z') }, turn: 3, today: Number(sid) * 10 }),
    changes: (sid) => changes.list(sid),
  });
  const changes = createChanges();
  control.drive({
    stop: async (sid, ref, o, { by }) => { calls.push(['stop', sid, ref, o, by]); return { ok: true }; },
    detach: async (sid, ref, { by }) => { calls.push(['detach', sid, ref, by]); },
    send: async (sid, ref, mode, text, { by }) => { calls.push(['send', sid, ref, mode, text, by]); if (mode === 'steer' && sid === '2') throw Object.assign(new Error('a1 is not working; write followup or message instead'), { code: 'EINVAL' }); return { id: 7 }; },
  });
  const tasks = new Tasks();
  const task = tasks.add({ kind: 'run', label: 'x', ns: [], kill: () => calls.push(['kill']) });
  const w = { id: 'w1', paths: ['/work/a'], by: 'any', ownerName: 'main', owner: 'a1', created: 0, held: [] };
  const watches = { get: (id) => (id === 'w1' ? w : null), all: () => [w], remove: (id) => calls.push(['remove', id]), deliverHeld: (id) => calls.push(['deliverHeld', id]) };
  const base = new Namespace();
  base.mount(new InMemoryFs(), '/');
  base.mount(new TaskFs(tasks, () => watches), '/task');
  const term = over(base, [['/session', control.view({ by: 'user' }), { label: 'control (you)' }]]);
  const main = over(base, [['/session', control.view({ by: 'agent', sid: 1 }), { label: 'control (a1)' }]]);
  // As the terminal and the bash tool run a script: a failed redirection write reported, not thrown (CP6).
  const sh = (fs) => (cmd) => execScript(new Bash({ fs: tagWrites(fs), cwd: '/' }), cmd, { cwd: '/' });
  return { control, calls, task, term, main, base, changes, terminal: sh(term), agent: sh(main) };
}
const fill = (p, page) => p.replace('{sid}', '1').replace('{ref}', 'a2').replace('{task}', String(page.task.id)).replace('{watch}', 'w1');
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

await test('grammar: ctl lines and in headers', async () => {
  assert.deepEqual(parseCtl('stop\n\nkill\n'), ['stop', 'stop']);
  assert.deepEqual(parseCtl('stop all', { main: true }), ['stop all']);
  assert.throws(() => parseCtl('stop all'), /ctl accepts: stop, detach/);
  assert.throws(() => parseCtl('stop\nexplode'), /got "explode"/);
  assert.deepEqual(parseIn('steer\nuse tabs\n'), { mode: 'steer', text: 'use tabs' });
  assert.deepEqual(parseIn('followup then tests'), { mode: 'followup', text: 'then tests' });
  assert.deepEqual(parseIn('follow-up\nx'), { mode: 'followup', text: 'x' });
  assert.deepEqual(parseIn('Please look'), { mode: 'message', text: 'Please look' });
  assert.deepEqual(parseIn('steering is hard'), { mode: 'message', text: 'steering is hard' });
});

await test(`every acting control works from the terminal (${CONTROLS.length} controls)`, async () => {
  for (const c of CONTROLS) {
    const page = fakePage();
    const r = await page.terminal(`printf %s ${shq(c.op[1])} > ${fill(c.op[0], page)}`);
    assert.equal(r.exitCode, 0, `${c.id}: ${r.stderr}`);
    const got = page.calls.at(-1);
    assert.deepEqual(got.slice(0, c.expect.length), c.expect, c.id);
    if (got[0] === 'stop' || got[0] === 'send' || got[0] === 'detach') assert.equal(got.at(-1), 'user', `${c.id} is attributed to the user`);
  }
});

await test('the same files from the main agent: ctl works in its own session, in is refused, other sessions are invisible', async () => {
  for (const c of CONTROLS) {
    const page = fakePage();
    const r = await page.agent(`printf %s ${shq(c.op[1])} > ${fill(c.op[0], page)}`);
    if (c.agent === 'ok') { assert.equal(r.exitCode, 0, `${c.id}: ${r.stderr}`); assert.deepEqual(page.calls.at(-1).slice(0, c.expect.length), c.expect, c.id); }
    else { assert.notEqual(r.exitCode, 0, c.id); assert.match(r.stderr, new RegExp(c.agent), c.id); assert.equal(page.calls.length, 0, c.id); }
  }
  const page = fakePage();
  assert.deepEqual((await page.agent('ls /session')).stdout.split('\n').filter(Boolean), ['1', 'current', 'events']);
  assert.notEqual((await page.agent('cat /session/2/status')).exitCode, 0);
  assert.equal((await page.agent('cat /session/current/agents/a2/status')).stdout.split(' ')[0], 'running');
});

await test('reads: status, title, last, ns, events; errors read like Rerror', async () => {
  const page = fakePage();
  assert.match((await page.terminal('cat /session/1/status')).stdout, /^working agents=2 running=1\n$/);
  assert.equal((await page.terminal('cat /session/current/title')).stdout, 'Essay review\n');
  assert.match((await page.terminal('cat /session/1/agents/a2/status')).stdout, /^running \d+\.\ds subagent scout: read the docs\n$/);
  assert.equal((await page.terminal('cat /session/1/agents/a2/last')).stdout, 'Found 3 sources.\n');
  assert.equal((await page.terminal('cat /session/1/agents/a2/ns')).stdout, '/work  rw opfs\n');
  await page.terminal('echo stop > /session/1/agents/a2/ctl');
  await page.terminal("printf 'steer\\nsecret words' > /session/1/agents/a1/in");
  const ev = (await page.terminal('cat /session/events')).stdout;
  assert.match(ev, /1 a2 ctl stop by you/);
  assert.match(ev, /1 a1 in steer by you \(12 chars\)/);
  assert.doesNotMatch(ev, /secret/, 'events carry no message content');
  const bad = await page.terminal('echo explode > /session/1/agents/a2/ctl');
  assert.match(bad.stderr, /EINVAL: ctl accepts: stop, detach \(got "explode"\)/);
  const idle = await page.terminal('echo steer hi > /session/2/agents/a1/in');
  assert.match(idle.stderr, /a1 is not working/);
  assert.equal(why(new Error("EINVAL: a1 is not working, write '/session/2/agents/a1/in'")), 'a1 is not working');
  try { await page.term.writeFile('/session/1/title', 'x'); assert.fail(); } catch (e) { assert.equal(codeOf(e), 'EROFS'); }
});

await test('same-page writes return the harness receipt (a steer id for the tray)', async () => {
  const page = fakePage();
  assert.deepEqual(await page.term.writeFile('/session/1/agents/a1/in', 'steer\nx'), { id: 7 });
});

await test('events: a blocking read in JS and over 9P (flush interrupts it)', async () => {
  const page = fakePage();
  const at = page.control.seq;
  const p = page.control.next(at);
  page.control.state(1, 'a2', 'stopped');
  page.control.state(1, 'a2', 'stopped'); // unchanged: no event
  assert.deepEqual((await p).map((e) => e.line.replace(/^\d+ /, '')), ['1 a2 state stopped']);
  const { port1, port2 } = new MessageChannel();
  const server = serve(port1, page.term);
  const client = new Client(port2);
  await client.connect();
  // Low-level: walk, open, read (blocks), then an event arrives.
  const f2 = await client.walk('/session/events');
  await client.call({ type: 'Topen', fid: f2, mode: OREAD });
  let done = false;
  const r = client.call({ type: 'Tread', fid: f2, offset: 0, count: 4096 }).then((x) => { done = true; return new TextDecoder().decode(x.data); });
  await new Promise((s) => setTimeout(s, 30));
  assert.equal(done, false, 'the read waits for the next event');
  page.control.state(1, 'a1', 'idle');
  assert.match(await r, /1 a1 state idle\n$/);
  const ac = new AbortController();
  const r2 = client.call({ type: 'Tread', fid: f2, offset: 0, count: 4096 }, { signal: ac.signal }).then(() => 'answered', (e) => 'flushed');
  await new Promise((s) => setTimeout(s, 20));
  ac.abort();
  assert.equal(await r2, 'flushed');
  client.close(); server.close();
});

// ── Static: the Interface's handlers write control files ────────────
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const lines = main.split('\n');
const bodyOf = (name) => {
  const i = lines.findIndex((l) => new RegExp(`^(async )?function ${name}\\(`).test(l));
  assert.ok(i >= 0, `helper ${name} exists`);
  const j = lines.findIndex((l, k) => k > i && l === '}');
  return lines.slice(i, j + 1).join('\n');
};
const DRIVER_START = '// ── Control plane: the harness side', DRIVER_END = '// ── End of the harness side';

await test(`every acting control's Interface handler writes its control file (${CONTROLS.length})`, async () => {
  const failures = [];
  for (const c of CONTROLS) {
    const i = lines.findIndex((l) => l.includes(c.anchor));
    if (i < 0) { failures.push(`${c.id}: anchor not found`); continue; }
    const h = lines.slice(i, i + c.lines).join('\n');
    const bad = FORBIDDEN.filter((f) => h.includes(f));
    const helpers = (c.via ?? []).filter((n) => h.includes(n + '(') || (c.via.length > 1 && c.via.indexOf(n) > 0));
    const writes = CTL_CALL.test(h) || helpers.some((n) => CTL_CALL.test(bodyOf(n)) && !FORBIDDEN.some((f) => bodyOf(n).includes(f)));
    if (bad.length || !writes) failures.push(`${c.id}: ${bad.length ? 'calls ' + bad.join(', ') : 'writes no control file'}`);
  }
  assert.deepEqual(failures, []);
});

await test('direct harness calls appear only inside the harness side (driver)', async () => {
  const a = main.indexOf(DRIVER_START), b = main.indexOf(DRIVER_END);
  assert.ok(a > 0 && b > a, 'driver region is marked');
  const outside = main.slice(0, a) + main.slice(b);
  const found = FORBIDDEN.flatMap((f) => outside.split('\n').map((l, n) => [l, n]).filter(([l]) => l.includes(f)).map(([l]) => `${f} in: ${l.trim().slice(0, 90)}`));
  assert.deepEqual(found, []);
});

await test('the terminal stops with a ctl write too', async () => {
  const t = readFileSync(new URL('../src/terminal.js', import.meta.url), 'utf8');
  assert.match(t, /writeFile\(`\/task\/\$\{[^}]+\}\/ctl`, 'kill'\)/);
});

await test('usage: the agent reads its own allowance and request counts, read-only, no other session (AG35)', async () => {
  const page = fakePage();
  const r = await page.agent('cat /session/current/usage');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /^allowance: 412 of 500 requests left today \(the user's key, also spent by their other tools and devices\)\n/);
  assert.match(r.stdout, /\nresets: 2026-11-02T08:00:00\.000Z\n/);
  assert.match(r.stdout, /\nrequests-this-turn: 3\nrequests-today-this-session: 10\n/);
  assert.notEqual((await page.agent('cat /session/2/usage')).exitCode, 0, 'another session is invisible');
  const w = await page.agent('echo 9999 > /session/current/usage; echo next');
  assert.notEqual(w.exitCode, 0); assert.match(w.stderr, /EROFS/);
  assert.equal((await page.terminal('cat /session/2/usage')).stdout.split('\n').at(-3), 'requests-today-this-session: 20', 'the user sees every session');
  assert.match(usageText({ allowance: { remaining: null } }), /^allowance: unknown \(.*unknown is not zero\)\nrequests-this-turn: unknown\n/);
  assert.match(usageText({ allowance: { mode: 'campus', remaining: 40, limit: 200 } }), /^allowance: about 40 of 200 .*shared with everyone on this network/);
  assert.match(usageText({ allowance: { mode: 'campus', offCampus: true } }), /^allowance: none \(off campus/);
});

await test('changes: net paths changed this turn, subagents marked, actions left out (AG22)', async () => {
  const c = createChanges();
  c.note(1, 'created', '/work/new.md', 'a1'); c.note(1, 'modified', '/work/new.md', 'a1');
  c.note(1, 'created', '/tmp/scratch', 'a1'); c.note(1, 'deleted', '/tmp/scratch', 'a1');
  c.note(1, 'modified', '/work/b.js', 'a2'); c.note(1, 'modified', '/work/b.js', 'a1');
  c.note(1, 'deleted', '/work/old.txt', 'a1'); c.note(1, 'created', '/work/old.txt', 'a1');
  c.note(1, 'modified', '/work/my file.txt', 'a3'); c.note(1, 'deleted', '/work/my file.txt', 'a3');
  c.note(1, 'modified', '/session/1/ctl', 'a1'); c.note(1, 'modified', '/task/3/ctl', 'a1');
  c.note(2, 'created', '/work/elsewhere', 'a1');
  assert.equal(changesText(c.list(1)), 'modified a1,a2 /work/b.js\ndeleted a3 /work/my file.txt\ncreated a1 /work/new.md\nmodified a1 /work/old.txt\n');
  c.begin(1); assert.equal(changesText(c.list(1)), '', 'a new turn starts empty');
  assert.equal(c.list(2).length, 1, 'sessions are separate');
  // The tools' fs reports what a script changes (src/tools.js noting).
  const fs = new InMemoryFs();
  await fs.mkdir('/work', { recursive: true });
  for (const f of ['keep', 'gone', 'from']) await fs.writeFile('/work/' + f, 'x');
  const seen = createChanges();
  const r = await new Bash({ fs: noting(fs, (op, p) => seen.note(1, op, p, 'a1')), cwd: '/work' }).exec('echo a > keep; echo b > made; rm gone; mv from to; mkdir dir; cp keep dir/copy; cat keep > /dev/null');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(changesText(seen.list(1)), 'created a1 /work/dir\ncreated a1 /work/dir/copy\ndeleted a1 /work/from\ndeleted a1 /work/gone\nmodified a1 /work/keep\ncreated a1 /work/made\ncreated a1 /work/to\n');
  // Read through the control plane, the agent's own session only.
  const page = fakePage();
  page.changes.note(1, 'created', '/work/report.md', 'a1'); page.changes.note(1, 'modified', '/work/notes.md', 'a2');
  assert.equal((await page.agent('cat /session/current/changes')).stdout, 'modified a2 /work/notes.md\ncreated a1 /work/report.md\n');
  assert.deepEqual((await page.agent('ls /session/current')).stdout.split('\n').filter(Boolean), ['agents', 'changes', 'ctl', 'status', 'title', 'usage']);
});

await test('CP6: a failed control write reports itself and names what did not run (AG33)', async () => {
  const page = fakePage();
  // The story: stop a2 and a9 (no such agent), then list the agents.
  let r = await page.agent('echo stop > /session/current/agents/a2/ctl\necho stop > /session/current/agents/a9/ctl\nls /session/current/agents');
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /^bash: \/session\/current\/agents\/a9\/ctl: ENOENT/);
  assert.match(r.stderr, /the 1 command before it ran but its output is lost; 1 later command did not run: `ls \/session\/current\/agents`/);
  assert.deepEqual(page.calls.map((c) => c.slice(0, 3)), [['stop', '1', 'a2']], 'the earlier write still happened');
  // A refused in and a rejected ctl line, each with its reason.
  r = await page.agent('printf hi > /session/current/agents/a2/in; cat /session/current/status; echo done');
  assert.match(r.stderr, /in: EPERM: agents message each other/);
  assert.match(r.stderr, /2 later commands did not run: `cat \/session\/current\/status`, `echo done`/);
  r = await page.terminal("echo explode > /session/1/ctl && echo ok; echo 'a; b'");
  assert.match(r.stderr, /ctl accepts: stop, detach/);
  assert.match(r.stderr, /including the rest of its line; 1 later command did not run: `echo 'a; b'`/);
  // Failures that are not writes still throw; ordinary scripts are untouched.
  assert.equal((await page.agent('cat /session/current/status; echo after')).stdout, 'working agents=2 running=1\nafter\n');
  assert.deepEqual(commandsOf("a; b 'c;d'\n# x; y\nfor i in 1; do e; done"), ['a', "b 'c;d'", 'for i in 1', 'do e', 'done']);
});

console.log(`\n${passed} passed (${CONTROLS.length} controls through files, ${DIRECT.length} direct by design)`);
