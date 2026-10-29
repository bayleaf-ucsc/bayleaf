// Node checks for the Local lane's pure parts and the newline/empty-error tool fixes.
// Run: NODE_PATH=/tmp/pouch-scratch/fidb/node_modules node test/local-node.mjs
import '/tmp/pouch-scratch/fidb/node_modules/fake-indexeddb/auto/index.mjs';
import assert from 'node:assert/strict';
import { Vfs, DEFAULTS } from '../src/vfs.js';
import defaults from '../src/defaults.js';
import { createTools, matchNewline, oneFinalNewline } from '../src/tools.js';
import { parseToolCalls, toLocalMessages, turnState, localApi, STEP_CAP, isLocal } from '../src/local/provider.js';
import { Type } from 'typebox';
globalThis.navigator ??= {};
Object.assign(DEFAULTS, defaults);
let n = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('PASS', name); }, (e) => { console.log('FAIL', name, e.message); process.exitCode = 1; });

// matchNewline: the experiment's normalization, plus a deletion and CRLF.
await ok('newText inherits a missing final newline', () => assert.deepEqual(matchNewline({ oldText: 'a = 1\n', newText: 'a = 1\nb = 2' })[0].newText, 'a = 1\nb = 2\n'));
await ok('newText loses an extra final newline', () => assert.deepEqual(matchNewline({ oldText: 'x', newText: 'y\n\n' })[0].newText, 'y'));
await ok('consistent edits untouched', () => { for (const e of [{ oldText: 'a\n', newText: 'b\n' }, { oldText: 'a', newText: 'b' }, { oldText: 'a\nb', newText: 'a\nc\nb' }]) assert.equal(matchNewline(e)[1], false); });
await ok('a deletion (empty newText) is left alone', () => assert.deepEqual(matchNewline({ oldText: 'b\n', newText: '' }), [{ oldText: 'b\n', newText: '' }, false]));
await ok('CRLF oldText gives CRLF', () => assert.equal(matchNewline({ oldText: 'a\r\n', newText: 'b' })[0].newText, 'b\r\n'));
await ok('oneFinalNewline', () => {
  assert.deepEqual(oneFinalNewline('Fahrenheit'), ['Fahrenheit\n', true]);
  assert.deepEqual(oneFinalNewline('x\n\n\n'), ['x\n', true]);
  assert.deepEqual(oneFinalNewline('x\n'), ['x\n', false]);
  assert.deepEqual(oneFinalNewline(''), ['', false]);
  assert.deepEqual(oneFinalNewline('a\r\nb'), ['a\r\nb\r\n', true]);
});

const vfs = new Vfs();
await vfs.init();
const [read, write, edit, bash] = createTools(vfs, Type, { defenseInDepth: false });
await ok('write adds the final newline and says so', async () => {
  assert.match(await write.execute({ path: 'docs/unit.txt', content: 'Fahrenheit' }), /exactly one newline/);
  assert.equal(await vfs.fs.readFile('/work/docs/unit.txt'), 'Fahrenheit\n');
});
await ok('append edit without final newline keeps the file ending', async () => {
  await write.execute({ path: 'src/ui.js', content: 'export const label = "Temperature";\n' });
  const r = await edit.execute({ path: 'src/ui.js', oldText: 'export const label = "Temperature";\n', newText: 'export const label = "Temperature";\nexport const unit = "F";' });
  assert.match(r, /matched to oldText/);
  assert.equal(await vfs.fs.readFile('/work/src/ui.js'), 'export const label = "Temperature";\nexport const unit = "F";\n');
});
await ok('legitimate mid-line and multi-edit changes are unchanged', async () => {
  await write.execute({ path: 'c.js', content: 'return c * 9 / 5 + 30;\nline2\nline3\n' });
  const r = await edit.execute({ path: 'c.js', edits: [{ oldText: '+ 30', newText: '+ 32' }, { oldText: 'line2\n', newText: '' }] });
  assert.doesNotMatch(r, /matched/);
  assert.equal(await vfs.fs.readFile('/work/c.js'), 'return c * 9 / 5 + 32;\nline3\n');
});
await ok('grep with no match explains itself', async () => {
  await assert.rejects(bash.execute({ command: 'grep -rn nothing-here src' }, {}), (e) => /^no output, exit 1 \(for grep this means no matches/.test(e.message));
  await assert.rejects(bash.execute({ command: 'false' }, {}), (e) => e.message === 'no output, exit 1');
  await assert.rejects(bash.execute({ command: 'cat missing.txt' }, {}), (e) => /No such file/.test(e.message));
});

await ok('concurrent edits of one file both apply (one model message, several calls)', async () => {
  await write.execute({ path: 'src/r.js', content: 'import { a } from "./a.js";\nexport const x = a(1);\n' });
  await Promise.all([edit.execute({ path: 'src/r.js', oldText: 'import { a }', newText: 'import { b }' }), edit.execute({ path: '/work/src/r.js', oldText: '= a(1)', newText: '= b(1)' })]);
  assert.equal(await vfs.fs.readFile('/work/src/r.js'), 'import { b } from "./a.js";\nexport const x = b(1);\n');
});

// Provider parts.
await ok('parseToolCalls: two calls, newlines trimmed once, prose kept', () => {
  const r = parseToolCalls('Doing it.<tool_call>\n<function=edit>\n<parameter=path>\na.js\n</parameter>\n<parameter=newText>\nx\n\n</parameter>\n</function>\n</tool_call><tool_call><function=read><parameter=path>b</parameter></function></tool_call><|im_end|>');
  assert.equal(r.text, 'Doing it.');
  assert.deepEqual(r.calls, [{ name: 'edit', arguments: { path: 'a.js', newText: 'x\n' } }, { name: 'read', arguments: { path: 'b' } }]);
  assert.equal(parseToolCalls('<tool_call><function=read>').malformed, true);
});
const user = (t) => ({ role: 'user', content: t, timestamp: 0 });
const asst = (calls, text = '') => ({ role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), ...calls.map(([name, args], i) => ({ type: 'toolCall', id: 'c' + i, name, arguments: args }))] });
const res = (name, text, isError = false) => ({ role: 'toolResult', toolCallId: 'c', toolName: name, content: [{ type: 'text', text }], isError, timestamp: 0 });
await ok('toLocalMessages and turnState', () => {
  const ms = [{ role: 'system', content: 'big pouch prompt', toolsAdded: [{ name: 'read' }] }, user('old'), asst([], 'hi'), user('do it'),
    asst([['edit', { path: 'a' }]]), res('edit', 'not found', true), asst([['edit', { path: 'b' }], ['write', { path: '/work/c' }]]), res('edit', 'nope', true), res('write', 'ok')];
  const l = toLocalMessages(ms);
  assert.equal(l[0].content, 'old'); assert.equal(l.filter((m) => m.role === 'tool')[0].content, 'ERROR: not found');
  assert.deepEqual(turnState(ms), { steps: 2, files: 3, failedEdits: 2 });
});
await ok('isLocal', () => { assert.ok(isLocal('local:lfm3-1.7b-q4f16')); assert.ok(!isLocal('glm-5-3')); });

