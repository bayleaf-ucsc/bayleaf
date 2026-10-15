/** Execute the actual harness with inert HTTP/D1/module boundaries, no secrets. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const source = readFileSync(new URL('./harness-provision.mjs', import.meta.url), 'utf8');
async function scenario(failure, cleanupFailure = '') {
  const keys = new Map([['unrelated', { hash: 'unrelated', name: 'BayLeaf API for someone-else@example.invalid' }]]);
  const rows = new Map(), logs = [], deleted = [], sqlCalls = [];
  let owner, runId, originalRaised = false;
  class OriginalFailure extends Error { name = 'OriginalFailure'; }
  const abort = () => { originalRaised = true; throw new OriginalFailure('synthetic content must never be logged'); };
  const process = { argv: ['node', 'harness', '--live'], exitCode: 0,
    exit() { throw new Error('Unexpected process.exit'); } };
  const context = createContext({ process, URL, Set, Map, console: {
    log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')),
  }, fetch: async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'openrouter.ai') {
      assert.equal(options.headers.Authorization, 'Bearer inert-admin');
      if (url.pathname.endsWith('/keys')) {
        if (cleanupFailure === 'inventory' && originalRaised) return new Response(null, { status: 503 });
        return Response.json({ data: [...keys.values()] });
      }
      const hash = url.pathname.split('/').at(-1);
      if (options.method === 'DELETE') {
        deleted.push(hash);
        if (cleanupFailure === 'delete') return new Response(null, { status: 403 });
        if (cleanupFailure !== 'survivor') keys.delete(hash);
        return Response.json({});
      }
      if (cleanupFailure === 'lookup' && originalRaised) return new Response(null, { status: 401 });
      return keys.has(hash) ? Response.json({ data: keys.get(hash) }) : new Response(null, { status: 404 });
    }
    assert.equal(url.origin, 'http://localhost:8799');
    if (url.pathname === '/key') {
      if (options.method === 'DELETE') return new Response(null, { status: 404 });
      if (rows.has(owner)) return new Response(null, { status: 409 });
      rows.set(owner, { email: owner, bayleaf_token: 'sk-bayleaf-' + 'a'.repeat(32), revoked: 0, or_key_hash: null, or_key_secret: null });
      return Response.json({ key: rows.get(owner).bayleaf_token });
    }
    if (url.pathname === '/v1/auth/key') {
      const row = rows.get(owner); row.or_key_hash = 'owned'; row.or_key_secret = 'inert';
      for (const hash of ['owned', 'unrecorded-race-loser']) keys.set(hash, {
        hash, name: `BayLeaf API for ${owner}`, limit: 5,
      });
      if (failure === 'poisoned-d1' || failure === 'created-unowned') row.or_key_hash = 'unrelated';
      if (failure === 'before-inventory' || failure === 'poisoned-d1') abort();
      return Response.json({ data: { limit: 5, label: 'sk-or-elided...key', bayleaf: { openrouter: {} } } });
    }
    if (url.pathname === '/dashboard') {
      // The stale unowned hash is now only in `created`, not in the D1 row.
      if (failure === 'created-unowned') rows.get(owner).or_key_hash = 'owned';
      abort();
    }
    throw new Error('Unexpected synthetic HTTP path');
  } });
  const mocks = {
    'node:fs': { readFileSync: path => path === 'wrangler.jsonc' ? JSON.stringify({ vars: {} })
      : path === '.env' ? 'OPENROUTER_MAINTENANCE_KEY=inert-admin' : 'OIDC_CLIENT_SECRET=inert-session' },
    'node:crypto': { randomUUID: () => { runId = crypto.randomUUID(); return runId; } },
    'hono/jwt': { sign: async data => { owner = data.email; return 'inert-cookie'; } },
    'node:child_process': { execFileSync: (exe, args) => {
      assert.equal(exe, 'npx'); assert.ok(args.includes('--local'));
      const sql = args.at(-1); sqlCalls.push(sql);
      if (sql.startsWith('DELETE')) {
        if (cleanupFailure !== 'd1-survivor') for (const email of rows.keys()) if (sql.includes(`'${email}'`)) rows.delete(email);
        return JSON.stringify([{ results: [] }]);
      }
      return JSON.stringify([{ results: [...rows.values()].filter(row => sql.includes(`'${row.email}'`)) }]);
    } },
  };
  const module = new SourceTextModule(source, { context });
  await module.link(specifier => {
    assert.ok(mocks[specifier], 'Only explicitly synthetic dependencies allowed');
    const entries = Object.entries(mocks[specifier]);
    return new SyntheticModule(entries.map(([key]) => key), function () {
      for (const [key, value] of entries) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate(); await module.namespace.completion;
  assert.equal(process.exitCode, 1);
  assert.ok(logs.some(line => line.includes('Harness aborted (OriginalFailure)')), 'Original failure preserved');
  assert.ok(!logs.join('\n').includes('synthetic content must never be logged'));
  assert.ok(!deleted.includes('unrelated')); assert.ok(keys.has('unrelated'));
  assert.ok(sqlCalls.some(sql => sql.startsWith('DELETE') && sql.includes(runId)));
  if (!cleanupFailure && !['poisoned-d1', 'created-unowned'].includes(failure)) {
    assert.equal(keys.size, 1); assert.equal(rows.size, 0);
    assert.ok(deleted.includes('unrecorded-race-loser'), 'Rediscovery catches a key never in D1/inventory');
    assert.ok(logs.some(line => line.includes('verified absent')));
  } else {
    assert.ok(logs.some(line => line.startsWith('FAIL cleanup')), 'Cleanup must fail closed');
    assert.ok(!logs.some(line => line.includes('verified absent')));
  }
  if (['poisoned-d1', 'created-unowned'].includes(failure)) {
    assert.equal(keys.size, 1, 'Verified owned keys still cleaned despite poisoned candidate');
    assert.equal(rows.size, 0);
    assert.ok(deleted.includes('owned'));
  }
  if (cleanupFailure === 'lookup') assert.equal(deleted.length, 0, 'Failed provider lookup cannot authorize any deletion');
  return owner;
}
const first = await scenario('before-inventory');
const second = await scenario('after-inventory');
assert.notEqual(first, second, 'Each run has a unique ownership identity');
await scenario('poisoned-d1');
await scenario('created-unowned');
for (const failure of ['inventory', 'delete', 'survivor', 'lookup', 'd1-survivor'])
  await scenario('after-inventory', failure);
console.log('PASS 9 synthetic exception/cleanup paths, unique ownership, no content logging');
