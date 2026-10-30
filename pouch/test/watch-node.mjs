// File watches (src/ns/watch.js) without a browser: globs, change summaries,
// write attribution through tagged views, and the delivery policy (busy
// batching, idle wakes, wake cap and held events, once, user-first, scope,
// rescan after a reload). Run: node test/watch-node.mjs
import assert from 'node:assert/strict';
import { InMemoryFs } from 'just-bash';
import { Namespace, subset } from '../src/ns/namespace.js';
import { Tasks, TaskFs } from '../src/ns/tasks.js';
import { attribute, createWatches, globRe, baseOf, summarize, expand, formatEvents, watchTool, MAX_WAKES } from '../src/ns/watch.js';

let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 2000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(5); } };

// ── globs and summaries ──
assert.ok(globRe('/work/data/*.csv').test('/work/data/a.csv'));
assert.ok(!globRe('/work/data/*.csv').test('/work/data/sub/a.csv'));
assert.ok(globRe('/work/**/*.md').test('/work/essay.md') && globRe('/work/**/*.md').test('/work/a/b/c.md'));
assert.ok(globRe('/work/f?.[ch]').test('/work/f1.c') && !globRe('/work/f?.[ch]').test('/work/f1.js'));
assert.equal(baseOf('/work/data/*.csv'), '/work/data');
assert.equal(baseOf('/work/essay.md'), '/work/essay.md');
ok('globs: * and ? within a segment, ** across, classes; base folder');

const L = (...xs) => enc.encode(xs.join('\n') + '\n');
assert.equal(summarize(L('a', 'b', 'c'), L('a', 'B', 'c')), 'changed: line 2 (+1 -1)');
assert.equal(summarize(L(...'abcdefghijklmnopqr'), L(...'abcdefghijklXYZWnopqr'.split(''))), 'changed: lines 13-16 (+4 -1)');
assert.equal(summarize(L('a', 'b'), L('a', 'b')), 'saved: no changes');
assert.equal(summarize(null, L('x', 'y')), 'created: 2 lines, 4 B');
assert.equal(summarize(L('x'), null), 'deleted: was 1 line, 2 B');
assert.match(summarize(L('1', '2', '3', '4', '5', '6', '7', '8'), L('1', 'X', '3', '4', 'Y', '6', '7', 'Z')), /^changed: lines 2, 5, 8 \(\+3 -3\)$/);
assert.match(summarize(new Uint8Array([0, 1]), new Uint8Array([0, 1, 2])), /binary/);
const ev = formatEvents([{ watch: 'w1', path: '/work/essay.md', source: 'user', before: L('a', 'b'), after: L('a', 'b', 'c') }], [{ id: 'w1', note: 'offer to re-run the panel' }]);
assert.equal(ev, '[from files] essay.md changed by you: line 3 (+1 -0)\n[watch w1, your note: offer to re-run the panel; unwatch w1 to stop]');
const ev2 = formatEvents([{ watch: 'w2', path: '/work/data/a.csv', source: 'user', before: null, after: L('h', '1') }], [{ id: 'w2', note: '', once: true }]);
assert.equal(ev2, '[from files] data/a.csv created by you: 2 lines, 4 B\n[watch w2; a once watch: more changes during this turn still arrive, then it is removed]');
assert.ok(!ev.includes('a\nb'), 'never the content');
ok('summaries: line ranges and counts, new/deleted with size, binary; event text format');

