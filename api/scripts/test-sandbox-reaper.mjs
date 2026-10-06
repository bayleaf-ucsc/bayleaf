/** Synthetic control-plane checks. No real sandbox mutations or credentials. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const bundle = await build({ entryPoints: ['src/sandboxReaper.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser' });
const { reapInactiveSandboxes, SANDBOX_REAPER_CRON } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const now = Date.parse('2026-10-06T08:17:00Z');
const cutoff = now - 90 * 86400000;
const machine = (id, overrides = {}) => ({ id, state: 'archived', desiredState: 'archived',
  labels: { 'chat.bayleaf.dev': 'synthetic@ucsc.edu' },
  lastActivityAt: new Date(cutoff).toISOString(), ...overrides });
const originalFetch = globalThis.fetch;
let calls, cleared, inventory, details, verification, deletionStatus;
const env = { SANDBOX_REAPER_MODE: 'delete', DAYTONA_API_URL: 'https://daytona.example.test/api',
  DAYTONA_API_KEY: 'synthetic', DAYTONA_DEPLOYMENT_LABEL: 'chat.bayleaf.dev',
  DB: { prepare(sql) {
    assert.equal(sql, 'UPDATE user_keys SET daytona_sandbox_id = NULL WHERE daytona_sandbox_id = ?');
    return { bind(id) { return { async run() { cleared.push(id); } }; } };
  } } };
function setup(items) {
  calls = []; cleared = []; inventory = [{ items, nextCursor: null }];
  details = new Map(items.map(m => [m.id, m])); verification = 404; deletionStatus = 200;
  const deleted = new Set();
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    assert.equal(u.hostname, 'daytona.example.test');
    assert.equal(options.headers.Authorization, 'Bearer synthetic');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    calls.push({ path: u.pathname, search: u.search, method: options.method });
    if (u.pathname === '/api/sandbox') {
      const page = u.searchParams.has('cursor') ? Number(u.searchParams.get('cursor')) : 0;
      return Response.json(inventory[page]);
    }
    const id = decodeURIComponent(u.pathname.split('/').at(-1));
    if (options.method === 'DELETE') {
      deleted.add(id); return new Response(null, { status: deletionStatus });
    }
    if (deleted.has(id)) return typeof verification === 'number'
      ? new Response(null, { status: verification }) : Response.json(verification);
    const detail = details.get(id);
    return typeof detail === 'number' ? new Response(null, { status: detail }) : Response.json(detail);
  };
}
const mutations = () => calls.filter(c => c.method === 'DELETE');
try {
  assert.equal(SANDBOX_REAPER_CRON, '17 8 * * *');
  const config = readFileSync('wrangler.jsonc', 'utf8');
  assert.ok(config.includes('"0 * * * *", "17 8 * * *"'));
  const entry = readFileSync('src/index.ts', 'utf8');
  assert.ok(entry.includes('event.cron === SANDBOX_REAPER_CRON'));

  setup([machine('archived'), machine('stopped', { state: 'stopped', desiredState: 'stopped' })]);
  inventory = [{ items: [machine('archived')], nextCursor: '1' },
    { items: [machine('stopped', { state: 'stopped', desiredState: 'stopped' })], nextCursor: null }];
  let report = await reapInactiveSandboxes(env, now);
  assert.equal(report.deleted, 2); assert.deepEqual(cleared, ['archived', 'stopped']);
  assert.equal(calls[1].search, '?cursor=1');
  assert.equal(calls.filter(c => c.method === 'GET' && c.path.endsWith('/archived')).length, 2);

  setup([machine('old')]);
  report = await reapInactiveSandboxes({ ...env, SANDBOX_REAPER_MODE: 'dry-run' }, now);
  assert.equal(report.candidates, 1); assert.equal(mutations().length, 0); assert.equal(cleared.length, 0);
  setup([machine('old')]);
  await reapInactiveSandboxes({ ...env, SANDBOX_REAPER_MODE: undefined }, now);
  assert.equal(calls.length, 0);

  setup([machine('recent', { lastActivityAt: new Date(cutoff + 1).toISOString() }),
    machine('personal', { labels: { 'chat.adamsmith.as': 'synthetic' } }),
    machine('missing', { lastActivityAt: undefined }), machine('invalid', { lastActivityAt: 'bad' }),
    machine('running', { state: 'started', desiredState: 'started' }),
    machine('transitioning', { desiredState: 'started' })]);
  report = await reapInactiveSandboxes(env, now);
  assert.equal(report.candidates, 0); assert.equal(mutations().length, 0);

  for (const change of [{ lastActivityAt: new Date(now).toISOString() },
    { state: 'started', desiredState: 'started' }, { labels: { 'chat.bayleaf.dev': 'other' } },
    { id: 'different' }]) {
    setup([machine('old')]); details.set('old', machine('old', change));
    await reapInactiveSandboxes(env, now); assert.equal(mutations().length, 0);
  }
  for (const status of [404, 500]) {
    setup([machine('old')]); details.set('old', status);
    await reapInactiveSandboxes(env, now); assert.equal(mutations().length, 0);
  }
  setup([machine('old')]); deletionStatus = 500;
  report = await reapInactiveSandboxes(env, now);
  assert.equal(report.failed, 1); assert.equal(cleared.length, 0);
  setup([machine('old')]); verification = machine('old', { state: 'destroying' });
  report = await reapInactiveSandboxes(env, now);
  assert.equal(report.pending, 1); assert.equal(cleared.length, 0);
  setup([machine('old')]); verification = machine('old', { state: 'destroyed' });
  report = await reapInactiveSandboxes(env, now); assert.equal(report.deleted, 1);

  setup([machine('old')]);
  inventory = [{ items: [machine('old')], nextCursor: '1' }, { items: [], nextCursor: '1' }];
  await assert.rejects(reapInactiveSandboxes(env, now), /pagination invalid/);
  assert.equal(mutations().length, 0);
  setup([machine('old')]); inventory = [{ items: [machine('old')], nextCursor: '1' }, {}];
  await assert.rejects(reapInactiveSandboxes(env, now), /inventory invalid/);
  assert.equal(mutations().length, 0);
  console.log('Sandbox reaper checks passed');
} finally { globalThis.fetch = originalFetch; }
