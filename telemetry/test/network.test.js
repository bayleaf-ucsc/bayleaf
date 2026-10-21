import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { campusAddressStatus } from '../../api/src/utils/ipRanges.js';
import { browserNetworkLocation } from '../src/browser-policy.js';
import { createWorker } from '../src/worker.js';
import { database } from './d1.js';
import { DAY } from '../src/policies.js';

const NOW = 1_790_000_000_000;
const READ = 'synthetic-read-secret-1234567890';
const WRITE = 'synthetic-write-secret-123456789';
const payload = { schema_version: 1, destination: 'landing', referring_hostname: null };
const envFor = db => ({ TELEMETRY_ENABLED: 'true', BROWSER_ENABLED: 'true', TELEMETRY_DB: db,
  RETENTION_DAYS: '90', READ_SECRET: READ, WRITE_KEYS_JSON: JSON.stringify({ 'chat-retention': WRITE }) });
const request = (headers = {}, body = payload) => new Request('https://telemetry.invalid/v1/browser', {
  method: 'POST', headers: { Origin: 'https://bayleaf.dev', 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const migration = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

test('shared canonical CIDRs: every IPv4 and IPv6 boundary, case and compression', () => {
  for (const [before, first, last, after] of [
    ['128.113.255.255', '128.114.0.0', '128.114.255.255', '128.115.0.0'],
    ['169.232.255.255', '169.233.0.0', '169.233.255.255', '169.234.0.0'],
    ['192.35.219.255', '192.35.220.0', '192.35.220.255', '192.35.221.0'],
    ['192.35.222.255', '192.35.223.0', '192.35.223.255', '192.35.224.0'],
    ['2607:f5ef:ffff:ffff:ffff:ffff:ffff:ffff', '2607:f5f0::',
      '2607:f5f0:ffff:ffff:ffff:ffff:ffff:ffff', '2607:f5f1::'],
  ]) {
    assert.equal(campusAddressStatus(before), false);
    assert.equal(campusAddressStatus(first), true);
    assert.equal(campusAddressStatus(last), true);
    assert.equal(campusAddressStatus(after), false);
  }
  assert.equal(campusAddressStatus('2607:F5F0:0000:0000:0000:0000:0000:0001'), true);
  assert.equal(campusAddressStatus('2607:f5f0::192.0.2.1'), true);
  assert.equal(campusAddressStatus('::ffff:128.114.0.1'), false, 'mapped IPv6 is not in the configured IPv6 campus range');
  assert.equal(campusAddressStatus('127.0.0.1', '127.0.0.1/32,::1/128'), true);
  assert.equal(campusAddressStatus('::1', '127.0.0.1/32,::1/128'), true);
  assert.equal(campusAddressStatus('192.0.2.1', '0.0.0.0/0'), true);
  assert.equal(campusAddressStatus('::1', '::/0'), true);
  const ranges = JSON.parse(readFileSync(new URL('../../api/src/utils/campus-networks.json', import.meta.url), 'utf8')).join(',');
  for (const ip of ['128.114.0.0', '169.233.255.255', '192.35.220.255', '192.35.223.0',
    '2607:F5F0::1', '192.0.2.1', '2607:f5f1::', 'invalid'])
    assert.equal(campusAddressStatus(ip, '@ucsc'), campusAddressStatus(ip, ranges));
  const apiConfig = readFileSync(new URL('../../api/wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(apiConfig, /"CAMPUS_IP_RANGES":\s*"@ucsc"/);
});

test('missing/invalid addresses are unknown, never loosely parsed or echoed', () => {
  for (const ip of [null, '', 'garbage', '128.114.0.1junk', '128.114.0.256', '128.114.0.-1',
    '128.114..1', '128.114.0.01', '128.114.0.1:443', '128.114.0.1, 192.0.2.1',
    '2607:f5f0:::1', '2607:f5f0::1::2', '2607:f5f0::gg', '2607:f5f0:0:0:0:0:0:0:1',
    '2607:f5f0::0:0:0:0:0:1', '[2607:f5f0::1]', '2607:f5f0::1%en0', '2607:f5f0::12345']) {
    assert.equal(campusAddressStatus(ip), null);
  }
  for (const config of ['', '@unknown', '@UCSC', '128.114.0.0/33', '2607:f5f0::/129', '128.114.0.0/16junk', '::/32/64'])
    assert.equal(campusAddressStatus('128.114.0.1', config), null);
  assert.equal(browserNetworkLocation(request({ 'X-Forwarded-For': '128.114.0.1', Forwarded: 'for=128.114.0.1' })), 'unknown');
  assert.equal(browserNetworkLocation(request({ 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': '128.114.0.1' })), 'other-network');
  assert.equal(browserNetworkLocation(request({ 'CF-Connecting-IP': '128.114.0.1', 'X-Forwarded-For': '192.0.2.1' })), 'campus-network');
});

test('collector enriches browser rows only, rejects client dimensions and retains no addresses', async t => {
  const db = database(); t.after(() => db.close());
  let now = NOW;
  const worker = createWorker({ clock: () => now }), env = envFor(db);
  for (const [headers, expected] of [
    [{ 'CF-Connecting-IP': '128.114.0.1' }, 'campus-network'],
    [{ 'CF-Connecting-IP': '2607:f5f0::1' }, 'campus-network'],
    [{ 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': '128.114.0.1' }, 'other-network'],
    [{ 'CF-Connecting-IP': '128.114.0.1junk' }, 'unknown'],
    [{ 'X-Forwarded-For': '128.114.0.1' }, 'unknown'],
    [{}, 'unknown'],
  ]) {
    const response = await worker.fetch(request(headers), env);
    assert.equal(response.status, 202);
    assert.equal(db.sql.prepare('SELECT network_location FROM browser_observations ORDER BY id DESC LIMIT 1').get().network_location, expected);
  }
  for (const field of ['network_location', 'campus_network', 'ip', 'prefix', 'ip_hash']) {
    assert.equal((await worker.fetch(request({}, { ...payload, [field]: 'campus-network' }), env)).status, 400);
  }
  const read = () => worker.fetch(new Request(`https://telemetry.invalid/v1/read/browser?from=${NOW - 1}&to=${NOW + 1}&limit=50`,
    { headers: { Authorization: `Bearer ${READ}` } }), env);
  const result = await (await read()).json();
  assert.equal(result.schema_version, 2); assert.equal(result.policy_version, 3);
  assert.equal(result.rows.length, 6);
  assert.ok(result.rows.every(row => row.schema_version === 2 && row.policy_version === 3));
  assert.doesNotMatch(JSON.stringify(result), /128\.114|192\.0\.2|f5f0|forwarded/i);
  for (const table of ['metric_points', 'deletion_runs', 'probe_runs', 'source_status'])
    assert.ok(!db.sql.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'network_location'));
  const deletion = new Request('https://telemetry.invalid/v1/deletions', { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${WRITE}`, 'CF-Connecting-IP': '128.114.0.1',
  }, body: JSON.stringify({ schema_version: 1, source: 'chat-retention', batch_id: crypto.randomUUID(), observed_at: NOW,
    job: 'chat-retention', outcome: 'success', duration_ms: 1, deleted: 0, extensions: {} }) });
  assert.equal((await worker.fetch(deletion, env)).status, 202);
  assert.equal(db.sql.prepare('SELECT policy_version FROM deletion_runs').get().policy_version, 4);
  now = NOW + 90 * DAY;
  // Bounded read cannot span 90 days; use storage for exact original-time read.
  const { readRows } = await import('../src/store.js');
  assert.equal((await readRows(db, 'browser', { from: NOW - 1, to: NOW + 1, limit: 50 }, now, env)).length, 0);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM browser_observations').get().n, 6);
  await worker.scheduled({}, env);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM browser_observations').get().n, 0);
});

test('migration preserves historical versions, expiry and unknown classification', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration('0001_telemetry.sql'));
    db.prepare('INSERT INTO browser_observations VALUES (1,1,2,?,?,?,\'landing\',NULL)').run(NOW, NOW, NOW + DAY);
    db.exec(migration('0002_retention_state.sql'));
    db.exec(migration('0003_browser_network.sql'));
    const row = db.prepare('SELECT * FROM browser_observations').get();
    assert.equal(row.network_location, 'unknown'); assert.equal(row.schema_version, 1);
    assert.equal(row.policy_version, 2); assert.equal(row.expires_at, NOW + DAY);
    assert.throws(() => db.prepare('UPDATE browser_observations SET network_location=?').run('128.114.0.1'));
  } finally { db.close(); }
});

test('workerd / D1 admits and privately reads coarse browser classification', async t => {
  const local = createRequire(import.meta.url), api = createRequire(new URL('../../api/package.json', import.meta.url));
  const dependency = name => { try { return local(name); } catch { return api(name); } };
  const { build } = dependency('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = dependency('miniflare');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const apiBundle = await build({ entryPoints: [fileURLToPath(new URL('../../api/src/utils/ip.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser' });
  const { campusNetworkStatus, isCampusPassEligible } = await import(`data:text/javascript;base64,${Buffer.from(apiBundle.outputFiles[0].text).toString('base64')}`);
  const apiEnv = { CAMPUS_IP_RANGES: '@ucsc', CAMPUS_POOL_KEY: 'synthetic' };
  assert.equal(isCampusPassEligible(request({ 'CF-Connecting-IP': '128.114.0.1' }), apiEnv), true);
  for (const headers of [{}, { 'CF-Connecting-IP': '128.114.0.1junk' }, { 'X-Forwarded-For': '128.114.0.1' }]) {
    assert.equal(campusNetworkStatus(request(headers), apiEnv), null);
    assert.equal(isCampusPassEligible(request(headers), apiEnv), false);
  }
  assert.equal(isCampusPassEligible(request({ 'CF-Connecting-IP': '128.114.0.1' }), { ...apiEnv, CAMPUS_IP_RANGES: '@unknown' }), false);
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import { createWorker } from './src/worker.js'; export default createWorker({clock:()=>${NOW}});
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const { TELEMETRY_DB, ...bindings } = envFor(null);
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-08-01', d1Databases: ['TELEMETRY_DB'], bindings,
    outboundService: () => { throw new Error('No outbound calls permitted'); } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('TELEMETRY_DB');
  for (const file of ['0001_telemetry.sql', '0002_retention_state.sql', '0003_browser_network.sql', '0004_daytona_lifecycle.sql'])
    for (const stmt of migration(file).replace(/^\s*--.*$/gm, '').split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
  const req = request({ 'CF-Connecting-IP': '2607:f5f0::1', 'X-Forwarded-For': '192.0.2.1' });
  assert.equal((await mf.dispatchFetch(req.url, { method: req.method, headers: req.headers, body: await req.text() })).status, 202);
  const result = await mf.dispatchFetch(`https://telemetry.invalid/v1/read/browser?from=${NOW - 1}&to=${NOW + 1}&limit=10`,
    { headers: { Authorization: `Bearer ${READ}` } });
  const data = await result.json();
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].network_location, 'campus-network');
  assert.equal(data.rows[0].schema_version, 2);
});