// ── attribution ──
function tree() {
  const ns = new Namespace(), mem = new InMemoryFs();
  ns.mount(mem, '/');
  return ns;
}
{
  const ns = tree();
  await ns.mkdir('/work/data', { recursive: true });
  await ns.writeFile('/work/essay.md', 'a\nb\n');
  const seen = [];
  const sink = { wants: (p) => p === '/work/essay.md' || /^\/work\/data\/[^/]*\.csv$/.test(p), wantsUnder: (p) => '/work/data'.startsWith(p) || p.startsWith('/work/data'), observe: (e) => seen.push(e) };
  const user = attribute(ns, 'user', sink), agentFs = attribute(ns, 'agent', sink);
  await user.writeFile('/work/essay.md', 'a\nb\nc\n');
  await agentFs.writeFile('/work/other.txt', 'x');
  await ns.writeFile('/work/essay.md', 'raw\n'); // raw namespace: not reported
  await agentFs.writeFile('/work/data/a.csv', 'h\n');
  await user.rm('/work/data', { recursive: true });
  await user.mv('/work/essay.md', '/work/essay2.md');
  assert.deepEqual(seen.map((e) => [e.path, e.source, e.before == null ? null : new TextDecoder().decode(e.before), e.after == null ? null : new TextDecoder().decode(e.after)]), [
    ['/work/essay.md', 'user', 'a\nb\n', 'a\nb\nc\n'],
    ['/work/data/a.csv', 'agent', null, 'h\n'],
    ['/work/data/a.csv', 'user', 'h\n', null],
    ['/work/essay.md', 'user', 'raw\n', null],
  ]);
  // A capability view cut from an attributed view still reports its writes.
  const sub = subset(attribute(ns, 'subagent judge (s3)', sink), ['/work/data']);
  await sub.writeFile('/work/data/b.csv', 'z\n');
  assert.equal(seen.at(-1).source, 'subagent judge (s3)');
  ok('attribution: each view tags its writes; raw writes and unwatched paths are not reported; rm/mv of folders; subset views');
}

