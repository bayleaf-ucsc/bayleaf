// Explicit one-off production operation. Never logs credentials or chat content.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { cleanupSynthetic } from './index.mjs';

const origin = 'https://chat.bayleaf.dev';
const target = 'https://probe.bayleaf.dev';
const listPath = '/api/v1/chats/list?page=1&include_pinned=true&include_folders=true';
const started = Date.now();
const observed = new Map();
let token, userId, stage = 'credentials', uncertainUntil = 0;
const output = value => console.log(JSON.stringify(value));
async function api(path, options = {}) {
  const response = await fetch(origin + path, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (response.status !== 200) { await response.body?.cancel(); return { status: response.status }; }
  return { status: 200, data: await response.json() };
}
async function scan() {
  const listing = await api(listPath);
  assert.equal(listing.status, 200);
  assert.ok(Array.isArray(listing.data) && listing.data.length <= 5);
  for (const row of listing.data) {
    assert.match(row.id, /^[0-9a-f-]{36}$/);
    if (observed.has(row.id)) continue;
    const record = await api(`/api/v1/chats/${row.id}`);
    if (record.status === 401) continue; // Worker deletion raced this read.
    assert.equal(record.status, 200);
    const marker = record.data.variables?.bayleaf_probe;
    const match = marker?.match(/^bayleaf-probe-v1:(\d{13}):[0-9a-f-]{36}$/);
    assert.ok(match && Number(match[1]) >= started);
    assert.equal(record.data.user_id, userId);
    assert.deepEqual(record.data.chat.models, ['basic']);
    const users = Object.values(record.data.chat.history.messages).filter(m => m.role === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].content, "What's BayLeaf?");
    observed.set(row.id, marker);
  }
  return listing.data;
}

