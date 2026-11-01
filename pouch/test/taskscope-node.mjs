// /task in the main agent's namespace holds only its own session's tasks
// (Batch G, from the Batch F review): main could kill another session's
// subagents, and the user's terminal commands, by writing their ctl files.
// The Interface and the terminal still see every task.
//   node test/taskscope-node.mjs
import assert from 'node:assert/strict';
import { Tasks, TaskFs } from '../src/ns/tasks.ts';

const tasks = new Tasks();
const killed = [];
const add = (kind, label, sid) => tasks.add({ kind, label, sid, kill: () => killed.push(label) });
const mineSub = add('subagent', 'scout', 's1'), mineRun = add('run', 'calc', 's1');
const otherSub = add('subagent', 'reader', 's2'), terminalCmd = add('terminal', 'sleep 60', null);
const watches = { all: () => [{ id: 'w1', sid: 's1' }, { id: 'w2', sid: 's2' }], get: (id) => watches.all().find((w) => w.id === id) };
watches.all().forEach((w) => Object.assign(w, { paths: ['/work'], note: '', by: 'a1', once: false, owner: 'a1', ownerName: 'main', created: 0 }));

const all = new TaskFs(tasks, () => watches);
const main1 = new TaskFs(tasks, () => watches, { sid: 's1' });

// The user's view: everything.
assert.deepEqual((await all.readdir('/')).sort(), [mineSub, mineRun, otherSub, terminalCmd].map((t) => String(t.id)).concat('watch').sort());
// Main of s1: its own subagent and run, its own watches; nothing else exists for it.
assert.deepEqual((await main1.readdir('/')).sort(), [mineSub, mineRun].map((t) => String(t.id)).concat('watch').sort());
assert.deepEqual(await main1.readdir('/watch'), ['w1']);
for (const t of [otherSub, terminalCmd]) {
  await assert.rejects(main1.readFile(`/${t.id}/status`), /ENOENT/, `main of s1 reads task ${t.label}`);
  await assert.rejects(main1.writeFile(`/${t.id}/ctl`, 'kill\n'), /ENOENT/, `main of s1 kills task ${t.label}`);
}
await assert.rejects(main1.readFile('/watch/w2/note'), /ENOENT/);
await assert.rejects(main1.writeFile('/watch/w2/ctl', 'stop\n'), /ENOENT/);
assert.deepEqual(killed, []);
await main1.writeFile(`/${mineSub.id}/ctl`, 'kill\n');
await all.writeFile(`/${otherSub.id}/ctl`, 'kill\n');
assert.deepEqual(killed, ['scout', 'reader']);
console.log('PASS /task is scoped to the main agent\'s session; the user sees all');
