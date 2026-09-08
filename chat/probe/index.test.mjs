import { test } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from '@cloudflare/puppeteer';
import worker, { checkStream, probe, probeDetail, probeBrowser, cleanupSynthetic, metrics,
  DIRECT_MODEL, renderedAnswer } from './index.mjs';

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

test('upstream failures have stable, content-free diagnostic codes', async () => {
  assert.equal(await probeDetail('test-key', null, async () => new Response('sensitive error', { status: 401 })),
    'chat_http_401');
  assert.equal(await probeDetail('test-key', null, async () => new Response('not SSE')),
    'chat_protocol');
  assert.equal(await probeDetail('test-key', null, async () => new Response('data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })), 'stream_incomplete');
  assert.equal(await probeDetail('test-key', null, async () => { throw new Error('sensitive error'); }),
    'chat_transport');
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

test('GET and HEAD withhold headers until completion; failures reveal only diagnostic codes', async t => {
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
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else assert.equal((await response.json()).result, 'ok');
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret'); });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-bayleaf-probe-result'), 'chat_transport');
  assert.equal((await response.json()).result, 'chat_transport');
});

test('deadline aborts upstream work', { timeout: 3000 }, async t => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-bayleaf-probe-result'), 'deadline');
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

test('browser routes authenticate and use independent admission before browser work', async () => {
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await worker.fetch(request(method, '/chat/basic/e2e', false), env)).status, 401);
    assert.equal((await worker.fetch(request(method, '/chat/basic/e2e'), {
      ...env, OWUI_E2E_TOKEN: 'ordinary-token', BROWSER: {}, LIMITER: { async limit({ key }) {
        assert.equal(key, 'browser');
        return { success: false };
      } },
    })).status, 429);
  }
  assert.equal((await worker.fetch(request('POST', '/chat/basic/e2e'), env)).status, 405);
  assert.equal((await worker.fetch(request('GET', '/chat/basic/e2e?model=other'), env)).status, 404);
});

const userId = '00000000-0000-4000-8000-000000000001';
test('browser deadline override is validated independently of HTTP deadline', async t => {
  const timer = t.mock.method(globalThis, 'setTimeout', () => 0);
  for (const [path, expected] of [['/chat/basic', 1000], ['/chat/basic/e2e', 55000]]) {
    const response = await worker.fetch(request('GET', path), {
      ...env, BROWSER_DEADLINE_MS: '55000', OWUI_E2E_TOKEN: 'token', BROWSER: {},
      LIMITER: { async limit() { return { success: false }; } },
    });
    assert.equal(response.status, 429);
    assert.equal(timer.mock.calls.at(-1).arguments[1], expected);
  }
  const invalid = await worker.fetch(request('GET', '/chat/basic/e2e'), {
    ...env, BROWSER_DEADLINE_MS: '55001', OWUI_E2E_TOKEN: 'token', BROWSER: {},
  });
  assert.equal(invalid.headers.get('x-bayleaf-probe-result'), 'not_configured');
});
const chatId = '00000000-0000-4000-8000-000000000002';
const marker = `bayleaf-probe-v1:${Date.now() - 700000}:${chatId}`;
const synthetic = tag => ({ id: chatId, user_id: userId, variables: { bayleaf_probe: tag }, chat: {
  title: 'Generated synthetic title', models: ['basic'], history: {
    currentId: 'answer', messages: {
      prompt: { role: 'user', content: "What's BayLeaf?" },
      answer: { id: 'answer', role: 'assistant', content: 'Synthetic answer', done: true },
    },
  },
} });

test('cleanup requires exact marker, owner, model and prompt; confirms deletion', async () => {
  for (const bad of ['owner', 'marker', 'model', 'prompt', 'delete', 'verify', null]) {
    let deleted = false;
    let deletes = 0;
    const fetcher = async (url, options) => {
      if (url.includes('/list?')) return Response.json(deleted ? [] : [{ id: chatId }]);
      if (options.method === 'DELETE') {
        deletes++;
        deleted = true;
        return Response.json(bad !== 'delete');
      }
      if (deleted && bad !== 'verify') return new Response(null, { status: 401 });
      const record = synthetic(marker);
      if (bad === 'owner') record.user_id = 'someone-else';
      if (bad === 'marker') record.variables.bayleaf_probe = 'unmarked';
      if (bad === 'model') record.chat.models = ['other'];
      if (bad === 'prompt') record.chat.history.messages.prompt.content = 'human';
      return Response.json(record);
    };
    const operation = cleanupSynthetic('token', userId, AbortSignal.timeout(1000), { marker, chatId, fetcher });
    if (bad) await assert.rejects(operation);
    else assert.equal(await operation, 1);
    if (['owner', 'marker', 'model', 'prompt'].includes(bad)) assert.equal(deletes, 0);
  }
});

test('cleanup ignores unrelated and fresh markers; lost creation cannot silently pass', async () => {
  for (const tag of ['unrelated', `bayleaf-probe-v1:${Date.now()}:${chatId}`]) {
    const fetcher = async (url, options) => {
      assert.equal(options.method, 'GET');
      return Response.json(url.includes('/list?') ? [{ id: chatId }] : synthetic(tag));
    };
    assert.equal(await cleanupSynthetic('token', userId, AbortSignal.timeout(1000), { fetcher }), 0);
    await assert.rejects(cleanupSynthetic('token', userId, AbortSignal.timeout(1000), {
      marker, attempted: true, fetcher,
    }));
  }
});

test('browser success, render timeout, lost creation reply, and cleanup/close failure', async t => {
  for (const mode of ['ok', 'render_timeout', 'lost_reply', 'delete_failure', 'close_failure', 'empty',
    'close_timeout', 'cleanup_timeout', 'missing_answer_id']) {
    let clock = 0, renders = 0;
    const timing = metrics(() => ++clock);
    const budgets = {};
    if (mode.endsWith('_timeout') && mode !== 'render_timeout') {
      t.mock.method(AbortSignal, 'timeout', ms => {
        const budget = new AbortController();
        budgets[ms] = budget;
        return budget.signal;
      });
    }
    let tag, created = false, deleted = false, closed = false;
    let onRender;
    const events = {};
    const controller = new AbortController();
    const page = {
      setDefaultTimeout() {}, on(name, callback) { events[name] = callback; },
      async evaluateOnNewDocument() {}, async setRequestInterception() {},
      async exposeFunction(_name, callback) { onRender = callback; },
      async goto() {}, async waitForSelector() {}, async focus() {},
      async $eval() { return true; },
      async click() {
        const request = {
          url: () => 'https://chat.bayleaf.dev/api/chat/completions', method: () => 'POST',
          postData: () => JSON.stringify({ model: 'basic', parent_id: null, session_id: 'socket',
            user_message: { content: "What's BayLeaf?" } }),
          async continue({ postData }) {
            created = true;
            tag = JSON.parse(postData).chat_variables.bayleaf_probe;
            if (mode !== 'lost_reply') events.response({
              request: () => request, status: () => 200, json: async () => ({ chat_id: chatId }),
            });
          },
          async abort() { assert.fail('unexpected abort'); },
        };
        events.request(request);
        onRender('sensitive-not-an-allowed-event');
        if (mode === 'ok') {
          onRender('first_rendered');
          onRender('complete_rendered');
        }
      },
      async waitForFunction() {
        if (mode === 'lost_reply' && ++renders === 2) setImmediate(() => controller.abort());
        if (mode === 'render_timeout') {
          controller.abort();
          return new Promise(() => {});
        }
      },
    };
    const driver = { async launch() { return {
      async createBrowserContext() { return { async newPage() { return page; } }; },
      target() { return { async createCDPSession() { return { async send() {
        closed = true;
        if (mode === 'close_failure') throw new Error('sensitive');
        if (mode === 'close_timeout') { budgets[5000].abort(); return new Promise(() => {}); }
      } }; } }; },
      async disconnect() {},
    }; } };
    const fetcher = async (url, options) => {
      if (url.endsWith('/auths/')) return Response.json({ id: userId, role: 'user' });
      if (url.includes('/list?')) return Response.json(created && !deleted ? [{ id: chatId }] : []);
      if (options.method === 'DELETE') {
        assert.ok(closed);
        assert.equal(options.signal.aborted, false);
        if (mode === 'delete_failure') return new Response(null, { status: 500 });
        if (mode === 'cleanup_timeout') { budgets[15000].abort(); return new Promise(() => {}); }
        deleted = true;
        return Response.json(true);
      }
      if (deleted) return new Response(null, { status: 401 });
      const record = synthetic(tag);
      if (mode === 'empty') record.chat.history.messages.answer.content = '';
      if (mode === 'missing_answer_id') delete record.chat.history.messages.answer.id;
      return Response.json(record);
    };
    const report = await probeBrowser('token', {}, controller.signal, { driver, fetcher, timing });
    assert.equal(report.result, {
      ok: 'ok', render_timeout: 'browser_deadline', lost_reply: 'browser_deadline',
      delete_failure: 'browser_cleanup_failed', close_failure: 'browser_close_failed', empty: 'browser_persisted',
      close_timeout: 'browser_close_failed', cleanup_timeout: 'browser_cleanup_failed',
      missing_answer_id: 'browser_persisted',
    }[mode]);
    assert.equal(report.cleanup, ['delete_failure', 'cleanup_timeout'].includes(mode) ? 'failed' : 'confirmed');
    assert.equal(deleted, !['delete_failure', 'cleanup_timeout'].includes(mode));
    const m = report.metrics;
    assert.equal(m.total, m.accounted + m.unaccounted);
    assert.ok(Object.values(m.phases).every(n => n >= 0));
    assert.ok(m.phases.browser_close > 0);
    assert.ok(m.phases.chat_cleanup > 0);
    assert.ok(m.events.creation_request <= m.events.send_returned);
    if (mode === 'ok') {
      assert.ok(m.events.first_rendered <= m.events.complete_rendered);
      assert.ok(m.events.complete_rendered <= m.events.send_returned);
      assert.ok(m.events.complete_rendered <= m.events.persistence_verified);
      assert.deepEqual(Object.keys(m.phases), ['identity', 'stale_cleanup', 'launch', 'context', 'page',
        'interception', 'setup', 'render_observer', 'navigation', 'composer', 'typed', 'submitted', 'first_rendered',
        'rendered', 'creation_response', 'persisted', 'render_validation', 'browser_close', 'chat_cleanup']);
    }
    if (mode === 'render_timeout') assert.equal(m.failed_phase, 'first_rendered');
    if (mode === 'lost_reply') assert.equal(m.failed_phase, 'creation_response');
    if (mode === 'delete_failure' || mode === 'close_failure') assert.equal(report.work_result, 'ok');
    assert.doesNotMatch(JSON.stringify(report), /sensitive|00000000-/);
    if (mode === 'ok') {
      t.mock.method(globalThis, 'fetch', fetcher);
      t.mock.method(puppeteer, 'launch', driver.launch);
      let getHeaders;
      for (const method of ['GET', 'HEAD']) {
        created = deleted = closed = false;
        const response = await worker.fetch(request(method, '/chat/basic/e2e'), {
          ...env, OWUI_E2E_TOKEN: 'token', BROWSER: {},
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-bayleaf-probe-cleanup'), 'confirmed');
        assert.equal(response.headers.get('x-bayleaf-probe-close'), 'confirmed');
        assert.ok(closed && deleted);
        if (method === 'GET') {
          getHeaders = [...response.headers.keys()];
          const text = await response.text();
          assert.doesNotMatch(text, /Synthetic answer|00000000-|sensitive/);
          assert.equal(JSON.parse(text).layer, 'browser');
        } else {
          assert.deepEqual([...response.headers.keys()], getHeaders);
          assert.equal(await response.text(), '');
        }
      }
    }
    t.mock.restoreAll();
  }
});

test('browser rejects admin identity and refuses an oversized cleanup scan before launch', async () => {
  for (const admin of [true, false]) {
    const report = await probeBrowser('token', {}, AbortSignal.timeout(1000), {
      driver: { async launch() { assert.fail('must not launch'); } },
      fetcher: async url => Response.json(url.endsWith('/auths/')
        ? { id: userId, role: admin ? 'admin' : 'user' }
        : Array.from({ length: 6 }, () => ({ id: chatId }))),
    });
    assert.equal(report.result, admin ? 'browser_identity' : 'browser_stale_cleanup');
    assert.equal(report.close, 'not_started');
  }
});

test('late browser launch after cancellation closes without opening a page', async () => {
  const controller = new AbortController();
  let release, closing;
  const launched = new Promise(resolve => { release = resolve; });
  const closed = new Promise(resolve => { closing = resolve; });
  const pending = probeBrowser('token', {}, controller.signal, {
    fetcher: async url => Response.json(url.endsWith('/auths/') ? { id: userId, role: 'user' } : []),
    driver: { async launch() { controller.abort(); return launched; } },
  });
  const report = await pending;
  assert.equal(report.stage, 'launch');
  assert.equal(report.result, 'browser_close_failed');
  assert.equal(report.close, 'unconfirmed');
  release({
    async newPage() { assert.fail('must not open a late page'); },
    target() { return { async createCDPSession() { return { async send() {} }; } }; },
    async disconnect() { closing(); },
  });
  await closed;
});

test('both HTTP layers share exact additive timings with delayed chunks and distinct SSE markers', async () => {
  for (const direct of [false, true]) {
    let clock = 0;
    const timing = metrics(() => clock);
    const chunks = [
      [3, ': keepalive\n\n'], [11, frame(choice({ reasoning_content: 'private reasoning' }))],
      [5, frame(choice({ content: '<thi' }))], [2, frame(choice({ content: 'nk>reasoning</think>' }))],
      [13, frame(choice({ content: 'BayLeaf' }))], [17, frame(choice({}, 'stop'))],
      [19, 'data: [DONE]\n\n'], [23, null],
    ];
    const result = await probeDetail('inference-key', new AbortController().signal, async (url, options) => {
      assert.equal(url, direct ? 'https://openrouter.ai/api/v1/chat/completions'
        : 'https://chat.bayleaf.dev/api/chat/completions');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, 'Bearer inference-key');
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload, { model: direct ? DIRECT_MODEL : 'basic', stream: true,
        messages: [{ role: 'user', content: "What's BayLeaf?" }],
        ...(direct ? { provider: { zdr: true, sort: 'throughput' }, reasoning: { effort: 'low' }, max_tokens: 2048 } : {}),
      });
      clock += 7;
      return new Response(new ReadableStream({ pull(c) {
        const [delay, text] = chunks.shift();
        clock += delay;
        if (text === null) c.close();
        else c.enqueue(new TextEncoder().encode(text));
      } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } });
    }, { direct, timing });
    assert.equal(result, 'ok');
    const m = timing.snapshot();
    assert.deepEqual(m.events, { request_start: 0, response_headers: 7, first_byte: 10,
      first_answer: 41, stop: 58, done: 77, eof: 100 });
    assert.deepEqual(m.phases, { response_headers: 7, header_validation: 0, await_first_byte: 3, await_answer: 31,
      answer_stream: 17, stop_to_done: 19, done_to_eof: 23, validation: 0, stream_cleanup: 0 });
    assert.equal(m.total, 100);
    assert.equal(m.accounted, 100);
    assert.equal(m.unaccounted, 0);
    assert.doesNotMatch(JSON.stringify(m), /private|reasoning|BayLeaf|inference-key/);
  }
});

test('direct model tracks the checked-in Basic base model', async () => {
  const { readFile } = await import('node:fs/promises');
  const basic = JSON.parse(await readFile(new URL('../models/basic/model.json', import.meta.url), 'utf8'));
  assert.equal(`openrouter.${DIRECT_MODEL}`, basic.base_model_id);
});

test('partial SSE frames and split reasoning tags cannot advance first answer', async () => {
  let clock = 0;
  const timing = metrics(() => clock);
  const pieces = [frame(choice({ content: '<' })), frame(choice({ content: 'think>secret' })),
    frame(choice({ content: '</think>' })), 'data: {"choices":[{"index":0,"delta":{"content":"real"}}]}',
    '\n\n', frame(choice({}, 'stop')), 'data: [DONE]\n\n'];
  const body = new ReadableStream({ pull(c) {
    clock += 10;
    if (pieces.length) c.enqueue(new TextEncoder().encode(pieces.shift()));
    else c.close();
  } }, { highWaterMark: 0 });
  assert.equal(await checkStream(body, { timing }), true);
  assert.equal(timing.snapshot().events.first_answer, 50);
});

test('failed stream stages retain elapsed time and cancellation uses its own budget', async () => {
  let clock = 0, cancelled = false;
  const timing = metrics(() => clock);
  const controller = new AbortController();
  const body = new ReadableStream({ pull() { clock = 20; controller.abort(); }, cancel() {
    cancelled = true;
    clock += 7;
  } }, { highWaterMark: 0 });
  await assert.rejects(checkStream(body, { timing, signal: controller.signal }));
  const m = timing.snapshot();
  assert.equal(cancelled, true);
  assert.equal(m.failed_phase, 'await_first_byte');
  assert.deepEqual(m.phases, { await_first_byte: 20, stream_cleanup: 7 });
  assert.deepEqual(m.events, {});
  assert.equal(m.total, 27);
});

test('authenticated gates expose bounded metrics, unauthenticated gates expose none, and no inference runs', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => assert.fail('no call'));
  for (const method of ['GET', 'HEAD']) {
    for (const [bindings, status, result] of [
      [{ ...env, ENABLED: 'false' }, 503, 'disabled'],
      [env, 503, 'not_configured'],
      [{ ...env, OPENROUTER_API_KEY: 'key', OWUI_API_KEY: '', LIMITER: {
        async limit({ key }) { assert.equal(key, 'openrouter'); return { success: false }; },
      } }, 429, 'rate_limited'],
    ]) {
      const response = await worker.fetch(request(method, '/openrouter/basic'), bindings);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('x-bayleaf-probe-result'), result);
      assert.match(response.headers.get('server-timing'), /p_authentication;dur=/);
      if (method === 'GET') assert.equal((await response.json()).result, result);
      else assert.equal(await response.text(), '');
    }
    const response = await worker.fetch(request(method, '/openrouter/basic', false), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('server-timing'), null);
    assert.equal(response.headers.get('x-bayleaf-probe-events'), null);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('GET/HEAD metric headers match on both HTTP routes and never return payloads', async t => {
  t.mock.method(performance, 'now', () => 0);
  const calls = t.mock.method(globalThis, 'fetch', async () => new Response(good,
    { headers: { 'Content-Type': 'text/event-stream' } }));
  for (const path of ['/chat/basic', '/openrouter/basic']) {
    const bindings = { ...env, OPENROUTER_API_KEY: 'direct-secret' };
    const get = await worker.fetch(request('GET', path), bindings);
    const head = await worker.fetch(request('HEAD', path), bindings);
    assert.deepEqual([...head.headers], [...get.headers]);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const text = await get.text();
    assert.doesNotMatch(text, /campus service|direct-secret|test-key|messages|choices|Bearer/);
    assert.equal(JSON.parse(text).version, 2);
    assert.ok(get.headers.get('server-timing').length < 4096);
    assert.ok(get.headers.get('x-bayleaf-probe-events').length < 2048);
  }
  assert.equal(calls.mock.callCount(), 4);
});

test('HEAD withholds failure headers until response body cleanup finishes', async t => {
  let release, cleaning;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { cleaning = resolve; });
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cleaning(); return gate; },
  }), { status: 403 }));
  let settled = false;
  const pending = worker.fetch(request('HEAD', '/openrouter/basic'), { ...env, OPENROUTER_API_KEY: 'key' })
    .then(response => { settled = true; return response; });
  await ready;
  assert.equal(settled, false);
  release();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-bayleaf-probe-result'), 'openrouter_http_403');
  assert.match(response.headers.get('server-timing'), /p_stream_cleanup;dur=/);
});

