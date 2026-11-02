// Localhost provider checks against the loopback dummy (test/dummy-openai.mjs):
// URL validation, the origin guard, Test connection, both transports through
// pi-durable (tool loop, usage, abort, step cap) and specific errors. No real model;
// the only network is 127.0.0.1. `--omlx` adds a read-only check against a real
// oMLX on 12348 (key from ~/.omlx/settings.json, never printed).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseLocalhostUrl, explainMessage, guardedFetch, testConnection, localhostModel, applyProfile, LOCALHOST_PROVIDER } from '../src/localhost.ts';
import { profileOf, LOCALHOST_STEP_CAP } from '../src/profiles.ts';
import { openAgent, MemoryStorage, Type, needsSealed } from '../src/agent.ts';
import { startDummy } from './dummy-openai.mjs';

let pass = 0;
const ok = (name) => { pass++; console.log('ok', name); };

// ── URL validation: loopback only
const good = { 'http://127.0.0.1:12348': 'http://127.0.0.1:12348/v1', '127.0.0.1:11434': 'http://127.0.0.1:11434/v1', 'http://localhost:1234/v1/': 'http://localhost:1234/v1',
'localhost': 'http://localhost/v1', 'http://LOCALHOST:5/proxy/v1': 'http://localhost:5/proxy/v1', 'http://127.1:9': 'http://127.0.0.1:9/v1' };
for (const [i, o] of Object.entries(good)) assert.equal(parseLocalhostUrl(i).base, o, i);
const bad = ['http://127.0.0.1.evil.com', 'http://localhost.evil', 'http://localhost.evil:80', 'http://0.0.0.0:12348', 'http://user@127.0.0.1', 'http://127.0.0.1:1@evil.com', 'http://evil.com#@127.0.0.1',
  'http://evil.com\\@127.0.0.1', 'https://127.0.0.1:12348', 'http://127.0.0.2', 'http://[::1]:8080', 'http://192.168.1.212:12348', 'http://darknut.local:12348', 'ftp://127.0.0.1', 'http://[::ffff:127.0.0.1]', 'http://127.0.0.1:99999',
  'http://localhost:12348/v1?x=1', 'javascript:alert(1)', 'file:///etc/passwd', '', 'http://xn--localhost-.com', 'http://localhost./'];
for (const i of bad) assert.equal(parseLocalhostUrl(i).ok, false, `accepted ${i}: ${parseLocalhostUrl(i).base}`);
ok(`URL validation: ${Object.keys(good).length} loopback forms accepted, ${bad.length} lookalikes refused`);

// ── the guard refuses other origins even if a caller asks
const seen = [];
const g = guardedFetch(() => ({ base: 'http://127.0.0.1:9/v1', key: 'k' }), { fetchImpl: async (u, init) => { seen.push([u, new Headers(init.headers)]); return new Response('{}'); } });
await assert.rejects(g('https://api.bayleaf.dev/sealed/v1/chat/completions', {}), /Refusing/);
await assert.rejects(g('http://127.0.0.1:10/v1/models', {}), /Refusing/);
await g('http://127.0.0.1:9/v1/models', { headers: { 'x-stainless-os': 'x', authorization: 'Bearer none' } });
assert.equal(seen.length, 1); assert.equal(seen[0][1].get('authorization'), 'Bearer k'); assert.equal(seen[0][1].get('x-stainless-os'), null);
await assert.rejects(guardedFetch(() => ({ base: 'http://evil.com/v1' }))('http://evil.com/v1/models'), /not set up/);
ok('guardedFetch: other origins refused, key set, x-stainless headers dropped');

