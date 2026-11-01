// Node checks of the look tool (src/tools.js lookAt, agent.js toTool; JOURNEYS
// AG1, AG4, AG8): path validation, the per-call cap, format refusals, the
// text-only refusal, and where the image sits in the request pi-ai actually
// sends (OpenAI chat format: the tool message is text, the image follows in a
// user message). A scripted fake Sealed endpoint; no network, no real model.
// prepareImage needs a canvas, so a fake stands in (the browser test uses the real one).
// Run: node test/look-node.mjs
import assert from 'node:assert/strict';
import { openAgent, MemoryStorage, Type } from '../src/agent.js';
import { createTools, lookAt, LOOK_MAX, LOOK_REFUSAL } from '../src/tools.js';

let pass = 0;
const ok = (name) => { pass++; console.log('ok', name); };

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const JPEG = new Uint8Array([255, 216, 255, 224, 0, 16]);
const files = new Map([
  ['/work/chart.png', PNG], ['/work/photo.jpg', JPEG],
  ['/work/logo.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
  ['/work/drawing.txt', new TextEncoder().encode('<?xml version="1.0"?>\n<svg width="10"></svg>')],
  ['/work/notes.md', new TextEncoder().encode('# notes\n')],
]);
const fs = {
  async readFileBuffer(p) {
    if (p === '/work/dir') { const e = new Error('EISDIR'); e.code = 'EISDIR'; throw e; }
    if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return files.get(p);
  },
  async stat(p) {
    if (p === '/work/dir') return { size: 0, isDirectory: true };
    if (p === '/work/huge.png') return { size: 25 * 1024 * 1024 };
    if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { size: files.get(p).length };
  },
};
const prepared = [];
const prepare = async (bytes) => {
  prepared.push(bytes.length);
  return bytes[0] === 137
    ? { image: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, width: 3000, height: 1500, sentWidth: 2000, sentHeight: 1000, bytes: 8 }
    : { image: { type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' }, width: 640, height: 480, sentWidth: 640, sentHeight: 480, bytes: 6 };
};

// ── validation and caps
await assert.rejects(lookAt([], fs, prepare), /at least one image path/);
await assert.rejects(lookAt(Array.from({ length: LOOK_MAX + 1 }, (_, i) => `/work/${i}.png`), fs, prepare), new RegExp(`at most ${LOOK_MAX} paths per call \\(got ${LOOK_MAX + 1}\\)`));
assert.equal(prepared.length, 0, 'nothing prepared when the call is refused');
ok(`empty and over-cap calls refused before reading (LOOK_MAX ${LOOK_MAX})`);

const r = await lookAt(['chart.png', '/work/chart.png', 'photo.jpg', 'missing.png', 'logo.svg', 'drawing.txt', 'notes.md', 'dir'], fs, prepare);
assert.equal(r.images.length, 2, 'duplicate path sent once');
assert.deepEqual(r.images.map((i) => i.mimeType), ['image/png', 'image/jpeg']);
const lines = r.text.split('\n');
assert.match(lines[0], /^\/work\/chart\.png: image 1, PNG 3000x1500, sent scaled to 2000x1000 PNG, 8 bytes$/);
assert.match(lines[1], /^\/work\/photo\.jpg: image 2, JPEG 640x480, sent at full size as JPEG, 6 bytes$/);
assert.match(r.text, /\/work\/missing\.png: not sent\. \/work\/missing\.png does not exist/);
assert.match(r.text, /\/work\/logo\.svg: not sent\. SVG is not sent as an image; it is text, so read its markup with the read tool/);
assert.match(r.text, /\/work\/drawing\.txt: not sent\. SVG is not sent/, 'SVG sniffed by content too');
assert.match(r.text, /\/work\/notes\.md: not sent\. It is not a PNG, JPEG, GIF or WebP image/);
assert.match(r.text, /\/work\/dir: not sent\. \/work\/dir is a folder/);
assert.match(lines.at(-1), /^\[2 images attached in this order; they count toward this conversation's context\]$/);
ok('one line per path (original and sent size, bytes), refusals inline, duplicates once, images in order');

await assert.rejects(lookAt(['notes.md', 'logo.svg'], fs, prepare), (e) => /notes\.md: not sent/.test(e.message) && /logo\.svg: not sent/.test(e.message));
ok('a call with nothing sendable fails, naming each path');

await assert.rejects(lookAt(['huge.png'], fs, prepare), /huge\.png: not sent\. It is 26,214,400 bytes/);
files.set('/work/commented.txt', new TextEncoder().encode('<?xml version="1.0"?><!-- a --> <!-- b --><svg/>'.replace('<svg/>', '<svg >')));
await assert.rejects(lookAt(['commented.txt'], fs, prepare), /SVG is not sent as an image/);
const ac = new AbortController(); ac.abort();
const preparedAt = prepared.length;
await assert.rejects(lookAt(['chart.png', 'photo.jpg'], fs, prepare, ac.signal), (e) => e.name === 'AbortError');
assert.equal(prepared.length, preparedAt, "stopped before preparing anything");
ok('a file over the cap is refused from its size, unread; SVG behind comments is still named; Stop skips the rest');

// ── the tool through createTools: the text-only refusal comes before any read
const vfs = { fs, changed() {}, mounts: new Map() };
const tools = createTools(vfs, Type, {}, { prepareImage: prepare });
const look = tools.find((t) => t.name === 'look');
assert.ok(look && look.parameters.properties.paths.maxItems === LOOK_MAX, 'look registered with the cap in its schema');
const before = prepared.length;
await assert.rejects(look.execute({ paths: ['chart.png'] }, { seesImages: false }), (e) => e.message === LOOK_REFUSAL);
assert.equal(prepared.length, before, 'refused without preparing');
assert.equal((await look.execute({ paths: ['chart.png'] }, {})).images.length, 1, 'unknown model: sent');
ok('text-only model: plain refusal, nothing prepared');

// ── end to end through pi-durable and pi-ai's OpenAI chat serializer
const enc = new TextEncoder();
const sse = (chunks) => new Response(new ReadableStream({ start(c) {
  for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
  c.enqueue(enc.encode('data: [DONE]\n\n')); c.close();
} }), { headers: { 'content-type': 'text/event-stream' } });
const chunk = (delta, finish = null) => ({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
const say = (text) => sse([chunk({ role: 'assistant', content: text }), chunk({}, 'stop')]);
let callN = 0;
const call = (name, args) => sse([chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${++callN}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }), chunk({}, 'tool_calls')]);
const bodies = [];
async function fakeFetch(_url, init) {
  const body = JSON.parse(init.body);
  bodies.push(body);
  const child = /You are a subagent named/.test(JSON.stringify(body.messages[0] ?? ''));
  const last = body.messages.at(-1);
  const lastText = typeof last.content === 'string' ? last.content : (last.content ?? []).map((b) => b.text ?? '').join('');
  if (child && body.messages.filter((m) => m.role === 'assistant').length === 0) return call('look', { paths: ['/work/chart.png'] });
  if (child) return say('The chart is blue.');
  if (last.role === 'user' && /^look at the chart/.test(lastText)) return call('look', { paths: ['chart.png'], note: 'checking the axis' });
  if (last.role === 'user' && /^spawn a looker/.test(lastText)) return call('subagent', { action: 'spawn', task: 'Look at /work/chart.png and say its colour', name: 'looker' });
  return say('done');
}
const client = { getVerificationDocument: async () => ({ securityVerified: true }), secureClient: { fetch: fakeFetch }, openAIOptions: { apiKey: 'test' } };
const regs = new Map(), reports = [];
const agent = await openAgent({
  storage: new MemoryStorage(), tools, systemPrompt: () => 'You are BayLeaf Pouch.', getClient: async () => client,
  models: [{ id: 'eyes', contextWindow: 131072, multimodal: true }, { id: 'text', contextWindow: 131072 }],
  subagents: { reg: { get: async (sid) => regs.get(sid), set: async (sid, l) => (l ? regs.set(sid, l) : regs.delete(sid)) }, onReport: (sid, sub, child) => reports.push(sub) },
});
const imagesIn = (body) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((p) => p.type === 'image_url'));

const sid = await agent.createSession('eyes');
await agent.send(sid, 'look at the chart', [], undefined, 'eyes');
const after = bodies.at(-1);
const ti = after.messages.findIndex((m) => m.role === 'tool');
assert.ok(ti > 0, 'a tool message was sent');
assert.equal(typeof after.messages[ti].content, 'string', 'the tool message is text only (OpenAI chat format)');
assert.match(after.messages[ti].content, /^\/work\/chart\.png: image 1, PNG 3000x1500/);
const u = after.messages[ti + 1];
assert.equal(u.role, 'user', 'the image follows in a user message');
assert.deepEqual(u.content.map((p) => p.type), ['text', 'image_url']);
assert.equal(u.content[1].image_url.url, 'data:image/png;base64,iVBORw0KGgo=');
assert.ok(after.tools.some((t) => t.function.name === 'look'), 'look offered');
let snap = await agent.snapshot(sid);
const card = snap.items.find((i) => i.type === 'tool' && i.name === 'look');
assert.equal(card.status, 'done');
assert.equal(card.images?.length, 1, 'the transcript item keeps what was sent, for thumbnails');
ok('image-capable Sealed model: tool text, then a user message with the data: URL image');

const sid2 = await agent.createSession('text');
await agent.send(sid2, 'look at the chart', [], undefined, 'text');
const t2 = bodies.at(-1);
assert.equal(imagesIn(t2).length, 0, 'no image in any message');
assert.ok(t2.messages.find((m) => m.role === 'tool').content.includes(LOOK_REFUSAL));
snap = await agent.snapshot(sid2);
assert.equal(snap.items.find((i) => i.type === 'tool' && i.name === 'look').status, 'error');
ok('text-only model: the call fails with the plain refusal; no image in the request');

// A history with an image, then a switch to a text-only model: pi-ai replaces the
// image with a placeholder rather than sending it.
await agent.send(sid, 'and now?', [], undefined, 'text');
assert.equal(imagesIn(bodies.at(-1)).length, 0);
assert.match(JSON.stringify(bodies.at(-1).messages), /omitted: model does not support images/);
ok('switching an image session to a text-only model drops the image with a visible placeholder');

// Subagents get look too, judged by their own model.
const sid3 = await agent.createSession('eyes');
const n0 = bodies.length;
await agent.send(sid3, 'spawn a looker', [], undefined, 'eyes');
for (let i = 0; i < 100 && !reports.length; i++) await new Promise((r) => setTimeout(r, 30));
const childBodies = bodies.slice(n0).filter((b) => /You are a subagent named/.test(JSON.stringify(b.messages[0])));
assert.ok(childBodies[0]?.tools.some((t) => t.function.name === 'look'), 'subagent offered look');
assert.equal(imagesIn(childBodies[1] ?? { messages: [] }).length, 1, 'the subagent\'s next request carries the image');
ok('a subagent on an image-capable model looks too');

console.log(`${pass} passed`);
process.exit(0);
