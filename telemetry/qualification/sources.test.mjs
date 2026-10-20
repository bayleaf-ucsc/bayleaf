// Cross-agent contract proof, fully offline. Uses collector validation directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { database } from '../test/d1.js';
import { createWorker } from '../src/worker.js';
import { createServiceSender } from '../adapters/common.mjs';
import { createArrivalClient } from '../adapters/browser.mjs';
import { validate } from '../src/validate.js';
import { PHASES as CORE_PHASES, EVENTS as CORE_EVENTS, POLICY_VERSION } from '../src/policies.js';
import { browserArrival } from '../adapters/browser.mjs';
import { apiUserDeletion, apiSandboxDeletion } from '../adapters/deletions.mjs';
import { probeSummary, PHASES, EVENTS, BROWSER_PHASES } from '../adapters/probes.mjs';
import { run, apiRetention, sandboxReaper, browserProbe } from '../adapters/fixtures.mjs';

const now = Date.parse(run.ended_at) + 1000;
const env = { RETENTION_DAYS: '7' };

test('browser adapter accepted by collector without timestamp or identity', () => {
  const input = browserArrival({ destination: 'sandbox', referrer: 'https://example.org/private?secret#fragment' });
  const record = validate('browser', input, env, now);
  assert.equal(record.referring_hostname, 'example.org');
  assert.equal(record.observed_at, now);
  assert.equal(record.policy_version, POLICY_VERSION);
  assert(!('batch_id' in record));
});

test('actual API aggregate report adapters round-trip collector validation', () => {
  for (const payload of [apiUserDeletion(apiRetention, run),
    apiSandboxDeletion(sandboxReaper, { ...run, outcome: 'partial' }, 'delete')]) {
    const normalized = validate('deletions', payload, env, now);
    assert.deepEqual(normalized.extensions, payload.extensions);
    assert.equal(normalized.deleted, payload.deleted);
    assert.equal(normalized.batch_id, run.run_id);
  }
});

test('metrics-v2 names and failure/cleanup distinctions survive collector', () => {
  assert(PHASES.every(name => CORE_PHASES.includes(name)));
  assert(EVENTS.every(name => CORE_EVENTS.includes(name)));
  const record = validate('probes', probeSummary(browserProbe, run), env, now);
  assert.equal(record.events_ms.first_rendered, 500);
  assert.equal(record.phases_ms.first_rendered, 300);
  assert.equal(record.extensions.close, 'confirmed');
  assert.equal(record.extensions.accounted_ms, 900);
  const codes = ['disabled', 'not_configured', 'rate_limited', 'deadline', 'client_aborted', 'probe_internal',
    'browser_cleanup_failed', 'browser_client_aborted', ...BROWSER_PHASES.map(x => `browser_${x}`),
    'chat_http_401', 'api_http_429', 'sealed_attestation_verify', 'catalog_absence'];
  for (const result of codes) {
    const payload = probeSummary({ ...browserProbe, result, metrics: { ...browserProbe.metrics, failed_phase: 'gates' } },
      { ...run, outcome: result === 'disabled' ? 'disabled' : 'failed' });
    assert(payload, result);
    assert.equal(validate('probes', payload, env, now).extensions.result, result);
  }
});

test('Python typed Chat accumulator emits collector deletion contract', () => {
  const script = `
import json, sys
sys.path.insert(0, 'telemetry/adapters')
from chat_retention import ChatRetentionCounts, RetentionPolicy, Run, chat_retention_summary
c = ChatRetentionCounts(users_total=10, users_held=1, chats_scanned=7, chats_expired=2,
  chats_deleted=2, users_impacted=1, files_total=3, files_orphan=1, files_deleted=1,
  users_expired=2, users_recheck_skipped=1, users_deleted=1)
r = Run('${run.run_id}', '${run.started_at}', '${run.ended_at}', 'ok')
print(json.dumps(chat_retention_summary(c, r, 'delete', RetentionPolicy(90, 86400, 18))))
`;
  const result = spawnSync('python3', ['-B', '-c', script], { cwd: new URL('../..', import.meta.url), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const record = validate('deletions', JSON.parse(result.stdout), env, now);
  assert.equal(record.deleted, 4);
  assert.equal(record.extensions.counts.users_deleted, 1);
  assert.equal(record.extensions.mode, 'delete');
  assert.equal(record.extensions.retention_days, 90);
});

function collector(t) {
  const db = database(); t.after(() => db.close());
  const keys = Object.fromEntries(['probe', 'api-retention', 'chat-retention', 'sandbox-reaper']
    .map(source => [source, `synthetic-only-collector-write-token-${source}`]));
  const env = { TELEMETRY_ENABLED: 'true', BROWSER_ENABLED: 'true', TELEMETRY_DB: db,
    READ_SECRET: 'synthetic-only-private-read-token', WRITE_KEYS_JSON: JSON.stringify(keys) };
  return { db, keys, env, worker: createWorker({ clock: () => now }) };
}

test('authenticated JS senders through real collector + SQLite enforce source/class/read token scopes', async t => {
  const { db, keys, env, worker } = collector(t);
  const statuses = [];
  const fetcher = async (url, init) => {
    const response = await worker.fetch(new Request(url, init), env);
    statuses.push(response.status);
    return response;
  };
  const make = (source, token = keys[source]) => createServiceSender({ enabled: true, source, service_token: token,
    endpoint: `https://collector.invalid/v1/${source === 'probe' ? 'probes' : 'deletions'}`, fetcher });
  assert.equal(await make('api-retention')(apiUserDeletion(apiRetention, run)), true);
  assert.equal(await make('probe')(probeSummary(browserProbe, run)), true);
  assert.equal(await make('sandbox-reaper')(apiSandboxDeletion(sandboxReaper, { ...run, outcome: 'partial' }, 'delete')), true);
  assert.equal(await make('api-retention', keys['chat-retention'])(apiUserDeletion(apiRetention, run)), false);
  assert.equal(statuses.at(-1), 400, 'valid other deletion source token cannot impersonate payload source');
  assert.equal(await make('api-retention', keys.probe)(apiUserDeletion(apiRetention, run)), false);
  assert.equal(statuses.at(-1), 401, 'probe token cannot authorize deletion class');
  assert.equal(await make('probe', env.READ_SECRET)(probeSummary(browserProbe, run)), false);
  assert.equal(statuses.at(-1), 401, 'read token cannot write');
  assert.equal(await make('probe', 'synthetic-only-unknown-write-token')(probeSummary(browserProbe, run)), false);
  assert.equal(statuses.at(-1), 401);
  const read = await worker.fetch(new Request(`https://collector.invalid/v1/read/probes?from=${now - 2000}&to=${now}&limit=10`,
    { headers: { Authorization: `Bearer ${keys.probe}` } }), env);
  assert.equal(read.status, 401, 'write token cannot read');
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM deletion_runs').get().n, 2);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM probe_runs').get().n, 1);
});

