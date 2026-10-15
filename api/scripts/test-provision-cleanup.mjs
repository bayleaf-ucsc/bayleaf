/** Execute the imported runner with inert HTTP/D1/credentials, no secrets. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProvision } from './harness-provision.mjs';

// Exercise the actual CLI entry without global/import replacements. Child
// permissions allow only module reads, not credential/config reads or subprocesses
// (and deny networking on Node versions with network permissions). Include lexical
// and real dependency paths for symlinked installs.
const harness = new URL('./harness-provision.mjs', import.meta.url);
const dependencies = fileURLToPath(new URL('../node_modules', import.meta.url));
const modulePaths = new Set([fileURLToPath(harness), dependencies, realpathSync(dependencies)]);
// Node 22.0–22.12 uses the experimental spelling. Keep both smoke checks and
// the same read/subprocess restrictions; suppress only its experimental warning
// so import-silence assertions still detect actual harness output.
const permission = process.allowedNodeEnvironmentFlags.has('--permission')
  ? ['--permission'] : ['--experimental-permission', '--disable-warning=ExperimentalWarning'];
const restricted = [...permission, ...[...modulePaths].map(path => `--allow-fs-read=${path}`)];
const guard = spawnSync(process.execPath, [...restricted, fileURLToPath(harness)], { encoding: 'utf8' });
assert.equal(guard.status, 2, guard.stderr);
assert.equal(guard.stdout, '');
assert.match(guard.stderr, /--live/, 'Missing opt-in explains the required flag without fixing usage wording');
const imported = spawnSync(process.execPath, [...restricted, '--input-type=module', '-e',
  `await import(${JSON.stringify(harness.href)});`, '--', '--live'], { encoding: 'utf8' });
assert.equal(imported.status, 0, imported.stderr);
assert.equal(imported.stdout + imported.stderr, '', 'Import is silent even with --live in argv');

async function scenario(failure, cleanupFailure = '') {
  const keys = new Map([['unrelated', { hash: 'unrelated', name: 'BayLeaf API for someone-else@example.invalid' }]]);
  for (let i = 0; i < 98; i++) keys.set(`other-${i}`, { hash: `other-${i}`, name: 'Unrelated' });
  const rows = new Map(), logs = [], deleted = [], sqlCalls = [], scans = [];
  rows.set('unrelated@example.invalid', { email: 'unrelated@example.invalid', or_key_hash: 'unrelated' });
  let owner, runId, lastLookup, originalRaised = false;
  class OriginalFailure extends Error { name = 'OriginalFailure'; }
  const secret = 'SECRET-SENTINEL-must-never-be-logged';
  const originalFailure = new OriginalFailure(secret);
  originalFailure.name = secret;
  originalFailure.stack = secret;
  const unknownCleanup = new AggregateError([new Error(secret)], secret);
  unknownCleanup.name = secret;
  unknownCleanup.operation = secret; // Untrusted lookalike diagnostic fields.
  unknownCleanup.status = 599;
  const abort = () => { originalRaised = true; throw originalFailure; };
  const console = {
    log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')),
  };
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'openrouter.ai') {
      assert.equal(options.headers.Authorization, 'Bearer inert-admin');
      if (url.pathname.endsWith('/keys')) {
        if (url.searchParams.get('limit') === '1') return Response.json({ data: [...keys.values()].slice(0, 1) });
        assert.equal(url.searchParams.get('limit'), '100');
        const offset = Number(url.searchParams.get('offset'));
        if (offset === 0) scans.push([]);
        scans.at(-1).push(offset);
        if (cleanupFailure === 'unknown' && originalRaised) throw unknownCleanup;
        if (cleanupFailure === 'inventory' && originalRaised) return new Response(secret, { status: 503 });
        return Response.json({ data: [...keys.values()].slice(offset, offset + 100) });
      }
      const hash = url.pathname.split('/').at(-1);
      if (options.method === 'DELETE') {
        assert.equal(lastLookup, hash, 'Every delete has its own immediately preceding provider lookup');
        lastLookup = null;
        deleted.push(hash);
        if (cleanupFailure === 'delete') return new Response(secret, { status: 403 });
        if (cleanupFailure !== 'survivor') keys.delete(hash);
        return Response.json({});
      }
      lastLookup = hash;
      if (['lookup', 'lookup-many'].includes(cleanupFailure) && originalRaised) return new Response(secret, { status: 401 });
      if (failure === 'primary-lookup' && !originalRaised) {
        originalRaised = true;
        return new Response(secret, { status: 402 });
      }
      return keys.has(hash) ? Response.json({ data: keys.get(hash) }) : new Response(null, { status: 404 });
    }
    assert.equal(url.origin, 'http://localhost:8799');
      if (url.pathname === '/key') {
      owner = JSON.parse(Buffer.from(options.headers.Cookie.split('.')[1], 'base64url')).email;
      runId = /^provision-(.*)-1@/.exec(owner)[1];
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
      for (let i = 98; i < 198; i++) keys.set(`other-${i}`, { hash: `other-${i}`, name: 'Unrelated' });
      keys.set('second-owner', { hash: 'second-owner', name: `BayLeaf API for ${owner.replace('-1@', '-2@')}` });
      keys.get('unrelated').name = `BayLeaf API for ${owner}-not-exact`;
      if (cleanupFailure === 'lookup-many') for (let i = 0; i < 24; i++)
        keys.set(`owned-${i}`, { hash: `owned-${i}`, name: `BayLeaf API for ${owner}` });
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
  };
  const d1 = sql => {
      sqlCalls.push(sql);
      if (sql.startsWith('DELETE')) {
        if (cleanupFailure !== 'd1-survivor') for (const email of rows.keys()) if (sql.includes(`'${email}'`)) rows.delete(email);
        return [];
      }
      return [...rows.values()].filter(row => sql.includes(`'${row.email}'`));
  };
  let finalFailure;
  try {
    await runProvision({ fetch, d1, console, sessionSecret: 'inert-session', admin: 'inert-admin', backendFlags: {} });
    assert.fail('Scenario should reject');
  } catch (error) { finalFailure = error; }
  if (failure !== 'primary-lookup') assert.equal(finalFailure, originalFailure, 'Original failure object preserved');
  assert.ok(!logs.join('\n').includes(secret), 'No secret in unknown names/messages/stacks, causes, fields or provider bodies');
  const diagnostics = logs.filter(line => line.startsWith('HARNESS_DIAGNOSTIC '))
    .map(line => JSON.parse(line.slice('HARNESS_DIAGNOSTIC '.length)));
  if (failure === 'primary-lookup') {
    assert.ok(diagnostics.some(record => record.phase === 'primary' && record.operation === 'provider.lookup'
      && record.status === 402 && record.reason === 'http_failure'), 'Top-level catch emits safe provider context');
  } else assert.ok(diagnostics.some(record => record.phase === 'primary' && record.errorClass === 'Error'));
  for (const record of diagnostics) {
    assert.equal(record.runId, runId);
    assert.ok(Object.keys(record).every(key => ['phase', 'runId', 'errorClass', 'operation', 'reason', 'status'].includes(key)));
  }
  const expectedHttp = { lookup: ['provider.lookup', 401], 'lookup-many': ['provider.lookup', 401],
    delete: ['provider.delete', 403], inventory: ['provider.list', 503] }[cleanupFailure];
  if (expectedHttp) assert.ok(diagnostics.some(record => record.phase === 'cleanup'
    && record.operation === expectedHttp[0] && record.status === expectedHttp[1] && record.reason === 'http_failure'),
  'Cleanup emits the safe operation and HTTP status alongside the original failure');
  if (cleanupFailure === 'unknown') assert.ok(diagnostics.some(record => record.phase === 'cleanup'
    && record.errorClass === 'Error' && !record.operation && !record.status), 'Unknown aggregates are class-only');
  if (cleanupFailure === 'lookup-many') {
    assert.ok(diagnostics.some(record => record.reason === 'diagnostics_truncated'));
    assert.ok(diagnostics.filter(record => record.phase === 'cleanup').length <= 13);
  }
  assert.ok(!deleted.includes('unrelated')); assert.ok(keys.has('unrelated'));
  assert.ok(rows.has('unrelated@example.invalid'), 'D1 cleanup leaves unrelated rows untouched');
  assert.ok(sqlCalls.some(sql => sql.startsWith('DELETE') && sql.includes(runId)));
  if (!cleanupFailure && !['poisoned-d1', 'created-unowned'].includes(failure)) {
    assert.equal(keys.size, 199); assert.equal(rows.size, 1);
    assert.ok(deleted.includes('unrecorded-race-loser'), 'Rediscovery catches a key never in D1/inventory');
    assert.ok(deleted.includes('second-owner'), 'One scan discovers both exact run-owned names across pages');
    assert.ok(logs.some(line => line.includes('verified absent')));
  } else {
    assert.ok(logs.some(line => line.startsWith('FAIL cleanup')), 'Cleanup must fail closed');
    assert.ok(!logs.some(line => line.includes('verified absent')));
  }
  if (['poisoned-d1', 'created-unowned'].includes(failure)) {
    assert.equal(keys.size, 199, 'Verified owned keys still cleaned despite poisoned candidate');
    assert.equal(rows.size, 1);
    assert.ok(deleted.includes('owned'));
  }
  if (['lookup', 'lookup-many'].includes(cleanupFailure)) assert.equal(deleted.length, 0, 'Failed provider lookup cannot authorize any deletion');
  assert.equal(scans.length, 2, 'Cleanup scans once for discovery and once for absence verification, not once per email');
  for (const offsets of scans) assert.deepEqual(offsets, Array.from({ length: offsets.length }, (_, i) => i * 100));
  if (!['inventory', 'unknown'].includes(cleanupFailure)) assert.deepEqual(scans[0], [0, 100, 200], 'Discovery traverses all pages');
  if (!['inventory', 'unknown'].includes(cleanupFailure)) assert.deepEqual(scans[1],
    Array.from({ length: Math.floor(keys.size / 100) + 1 }, (_, i) => i * 100), 'Absence verification traverses all pages');
  return owner;
}
const first = await scenario('before-inventory');
const second = await scenario('after-inventory');
assert.notEqual(first, second, 'Each run has a unique ownership identity');
await scenario('poisoned-d1');
await scenario('created-unowned');
await scenario('primary-lookup');
for (const failure of ['inventory', 'delete', 'survivor', 'lookup', 'd1-survivor', 'unknown', 'lookup-many'])
  await scenario('after-inventory', failure);

// Reach the real concurrent-first-use stage. One mint fails immediately while
// the other seven finish later: cleanup must wait, discover and delete them all.
async function concurrentMintFailure() {
  const rows = new Map(), keys = new Map(), claims = new Map(), logs = [];
  const original = new Error('inert concurrent failure');
  let tokenNumber = 0, claimNumber = 0, keyNumber = 0, started = 0, finished = 0, scans = 0;
  let firstEmail;
  const d1 = sql => {
    const selected = [...rows.values()].filter(row => sql.includes(`'${row.email}'`));
    if (sql.startsWith('DELETE')) { for (const row of selected) rows.delete(row.email); return []; }
    return sql.includes('count(*)') ? [{ n: selected.length }] : selected;
  };
  const mint = row => {
    row.or_key_hash = `hash-${++keyNumber}`;
    row.or_key_secret = 'inert';
    keys.set(row.or_key_hash, { hash: row.or_key_hash, name: `BayLeaf API for ${row.email}`, limit: 5 });
  };
  const provision = email => {
    const row = rows.get(email) ?? { email, or_key_hash: null, or_key_secret: null };
    row.bayleaf_token = 'sk-bayleaf-' + (++tokenNumber).toString(16).padStart(32, '0');
    row.revoked = 0; rows.set(email, row); return row;
  };
  const cookieEmail = options => JSON.parse(Buffer.from(options.headers.Cookie.split('.')[1], 'base64url')).email;
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'openrouter.ai') {
      if (url.pathname.endsWith('/keys')) {
        if (url.searchParams.get('limit') === '1') return Response.json({ data: [] });
        assert.equal(finished, 7, 'All successful late mints drain before cleanup discovery');
        scans++;
        return Response.json({ data: [...keys.values()] });
      }
      const hash = url.pathname.split('/').at(-1);
      if (options.method === 'DELETE') { keys.delete(hash); return Response.json({}); }
      return keys.has(hash) ? Response.json({ data: keys.get(hash) }) : new Response(null, { status: 404 });
    }
    assert.equal(url.origin, 'http://localhost:8799');
    if (url.pathname === '/key') {
      const email = cookieEmail(options); firstEmail ??= email;
      const row = rows.get(email);
      if (options.method === 'DELETE') {
        if (!row) return new Response(null, { status: 404 });
        row.revoked = 1; return Response.json({});
      }
      if (row && !row.revoked) return new Response(null, { status: 409 });
      return Response.json({ key: provision(email).bayleaf_token });
    }
    if (url.pathname === '/v1/auth/key') {
      const row = [...rows.values()].find(row => `Bearer ${row.bayleaf_token}` === options.headers.Authorization);
      if (!row || row.revoked) return new Response(null, { status: 401 });
      if (row.email !== firstEmail) {
        const attempt = ++started;
        if (attempt === 1) throw original;
        // Yield beyond the rejection so fail-fast Promise.all would leak keys.
        await Promise.resolve(); await Promise.resolve();
        mint(row); finished++;
      } else if (!keys.has(row.or_key_hash)) mint(row);
      return Response.json({ data: { limit: 5, label: 'sk-or-elided...key', bayleaf: { openrouter: {} } } });
    }
    if (url.pathname === '/dashboard') {
      const row = rows.get(cookieEmail(options));
      if (!keys.has(row.or_key_hash)) mint(row);
      return new Response(row.email);
    }
    if (url.pathname === '/auth/claim/initiate') {
      const claim = { user_code: `AAAA-${String(++claimNumber).padStart(4, '0')}`, device_code: String(claimNumber).padStart(32, '0') };
      claims.set(claim.device_code, claim); return Response.json(claim);
    }
    if (url.pathname === '/auth/claim') return new Response('<input name="token" value="inert-csrf">');
    if (url.pathname === '/auth/claim/approve') {
      const claim = [...claims.values()].find(claim => claim.user_code === options.body.get('code'));
      const email = cookieEmail(options);
      claim.key = (rows.get(email) ?? provision(email)).bayleaf_token;
      return Response.json({});
    }
    if (url.pathname === '/auth/claim/poll') {
      const claim = claims.get(url.searchParams.get('d'));
      if (!claim) return new Response(null, { status: 404 });
      if (!claim.key) return new Response(null, { status: 202 });
      claims.delete(claim.device_code); return Response.json({ key: claim.key });
    }
    assert.fail('Unexpected synthetic HTTP path');
  };
  await assert.rejects(runProvision({ fetch, d1, sessionSecret: 'inert-session', admin: 'inert-admin', backendFlags: {},
    console: { log: line => logs.push(line), error: line => logs.push(line) } }), error => error === original);
  assert.equal(started, 8); assert.equal(finished, 7);
  assert.equal(keys.size, 0); assert.equal(rows.size, 0);
  assert.equal(scans, 2, 'One discovery and one absence scan cover both owners');
  assert.ok(!logs.some(line => /^  FAIL/.test(line)), 'Lifecycle reaches concurrent stage without assertion failures');
  assert.ok(logs.some(line => line.includes('verified absent')));
}
await concurrentMintFailure();
console.log('PASS CLI guard/import silence, 12 synthetic exception/cleanup paths plus concurrent mint draining, paginated two-name discovery, bounded safe diagnostics, original failure identity, no content logging');
