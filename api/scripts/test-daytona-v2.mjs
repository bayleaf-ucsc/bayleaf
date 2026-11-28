#!/usr/bin/env node
/** Live wire shapes, synthetic data only. No provider credentials or workerd. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root,
  contents: `export { ensureSandbox, lookupOwnedV2Sandbox, createSignedPreview, refreshActivity, execCommand } from './src/daytona';
    export { createV2Sandbox, findV2Sandbox, getV2Sandbox, v2Toolbox } from './src/daytonaV2';` },
  format: 'esm', platform: 'browser', bundle: true, write: false });
const { ensureSandbox, lookupOwnedV2Sandbox, createSignedPreview, refreshActivity, execCommand,
  createV2Sandbox, findV2Sandbox, getV2Sandbox, v2Toolbox } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const env = { DAYTONA_API_VERSION: '2', DAYTONA_API_KEY: 'synthetic',
  DAYTONA_DEPLOYMENT_LABEL: 'chat.example.test', DAYTONA_V2_CREATE_ENABLED: 'true',
  DAYTONA_V2_IMAGE: 'fixture', DAYTONA_V2_REGION: 'us-east-ash-1' };
const email = 'owner@example.test', id = 'sbx_fixture-us-east-ash-1';
const legacy = '11111111-2222-3333-4444-555555555555';
const proxy = 'https://proxy.ash-1.us-east.daytona.app/toolbox';
const target = {
  id, labels: { 'chat.example.test': email }, persistent: true, status: 'running', toolbox_proxy_url: proxy,
  cpu: 0.5, cores_max: 1, memory_mib: 2048, memory_max_mib: 2048, disk_max_mib: 10240,
  lifecycle_policy: { on_idle_timeout: 'pause', idle_expiry_seconds: 3600, last_activity_at: '2026-11-27T00:00:00Z' },
};
let handler;
globalThis.fetch = async (input, options) => {
  const request = new Request(input, options);
  assert.equal(request.headers.get('Authorization'), 'Bearer synthetic');
  assert.equal(request.redirect, 'manual');
  return handler(new URL(request.url), request);
};
const get = `/sandboxes/${id}`;
handler = (url) => {
  if (url.pathname === '/sandboxes/search') {
    assert.deepEqual(JSON.parse(url.searchParams.get('labels')), { 'chat.example.test': email });
    if (!url.searchParams.has('cursor')) return Response.json({ sandboxes: [{ id: 'sbx_stale' }], next_cursor: 'next' });
    assert.equal(url.searchParams.get('cursor'), 'next');
    return Response.json({ sandboxes: [{ id }], next_cursor: null });
  }
  if (url.pathname === '/sandboxes/sbx_stale') return new Response(null, { status: 404 });
  assert.equal(url.pathname, get);
  return Response.json(target);
};
const current = await findV2Sandbox(email, env);
assert.equal(current.id, id);
assert.deepEqual([current.reservedCpu, current.cpu, current.memory, current.disk, current.idlePauseMinutes], [1, 2, 2, 10, 60]);
await assert.rejects(lookupOwnedV2Sandbox(email, env, legacy), /migration has not completed/);
await assert.rejects(lookupOwnedV2Sandbox('other@example.test', env, id), /ownership mismatch/);

let mode = 'error', creates = 0, resumes = 0;
const createKeys = new Set();
handler = async (url, r) => {
  if (url.pathname === '/sandboxes/search') return mode === 'error' ? new Response(null, { status: 503 })
    : Response.json({ sandboxes: [], next_cursor: null });
  if (url.pathname === '/sandboxes') {
    creates++;
    const payload = await r.json();
    createKeys.add(payload.idempotency_key);
    assert.deepEqual(payload.lifecycle_policy, {
      idle_expiry_seconds: 3600, on_idle_timeout: 'pause', timeout_seconds: 86400, on_timeout: 'pause',
    });
    assert.deepEqual([payload.cpu, payload.cores_max, payload.memory_mib, payload.memory_max_mib, payload.disk_max_mib],
      [0.5, 1, 2048, 2048, 10240]);
    assert.equal(payload.persistent, true);
    return Response.json({ id }, { status: 202 });
  }
  if (url.pathname === `${get}/resume`) {
    assert.equal(r.method, 'POST');
    resumes++;
    mode = 'running';
    return new Response(null, { status: 202 });
  }
  if (url.pathname === `${get}/reset-idle-timer`) {
    assert.equal(r.method, 'POST');
    return Response.json({ id });
  }
  if (url.pathname === `${get}/ports/443/signed-preview-urls`) {
    assert.equal(r.method, 'POST');
    assert.deepEqual(await r.json(), { expires_in_seconds: 420 });
    return Response.json({ url: 'https://443-fixture.ash-1.daytonaproxy03.net/' });
  }
  if (url.pathname === get) return Response.json({ ...target, status: mode === 'paused' ? 'paused' : 'running' });
  assert.equal(url.hostname, 'proxy.ash-1.us-east.daytona.app');
  assert.equal(url.pathname, `/toolbox/${id}/processes`);
  assert.deepEqual((await r.json()).argv, ['mkdir', '-p', '/home/daytona/workspace']);
  return Response.json({ id: 'process-mkdir', exitCode: 0, logs: { frames: [], eof: true } });
};
await assert.rejects(ensureSandbox(email, env), /503/);
assert.equal(creates, 0);
await assert.rejects(createV2Sandbox(email, { ...env, DAYTONA_V2_CREATE_ENABLED: 'false' }), /not enabled/);
mode = 'running';
assert.deepEqual(await Promise.all([createV2Sandbox(email, env), createV2Sandbox(email, env)]).then(rows => rows.map(m => m.id)), [id, id]);
assert.equal(createKeys.size, 1);
mode = 'paused';
assert.deepEqual(await ensureSandbox(email, env, id), { id, changed: false });
assert.equal(resumes, 1);
await refreshActivity(id, env);
assert.match((await createSignedPreview(id, 443, env, 420)).url, /\.ash-1\.daytonaproxy03\.net/);
const m = await getV2Sandbox(id, env);
assert.throws(() => v2Toolbox(env, { ...m, toolboxProxyUrl: 'https://proxy.attacker.test/toolbox' }, '/processes'), /Invalid/);

// A POST can replay its original status even after the sandbox has been deleted.
const [firstKey] = createKeys;
const nextKey = firstKey.replace(/-0$/, '-1');
const deletedId = 'sbx_deleted';
for (const deletionSource of ['POST', 'GET']) {
  const attempts = [];
  handler = async (url, request) => {
    if (url.pathname === '/sandboxes') {
      const { idempotency_key: key } = await request.json();
      attempts.push(key);
      if (key === firstKey) {
        return Response.json({ id: deletedId, status: deletionSource === 'POST' ? 'deleted' : 'queued' }, { status: 202 });
      }
      assert.equal(key, nextKey);
      return Response.json({ id, status: 'queued' }, { status: 202 });
    }
    if (url.pathname === `/sandboxes/${deletedId}`) {
      assert.equal(deletionSource, 'GET');
      return Response.json({ id: deletedId, status: 'deleted' });
    }
    assert.equal(url.pathname, get);
    return Response.json(target);
  };
  assert.equal((await createV2Sandbox(email, env)).id, id);
  assert.deepEqual(attempts, [firstKey, nextKey]);
}

// An ambiguous 404 must never advance the generation, even on repeated calls.
let visible = false;
const attempts = [];
handler = async (url, request) => {
  if (url.pathname === '/sandboxes') {
    attempts.push((await request.json()).idempotency_key);
    return Response.json({ id, status: 'queued' }, { status: 202 });
  }
  assert.equal(url.pathname, get);
  return visible ? Response.json(target) : new Response(null, { status: 404 });
};
await assert.rejects(createV2Sandbox(email, env), /deletion is unconfirmed/);
await assert.rejects(createV2Sandbox(email, env), /deletion is unconfirmed/);
visible = true;
assert.equal((await createV2Sandbox(email, env)).id, id);
assert.deepEqual(attempts, [firstKey, firstKey, firstKey]);

const workdir = '/home/daytona/workspace with spaces';
const files = new Map();
const cleanupPaths = new Set();
const executed = [];
const scriptPrefix = '#!/usr/bin/env bash\nset -e -o pipefail\n' +
  'export DEBIAN_FRONTEND=noninteractive GIT_TERMINAL_PROMPT=0 PIP_NO_INPUT=1 NPM_CONFIG_YES=true CI=true\n';
const largeCommand = `# ${'ä'.repeat(70_000)}\nprintf example`;
assert.ok(Buffer.byteLength(largeCommand) > 128 * 1024);
let execFailure, cleanupFails = false;
handler = async (url, request) => {
  if (url.pathname === get) return Response.json(target);
  assert.equal(url.hostname, 'proxy.ash-1.us-east.daytona.app');
  const toolbox = `/toolbox/${id}`;
  if (url.pathname === `${toolbox}/files/upload`) {
    assert.equal(request.method, 'POST');
    const path = url.searchParams.get('path');
    assert.match(path, /^\/tmp\/bayleaf-exec-[a-f0-9-]{36}\.sh$/);
    assert.equal(files.has(path), false);
    const file = (await request.formData()).get('file');
    assert.equal(file.name, 'file');
    assert.equal(file.type, 'application/octet-stream');
    files.set(path, await file.text());
    return new Response(null, { status: execFailure === 'upload' ? 503 : 200 });
  }
  if (url.pathname === `${toolbox}/processes/process-1/logs`) {
    assert.deepEqual(Object.fromEntries(url.searchParams), { cursor: 'more', encoding: 'text' });
    return Response.json({ frames: [{ data: 'two\n' }], eof: true });
  }
  assert.equal(url.pathname, `${toolbox}/processes`);
  assert.equal(request.method, 'POST');
  const body = await request.json();
  if (body.argv[0] === 'rm') {
    const path = body.argv[3];
    assert.deepEqual(body, { argv: ['rm', '-f', '--', path], timeoutMs: 5000 });
    cleanupPaths.add(path);
    assert.equal(files.delete(path), true);
    if (cleanupFails) throw new Error('synthetic cleanup failure');
    return Response.json({ id: 'process-rm', exitCode: 0, logs: { frames: [], eof: true } });
  }
  const path = body.argv[1];
  assert.deepEqual(body, { argv: ['bash', path], timeoutMs: 120_000, cwd: workdir });
  assert.ok(files.has(path));
  executed.push(files.get(path));
  if (execFailure === 'process') return new Response(null, { status: 502 });
  if (execFailure === 'logs') return Response.json({ id: 'process-1', truncatedHead: true });
  return Response.json({ id: 'process-1', exitCode: 7, logs: {
    frames: [{ data: 'one\n' }], nextCursor: 'more', eof: false,
  } });
};
cleanupFails = true;
assert.deepEqual(await Promise.all([
  execCommand(id, largeCommand, workdir, env),
  execCommand(id, 'printf other', workdir, env),
]), [{ exitCode: 7, output: 'one\ntwo\n' }, { exitCode: 7, output: 'one\ntwo\n' }]);
assert.deepEqual(new Set(executed), new Set([`${scriptPrefix}${largeCommand}\n`, `${scriptPrefix}printf other\n`]));
assert.equal(files.size, 0);
assert.equal(cleanupPaths.size, 2);
for (const [failure, expected] of [
  ['upload', /upload failed \(503\)/],
  ['process', /command transport failed \(502\)/],
  ['logs', /output is incomplete/],
]) {
  execFailure = failure;
  await assert.rejects(execCommand(id, 'printf failure', workdir, env), expected);
  assert.equal(files.size, 0);
}
assert.equal(executed.length, 4); // Failed upload was cleaned up without executing.
assert.equal(cleanupPaths.size, 5);
console.log('Daytona v2 checks passed: ownership, idempotency, pause/resume, idle timer, preview and Toolbox file-backed exec.');