test('browser configuration with token still emits no auth through actual collector', async t => {
  const { db, keys, env, worker } = collector(t);
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const arrival = createArrivalClient({ enabled: true, destination: 'chat', endpoint: 'https://collector.invalid/v1/browser',
    service_token: keys.probe, headers: { Authorization: `Bearer ${keys.probe}`, Cookie: 'private' },
    readReferrer: () => 'https://example.org/private?secret', fetcher: async (url, init) => {
      assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Cookie, undefined);
      assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.credentials, 'omit');
      // Origin is set by a real browser, never by arbitrary adapter headers.
      const req = new Request(url, init); req.headers.set('Origin', 'https://chat.bayleaf.dev');
      const response = await worker.fetch(req, env);
      finished(response.status); return response;
    } });
  arrival(); assert.equal(await done, 202);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM browser_observations').get().n, 1);
});

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('native JS fetch does not follow token-bearing redirects; deadline has no later retry', async t => {
  const seen = [];
  const target = await listen(t, (req, res) => { seen.push(req.headers.authorization); res.end(); });
  let requests = 0, receivedToken;
  const origin = await listen(t, (req, res) => {
    requests++; receivedToken = req.headers.authorization;
    res.writeHead(307, { Location: `${target}/capture` }); res.end();
  });
  const token = 'synthetic-only-probe-write-token';
  const sender = createServiceSender({ enabled: true, source: 'probe', service_token: token,
    endpoint: `${origin}/v1/probes` });
  assert.equal(await sender(probeSummary(browserProbe, run)), false);
  assert.equal(receivedToken, `Bearer ${token}`); assert.equal(requests, 1); assert.deepEqual(seen, []);
  const stalled = await listen(t, () => { requests++; });
  const deadlineSender = createServiceSender({ enabled: true, source: 'probe', service_token: token,
    endpoint: `${stalled}/v1/probes`, deadline_ms: 40 });
  assert.equal(await deadlineSender(probeSummary(browserProbe, run)), false);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(requests, 2); assert.deepEqual(seen, []);
});

test('Python default httpx sender authenticates to real collector + SQLite and refuses redirects', async t => {
  const { db, keys, env, worker } = collector(t);
  const statuses = [];
  let redirectsReached = 0, stalledRequests = 0;
  const other = await listen(t, (_req, res) => { redirectsReached++; res.end(); });
  const origin = await listen(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.headers.authorization === 'Bearer synthetic-only-redirect-write-token') {
      res.writeHead(307, { Location: `${other}/capture` }); res.end(); return;
    }
    if (req.headers.authorization === 'Bearer synthetic-only-stalled-write-token') {
      stalledRequests++; return; // Deadline must terminate the source wait, no retries.
    }
    const response = await worker.fetch(new Request(`https://collector.invalid${req.url}`, {
      method: req.method, headers: req.headers, body,
    }), env);
    statuses.push(response.status);
    res.writeHead(response.status); res.end(await response.text());
  });
  const script = `
import sys, json
sys.path.insert(0, 'telemetry/adapters')
from chat_retention import ChatRetentionCounts, RetentionPolicy, Run, chat_retention_summary, submit_summary
r = Run('${run.run_id}', '${run.started_at}', '${run.ended_at}', 'ok')
build = lambda: chat_retention_summary(ChatRetentionCounts(chats_deleted=2), r, 'delete', RetentionPolicy(90,86400,18))
out = [submit_summary(build, enabled=True, endpoint='${origin}/v1/deletions', service_token=token, deadline_ms=2000)
       for token in ['${keys['chat-retention']}', '${keys.probe}', '${env.READ_SECRET}', 'synthetic-only-redirect-write-token']]
out.append(submit_summary(build, enabled=True, endpoint='${origin}/v1/deletions',
  service_token='synthetic-only-stalled-write-token', deadline_ms=150))
print(json.dumps(out))
`;
  // Uses the existing local uv cache, never downloads or calls a provider.
  const child = spawn('uv', ['run', '--offline', '--with', 'httpx', 'python', '-B', '-c', script],
    { cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { errors += bytes; });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [code] = await once(child, 'exit'); clearTimeout(timeout);
  assert.equal(code, 0, errors);
  assert.deepEqual(JSON.parse(output), [true, false, false, false, false]);
  assert.deepEqual(statuses, [202, 401, 401]); assert.equal(redirectsReached, 0); assert.equal(stalledRequests, 1);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM deletion_runs').get().n, 1);
});