test('stalled stream cancellation is bounded without losing the original failed phase', async t => {
  let clock = 0, cleanupBudget;
  const timing = metrics(() => clock);
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 1000);
    cleanupBudget = new AbortController();
    return cleanupBudget.signal;
  });
  const body = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('event: error\ndata: {}\n\n')); },
    cancel() { clock += 1000; cleanupBudget.abort(); return new Promise(() => {}); },
  });
  await assert.rejects(checkStream(body, { timing }));
  const m = timing.snapshot();
  assert.equal(m.failed_phase, 'await_answer');
  assert.equal(m.phases.stream_cleanup, 1000);
  assert.equal(m.total, 1000);
  assert.equal(body.locked, false);
});

test('render predicate and serialized observer exclude reasoning and require completed-message control', async () => {
  // Execute the actual serialized predicate against a minimal DOM contract.
  const original = Object.fromEntries(['document', 'NodeFilter', 'getComputedStyle'].map(k => [k, globalThis[k]]));
  let complete = false;
  let nodes = [];
  const content = { getClientRects: () => [1] };
  const message = { querySelector: selector => selector === '#response-content-container' ? content : complete };
  content.closest = () => message;
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.document = {
    getElementById: () => message, querySelector: () => content,
    createTreeWalker: () => { let i = 0; return { currentNode: null,
      nextNode() { this.currentNode = nodes[i++]; return !!this.currentNode; } }; },
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [1] }),
  };
  try {
    nodes = [{ textContent: 'Thinking...', parentElement: { closest: () => true } }];
    assert.equal(renderedAnswer(), false);
    nodes.push({ textContent: 'Actual answer', parentElement: { closest: () => false } });
    assert.equal(renderedAnswer(), true);
    assert.equal(renderedAnswer(true), false);
    complete = true;
    assert.equal(renderedAnswer(true, 'same-persisted-message'), true);
    const { runInNewContext } = await import('node:vm');
    let notify, disconnected = false;
    const reported = [];
    runInNewContext(`(${renderedAnswer.toString()})(false, null, true)`, {
      document, NodeFilter, getComputedStyle,
      location: { origin: 'https://chat.bayleaf.dev' },
      window: { async __bayleafProbeEvent(name) { reported.push(name); } },
      MutationObserver: class {
        constructor(callback) { notify = callback; }
        observe() {}
        disconnect() { disconnected = true; }
      },
    });
    nodes.pop();
    complete = false;
    notify();
    assert.deepEqual(reported, []);
    nodes.push({ textContent: 'Actual answer', parentElement: { closest: () => false } });
    notify();
    assert.deepEqual(reported, ['first_rendered']);
    complete = true;
    notify();
    notify();
    assert.deepEqual(reported, ['first_rendered', 'complete_rendered']);
    assert.equal(disconnected, true);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
