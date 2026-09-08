import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { checkStream, probe } from './index.mjs';

const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const choice = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const good = frame(choice({ content: 'BayLeaf is a campus service.' })) +
  frame(choice({}, 'stop')) + frame({ choices: [], usage: { total_tokens: 42 } }) + 'data: [DONE]\n\n';
const stream = text => new Response(text).body;

test('complete answer passes, including bytewise CRLF and unicode chunks', async () => {
  assert.equal(await checkStream(stream(good)), true);
  const bytes = new TextEncoder().encode(good.replace('campus', 'université').replaceAll('\n', '\r\n'));
  const body = new ReadableStream({ start(c) {
    for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
    c.close();
  } });
  assert.equal(await checkStream(body), true);
});

test('keepalives and metadata do not count as an answer', async () => {
  const text = ': keepalive\n\n' + frame({ status: 'thinking' }) +
    frame(choice({ reasoning_content: 'reasoning' }, 'stop')) + 'data: [DONE]\n\n';
  assert.equal(await checkStream(stream(text)), false);
});

test('OpenRouter may repeat stop in an empty-content usage chunk', async () => {
  const usage = { ...choice({ content: '', role: 'assistant' }, 'stop'), usage: { total_tokens: 42 } };
  const text = good.replace('data: [DONE]', frame(usage) + 'data: [DONE]');
  assert.equal(await checkStream(stream(text)), true);
  await assert.rejects(checkStream(stream(good.replace('data: [DONE]',
    frame(choice({ content: 'unexpected continuation' }, 'stop')) + 'data: [DONE]'))));
});

test('incomplete, empty, and reasoning-only streams fail', async () => {
  for (const text of [
    'data: [DONE]\n\n', good.replace('data: [DONE]\n\n', ''),
    good.trimEnd(), good.replace('BayLeaf is a campus service.', '  '),
    good.replace('BayLeaf is a campus service.', '<think>Only reasoning</think>'),
    good.replace('BayLeaf is a campus service.', '<think>Unclosed reasoning'),
  ]) assert.equal(await checkStream(stream(text)), false);
});

test('errors, tool calls, truncation, malformed frames and oversized input fail', async () => {
  for (const text of [
    frame({ error: { message: 'secret upstream error' } }),
    'event: error\ndata: {}\n\n', 'data: not-json\n\n',
    good.replace('"stop"', '"length"'),
    frame(choice({ tool_calls: [{ id: 'call' }] })),
    frame(choice({ function_call: { name: 'tool' } })),
    good + frame({ error: 'late error' }),
    'data: ' + 'x'.repeat(65537),
    ': ' + 'x'.repeat(1024 * 1024),
  ]) await assert.rejects(checkStream(stream(text)));
});

test('upstream request is fixed, non-persisting, and redirects are not followed', async () => {
  assert.equal(await probe('test-key', new AbortController().signal, async (url, options) => {
    assert.equal(url, 'https://chat.bayleaf.dev/api/chat/completions');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(options.body), {
      model: 'basic', messages: [{ role: 'user', content: "What's BayLeaf?" }], stream: true,
    });
    return new Response(good, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  }), true);
  for (const response of [new Response('oops', { status: 401 }),
    new Response('', { status: 302 }), new Response('{"task_ids":[]}')]) {
    assert.equal(await probe('test-key', null, async () => response), false);
  }
});

const env = {
  ENABLED: 'true', DEADLINE_MS: '1000', PROBE_PASSWORD: 'test-password', OWUI_API_KEY: 'test-key',
  LIMITER: { async limit() { return { success: true }; } },
};
const request = (method = 'GET', path = '/chat/basic', auth = true) => new Request(`https://probe.example${path}`, {
  method, headers: auth ? { Authorization: `Basic ${btoa('probe:test-password')}` } : {},
});

test('routing, authentication, disabled state and rate limit fail closed', async () => {
  for (const [req, bindings, status] of [
    [request('GET', '/', false), env, 404],
    [request('GET', '/chat/basic?prompt=other'), env, 404],
    [request('POST'), env, 405],
    [request('GET', '/chat/basic', false), env, 401],
    [request(), { ...env, ENABLED: 'false' }, 503],
    [request(), { ...env, OWUI_API_KEY: '' }, 503],
    [request(), { ...env, DEADLINE_MS: '0' }, 503],
    [request(), { ...env, LIMITER: { async limit() { return { success: false }; } } }, 429],
  ]) {
    const response = await worker.fetch(req, bindings);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('GET and HEAD withhold headers until completion; failures reveal no contents', async t => {
  for (const method of ['GET', 'HEAD']) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.mock.method(globalThis, 'fetch', async () => {
      await gate;
      return new Response(good, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    let settled = false;
    const pending = worker.fetch(request(method), env).then(r => { settled = true; return r; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(settled, false);
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'OK\n');
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret'); });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Chat probe failed\n');
});

test('deadline aborts upstream work', { timeout: 3000 }, async t => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  assert.equal((await worker.fetch(request(), env)).status, 503);
});

test('limiter rejection and stall are bounded failures', { timeout: 3000 }, async () => {
  for (const limit of [async () => { throw new Error('binding unavailable'); },
    () => new Promise(() => {})]) {
    const response = await worker.fetch(request(), { ...env, LIMITER: { limit } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('HEAD waits during streaming, not just for upstream headers', async t => {
  let streamController;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(c) {
      streamController = c;
      c.enqueue(new TextEncoder().encode(frame(choice({ content: 'BayLeaf' }))));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  let settled = false;
  const pending = worker.fetch(request('HEAD'), env).then(r => { settled = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(streamController);
  assert.equal(settled, false);
  streamController.enqueue(new TextEncoder().encode(frame(choice({}, 'stop')) + 'data: [DONE]\n\n'));
  streamController.close();
  assert.equal((await pending).status, 200);
});

test('deadline and client disconnect abort open streams', { timeout: 5000 }, async t => {
  for (const disconnect of [false, true]) {
    let upstreamAborted = false;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(frame(choice({ content: 'partial' }))));
        signal.addEventListener('abort', () => {
          upstreamAborted = true;
          c.error(new Error('aborted'));
        }, { once: true });
        started();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const client = new AbortController();
    const req = new Request(request('HEAD'), { signal: client.signal });
    const pending = worker.fetch(req, env);
    await ready;
    if (disconnect) client.abort();
    assert.equal((await pending).status, 503);
    assert.equal(upstreamAborted, true);
    t.mock.restoreAll();
  }
});

test('already-disconnected caller does not start inference', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected'); });
  const req = new Request(request(), { signal: AbortSignal.abort() });
  assert.equal((await worker.fetch(req, env)).status, 503);
  assert.equal(fetchMock.mock.callCount(), 0);
});