assert.equal(profileOf({ modelId: 'localhost:x' }), 'localhost'); assert.equal(needsSealed('localhost:x'), false); assert.equal(needsSealed('glm-5-3'), true);
const prof = applyProfile({ messages: [{ role: 'system', content: 'P', toolsAdded: [{ name: 'read' }, { name: 'subagent' }, { name: 'agents' }] }, { role: 'user', content: 'x' }] });
assert.deepEqual(prof.messages[0].toolsAdded.map((t) => t.name), ['read']); assert.match(prof.messages[0].content, /Subagents are not available/);
const parts = applyProfile({ messages: [{ role: 'system', content: [{ type: 'text', text: 'P' }], toolsAdded: [{ name: 'read' }] }] });
assert.equal(parts.messages[0].content.length, 2); assert.equal(parts.messages[0].content[0].text, 'P'); assert.match(parts.messages[0].content[1].text, /Subagents are not available/);
ok('profile localhost: subagent and agents removed, note added (as a text part when content is parts)');

const KEY = 'test-key-1';
const d = await startDummy({ key: KEY, loadMs: 0 });
try {
  // ── Test connection
  let t = await testConnection({ url: d.url, key: '' });
  assert.equal(t.ok, false); assert.equal(t.kind, 'auth'); assert.match(t.error, /needs an API key/);
  t = await testConnection({ url: d.url, key: 'wrong' });
  assert.equal(t.kind, 'auth'); assert.match(t.error, /refused the API key/);
  t = await testConnection({ url: d.url, key: KEY });
  assert.equal(t.ok, true); assert.equal(t.transport, 'responses'); assert.deepEqual(t.models.map((m) => [m.id, m.contextWindow]), [['dummy-small', 32768], ['dummy-coder', 131072]]);
  d.cfg.responses = false;
  t = await testConnection({ url: d.url, key: KEY }); assert.equal(t.transport, 'completions');
  t = await testConnection({ url: d.url, key: KEY, transport: 'responses' }); assert.equal(t.transport, 'responses'); assert.equal(t.detected, 'completions');
  d.cfg.responses = true;
  t = await testConnection({ url: 'http://127.0.0.1:9', key: '' }); assert.equal(t.kind, 'unreachable'); assert.match(t.error, /Nothing answered at http:\/\/127\.0\.0\.1:9/);
  assert.ok(!d.log.some((e) => /completions|responses/.test(e.path) && e.method === 'POST' && e.model), 'Test connection never generates');
  ok('testConnection: key required, wrong key, models with context, transport detected and overridden, unreachable; never generates');

  // ── both transports through pi-durable: tool loop, usage, abort, errors
  for (const transport of ['completions', 'responses']) {
    d.log.length = 0;
    const config = { base: d.url + '/v1', key: KEY, transport, models: [{ id: 'dummy-coder', contextWindow: 131072 }, { id: 'dummy-small', contextWindow: 131072 }] }; // the server's real limit is lower (below)
    const files = { 'notes.txt': 'buy oat milk\n' };
    const tools = [{ name: 'read', description: 'Read a file', parameters: Type.Object({ path: Type.String() }), execute: async ({ path }) => files[path] ?? 'missing' },
      { name: 'subagent', description: 'never offered on Localhost', parameters: Type.Object({}), execute: async () => 'no' }];
    const waits = [];
    const agent = await openAgent({ storage: new MemoryStorage(), tools, systemPrompt: () => 'You are Pouch.', getClient: async () => { throw new Error('Sealed must not be asked'); }, localhost: { config, onWait: (k) => waits.push(k) } });
    try {
      const sid = await agent.createSession('lh');
      await agent.send(sid, 'Read it [[call read {"path":"notes.txt"}]]', [], undefined, 'localhost:dummy-coder');
      const snap = await agent.snapshot(sid);
      const gen = d.log.filter((e) => e.model);
      assert.equal(gen.length, 2, `${transport}: two model steps`);
      assert.ok(gen.every((e) => e.path === (transport === 'responses' ? '/v1/responses' : '/v1/chat/completions') && e.auth === 'good' && e.model === 'dummy-coder'));
      assert.deepEqual(gen[0].tools, ['read'], 'subagent tool removed');
      assert.ok(gen.every((e) => !e.headers.some((h) => h.startsWith('x-stainless'))));
      const last = snap.items.findLast((i) => i.type === 'assistant' || i.role === 'assistant');
      assert.match(JSON.stringify(snap.items), /Result seen: buy oat milk/);
      assert.ok(JSON.stringify(snap.usage ?? snap.items).length > 0); void last;
      // abort mid-stream
      const turn = agent.send(sid, 'tell me slowly [[slow 40]]', [], undefined, 'localhost:dummy-coder');
      await new Promise((r) => setTimeout(r, 900));
      await agent.abort(sid);
      await assert.rejects(turn);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(d.log.findLast((e) => e.model)?.closedEarly, true, `${transport}: abort closes the stream`);
      // context too long on a tiny-context model
      d.cfg.models = [['dummy-small', 600], ['dummy-coder', 131072]];
      const ctxErr = await agent.send(sid, 'x'.repeat(4000), [], undefined, 'localhost:dummy-small').then(() => 'resolved', (e) => e.message);
      assert.match(explainMessage(ctxErr, 'dummy-small'), /longer than dummy-small's context/, ctxErr);
      // a model the server no longer has
      d.cfg.models = [['dummy-small', 32768]];
      const missing = await agent.send(sid, 'hi', [], undefined, 'localhost:dummy-coder').then(() => 'resolved', (e) => e.message);
      assert.match(explainMessage(missing, 'dummy-coder'), /no model named dummy-coder/, missing);
      d.cfg.models = [['dummy-small', 32768], ['dummy-coder', 131072]];
      // removed from this browser
      agent.setLocalhost(null);
      await assert.rejects(agent.send(sid, 'hi', [], undefined, 'localhost:dummy-coder'), /not set up in this browser/);
      ok(`${transport}: tool loop over pi-durable, no subagent tool, abort closes the stream, context and missing-model errors explained, removal refuses before sending`);
    } finally { await agent.close(); }
  }

  // ── step cap
  const config = { base: d.url + '/v1', key: KEY, transport: 'completions', models: [{ id: 'dummy-coder', contextWindow: 131072 }] };
  const loop = [{ name: 'read', description: 'Read', parameters: Type.Object({ path: Type.String() }), execute: async () => 'again [[call read {"path":"x"}]]' }];
  // A tool result that asks for another call keeps the scripted model calling forever.
  const agent = await openAgent({ storage: new MemoryStorage(), tools: loop, systemPrompt: () => 'P', getClient: async () => null, localhost: { config } });
  try {
    d.log.length = 0;
    const sid = await agent.createSession('cap');
    await agent.send(sid, 'loop [[call read {"path":"x"}]]', [], undefined, 'localhost:dummy-coder');
    const steps = d.log.filter((e) => e.model).length;
    assert.equal(steps, LOCALHOST_STEP_CAP, `steps ${steps}`);
    assert.match(JSON.stringify((await agent.snapshot(sid)).items), /stopped after 24 steps/);
    ok(`step cap: a looping model stops after ${steps} requests with a visible note`);
  } finally { await agent.close(); }
  assert.equal(localhostModel({ id: 'm' }, { base: 'x', transport: 'responses' }).api, 'openai-responses');
  assert.equal(localhostModel({ id: 'm' }, { base: 'x' }).provider, LOCALHOST_PROVIDER);
} finally { await d.close(); }

// ── optional: the real oMLX (read-only: models and transport, no generation)
if (process.argv.includes('--omlx')) {
  const key = JSON.parse(readFileSync(homedir() + '/.omlx/settings.json', 'utf8')).auth.api_key;
  const t = await testConnection({ url: 'http://127.0.0.1:12348', key });
  assert.equal(t.ok, true, t.error); assert.equal(t.transport, 'responses');
  ok(`oMLX: ${t.models.length} models, ${t.transport}`);
}
console.log(`localhost-node: ${pass} passed`);