const collect = async (s) => { const ev = []; for await (const e of s) ev.push(e); return ev; };
const model = { id: 'local:x', api: 'pouch-local', provider: 'pouch-local' };
const tooled = (msgs) => ({ messages: [{ role: 'system', content: 'p', toolsAdded: [{ name: 'read' }] }, ...msgs] });
await ok('stream: tool call, hints, usage', async () => {
  const hints = [];
  const engine = { async generate(req, { onDelta }) {
    assert.equal(req.head[0].role, 'system'); assert.ok(req.head.length > 2, 'few-shot present'); assert.equal(req.tools.length, 4);
    onDelta('Reading<tool'); onDelta('_call><function=read><parameter=path>\na\n</parameter></function></tool_call>');
    return { text: 'Reading<tool_call><function=read><parameter=path>\na\n</parameter></function></tool_call>', input_tokens: 900, output_tokens: 20, trimmed: 1 };
  } };
  const ev = await collect(localApi(engine, { onHint: (k) => hints.push(k) }).stream(model, tooled([user('x'), asst([['edit', { path: 'a' }]]), res('edit', 'e', true), asst([['edit', { path: 'a' }]]), res('edit', 'e', true)]), {}));
  const done = ev.at(-1);
  assert.equal(done.type, 'done'); assert.equal(done.reason, 'toolUse');
  assert.deepEqual(done.message.content.map((c) => c.type), ['text', 'toolCall']);
  assert.equal(done.message.content[0].text, 'Reading');
  assert.ok(!ev.some((e) => e.type === 'text_delta' && e.delta.includes('<')), 'no XML streamed');
  assert.equal(done.message.usage.input, 900);
  assert.deepEqual(hints.sort(), ['context', 'edit-failed']);
});
await ok('stream: step cap stops without generating', async () => {
  const hints = [], calls = Array.from({ length: STEP_CAP }, () => [asst([['read', { path: 'a' }]]), res('read', 'x')]).flat();
  const ev = await collect(localApi({ generate: () => assert.fail('generated past the cap') }, { onHint: (k) => hints.push(k) }).stream(model, tooled([user('x'), ...calls]), {}));
  assert.equal(ev.at(-1).reason, 'stop'); assert.match(ev.at(-1).message.content[0].text, /8 steps/); assert.deepEqual(hints, ['step-cap']);
});
await ok('stream: unknown tool refused, abort reported', async () => {
  const r1 = await collect(localApi({ generate: async () => ({ text: '<tool_call><function=subagent><parameter=task>x</parameter></function></tool_call>', input_tokens: 1, output_tokens: 1 }) }).stream(model, tooled([user('x')]), {}));
  assert.equal(r1.at(-1).message.content.some((c) => c.type === 'toolCall'), false); assert.match(r1.at(-1).message.content[0].text, /cannot use/);
  const ac = new AbortController(); ac.abort();
  const r2 = await collect(localApi({ generate: async () => ({ text: 'partial', interrupted: true, input_tokens: 1, output_tokens: 1 }) }).stream(model, tooled([user('x')]), { signal: ac.signal }));
  assert.equal(r2.at(-1).type, 'error'); assert.equal(r2.at(-1).reason, 'aborted');
});
await ok('stream: no tools means no few-shot', async () => {
  await collect(localApi({ generate: async (req) => { assert.equal(req.head.length, 1); assert.equal(req.tools.length, 0); return { text: 'Title', input_tokens: 1, output_tokens: 1 }; } }).stream(model, { messages: [user('name this')] }, {}));
});
console.log(`${n} passed`);
