// Offline provider-boundary checks: zero real inference and no network.
import assert from 'node:assert/strict';
import { openAgent, MemoryStorage, Type } from '../src/agent.js';
import { attachmentContext, rasterMime } from '../src/attachments.js';
globalThis.fetch = () => { throw new Error('Unexpected network'); };
const requests = [];
const chunk = (delta, finish = null) => ({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'old', choices: [{ index: 0, delta, finish_reason: finish }] });
const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
let release, started;
const atTool = new Promise((r) => { started = r; });
const barrier = new Promise((r) => { release = r; });
const client = {
  getVerificationDocument: async () => ({ securityVerified: true }), openAIOptions: { apiKey: 'offline' },
  secureClient: { fetch: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (requests.length === 1) return sse([chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'wait', arguments: '{}' } }] }), chunk({}, 'tool_calls')]);
    return sse([chunk({ role: 'assistant', content: 'Offline answer' }), chunk({}, 'stop')]);
  } },
};
const agent = await openAgent({ storage: new MemoryStorage(), getClient: async () => client,
  models: [{ id: 'old' }, { id: 'new', multimodal: true }],
  tools: [{ name: 'wait', description: 'Wait', parameters: Type.Object({}), execute: async () => { started(); await barrier; return 'done'; } }],
});
try {
  const sid = await agent.createSession('old');
  let pending = 'old';
  const turn = agent.send(sid, 'First turn', [], undefined, pending);
  await atTool; pending = 'new'; // picker changes only pending choice, not conversation config
  release(); await turn;
  assert.deepEqual(requests.map((r) => r.model), ['old', 'old']);
  const file = { path: '/work/.attachments/unique-notes.txt', name: 'notes.txt', size: 5, type: 'text/plain' };
  await agent.send(sid, 'Second turn', [], { files: [file], images: [] }, pending);
  assert.equal(requests.at(-1).model, 'new');
  assert.match(JSON.stringify(requests.at(-1).messages), /unique-notes.txt/);
  const snap = await agent.snapshot(sid);
  assert.equal(snap.items.filter((i) => i.type === 'user').at(-1).text, 'Second turn');
  assert.deepEqual(snap.items.filter((i) => i.type === 'user').at(-1).attachments, [file]);
  // pi-ai serializes image blocks at the encrypting fetch seam, and durable storage keeps them.
  const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
  const n = requests.length;
  await assert.rejects(agent.send(sid, 'image', [], { files: [file], images: [image] }, 'old'), /image-capable/);
  assert.equal(requests.length, n);
  await agent.send(sid, 'image', [], { files: [file], images: [image] }, 'new');
  const last = requests.at(-1).messages.at(-1);
  assert.ok(last.content.some((b) => b.type === 'image_url' && b.image_url.url === 'data:image/png;base64,' + image.data));
  await agent.send(sid, 'recall', [], undefined, 'new');
  assert.match(JSON.stringify(requests.at(-1).messages), /iVBORw0KGgo=/, 'image survives next request from durable history');
  assert.equal(rasterMime(new TextEncoder().encode('<svg onload="evil()"/>')), null);
  assert.match(attachmentContext([file]), /binary files are not text/);
  console.log('PASS next-turn models, in-flight tool rounds, attachment references, vision capability preflight, serialized + persisted image blocks, raster whitelist; 0 network requests');
} finally { await agent.close(); }
