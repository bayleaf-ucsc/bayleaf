import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createArrivalClient, browserArrival, referrerHostname } from './browser.mjs';
import { createServiceSender, deliver } from './common.mjs';
import { apiUserDeletion, apiSandboxDeletion, emitDeletion } from './deletions.mjs';
import { probeSummary, emitProbe, PHASES, EVENTS } from './probes.mjs';
import { run, apiRetention, sandboxReaper, browserProbe } from './fixtures.mjs';

test('browser arrival projects only destination and sanitized hostname', () => {
  assert.deepEqual(browserArrival({ destination: 'chat', referrer: 'https://EXAMPLE.org:8443/private/person?q=secret#token',
    path: '/c/private-chat-id', user: 'someone' }),
  { schema_version: 1, destination: 'chat', referring_hostname: 'example.org' });
  assert.equal(browserArrival({ destination: '/dashboard/someone' }), null);
  for (const value of ['', 'not a url', 'file:///private', 'https://user:secret@example.org',
    'http://127.0.0.1/x', 'http://[::1]/x', 'https://localhost/', 'https://x.internal/',
    'https://someone-private-nonce.bayleaf.dev/x', 'https://0123456789abcdef.example.org']) {
    assert.equal(referrerHostname(value), null, value);
  }
  assert.equal(referrerHostname('https://chat.bayleaf.dev/c/secret'), 'chat.bayleaf.dev');
});

test('browser client inert by default, once-only and fire-and-forget when opted in', async () => {
  let reads = 0, calls = 0, request;
  const readReferrer = () => { reads++; return 'https://example.org/private?secret'; };
  createArrivalClient({ readReferrer })();
  assert.equal(reads, 0);
  const arrival = createArrivalClient({ enabled: true, endpoint: 'https://collector.example/v1/browser',
    service_token: 'synthetic-collector-token-must-not-leak', headers: { Authorization: 'must-not-leak' },
    destination: 'sandbox', readReferrer, fetcher: async (url, init) => {
      calls++; request = init; assert.equal(url, 'https://collector.example/v1/browser'); return new Response(null, { status: 204 });
    } });
  assert.equal(arrival(), undefined); arrival();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(calls, 1);
  assert.equal(request.credentials, 'omit'); assert.equal(request.referrerPolicy, 'no-referrer');
  assert.equal(request.referrer, ''); assert.equal(request.redirect, 'manual');
  assert.deepEqual(Object.keys(request.headers), ['Content-Type']);
  assert(!request.body.includes('secret'));
});

test('delivery bounded with no retries even if transport ignores abort; every failure swallowed', async () => {
  let calls = 0, signal;
  const config = { enabled: true, endpoint: 'http://127.0.0.1/v1/browser', deadline_ms: 15,
    fetcher: (url, init) => { calls++; signal = init.signal; return new Promise(() => {}); } };
  assert.equal(await deliver({}, '/v1/browser', config), false);
  assert(signal.aborted); assert.equal(calls, 1);
  for (const endpoint of ['https://u:p@example.org/v1/browser', 'https://example.org/v1/browser?key=secret',
    'http://example.org/v1/browser', 'https://example.org/wrong']) {
    assert.equal(await deliver({}, '/v1/browser', { ...config, endpoint }), false);
  }
  assert.equal(calls, 1);
  assert.equal(await deliver({ large: 'x'.repeat(16384) }, '/v1/browser', config), false);
  assert.equal(await deliver({}, '/v1/browser', { ...config, fetcher: () => { throw Error('private'); } }), false);
  assert.equal(await deliver({}, '/v1/browser', { ...config, fetcher: async () => new Response('private', { status: 503 }) }), false);
  assert.equal(await deliver({}, '/v1/browser', { ...config, fetcher: async () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }) }), false);
});

test('service sender requires explicit source token and never accepts arbitrary headers', async () => {
  const payload = apiUserDeletion(apiRetention, run);
  const token = 'synthetic-only-collector-write-token';
  let calls = 0;
  const config = { enabled: true, source: 'api-retention', service_token: token,
    endpoint: 'https://collector.example/v1/deletions', headers: { Cookie: 'upstream-private' },
    fetcher: async (url, init) => {
      calls++; assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type']);
      assert(!url.includes(token)); assert(!init.body.includes(token));
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 202 });
    } };
  for (const service_token of [undefined, '', 'too-short', `${token}\n`, `${token} other`])
    assert.equal(await createServiceSender({ ...config, service_token })(payload), false);
  assert.equal(calls, 0);
  assert.equal(await createServiceSender(config)(payload), true);
  assert.equal(await createServiceSender(config)({ ...payload, source: 'sandbox-reaper' }), false);
  assert.equal(await deliver(payload, '/v1/deletions', config), false);
  assert.equal(calls, 1);
});

test('one outstanding fetch per service sender persists after deadline until underlying settlement', async () => {
  let calls = 0, finish, signal;
  const sender = createServiceSender({ enabled: true, source: 'probe',
    service_token: 'synthetic-only-probe-write-token', endpoint: 'https://collector.example/v1/probes', deadline_ms: 10,
    fetcher: (url, init) => { calls++; signal = init.signal; return new Promise(resolve => { finish = resolve; }); } });
  const payload = probeSummary(browserProbe, run);
  const pending = sender(payload);
  assert.equal(await sender(payload), false);
  assert.equal(await pending, false);
  assert(signal.aborted);
  for (let n = 0; n < 20; n++) assert.equal(await sender(payload), false);
  assert.equal(calls, 1);
  finish(new Response(null, { status: 202 }));
  await new Promise(resolve => setImmediate(resolve));
  const next = sender(payload);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  finish(new Response(null, { status: 202 }));
  assert.equal(await next, true);
});