// ── the registry ──
function harness({ files = {} } = {}) {
  const ns = tree();
  const saved = new Map();
  const log = []; // deliveries
  const state = { busy: false, queued: false, scope: null };
  let release;
  const deps = {
    fs: ns, load: async (sid) => saved.get(sid), save: (sid, l) => saved.set(sid, structuredClone(l)), sessions: async () => [...saved.keys()],
    scopeOf: (_sid, owner) => (owner === 's1' ? null : state.scope),
    userQueued: () => state.queued, busy: async () => state.busy,
    deliver: async (sid, owner, ev) => { log.push({ sid, owner, ...ev, at: Date.now(), queuedThen: state.queued }); if (ev.mode === 'wake') { state.busy = true; return { done: new Promise((r) => { release = () => { state.busy = false; r(); }; }) }; } return {}; },
    ready: Promise.resolve(), onChange: () => {},
  };
  const reg = createWatches(deps);
  const user = attribute(ns, 'user', reg), agentFs = attribute(ns, 'agent', reg), run = attribute(ns, 'run', reg);
  return { ns, reg, user, agentFs, run, log, state, saved, deps, end: () => release?.(), init: async () => { for (const [p, t] of Object.entries(files)) { await ns.mkdir(p.replace(/\/[^/]*$/, ''), { recursive: true }); await ns.writeFile(p, t); } } };
}
{
  const h = harness({ files: { '/work/essay.md': 'one\ntwo\n' } });
  await h.init();
  const w = await h.reg.add('1', 's1', 'main', { paths: ['essay.md'], note: 'offer to re-run the panel' });
  assert.equal(w.by, 'user'); assert.deepEqual(w.paths, ['/work/essay.md']);
  await h.agentFs.writeFile('/work/essay.md', 'one\ntwo\nagent\n');
  await h.run.writeFile('/work/essay.md', 'one\ntwo\nrun\n');
  await sleep(30);
  assert.equal(h.log.length, 0, 'agent and run writes do not fire a user watch');
  await h.user.writeFile('/work/essay.md', 'one\nTWO\nrun\n');
  await until(() => h.log.length === 1);
  assert.equal(h.log[0].mode, 'wake');
  assert.match(h.log[0].content, /^\[from files\] essay\.md changed by you: line 2 \(\+1 -1\)\n\[watch w1, your note: offer to re-run the panel/);
  ok('by user: agent edit and run write do not fire; a user save wakes an idle owner with the change summary');

  // Busy: events during the woken turn join it as steers, batched.
  await h.user.writeFile('/work/essay.md', 'one\nTWO\nrun\nfour\n');
  await h.user.writeFile('/work/essay.md', 'one\nTWO\nrun\nfour\nfive\n');
  await until(() => h.log.length >= 2);
  await sleep(30);
  assert.ok(h.log.slice(1).every((d) => d.mode === 'steer'), 'during a wake, events steer');
  const steered = h.log.slice(1).map((d) => d.content).join('\n');
  assert.match(steered, /line(s)? 4/);
  h.end(); await sleep(10);
  ok(`busy batching: ${h.log.length - 1} steer message(s) for 2 saves during the woken turn (natural coalescing only)`);

  // Wake cap: three wakes, then held for the tray; Deliver sends them.
  h.log.length = 0; w.wakes = 1; // one wake so far
  for (let i = 0; i < 4; i++) { await h.user.writeFile('/work/essay.md', `v${i}\n`); await until(() => h.log.length === i + 1 || (i >= MAX_WAKES - 1 && w.held.length === i - (MAX_WAKES - 2))); h.end(); await sleep(10); }
  assert.equal(h.log.filter((d) => d.mode === 'wake').length, MAX_WAKES - 1);
  assert.equal(w.held.length, 2);
  h.reg.userSpoke('1'); assert.equal(w.wakes, 0);
  assert.equal(w.held.length, 2, 'user input resets the cap but keeps held events for Deliver');
  h.reg.deliverHeld('w1');
  await until(() => h.log.length === MAX_WAKES);
  assert.match(h.log.at(-1).content, /essay\.md changed by you \(2 writes\): line 1 \(\+1 -1\)/);
  assert.equal(w.held.length, 0); h.end();
  ok('wake cap: 3 wakes without user input, then events are held; Deliver sends them merged');

  // User first: a queued user message goes before a watch event.
  h.log.length = 0; h.state.queued = true;
  await h.user.writeFile('/work/essay.md', 'queued\n');
  await sleep(200);
  assert.equal(h.log.length, 0, 'held while the user has a message queued');
  h.state.queued = false; h.state.busy = true; // the user's turn is running now
  await until(() => h.log.length === 1);
  assert.equal(h.log[0].mode, 'steer'); h.state.busy = false;
  ok('user-first: an event waits behind the user\'s queued message, then joins that turn as a steer');

  // Stop watching.
  assert.ok(h.reg.remove('w1'));
  await h.user.writeFile('/work/essay.md', 'after\n'); await sleep(30);
  assert.equal(h.log.length, 1);
  ok('unwatch: no more events');
}
{
  // once + glob: the first file wakes; the rest of a multi-file drop joins the woken turn.
  const h = harness();
  await h.ns.mkdir('/work/data', { recursive: true });
  const w = await h.reg.add('1', 's1', 'main', { paths: ['/work/data/*.csv'], once: true, note: 'clean the CSVs' });
  for (const n of ['a', 'b', 'c']) await h.user.writeFile(`/work/data/${n}.csv`, 'h\n1\n');
  await until(() => h.log.length >= 1); await sleep(50);
  const files = (h.log.map((d) => d.content).join('\n').match(/\[from files\]/g) ?? []).length;
  console.log(`  multi-file drop (3 sequential writes, settled): ${h.log.length} delivery(ies), ${files} file line(s) reached the agent`);
  assert.equal(h.log.length, 1, 'one wake for the drop'); assert.equal(h.log[0].mode, 'wake'); assert.equal(files, 3, 'all three files in that wake');
  assert.ok(h.reg.get(w.id), 'once: still there while the woken turn runs');
  await h.user.writeFile('/work/data/d.csv', 'h\n2\n'); await until(() => h.log.length >= 2, 2000);
  assert.equal(h.log[1]?.mode, 'steer', 'a file arriving during the woken turn joins it');
  h.end(); await sleep(50);
  assert.equal(h.reg.get(w.id), undefined, 'once: removed when the woken turn ends');
  await h.user.writeFile('/work/data/e.csv', 'h\n3\n'); await sleep(500);
  assert.equal(h.log.length, 2, 'nothing after that');
  ok('once = one wake: a 3-file drop is one wake with all files; a 4th joins the woken turn; removed when it ends');
}
{
  // Scope: a subagent cannot watch outside its mounts.
  const h = harness({ files: { '/work/essay.md': 'x\n', '/pouch/AGENTS.md': 'y\n' } });
  await h.init();
  h.state.scope = ['/work/essay.md'];
  await assert.rejects(h.reg.add('1', 's3', 'judge', { paths: ['/pouch/AGENTS.md'] }), /outside what you can see/);
  await assert.rejects(h.reg.add('1', 's3', 'judge', { paths: ['/work/*.md'] }), /outside what you can see/);
  const w = await h.reg.add('1', 's3', 'judge', { paths: ['/work/essay.md'], by: 'any' });
  await assert.rejects(h.reg.add('1', 's1', 'main', { paths: ['/task/1/status'] }), /task cannot be watched/);
  await h.agentFs.writeFile('/work/essay.md', 'z\n');
  await until(() => h.log.length === 1);
  assert.equal(h.log[0].owner, 's3');
  assert.match(h.log[0].content, /changed by Pouch/);
  ok('scope: a subagent watches only inside its mounts; by any fires on agent writes; events go to the owner');

  // The tool, and /task/watch.
  const tool = watchTool({ Type: { Object: (x) => x, Optional: (x) => x, Union: (x) => x, Literal: (x) => x, Array: (x) => x, String: (x) => x, Boolean: (x) => x }, watches: h.reg, callerOf: async (c) => (c === 'child' ? { sid: '1', owner: 's3', ownerName: 'judge' } : { sid: '1', owner: 's1', ownerName: 'main' }) });
  const said = await tool.execute({ action: 'watch', paths: ['/work/essay.md'], note: 'offer to re-run the panel' });
  assert.match(said, /^Watching \/work\/essay\.md as w2 .*Tell the user in one line/);
  assert.match(await tool.execute({ action: 'list' }), /w1 .*owner judge s3[\s\S]*w2 \/work\/essay\.md: changes by the user; note: offer to re-run the panel/);
  assert.doesNotMatch(await tool.execute({ action: 'list' }, { caller: 'child' }), /w2/);
  await assert.rejects(tool.execute({ action: 'unwatch', id: 'w2' }, { caller: 'child' }), /No watch "w2" of yours/);
  const tfs = new TaskFs(new Tasks(), () => h.reg);
  assert.deepEqual(await tfs.readdir('/'), ['watch']);
  assert.deepEqual(await tfs.readdir('/watch'), ['w1', 'w2']);
  assert.equal(await tfs.readFile('/watch/w2/paths'), '/work/essay.md\n');
  assert.match(await tfs.readFile('/watch/w2/note'), /offer to re-run the panel\nby user; owner main \(s1\)/);
  await assert.rejects(tfs.writeFile('/watch/w2/ctl', 'kill'), /accepts one command: stop/);
  await tfs.writeFile('/watch/w2/ctl', 'stop\n');
  assert.equal(h.reg.get('w2'), undefined);
  assert.match(await tool.execute({ action: 'unwatch', id: 'w1' }), /Stopped watching/);
  void w;
  ok('tool: watch/list/unwatch with owner checks; /task/watch/<id>/{paths,note,ctl}, echo stop > ctl unwatches');
}
{
  // Reload: watches come back from storage; a file changed while closed fires once.
  const h = harness({ files: { '/work/essay.md': 'one\n', '/work/data/a.csv': 'x\n' } });
  await h.init();
  await h.reg.add('1', 's1', 'main', { paths: ['/work/essay.md'] });
  await h.reg.add('1', 's1', 'main', { paths: ['/work/data/*.csv'], by: 'agent' });
  await h.agentFs.writeFile('/work/essay.md', 'agent\n'); // known: hash follows, no event
  await sleep(30);
  await h.ns.writeFile('/work/data/b.csv', 'new\n'); // while "closed" (raw write)
  await h.ns.writeFile('/work/essay.md', 'outside\n');
  const again = createWatches({ ...h.deps, ready: Promise.resolve() });
  await again.boot();
  await until(() => h.log.length === 1);
  await sleep(50);
  assert.equal(h.log.length, 1, 'only the user watch fires for an outside change');
  assert.match(h.log[0].content, /essay\.md changed by outside Pouch \(while it was closed\): now 1 line, 8 B/);
  await again.rescan('outside'); await sleep(30);
  assert.equal(h.log.length, 1, 'fires once');
  assert.deepEqual(again.list('1').map((w) => w.id), ['w1', 'w2']);
  again.removeSession('1');
  assert.equal(again.list('1').length, 0);
  ok('reload: re-armed from storage; a change made while closed fires once; agent edits never misfire; session removal drops them');
}
{
  const ns = tree();
  for (const p of ['/work/data/a.csv', '/work/data/b.txt', '/work/data/sub/c.csv']) { await ns.mkdir(p.replace(/\/[^/]*$/, ''), { recursive: true }); await ns.writeFile(p, '1'); }
  assert.deepEqual(await expand(ns, '/work/data/*.csv'), ['/work/data/a.csv']);
  assert.deepEqual(await expand(ns, '/work/data/**/*.csv'), ['/work/data/a.csv', '/work/data/sub/c.csv']);
  ok('expand: globs walk only below their base');
}
console.log(`watch-node: ${passed} passed`);