try {
  const bootstrap = JSON.parse(await readFile(new URL('bootstrap.secrets.json', import.meta.url), 'utf8'));
  const secrets = JSON.parse(await readFile(new URL('worker.secrets.json', import.meta.url), 'utf8'));
  assert.equal(bootstrap.role, 'user');
  assert.ok(bootstrap.email && bootstrap.password && secrets.OWUI_API_KEY && secrets.PROBE_PASSWORD);
  stage = 'signin';
  const identity = await api('/api/v1/auths/signin', {
    method: 'POST', body: JSON.stringify({ email: bootstrap.email, password: bootstrap.password }),
  });
  assert.equal(identity.status, 200);
  assert.equal(identity.data.role, 'user');
  assert.equal(identity.data.id, bootstrap.id);
  token = identity.data.token;
  userId = identity.data.id;
  const key = await api('/api/v1/auths/api_key');
  assert.equal(key.status, 200);
  assert.equal(key.data.api_key, secrets.OWUI_API_KEY);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.ok(claims.exp * 1000 > Date.now());
  output({ ordinary_user: true, same_api_key_identity: true, session_expires_utc: new Date(claims.exp * 1000).toISOString() });

  const installSecrets = process.argv.includes('--install-secrets');
  const installApiSecret = process.argv.includes('--install-api-secret');
  if (installSecrets || installApiSecret) {
    stage = 'secret_upload';
    assert.ok(installApiSecret ? process.env.BAYLEAF_API_KEY : process.env.OPENROUTER_API_KEY);
    // Only the documented inference credential is accepted from the environment.
    // No temporary secret file, arguments containing values, or raw CLI output.
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk'], {
      cwd: new URL('.', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    child.stdout.resume();
    child.stderr.resume();
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    child.stdin.on('error', () => {});
    const installed = installApiSecret
      ? { BAYLEAF_API_KEY: process.env.BAYLEAF_API_KEY }
      : { OWUI_E2E_TOKEN: token, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
    child.stdin.end(JSON.stringify(installed));
    assert.equal(await exited, 0);
    output({ installed_secret_names: Object.keys(installed) });
  } else {
    stage = 'baseline';
    const baseline = await api(listPath);
    assert.equal(baseline.status, 200);
    assert.deepEqual(baseline.data, []); // Never inspect human history or adopt old records.
    const routes = process.argv.includes('--api-only')
      ? [['api', '/api/recommended']]
      : [['owui', '/chat/basic'], ['openrouter', '/openrouter/basic'],
        ['api', '/api/recommended'], ['browser', '/chat/basic/e2e']];
    for (const [, path] of routes) {
      for (const method of ['GET', 'HEAD']) {
        stage = 'unauthorized';
        const response = await fetch(target + path, { method, redirect: 'manual', signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('server-timing'), null);
        assert.ok(![...response.headers.keys()].some(name => name.startsWith('x-bayleaf-probe-')));
        assert.equal(await response.text(), method === 'HEAD' ? '' : 'Unauthorized\n');
      }
    }
    output({ unauthorized_checks: routes.length * 2, status: 401, detailed_metrics: false });
    for (const [layer, path] of routes) {
      for (const method of ['GET', 'HEAD']) {
        stage = `${layer}_${method}`;
        const before = observed.size;
        let settled = false, pollingError, headersAt;
        const begin = performance.now();
        uncertainUntil = Date.now() + 85000;
        const pending = fetch(target + path, {
          method, redirect: 'manual', signal: AbortSignal.timeout(85000),
          headers: { Authorization: `Basic ${btoa(`probe:${secrets.PROBE_PASSWORD}`)}` },
        }).then(response => { headersAt = performance.now(); return response; })
          .finally(() => { settled = true; });
        // Attach a rejection handler immediately while independent observation runs.
        pending.catch(() => {});
        if (layer === 'browser') {
          while (!settled) {
            try { await scan(); } catch { pollingError = true; }
            await sleep(1000);
          }
        }
        const response = await pending;
        uncertainUntil = 0;
        const elapsed = headersAt - begin;
        const timing = response.headers.get('server-timing') ?? '';
        const phases = Object.fromEntries([...timing.matchAll(/(?:^|, )([a-z_]+);dur=([\d.]+)/g)].map(m => [m[1], Number(m[2])]));
        const events = Object.fromEntries([...(response.headers.get('x-bayleaf-probe-events') ?? '').matchAll(/(?:^|, )([a-z_]+)=([\d.]+)/g)].map(m => [m[1], Number(m[2])]));
        const result = response.headers.get('x-bayleaf-probe-result');
        output({ layer, method, status: response.status, result, elapsed_ms: Math.round(elapsed),
          phases_ms: phases, events_ms: events,
          cleanup: response.headers.get('x-bayleaf-probe-cleanup'), close: response.headers.get('x-bayleaf-probe-close') });
        assert.equal(response.status, 200);
        assert.equal(result, 'ok');
        assert.equal(response.headers.get('x-bayleaf-probe-metrics-version'), '2');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok(Object.keys(phases).length >= 6 && phases.total > 0);
        const sum = Object.entries(phases).filter(([name]) => name.startsWith('p_')).reduce((a, [, n]) => a + n, 0);
        assert.ok(Math.abs(sum - phases.accounted) < 0.1);
        assert.ok(Math.abs(phases.total - phases.accounted - phases.unaccounted) < 0.1);
        if (method === 'GET') {
          const body = await response.json();
          assert.equal(body.version, 2);
          assert.equal(body.layer, layer);
          assert.equal(body.result, 'ok');
          assert.equal(body.metrics.unit, 'ms');
          assert.ok(Math.abs(body.metrics.total - phases.total) < 0.01);
          for (const [name, value] of Object.entries(body.metrics.phases)) {
            assert.ok(Number.isFinite(value) && value >= 0 && Math.abs(value - phases[`p_${name}`]) < 0.01);
          }
        } else assert.equal(await response.text(), '');
        if (layer === 'browser') {
          assert.ok(!pollingError);
          assert.equal(observed.size - before, 1);
          assert.equal(response.headers.get('x-bayleaf-probe-cleanup'), 'confirmed');
          assert.equal(response.headers.get('x-bayleaf-probe-close'), 'confirmed');
          for (const id of observed.keys()) assert.equal((await api(`/api/v1/chats/${id}`)).status, 401);
          assert.deepEqual(await scan(), []);
          output({ method, independent_exact_chat_absence: true, authenticated_list_empty: true });
        }
      }
    }
    output({ qualification: 'passed', completed_utc: new Date().toISOString() });
  }
} catch {
  output({ qualification: 'failed', stage });
  process.exitCode = 1;
} finally {
  if (token && userId && !process.argv.includes('--install-secrets') &&
      !process.argv.includes('--install-api-secret')) {
    try {
      // Allow independent Worker cleanup to finish after a transport failure.
      if (uncertainUntil > Date.now()) await sleep(uncertainUntil - Date.now());
      const remaining = await scan();
      for (const row of remaining) {
        await cleanupSynthetic(token, userId, AbortSignal.timeout(15000), {
          marker: observed.get(row.id), chatId: row.id, attempted: true,
        });
      }
      for (const id of observed.keys()) assert.equal((await api(`/api/v1/chats/${id}`)).status, 401);
      assert.deepEqual(await scan(), []);
      output({ final_cleanup: 'confirmed', exact_synthetic_records_observed: observed.size, recovered: remaining.length, remaining: 0 });
    } catch { output({ final_cleanup: 'failed' }); process.exitCode = 1; }
  }
  output({ temporary_server: 'not_started', temporary_secret_file: 'not_created' });
}