test('ignored response-body cancellation also retains the service sender slot', async () => {
  let calls = 0, cancel;
  const sender = createServiceSender({ enabled: true, source: 'probe',
    service_token: 'synthetic-only-probe-write-token', endpoint: 'https://collector.example/v1/probes', deadline_ms: 10,
    fetcher: async () => { calls++; return { status: 202, body: { cancel: () => new Promise(resolve => { cancel = resolve; }) } }; } });
  const payload = probeSummary(browserProbe, run);
  assert.equal(await sender(payload), false);
  assert.equal(await sender(payload), false); assert.equal(calls, 1);
  cancel(); await new Promise(resolve => setImmediate(resolve));
});

test('API account retirements and provider outbox progress are different units', () => {
  const summary = apiUserDeletion({ ...apiRetention, email: 'must-not-survive', raw: 'secret' }, run);
  assert.equal(summary.source, 'api-retention'); assert.equal(summary.job, 'user-retention');
  assert.equal(summary.deleted, 2); assert.equal(summary.extensions.counts.outboxCompleted, 5);
  assert.equal(summary.extensions.counts.providerPending, 4);
  assert(!JSON.stringify(summary).includes('secret'));
  assert.equal(apiUserDeletion({ ...apiRetention, retired: true }, run), null);
  assert.equal(apiUserDeletion({ ...apiRetention, mode: 'dry-run' }, run), null);
  assert.equal(apiUserDeletion(apiRetention, { ...run, run_id: 'user@example.org' }), null);
  assert.equal(apiUserDeletion(apiRetention, { ...run, ended_at: '2026-02-30T00:00:00.000Z' }), null);
  assert.equal(apiUserDeletion(apiRetention, { ...run, ended_at: '2026-10-20T11:00:00.000Z' }), null);
});

test('sandbox reaper needs explicit mode; pending removal is not confirmed deletion', () => {
  const summary = apiSandboxDeletion(sandboxReaper, { ...run, outcome: 'partial' }, 'delete');
  assert.equal(summary.deleted, 1); assert.equal(summary.extensions.counts.pending, 1);
  assert.equal(apiSandboxDeletion(sandboxReaper, run), null);
  assert.equal(apiSandboxDeletion(sandboxReaper, run, 'dry-run'), null);
  assert.equal(apiSandboxDeletion({ ...sandboxReaper, dryRun: true, deleted: 0 },
    { ...run, outcome: 'disabled' }, 'disabled').outcome, 'skipped');
});

test('probe metrics-v2 preserves additive phases separately from cumulative offsets', () => {
  const summary = probeSummary({ ...structuredClone(browserProbe), chat_id: 'secret', diagnostics: 'private',
    metrics: { ...browserProbe.metrics, phases: { ...browserProbe.metrics.phases, 'user@example.org': 7 } } }, run);
  assert.equal(summary.duration_ms, 1000);
  assert.equal(summary.phases_ms.first_rendered, 300);
  assert.equal(summary.events_ms.first_rendered, 500);
  assert.equal(summary.extensions.accounted_ms, 900);
  assert.equal(summary.extensions.cleanup, 'confirmed');
  assert(!JSON.stringify(summary).includes('secret')); assert(!JSON.stringify(summary).includes('user@'));
  const failure = structuredClone(browserProbe);
  failure.result = 'browser_cleanup_failed'; failure.work_result = 'ok'; failure.cleanup = 'failed';
  failure.metrics.failed_phase = 'chat_cleanup';
  const failed = probeSummary(failure, { ...run, outcome: 'failed' });
  assert.equal(failed.outcome, 'failure'); assert.equal(failed.extensions.work_result, 'ok');
  assert.equal(failed.extensions.failed_phase, 'chat_cleanup');
  assert.equal(probeSummary(failure, run), null);
  assert.equal(probeSummary({ ...browserProbe, cleanup: 'failed' }, run), null);
  assert.equal(probeSummary({ ...browserProbe, close: 'failed' }, run), null);
  assert.equal(probeSummary({ ...browserProbe, result: 'raw-private-error' }, run), null);
  assert.equal(probeSummary({ ...browserProbe, metrics: { ...browserProbe.metrics, total: NaN } }, run), null);
});

test('catalog summary drops model lists and preserves only layer/result/timings', () => {
  const payload = probeSummary({ version: 2, layer: 'catalog', result: 'catalog_absence',
    missing: ['model-must-not-survive'], deprecated: ['another-model'],
    metrics: { unit: 'ms', total: 30, accounted: 25, unaccounted: 5, phases: { catalog_fetch: 25 }, events: {} } },
  { ...run, outcome: 'failed' });
  assert.equal(payload.layer, 'catalog'); assert(!JSON.stringify(payload).includes('model-must'));
});

test('safe emitters swallow invalid builders and hostile reports', async () => {
  assert.equal(await emitDeletion(() => { throw Error('private'); }, {}), false);
  const hostile = { get version() { throw Error('private'); } };
  assert.equal(await emitProbe(hostile, run, {}), false);
});

test('allowlists cover actual source literal phase and event names, not invented aliases', async () => {
  const source = await readFile(new URL('../../chat/probe/index.mjs', import.meta.url), 'utf8');
  for (const match of source.matchAll(/(?:timing\.(?:phase|begin)|step)\('([a-z_]+)'/g))
    assert(PHASES.includes(match[1]), `missing phase ${match[1]}`);
  for (const match of source.matchAll(/timing\.mark\('([a-z_]+)'/g))
    assert(EVENTS.includes(match[1]), `missing event ${match[1]}`);
});
