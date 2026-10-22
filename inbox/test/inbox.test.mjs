// Contract tests for the BayLeaf Inboxes Worker, written from inbox/DESIGN.md alone.
//
// Harness (workerd through Miniflare 5, no network):
// - `inbox`: the Worker under test, bundled with esbuild inside a thin wrapper that
//   re-exports everything (so `InboxManagement` stays a named entrypoint) and adds one
//   test-only host, `email-harness.invalid`, which calls the real email() handler with a
//   hand-built message. Miniflare's own /cdn-cgi/local/email route parses the MIME first
//   and refuses unparseable input, so parse_error can only be reached this way.
// - `edge`: a forwarder in front of `inbox` for HTTP reception. Miniflare's dispatchFetch
//   always sends chunked bodies and rewrites Host to 127.0.0.1; the edge sets Host from
//   the URL and buffers the body so Content-Length is real, unless the request carries
//   `x-harness-stream: 1`, in which case the body stays a stream with no length.
// - `rpc`: stands in for the API's service binding to the `InboxManagement` entrypoint.
//   POST /rpc/<method> with a JSON array of arguments. Response results are buffered and
//   their original status and headers returned in x-rpc-* headers. A thrown error becomes
//   {__thrown}, which the contract forbids.
// - Email reception goes through Miniflare's /cdn-cgi/local/email?format=json route, whose
//   JSON reply exposes the setReject reason. The scheduled sweep runs via getWorker().scheduled().
// - Time travel is done by editing D1 rows directly.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign';
import { exportTests } from './export-cases.mjs';

const local = createRequire(import.meta.url);
const { build } = local('esbuild');
const { Miniflare, convertV4MiniflareOptions } = local('miniflare');
const { default: PostalMime } = await import(new URL('../node_modules/postal-mime/dist/esm/postal-mime.js', import.meta.url));

const DOMAIN = 'bayleaf-inboxes.dev';
const COMPAT = '2026-08-01';
const CRON = '*/15 * * * *';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Small overrides keep the tests fast. DESTROY_QUIESCE_SECONDS stays at its default:
// receivers abort when they exceed a third of it, so 0 would break all reception.
const LIMITS = {
  RETENTION_SECONDS: '7776000',
  MAX_INBOXES_PER_OWNER: '3',
  MAX_CREDENTIALS_PER_INBOX: '3',
  MAX_HTTP_BODY_BYTES: '1024',
  MAX_EMAIL_BYTES: '65536',
  MAX_INBOX_BYTES: '65536',
  MAX_OWNER_BYTES: '200000',
  MAX_INBOX_MESSAGES: '5000',
  MAX_DAILY_RECEIPTS: '50',
  MAX_SEARCH_TEXT: '32768',
  DESTROY_QUIESCE_SECONDS: '900',
};

function telemetryTests() { describe('content-free telemetry in real workerd/D1', () => {
  it('counts reception/lifecycle and retries the same sealed export without leaking content', async () => {
    const exports = [];
    const h = await harness({ vars: { INBOX_TELEMETRY_ENABLED: 'true',
      INBOX_TELEMETRY_WRITE_SECRET: 'synthetic-inboxes-writer-for-local-tests' },
      telemetrySend: async request => {
        assert.equal(request.url, 'https://telemetry.bayleaf.dev/v1/metrics');
        exports.push(await request.text());
        return new Response(null, { status: exports.length === 1 ? 503 : 202 });
      } });
    try {
      const own = owner(), ibx = await h.create(own, 'http');
      assert.equal((await h.http(ibx.url + 'private-path', { method: 'POST', body: 'private-body' })).status, 200);
      const current = (await h.db.prepare('SELECT start_at FROM telemetry_windows').first()).start_at;
      const old = current - 900000;
      await h.db.batch([
        h.db.prepare('INSERT INTO telemetry_windows(start_at,batch_id) VALUES (?,?)').bind(old, crypto.randomUUID()),
        h.db.prepare('UPDATE telemetry_counts SET start_at=? WHERE start_at=?').bind(old, current),
        h.db.prepare('DELETE FROM telemetry_windows WHERE start_at=?').bind(current),
      ]);
      await h.sweep();
      await h.sweep();
      assert.equal(exports.length, 2);
      assert.equal(exports[0], exports[1]);
      const payload = JSON.parse(exports[0]);
      assert.deepEqual(payload.points.map(p => p.name).sort(), ['inbox.lifecycle', 'inbox.receipts']);
      for (const secret of [own, ibx.id, ibx.url, 'private-path', 'private-body', 'synthetic-inboxes-writer'])
        assert.ok(!exports[0].includes(secret));
      assert.equal((await h.db.prepare('SELECT sent FROM telemetry_windows WHERE start_at=?').bind(old).first()).sent, 1);
    } finally { await h.mf.dispose(); }
  });
}); }

// ---------------------------------------------------------------- bundling

// INBOX_WORKER_SRC (relative to inbox/) lets a mutation check point the suite at a
// deliberately broken copy of the Worker; normal runs use src/worker.js.
const SRC = `./${process.env.INBOX_WORKER_SRC ?? 'src/worker.js'}`;
const WRAPPER = `
import * as mod from '${SRC}';
export * from '${SRC}';
const inner = mod.default;
function call(name, arg, env, ctx) {
  if (typeof inner === 'function') return new inner(ctx, env)[name](arg);
  return inner[name](arg, env, ctx);
}
function crudeHeaders(bytes) {
  const h = new Headers();
  try {
    let s = '';
    for (let i = 0; i < Math.min(bytes.length, 65536); i++) s += String.fromCharCode(bytes[i]);
    const end = s.search(/\\r?\\n\\r?\\n/);
    const block = (end < 0 ? s : s.slice(0, end)).replace(/\\r?\\n[ \\t]+/g, ' ');
    for (const line of block.split(/\\r?\\n/)) {
      const i = line.indexOf(':');
      if (i > 0 && /^[!-9;-~]+$/.test(line.slice(0, i))) h.append(line.slice(0, i), line.slice(i + 1).trim());
    }
  } catch {}
  return h;
}
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.hostname === 'expiry-harness.invalid') {
      const { method, args, point, latch } = await req.json();
      let paused = false;
      let dbCalls = 0, dbStatements = 0;
      const gate = async name => {
        if (!paused && name.includes(point)) {
          paused = true;
          await env.PUT_GATE.fetch('https://put-gate.invalid/' + latch);
        }
      };
      const originals = new Map();
      const statement = (raw, sql) => {
        const wrapped = new Proxy(raw, { get(target, key) {
          if (key === 'bind') return (...values) => statement(target.bind(...values), sql);
          if (['first', 'all', 'run'].includes(key)) return async (...values) => {
            dbCalls++; dbStatements++;
            await gate(sql);
            const result = await target[key](...values);
            await gate('after:' + sql);
            return result;
          };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        originals.set(wrapped, { raw, sql });
        return wrapped;
      };
      const db = { prepare: sql => statement(env.DB.prepare(sql), sql), batch: async statements => {
        const items = statements.map(s => originals.get(s));
        dbCalls++; dbStatements += items.length;
        if (point === 'fail-transition' && items.some(s => s.sql.includes('INSERT OR IGNORE INTO cleanup_prefixes')))
          throw new Error('synthetic transition failure');
        await gate(items.map(s => s.sql).join(' '));
        const result = await env.DB.batch(items.map(s => s.raw));
        await gate('after:' + items.map(s => s.sql).join(' '));
        return result;
      } };
      const blobs = new Proxy(env.BLOBS, { get(target, key) {
        if (key === 'get') return async (...values) => {
          const object = await target.get(...values);
          await gate('R2 read');
          return object;
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const wrapped = { ...env, DB: db, BLOBS: blobs };
      if (method === 'sweep') {
        await call('scheduled', {}, wrapped, ctx);
        return Response.json({ dbCalls, dbStatements });
      }
      if (method === 'receive') return call('fetch', new Request(args[0], { method: 'POST', body: 'delayed' }), wrapped, ctx);
      const result = await new mod.InboxManagement(ctx, wrapped)[method](...args);
      return result instanceof Response ? result : Response.json(result);
    }
    if (u.hostname === 'body-harness.invalid') {
      const { target, headers, statements } = await req.json();
      // Direct reader wrapper pauses the body at the precise post-preauth boundary.
      // Execute concurrent management changes before delivering its final bytes.
      let done = false;
      const body = { getReader() { return {
        async read() {
          if (done) return { done: true };
          done = true;
          await env.DB.batch(statements.map(s => env.DB.prepare(s.sql).bind(...s.args)));
          return { done: false, value: new TextEncoder().encode('slow body') };
        }, async cancel() {},
      }; } };
      return call('fetch', { url: target, method: 'POST', headers: new Headers(headers), body }, env, ctx);
    }
    const delay = req.headers.get('x-harness-delay-put');
    if (delay) {
      const blobs = env.BLOBS;
      const wrapped = new Proxy(blobs, { get(target, key) {
        if (key === 'put') return async (...args) => {
          // Hold a real pending subrequest, not a cross-request isolate promise
          // (workerd correctly cancels the latter as a hung request).
          await env.PUT_GATE.fetch('https://put-gate.invalid/' + delay);
          return target.put(...args);
        };
        if (key === 'delete') return async () => { throw new Error('injected late cleanup failure'); };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return call('fetch', req, { ...env, BLOBS: wrapped }, ctx);
    }
    if (u.hostname === 'email-harness.invalid') {
      const bytes = new Uint8Array(await req.arrayBuffer());
      let rejectReason, threw = null;
      const message = {
        from: u.searchParams.get('from'), to: u.searchParams.get('to'),
        rawSize: Number(u.searchParams.get('rawSize') ?? bytes.byteLength),
        headers: crudeHeaders(bytes), raw: new Response(bytes).body,
        setReject(reason) { rejectReason = String(reason); },
        async forward() { throw new Error('forward is not permitted'); },
        async reply() { throw new Error('reply is not permitted'); },
      };
      try { await call('email', message, env, ctx); } catch (e) { threw = String((e && e.message) || e); }
      return Response.json({ outcome: threw ? 'exception' : 'ok', rejectReason, threw });
    }
    return call('fetch', req, env, ctx);
  },
  email(message, env, ctx) { return call('email', message, env, ctx); },
  scheduled(controller, env, ctx) { return call('scheduled', controller, env, ctx); },
};`;

const EDGE = `export default { async fetch(req, env) {
  const u = new URL(req.url);
  const h = new Headers(req.headers);
  const stream = h.get('x-harness-stream') === '1';
  h.delete('x-harness-stream'); h.delete('transfer-encoding'); h.delete('content-length');
  h.set('host', u.host);
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') body = stream ? req.body : await req.arrayBuffer();
  return env.INBOX.fetch(new Request(req.url, { method: req.method, headers: h, body, redirect: 'manual' }));
} };`;

const RPC = `export default { async fetch(req, env) {
  const method = new URL(req.url).pathname.split('/')[2];
  const args = await req.json();
  let r;
  try { r = await env.INBOXES[method](...args); }
  catch (e) { return Response.json({ __thrown: String((e && e.message) || e) }, { status: 500 }); }
  if (r instanceof Response) {
    if (new URL(req.url).searchParams.has('cancel')) {
      const reader = r.body.getReader();
      await reader.read();
      await reader.cancel();
      return Response.json({ cancelled: true });
    }
    const headers = encodeURIComponent(JSON.stringify([...r.headers]));
    let buf, streamError = '';
    try { buf = await r.arrayBuffer(); } catch { buf = new ArrayBuffer(0); streamError = '1'; }
    return new Response(buf, { headers: { 'x-rpc-response': String(r.status), 'x-rpc-headers': headers, 'x-rpc-stream-error': streamError } });
  }
  return Response.json(r === undefined ? { __undefined: true } : r);
} };`;

const bundle = (await build({
  absWorkingDir: ROOT, stdin: { resolveDir: ROOT, contents: WRAPPER, sourcefile: 'test-wrapper.js' },
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'node:*'],
})).outputFiles[0].text;

// Preserve file boundaries for pre-events backfill fixtures, discovering every migration.
const migrations = await Promise.all((await readdir(new URL('../migrations/', import.meta.url)))
  .filter(f => f.endsWith('.sql')).sort().map(async file => ({ file,
    statements: (await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
      .replace(/--.*$/gm, '').match(/\s*(?:CREATE TRIGGER[\s\S]*?END|[^;]+);/g).map(s => s.trim()),
  })));

// ---------------------------------------------------------------- harness

const noNet = () => { throw new Error('No outbound network in tests'); };
telemetryTests();

describe('creation-only authenticated email restriction in real workerd/D1/R2', () => {
  const encoding = { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'der' } };
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048, ...encoding });
  const ed = generateKeyPairSync('ed25519', encoding);
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024, ...encoding });
  const policy = { domains: ['ucsc.edu'], selector_pins: {} };
  const raw = 'From: Author <author@ucsc.edu>\r\nTo: ignored@example.net\r\nSubject: Signed fixture\r\n\r\nOriginal body.\r\n';
  const keys = {
    'campus_key._domainkey.ucsc.edu': `v=DKIM1; k=rsa; p=${rsa.publicKey.toString('base64')}`,
    'campus_key._domainkey.other.example': `v=DKIM1; k=rsa; p=${rsa.publicKey.toString('base64')}`,
    'ed._domainkey.ucsc.edu': `v=DKIM1; k=ed25519; p=${ed.publicKey.subarray(-32).toString('base64')}`,
    'weak._domainkey.ucsc.edu': `v=DKIM1; k=rsa; p=${weak.publicKey.toString('base64')}`,
    'revoked._domainkey.ucsc.edu': 'v=DKIM1; k=rsa; p='
  };
  const signed = async (text = raw, signatures = [{}]) => {
    const s = await dkimSign(text, { signatureData: signatures.map(extra => ({
      signingDomain: 'ucsc.edu', selector: 'campus_key', privateKey: rsa.privateKey, ...extra
    })) });
    assert.deepEqual(s.errors, []);
    return s.signatures + text;
  };
  let h, valid, validEd, onDns;
  before(async () => {
    valid = await signed();
    validEd = await signed(raw, [{ selector: 'ed', privateKey: ed.privateKey }]);
    h = await harness({ vars: { MAX_INBOXES_PER_OWNER: '100', MAX_EMAIL_BYTES: '26214400',
      MAX_INBOX_BYTES: '41943040', MAX_OWNER_BYTES: '104857600' }, ratelimits: { accept: 1000, reject: 1000 },
      dnsSend: async req => {
        const u = new URL(req.url);
        assert.equal(u.origin, 'https://cloudflare-dns.com');
        assert.equal(u.pathname, '/dns-query');
        assert.equal(u.searchParams.get('type'), 'TXT');
        assert.equal(req.headers.get('accept'), 'application/dns-json');
        if (onDns) { const callback = onDns; onDns = null; await callback(); }
        const key = keys[u.searchParams.get('name').toLowerCase()];
        if (key === 'servfail') return Response.json({ Status: 2 });
        if (key === 'oversized') return new Response('x'.repeat(32769));
        if (key === 'http-error') return new Response('unavailable', { status: 503 });
        if (key === 'timeout') { await new Promise(resolve => setTimeout(resolve, 1700)); return Response.json({ Status: 2 }); }
        return Response.json(key ? { Status: 0, Answer: [{ type: 16, data: JSON.stringify(key) }] } : { Status: 3 });
      } });
  });
  after(async () => { await h?.mf.dispose(); });

  it('normalizes and reports immutable policy only to its owner', async () => {
    const a = owner(), b = owner();
    const ibx = await h.create(a, 'email', { email_auth: { domains: ['UCSC.EDU'], selector_pins: { 'UCSC.EDU': ['Campus_Key'] } } });
    const expected = { domains: ['ucsc.edu'], selector_pins: { 'ucsc.edu': ['campus_key'] } };
    assert.deepEqual(ibx.email_auth, expected);
    assert.equal(ibx.restricted_email_max_bytes, 1048576);
    assert.deepEqual((await h.rpc('getInbox', a, ibx.id)).email_auth, expected);
    assert.deepEqual((await h.rpc('listInboxes', a)).inboxes[0].email_auth, expected);
    isErr(await h.rpc('getInbox', b, ibx.id), 'not_found');
    assert.equal((await h.rpc('listInboxes', b)).inboxes.length, 0);
    await assert.rejects(h.db.prepare('UPDATE inboxes SET email_auth_json=NULL WHERE id=?').bind(ibx.id).run(), /immutable/);
    assert.deepEqual((await h.rpc('getInbox', a, ibx.id)).email_auth, expected);
  });

  it('rejects malformed policy and restrictions on HTTP without creating rows', async () => {
    const a = owner();
    for (const email_auth of [false, {}, { domains: [] }, { domains: ['*.ucsc.edu'] },
      { domains: ['user@ucsc.edu'] }, { domains: ['ucsc.edu', 'UCSC.EDU'] },
      { domains: ['ucsc.edu'], extra: true }, { domains: ['ucsc.edu'], selector_pins: { 'other.edu': ['s1'] } },
      { domains: ['ucsc.edu'], selector_pins: { 'ucsc.edu': [] } },
      { domains: ['ucsc.edu'], selector_pins: { 'ucsc.edu': ['bad..label'] } }]) {
      isErr(await h.rpc('createInbox', a, { type: 'email', email_auth }), 'invalid');
    }
    isErr(await h.rpc('createInbox', a, { type: 'http', access: 'open', email_auth: policy }), 'invalid');
    assert.equal((await h.rpc('listInboxes', a)).inboxes.length, 0);
  });

  it('preserves explicitly unrestricted reception, including omitted/null policy', async () => {
    for (const extra of [{}, { email_auth: null }]) {
      const ibx = await h.create(owner(), 'email', extra);
      assert.equal(ibx.email_auth, null);
      assert.equal(ibx.restricted_email_max_bytes, undefined);
      assert.equal((await h.emailDirect({ to: ibx.address, raw })).rejectReason, undefined);
      assert.equal((await h.db.prepare('SELECT email_auth_json FROM inboxes WHERE id=?').bind(ibx.id).first()).email_auth_json, null);
    }
  });

  for (const gate of [undefined, 'false']) it(`creation gate ${gate ?? 'unset'} fails closed but never bypasses an existing policy`, async () => {
    const gated = await harness({ vars: { EMAIL_AUTH_CREATION_ENABLED: gate } });
    try {
      const a = owner();
      isErr(await gated.rpc('createInbox', a, { type: 'email', email_auth: policy }), 'disabled');
      const open = await gated.create(a, 'email');
      assert.equal(open.email_auth, null);
      // Simulate a previously created restricted inbox while creation is off.
      const local = b32(26), id = `ibx_${b32(26)}`;
      await gated.db.prepare(`INSERT INTO inboxes(id,owner,type,nonce,state,created_at,email_auth_json)
        VALUES(?,?,'email',?,'active',?,?)`).bind(id, a, local, now(), JSON.stringify(policy)).run();
      const result = await gated.emailDirect({ to: `${local}@${DOMAIN}`, raw });
      assert.equal(result.rejectReason, '5.7.1 DKIM domain authorization required');
    } finally { await gated.mf.dispose(); }
  });

  it('failed DKIM does not consume ACCEPT_LIMIT; successful DKIM does', async () => {
    const limited = await harness({ ratelimits: { accept: 1, reject: 10 }, dnsSend: async () =>
      Response.json({ Status: 0, Answer: [{ type: 16, data: JSON.stringify(keys['campus_key._domainkey.ucsc.edu']) }] }) });
    try {
      const ibx = await limited.create(owner(), 'email', { email_auth: policy });
      assert.match((await limited.emailDirect({ to: ibx.address, raw })).rejectReason, /5\.7\.1/);
      assert.equal((await limited.emailDirect({ to: ibx.address, raw: valid })).rejectReason, undefined);
      assert.match((await limited.emailDirect({ to: ibx.address, raw: valid })).rejectReason, /Rate limited/);
      assert.equal((await limited.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n, 1);
    } finally { await limited.mf.dispose(); }
  });

  for (const algorithm of ['RSA', 'Ed25519']) it(`accepts ${algorithm} and stores only local proof metadata`, async () => {
    const ibx = await h.create(owner(), 'email', { email_auth: policy });
    const result = await h.emailDirect({ to: ibx.address, raw: algorithm === 'RSA' ? valid : validEd });
    assert.equal(result.threw, null);
    assert.equal(result.rejectReason, undefined);
    const stored = await h.db.prepare('SELECT meta_json FROM messages WHERE inbox_id=?').bind(ibx.id).first();
    assert.deepEqual(JSON.parse(stored.meta_json).dkim_auth, { domain: 'ucsc.edu',
      selector: algorithm === 'RSA' ? 'campus_key' : 'ed', algo: algorithm === 'RSA' ? 'rsa-sha256' : 'ed25519-sha256' });
  });

  const failures = {
    'unsigned mail': () => raw,
    'copied Authentication-Results': () => 'Authentication-Results: trusted.example; dkim=pass header.d=ucsc.edu\r\n' + raw,
    'body tampered': () => valid.replace('Original body.', 'Changed body.'),
    'signed header tampered': () => valid.replace('Subject: Signed fixture', 'Subject: Changed'),
    'duplicate From': () => 'From: other@ucsc.edu\r\n' + valid,
    'l= even when full-body': () => signed(raw, [{ maxBodyLength: 99999 }]),
    'l= plus unsigned appended body': async () => (await signed(raw, [{ maxBodyLength: 4 }])) + 'Unsigned append\r\n',
    'missing key': () => signed(raw, [{ selector: 'missing' }]),
    'revoked key': () => signed(raw, [{ selector: 'revoked' }]),
    '1024-bit RSA': () => signed(raw, [{ selector: 'weak', privateKey: weak.privateKey }]),
    'unaligned signed domain': () => signed(raw, [{ signingDomain: 'other.example' }]),
    'relaxed-only From subdomain': () => signed(raw.replace('author@ucsc.edu', 'author@sub.ucsc.edu')),
    'five signatures': () => signed(raw, [{}, {}, {}, {}, {}]),
    'wrong pin': () => valid,
    'valid unpinned signature plus invalid pinned one': () => signed(raw, [
      { selector: 'ed', privateKey: rsa.privateKey }, {}
    ])
  };
  for (const [name, message] of Object.entries(failures)) it(`rejects ${name} before storing`, async () => {
    const pins = name.includes('pin') ? { 'ucsc.edu': ['ed'] } : {};
    const ibx = await h.create(owner(), 'email', { email_auth: { ...policy, selector_pins: pins } });
    const result = await h.emailDirect({ to: ibx.address, raw: await message() });
    assert.equal(result.rejectReason, '5.7.1 DKIM domain authorization required');
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n, 0);
    assert.equal((await h.r2.list({ prefix: `m/${ibx.id}/` })).objects.length, 0);
  });

  it('accepts replay (not prevented) and a same-signature selector pin', async () => {
    const ibx = await h.create(owner(), 'email', { email_auth: { ...policy, selector_pins: { 'ucsc.edu': ['campus_key'] } } });
    for (let i = 0; i < 2; i++) assert.equal((await h.emailDirect({ to: ibx.address, raw: valid })).rejectReason, undefined);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n, 2);
  });

  it('rechecks active state at reservation if destroyed during DKIM lookup', async () => {
    const ibx = await h.create(owner(), 'email', { email_auth: policy });
    onDns = () => h.db.prepare("UPDATE inboxes SET state='destroying', destroy_requested_at=? WHERE id=?")
      .bind(now(), ibx.id).run();
    const result = await h.emailDirect({ to: ibx.address, raw: valid });
    assert.equal(result.rejectReason, '5.1.1 Address not found');
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n, 0);
  });

  it('bounds restricted size by both declared and actual bytes without affecting open mail', async () => {
    const ibx = await h.create(owner(), 'email', { email_auth: policy });
    for (const request of [{ raw: valid, rawSize: 1048577 }, { raw: raw + 'a'.repeat(1048576), rawSize: 1 }]) {
      const result = await h.emailDirect({ to: ibx.address, ...request });
      assert.match(result.rejectReason, /5\.3\.4 Restricted inbox.*1 MiB/);
    }
    const open = await h.create(owner(), 'email');
    assert.equal((await h.emailDirect({ to: open.address, raw: raw + 'a'.repeat(1048576) })).rejectReason, undefined);
  });

  it('combines creation policy with TTL and denies expiry during DKIM lookup', async () => {
    const a = owner();
    const ibx = await h.create(a, 'email', { preset: 'experiment', email_auth: policy });
    assert.ok(ibx.expires_at >= now() + 898 && ibx.expires_at <= now() + 900);
    assert.deepEqual(ibx.email_auth, policy);
    isErr(await h.rpc('updateInbox', a, ibx.id, { email_auth: null }), 'invalid');
    onDns = () => h.db.prepare('UPDATE inboxes SET expires_at=? WHERE id=?').bind(now() - 1, ibx.id).run();
    const result = await h.emailDirect({ to: ibx.address, raw: valid });
    assert.equal(result.rejectReason, '5.1.1 Address not found');
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n, 0);
    assert.equal((await h.r2.list({ prefix: `m/${ibx.id}/` })).objects.length, 0);
  });

  it('verifies a near-cap signed message before MIME parsing and storage', async () => {
    const ibx = await h.create(owner(), 'email', { email_auth: policy });
    const big = await signed(raw + 'x'.repeat(1048576 - 4096));
    assert.ok(Buffer.byteLength(big) < 1048576 && Buffer.byteLength(big) > 1040000);
    const started = performance.now();
    const result = await h.emailDirect({ to: ibx.address, raw: big });
    assert.equal(result.rejectReason, undefined);
    assert.equal(result.threw, null);
    console.log(JSON.stringify({ restrictedNearCapBytes: Buffer.byteLength(big), endpointWallMs: Math.round(performance.now() - started) }));
  });

  it('bounds MIME metadata work independently of a valid DKIM signature', async () => {
    const ibx = await h.create(owner(), 'email', { email_auth: policy });
    const multipart = raw.replace('\r\n\r\nOriginal body.\r\n',
      '\r\nContent-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
      ('--fixture\r\nContent-Type: text/plain\r\n\r\nx\r\n').repeat(300) + '--fixture--\r\n');
    const result = await h.emailDirect({ to: ibx.address, raw: await signed(multipart) });
    assert.equal(result.rejectReason, '5.3.4 MIME resource limit exceeded');
    assert.equal(result.threw, null);
    const stored = await h.db.prepare('SELECT meta_json FROM messages WHERE inbox_id=?').bind(ibx.id).first();
    assert.equal(stored, null);
  });

  it('treats DNS SERVFAIL, oversized responses, HTTP failure and timeout as transient, never accepting', async () => {
    for (const key of ['servfail', 'oversized', 'http-error', 'timeout']) {
      keys[`${key}._domainkey.ucsc.edu`] = key;
      const ibx = await h.create(owner(), 'email', { email_auth: policy });
      const result = await h.emailDirect({ to: ibx.address, raw: await signed(raw, [{ selector: key }]) });
      assert.equal(result.threw, 'email authorization temporarily unavailable');
      assert.equal(result.rejectReason, undefined);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n, 0);
      assert.equal((await h.r2.list({ prefix: `m/${ibx.id}/` })).objects.length, 0);
    }
  });
});

async function harness({ vars = {}, ratelimits = { accept: 60, reject: 30 }, telemetrySend, dnsSend, beforeEvents } = {}) {
  const puts = new Map();
  const putLatch = id => {
    if (!puts.has(id)) {
      const latch = {};
      latch.started = new Promise(resolve => { latch.notify = resolve; });
      latch.resume = new Promise(resolve => { latch.release = resolve; });
      puts.set(id, latch);
    }
    return puts.get(id);
  };
  const bindings = { INBOXES_ENABLED: 'true', EMAIL_AUTH_CREATION_ENABLED: 'true', INBOX_DOMAIN: DOMAIN, ...LIMITS, ...vars };
  for (const k of Object.keys(bindings)) if (bindings[k] === undefined) delete bindings[k];
  const inbox = { name: 'inbox', modules: true, script: bundle, compatibilityDate: COMPAT,
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['BLOBS'], bindings, outboundService: dnsSend || telemetrySend || noNet,
    serviceBindings: { PUT_GATE: async req => {
      const latch = putLatch(new URL(req.url).pathname.slice(1));
      latch.notify();
      await latch.resume;
      return new Response('ok');
    } } };
  if (ratelimits) inbox.ratelimits = {
    ACCEPT_LIMIT: { namespace_id: '9701', simple: { limit: ratelimits.accept, period: 60 } },
    REJECT_LIMIT: { namespace_id: '9702', simple: { limit: ratelimits.reject, period: 60 } },
  };
  const mf = new Miniflare(convertV4MiniflareOptions({
    unsafeTriggerHandlers: true,
    workers: [
      inbox,
      { name: 'edge', modules: true, script: EDGE, compatibilityDate: COMPAT,
        serviceBindings: { INBOX: 'inbox' }, outboundService: noNet },
      { name: 'rpc', modules: true, script: RPC, compatibilityDate: COMPAT,
        serviceBindings: { INBOXES: { name: 'inbox', entrypoint: 'InboxManagement' } }, outboundService: noNet },
    ],
  }));
  const db = await mf.getD1Database('DB', 'inbox');
  for (const { file, statements } of migrations) {
    if (file === '0004_events.sql' && beforeEvents) await beforeEvents(db);
    for (const stmt of statements) await db.prepare(stmt).run();
  }
  const r2 = await mf.getR2Bucket('BLOBS', 'inbox');
  const inboxWorker = await mf.getWorker('inbox');
  const edge = await mf.getWorker('edge');
  const rpcWorker = await mf.getWorker('rpc');

  const h = {
    mf, db, r2,
    async rpc(method, ...args) {
      const r = await rpcWorker.fetch(`https://rpc.test/rpc/${method}`, { method: 'POST', body: JSON.stringify(args) });
      if (r.headers.has('x-rpc-response')) {
        return { response: true, status: Number(r.headers.get('x-rpc-response')),
          headers: new Headers(JSON.parse(decodeURIComponent(r.headers.get('x-rpc-headers')))),
          streamError: r.headers.get('x-rpc-stream-error') === '1',
          bytes: new Uint8Array(await r.arrayBuffer()) };
      }
      const j = await r.json();
      assert.equal(j.__thrown, undefined, `RPC ${method} threw: ${j.__thrown}`);
      return j;
    },
    async http(url, init = {}) {
      const r = await edge.fetch(url, init);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, headers: r.headers, bytes, text: new TextDecoder().decode(bytes) };
    },
    async email({ to, raw, from = 'sender@example.org' }) {
      const q = new URLSearchParams({ format: 'json', from, to });
      const r = await mf.dispatchFetch(`http://localhost/cdn-cgi/local/email?${q}`, { method: 'POST', body: raw });
      const text = await r.text();
      try { return JSON.parse(text); } catch { return { outcome: 'harness', status: r.status, text }; }
    },
    async emailDirect({ to, raw, from = 'sender@example.org', rawSize }) {
      const q = new URLSearchParams({ from, to });
      if (rawSize !== undefined) q.set('rawSize', String(rawSize));
      const r = await inboxWorker.fetch(`https://email-harness.invalid/?${q}`, { method: 'POST', body: raw });
      return r.json();
    },
    async sweep() {
      const out = await inboxWorker.scheduled({ cron: CRON, scheduledTime: Date.now() });
      assert.equal(out.outcome, 'ok', 'scheduled sweep must not throw');
    },
    async slowBody(ibx, headers, statements) {
      const r = await inboxWorker.fetch('https://body-harness.invalid/', { method: 'POST',
        body: JSON.stringify({ target: ibx.url, headers, statements }) });
      await r.arrayBuffer();
      return r.status;
    },
    async putControl(id, action) {
      const latch = putLatch(id);
      if (action === 'release') latch.release();
      else await latch.started;
    },
    delayed(method, args, point, latch) {
      return inboxWorker.fetch('https://expiry-harness.invalid/', { method: 'POST',
        body: JSON.stringify({ method, args, point, latch }) });
    },
    // Convenience wrappers.
    async create(owner, type, extra = {}) {
      // Existing cases exercise open webhooks; closed-at-creation cases pass access explicitly.
      const ibx = await h.rpc('createInbox', owner, { type, ...(type === 'http' ? { access: 'open' } : {}), ...extra });
      assertOk(ibx);
      return ibx;
    },
    async list(owner, inboxId, opts = {}) {
      const r = await h.rpc('listMessages', owner, inboxId, opts);
      assertOk(r);
      return r;
    },
    async row(table, id) { return db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first(); },
    async objects(prefix) { return (await r2.list({ prefix })).objects.map(o => o.key); },
  };
  return h;
}

// ================================================================ arrival events

const b64u = s => Buffer.from(s).toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url').toString();
const EVENT_KEYS = ['created_at', 'cursor', 'event_id', 'message_id', 'type'];

describe('arrival events: finite catch-up (DESIGN: Arrival events)', () => {
  let h;
  before(async () => { h = await harness(); });
  after(async () => { await h?.mf.dispose(); });
  const events = async (own, id, opts = {}) => { const r = await h.rpc('listEvents', own, id, opts); assertOk(r); return r; };

  it('records one minimal event per stored receipt, ascending, resumable without gaps', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    for (const p of ['/a', '/b', '/c']) assert.equal((await postOpen(h, ibx, p, { body: 'secret-body' })).status, 200);
    const all = await events(own, ibx.id);
    assert.equal(all.more, false);
    assert.deepEqual(all.events.map(e => e.event_id), ['evt_1', 'evt_2', 'evt_3']);
    // Commit order, not listMessages' same-second id tiebreak.
    const paths = [];
    for (const e of all.events) paths.push((await h.rpc('getMessage', own, ibx.id, e.message_id)).preview.path);
    assert.deepEqual(paths, ['/a', '/b', '/c']);
    for (const e of all.events) {
      assert.deepEqual(Object.keys(e).sort(), EVENT_KEYS, 'events are references, not content');
      assert.equal(e.type, 'message.received');
    }
    assert.ok(!JSON.stringify(all).includes('secret-body') && !JSON.stringify(all).includes('/a'));
    assert.equal(all.cursor, all.events[2].cursor, 'caught up: resume at the head');
    const p1 = await events(own, ibx.id, { limit: 2 });
    assert.equal(p1.more, true);
    assert.equal(p1.cursor, p1.events[1].cursor);
    const p2 = await events(own, ibx.id, { after: p1.cursor, limit: 2 });
    assert.deepEqual([...p1.events, ...p2.events].map(e => e.event_id), ['evt_1', 'evt_2', 'evt_3']);
    assert.equal(p2.more, false);
    const idle = await events(own, ibx.id, { after: all.cursor });
    assert.deepEqual(idle.events, []);
    assert.equal(idle.cursor, all.cursor);
    await postOpen(h, ibx, '/d');
    const next = await events(own, ibx.id, { after: all.cursor });
    assert.deepEqual(next.events.map(e => e.event_id), ['evt_4']);
  });

  it('orders by commit rather than reservation, with no gap past a delayed R2 put', { timeout: 15000 }, async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    const start = await events(own, ibx.id, { after: 'now' });
    const delayed = postOpen(h, ibx, '/slow', { body: 'slow', headers: { 'x-harness-delay-put': 'event-order' } });
    await h.putControl('event-order', 'wait');
    try {
      assert.deepEqual((await events(own, ibx.id, { after: start.cursor })).events, [], 'pending writes have no arrival');
      assert.equal((await postOpen(h, ibx, '/fast')).status, 200);
      const fast = await events(own, ibx.id, { after: start.cursor });
      assert.deepEqual(fast.events.map(e => e.event_id), ['evt_1']);
      await h.putControl('event-order', 'release');
      assert.equal((await delayed).status, 200);
      const slow = await events(own, ibx.id, { after: fast.cursor });
      assert.deepEqual(slow.events.map(e => e.event_id), ['evt_2']);
      assert.equal((await h.rpc('getMessage', own, ibx.id, slow.events[0].message_id)).preview.path, '/slow');
    } finally { await h.putControl('event-order', 'release'); await delayed; }
  });

  it('rolls back the stored transition and counter if the event insert fails', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    await h.db.prepare(`CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN
      SELECT RAISE(ABORT, 'synthetic event failure'); END`).run();
    try {
      assert.equal((await postOpen(h, ibx, '/failed')).status, 503);
      assert.equal((await h.row('inboxes', ibx.id)).event_seq, 0);
      assert.deepEqual((await events(own, ibx.id)).events, []);
      const rows = (await h.db.prepare('SELECT state FROM messages WHERE inbox_id=?').bind(ibx.id).all()).results;
      assert.deepEqual(rows.map(r => r.state), ['pending'], 'no visible receipt without its event');
    } finally { await h.db.prepare('DROP TRIGGER fail_event').run(); }
    await h.db.prepare('UPDATE messages SET received_at=? WHERE inbox_id=?').bind(now() - 1000, ibx.id).run();
    await h.sweep();
    assert.deepEqual(await h.objects(`m/${ibx.id}/`), [], 'stale reservation cleanup also removes its R2 bytes');
    assert.equal((await postOpen(h, ibx, '/retry')).status, 200);
    assert.deepEqual((await events(own, ibx.id)).events.map(e => e.event_id), ['evt_1']);
  });

  it('advances past invisible events without sequence reuse when the inbox becomes empty', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    await postOpen(h, ibx, '/deleted');
    const first = (await events(own, ibx.id)).events[0];
    await h.rpc('deleteMessage', own, ibx.id, first.message_id);
    const empty = await events(own, ibx.id);
    assert.deepEqual(empty.events, []);
    assert.equal(empty.cursor, first.cursor);
    await postOpen(h, ibx, '/later');
    assert.deepEqual((await events(own, ibx.id, { after: empty.cursor })).events.map(e => e.event_id), ['evt_2']);
  });

  it('bounds replay to 100 references and advances over an invisible trailing receipt', async () => {
    const own = owner(), ibx = await h.create(own, 'http'), t = now();
    await h.db.batch([
      h.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x < 104)
        INSERT INTO messages (id, inbox_id, state, received_at, expires_at, size, meta_json)
        SELECT 'msg_' || 'aaaaaaaaaaaaaaaaaaaaaaaa' ||
          substr('abcdefghijklmnopqrstuvwxyz234567', (x / 32) + 1, 1) ||
          substr('abcdefghijklmnopqrstuvwxyz234567', (x % 32) + 1, 1),
          ?, 'stored', ?, CASE WHEN x = 104 THEN ? ELSE ? END, 0, '{}' FROM n`)
        .bind(ibx.id, t, t - 1, t + 3600),
      h.db.prepare(`INSERT INTO events (inbox_id, seq, message_id, type, created_at)
        SELECT inbox_id, ROW_NUMBER() OVER (ORDER BY id), id, 'message.received', ? FROM messages WHERE inbox_id = ?`)
        .bind(t, ibx.id),
      h.db.prepare('UPDATE inboxes SET event_seq = 105 WHERE id = ?').bind(ibx.id),
    ]);
    const a = await events(own, ibx.id);
    assert.equal(a.events.length, 100);
    assert.equal(a.more, true);
    const b = await events(own, ibx.id, { after: a.cursor });
    assert.equal(b.events.length, 4);
    assert.equal(b.more, false);
    assert.equal(unb64u(b.cursor).split(':')[2], '105', 'cursor crosses the expired tail without replaying it');
    assert.equal(new Set([...a.events, ...b.events].map(e => e.event_id)).size, 104);
  });

  it('after:"now" starts at the head; email receipts produce the same events', async () => {
    const own = owner(), ibx = await h.create(own, 'email');
    assert.equal((await h.email({ to: ibx.address, raw: mail() })).outcome, 'ok');
    const head = await events(own, ibx.id, { after: 'now' });
    assert.deepEqual(head.events, []);
    assert.equal(unb64u(head.cursor).split(':')[2], '1');
    await h.email({ to: ibx.address, raw: mail({ subject: 'second' }) });
    const later = await events(own, ibx.id, { after: head.cursor });
    assert.equal(later.events.length, 1);
    assert.equal(later.events[0].event_id, 'evt_2');
  });

  it('validates input; foreign, malformed and other-inbox cursors are invalid; other owners see not_found', async () => {
    const own = owner(), a = await h.create(own, 'http'), b = await h.create(own, 'http');
    await postOpen(h, a, '/');
    const cursor = (await events(own, a.id)).cursor;
    for (const opts of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { extra: 1 }, { after: 5 }, { after: 'nope' },
      { after: b64u('0123456789abcdef:ibx_x:1') }, { after: cursor + 'x'.repeat(200) }])
      isErr(await h.rpc('listEvents', own, a.id, opts), 'invalid');
    isErr(await h.rpc('listEvents', own, b.id, { after: cursor }), 'invalid');
    isErr(await h.rpc('listEvents', owner(), a.id, {}), 'not_found');
  });

  it('a foreign epoch or a position past the high-water mark is expired', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    await postOpen(h, ibx, '/');
    const [epoch, id] = unb64u((await events(own, ibx.id)).cursor).split(':');
    for (const forged of [b64u(`ffffffffffffffff:${id}:1`), b64u(`${epoch}:${id}:2`)]) {
      isErr(await h.rpc('listEvents', own, ibx.id, { after: forged }), 'expired');
    }
    const head = (await events(own, ibx.id)).cursor;
    await h.rpc('deleteMessage', own, ibx.id, (await events(own, ibx.id)).events[0].message_id);
    assert.deepEqual((await events(own, ibx.id, { after: head })).events, []);
  });

  it('revalidates on read: deleted, expired, destroyed and retired content never resurfaces', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    for (let i = 0; i < 3; i++) await postOpen(h, ibx, `/${i}`);
    const [e1, e2, e3] = (await events(own, ibx.id)).events;
    await h.rpc('deleteMessage', own, ibx.id, e1.message_id);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM events WHERE message_id = ?').bind(e1.message_id).first()).n, 0);
    await h.db.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').bind(now() - 1, e2.message_id).run();
    await h.rpc('setArchived', own, ibx.id, e3.message_id, true);
    assert.deepEqual((await events(own, ibx.id)).events.map(e => e.event_id), ['evt_3'], 'archive is a view; expiry hides before the sweep');
    await h.sweep();
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM events WHERE message_id = ?').bind(e2.message_id).first()).n, 0);
    await plant(h, ibx.id, { state: 'pending' });
    assert.equal((await events(own, ibx.id)).events.length, 1);
    await h.rpc('destroyInbox', own, ibx.id);
    isErr(await h.rpc('listEvents', own, ibx.id, {}), 'not_found');
    const expired = await h.create(own, 'http');
    await postOpen(h, expired, '/ttl');
    await h.db.prepare('UPDATE inboxes SET expires_at=? WHERE id=?').bind(now() - 1, expired.id).run();
    isErr(await h.rpc('listEvents', own, expired.id, {}), 'not_found');
    const retiredOwner = owner(), retired = await h.create(retiredOwner, 'http');
    await postOpen(h, retired, '/retired');
    await h.rpc('retireOwner', retiredOwner);
    isErr(await h.rpc('listEvents', retiredOwner, retired.id, {}), 'not_found');
  });
});

describe('arrival events: migration backfill', () => {
  it('backfills stored messages per inbox in arrival order and sets each high-water mark', async () => {
    const t = now(), meta = '{"type":"http","method":"POST","path":"/","query":"","headers":[],"content_type":null,"credential":null}';
    const h = await harness({ beforeEvents: async db => {
      const insert = (id, inbox, state, at) => db.prepare(`INSERT INTO messages (id, inbox_id, state, received_at, expires_at, size, meta_json)
        VALUES (?, ?, ?, ?, ?, 1, ?)`).bind(id, inbox, state, at, t + 3600, meta).run();
      for (const inbox of ['ibx_' + 'a'.repeat(26), 'ibx_' + 'b'.repeat(26)])
        await db.prepare(`INSERT INTO inboxes (id, owner, type, nonce, state, created_at) VALUES (?, 'owner-backfill-0000', 'http', ?, 'active', ?)`)
          .bind(inbox, inbox.slice(4), t).run();
      await insert('msg_' + 'c'.repeat(26), 'ibx_' + 'a'.repeat(26), 'stored', t - 5);
      await insert('msg_' + 'd'.repeat(26), 'ibx_' + 'a'.repeat(26), 'stored', t - 9);
      await insert('msg_' + 'e'.repeat(26), 'ibx_' + 'a'.repeat(26), 'pending', t - 1);
      await insert('msg_' + 'f'.repeat(26), 'ibx_' + 'b'.repeat(26), 'stored', t - 2);
    } });
    try {
      const rows = (await h.db.prepare('SELECT inbox_id, seq, message_id FROM events ORDER BY inbox_id, seq').all()).results;
      assert.deepEqual(rows.map(r => `${r.inbox_id.slice(4, 5)}${r.seq}${r.message_id.slice(4, 5)}`), ['a1d', 'a2c', 'b1f']);
      const seqs = (await h.db.prepare('SELECT event_seq FROM inboxes ORDER BY id').all()).results.map(r => r.event_seq);
      assert.deepEqual(seqs, [2, 1]);
      assert.match((await h.db.prepare('SELECT epoch FROM event_feed').first()).epoch, /^[0-9a-f]{16}$/);
    } finally { await h.mf.dispose(); }
  });
});

// ---------------------------------------------------------------- helpers

const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);
const owner = () => `owner-${randomBytes(8).toString('hex')}`;
const b32 = n => Array.from(randomBytes(n), b => BASE32[b & 31]).join('');
const nonceOf = ibx => (ibx.address ? ibx.address.split('@')[0] : new URL(ibx.url).hostname.split('.')[0]);
const sha256 = s => createHash('sha256').update(s).digest('hex');
const NOT_FOUND = { error: 'not_found' };
const INVALID = { error: 'invalid' };

function assertOk(r, what = 'result') {
  assert.ok(r && typeof r === 'object', `${what} must be an object`);
  assert.equal(r.error, undefined, `${what} returned error ${r && r.error}`);
}
function isErr(r, code) { assert.deepEqual(r, { error: code }); }
function assertDestroy(r, id) {
  assert.equal(r.id, id); assert.equal(r.state, 'destroying');
  assert.ok(Number.isSafeInteger(r.cleanup_not_before) && r.cleanup_not_before >= now());
}

const encSubject = s => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
function mail({ from = '"Sender" <sender@example.org>', to = 'someone@example.com', subject = 'hello',
  body = 'plain body', headers = [], id = `<${b32(10)}@example.org>` } = {}) {
  return Buffer.from([
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'Date: Tue, 20 Oct 2026 12:00:00 +0000',
    `Message-ID: ${id}`, ...headers, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, '',
  ].join('\r\n'), 'utf8');
}

async function postOpen(h, ibx, path = '/', init = {}) {
  return h.http(new URL(path, ibx.url).toString(), { method: 'POST', ...init });
}

// Insert a message row and its R2 object directly, keeping the reservation counters honest.
async function plant(h, inboxId, { state = 'stored', received_at = now(), expires_at = now() + 3600, size = 3 } = {}) {
  const id = `msg_${b32(26)}`;
  const meta = { type: 'http', method: 'POST', path: '/', query: '', headers: [], content_type: null, credential: null };
  await h.db.batch([
    h.db.prepare(`INSERT INTO messages (id, inbox_id, state, received_at, expires_at, archived, size, meta_json, search_text)
      VALUES (?,?,?,?,?,0,?,?,'')`).bind(id, inboxId, state, received_at, expires_at, size, JSON.stringify(meta)),
    h.db.prepare('UPDATE inboxes SET bytes_stored=bytes_stored+?, message_count=message_count+1 WHERE id=?').bind(size, inboxId),
  ]);
  await h.r2.put(`m/${inboxId}/${id}`, new Uint8Array(size));
  return id;
}

// ================================================================ main instance

describe('BayLeaf Inboxes contract', () => {
  let h;
  before(async () => { h = await harness(); });
  after(async () => { await h?.mf.dispose(); });

  // ---------------------------------------------------------------- RPC validation
  describe('RPC input validation (DESIGN: RPC)', () => {
    it('rejects malformed owners on every kind of method with invalid', async () => {
      const bad = ['', 'short-owner', 'a'.repeat(129), 'has space 1234567890', 'under_score_1234567', 'ümlaut-owner-123456', 123, null];
      for (const o of bad) {
        isErr(await h.rpc('createInbox', o, { type: 'http', access: 'open' }), 'invalid');
        isErr(await h.rpc('listInboxes', o), 'invalid');
        isErr(await h.rpc('getInbox', o, `ibx_${b32(26)}`), 'invalid');
      }
      // Bounds of the owner pattern are inclusive.
      assertOk(await h.rpc('listInboxes', 'a'.repeat(16)));
      assertOk(await h.rpc('listInboxes', 'A-'.repeat(64)));
    });

    it('rejects unknown keys, wrong types and bad labels without throwing', async () => {
      const o = owner();
      isErr(await h.rpc('createInbox', o, { type: 'http', access: 'open', extra: 1 }), 'invalid');
      isErr(await h.rpc('createInbox', o, { type: 'sms' }), 'invalid');
      isErr(await h.rpc('createInbox', o, {}), 'invalid');
      isErr(await h.rpc('createInbox', o, null), 'invalid');
      isErr(await h.rpc('createInbox', o), 'invalid');
      isErr(await h.rpc('createInbox', o, 'http'), 'invalid');
      isErr(await h.rpc('createInbox', o, { type: 'http', access: 'open', label: 'x'.repeat(65) }), 'invalid');
      isErr(await h.rpc('createInbox', o, { type: 'http', access: 'open', label: 7 }), 'invalid');
      // #116: webhook access is a required explicit choice; email has no such field.
      for (const access of [undefined, null, '', 'OPEN', 'private', true, 1])
        isErr(await h.rpc('createInbox', o, { type: 'http', ...(access === undefined ? {} : { access }) }), 'invalid');
      for (const access of ['open', 'closed', null])
        isErr(await h.rpc('createInbox', o, { type: 'email', access }), 'invalid');
      const r = await h.rpc('getInbox', o, 42);
      assert.ok(r.error === 'invalid' || r.error === 'not_found', 'non-string handle is an error');
      const l = await h.rpc('listMessages', o, `ibx_${b32(26)}`, 'not-an-object');
      assert.ok(l.error === 'invalid' || l.error === 'not_found');
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM inboxes WHERE owner=?').bind(o).first()).n, 0);
    });
  });

  // ---------------------------------------------------------------- lifecycle
  describe('inbox lifecycle (DESIGN: Domain and addresses, Inbox types, RPC)', () => {
    it('creates email and http inboxes with independent nonces and handles', async () => {
      const o = owner();
      const t0 = now();
      const e = await h.create(o, 'email', { label: 'mail-for-agents' });
      const w = await h.create(o, 'http');
      for (const ibx of [e, w]) {
        assert.match(ibx.id, /^ibx_[a-z2-7]{26}$/);
        assert.equal(ibx.state, 'active');
        assert.ok(Number.isInteger(ibx.created_at) && Math.abs(ibx.created_at - t0) < 30, 'created_at is epoch seconds');
        assert.deepEqual(ibx.usage, { bytes: 0, messages: 0, receipts_today: 0 });
        assert.equal(ibx.limits.bytes, Number(LIMITS.MAX_INBOX_BYTES));
        assert.equal(ibx.limits.messages, Number(LIMITS.MAX_INBOX_MESSAGES));
        assert.equal(ibx.limits.daily_receipts, Number(LIMITS.MAX_DAILY_RECEIPTS));
      }
      assert.equal(e.type, 'email');
      assert.equal(e.label, 'mail-for-agents');
      assert.match(e.address, new RegExp(`^[a-z2-7]{26}@${DOMAIN.replace(/\./g, '\\.')}$`));
      assert.equal(e.url, undefined);
      assert.equal(w.type, 'http');
      assert.equal(w.label, null);
      assert.match(w.url, new RegExp(`^https://[a-z2-7]{26}\\.${DOMAIN.replace(/\./g, '\\.')}/$`));
      assert.equal(w.address, undefined);
      assert.equal(w.closed, false);
      assert.notEqual(nonceOf(e), nonceOf(w));
      assert.notEqual(e.id.slice(4), nonceOf(e), 'the inbox handle is independent of the address nonce');
      assert.notEqual(w.id.slice(4), nonceOf(w));
      assert.equal((await h.row('inboxes', e.id)).nonce, nonceOf(e));
      assert.deepEqual(await h.rpc('getInbox', o, w.id), w);
      const listed = await h.rpc('listInboxes', o);
      assertOk(listed);
      assert.deepEqual(listed.inboxes.map(i => i.id).sort(), [e.id, w.id].sort());
      assert.equal(listed.owner_usage.bytes, 0);
      assert.equal(listed.owner_usage.limit_bytes, Number(LIMITS.MAX_OWNER_BYTES));
    });

    it('enforces MAX_INBOXES_PER_OWNER counting destroying inboxes', async () => {
      const o = owner();
      const made = [];
      for (let i = 0; i < 3; i++) made.push(await h.create(o, i % 2 ? 'email' : 'http'));
      isErr(await h.rpc('createInbox', o, { type: 'http', access: 'open' }), 'limit');
      assertDestroy(await h.rpc('destroyInbox', o, made[0].id), made[0].id);
      isErr(await h.rpc('createInbox', o, { type: 'email' }), 'limit');
      // Another owner is unaffected.
      await h.create(owner(), 'http');
    });

    it('defaults to 100 including destroying inboxes, rejects 101, and retires the full owner', async () => {
      const full = await harness({ vars: { MAX_INBOXES_PER_OWNER: undefined } });
      try {
        const o = owner();
        const empty = await full.rpc('getLimits', o);
        assert.equal(empty.owner.max_inboxes, 100);
        assert.equal(empty.owner.remaining_inboxes, 100);
        assert.equal(empty.owner.inboxes, 0);
        // Real D1 rows, no receipt bodies or R2 uploads: exercise the actual atomic cap.
        await full.db.batch(Array.from({ length: 99 }, (_, i) => full.db.prepare(
          `INSERT INTO inboxes(id,owner,type,nonce,state,created_at,destroy_requested_at)
           VALUES (?,?,'http',?,?,?,?)`
        ).bind(`ibx_${b32(26)}`, o, b32(26), i === 0 ? 'destroying' : 'active', now(), i === 0 ? now() : null)));
        const contenders = await Promise.all([
          full.rpc('createInbox', o, { type: 'http', access: 'open' }),
          full.rpc('createInbox', o, { type: 'email' }),
        ]);
        assert.equal(contenders.filter(r => r.id).length, 1);
        assert.deepEqual(contenders.find(r => r.error), { error: 'limit' });
        assert.equal((await full.rpc('listInboxes', o)).inboxes.length, 100);
        assert.equal((await full.rpc('getLimits', o)).owner.remaining_inboxes, 0);
        isErr(await full.rpc('createInbox', o, { type: 'http', access: 'open' }), 'limit');
        await full.create(owner(), 'http');
        assert.deepEqual(await full.rpc('retireOwner', o), { retired: true });
        assert.equal((await full.db.prepare("SELECT COUNT(*) n FROM inboxes WHERE owner=? AND state='destroying'").bind(o).first()).n, 100);
        assert.equal((await full.db.prepare('SELECT COUNT(*) n FROM cleanup_prefixes WHERE inbox_id IN (SELECT id FROM inboxes WHERE owner=?)').bind(o).first()).n, 100);
        isErr(await full.rpc('createInbox', o, { type: 'http', access: 'open' }), 'not_found');
      } finally { await full.mf.dispose(); }
    });

    it('discovers effective overrides and only the caller usage, including destruction reservations', async () => {
      const o = owner(), other = owner();
      const a = await h.create(o, 'http');
      await h.create(other, 'email');
      await h.db.prepare("UPDATE inboxes SET state='destroying',bytes_stored=123,message_count=2 WHERE id=?").bind(a.id).run();
      const result = await h.rpc('getLimits', o);
      assert.deepEqual(result.owner, { max_inboxes: 3, inboxes: 1, remaining_inboxes: 2,
        max_bytes: 200000, bytes: 123, remaining_bytes: 199877, messages: 2 });
      assert.deepEqual(result.per_inbox, { max_bytes: 65536, max_messages: 5000,
        max_daily_receipts: 50, max_credentials: 3 });
      assert.deepEqual(result.payload, { http_max_bytes: 1024, email_max_bytes: 65536,
        restricted_email_max_bytes: 65536, restricted_email_creation_enabled: true });
      assert.deepEqual(result.lifetime, { min_seconds: 60, max_seconds: 2592000,
        presets_seconds: { experiment: 900 }, default_ttl_seconds: null });
      assert.equal(result.retention_seconds, 7776000);
      assert.equal(result.destroy_quiesce_seconds, 900);
      assert.equal((await h.rpc('getLimits', other)).owner.bytes, 0);
      const narrow = await harness({ vars: { MAX_INBOX_TTL_SECONDS: '60', EMAIL_AUTH_CREATION_ENABLED: 'false' } });
      try {
        const limits = await narrow.rpc('getLimits', owner());
        assert.deepEqual(limits.lifetime.presets_seconds, {});
        assert.equal(limits.payload.restricted_email_creation_enabled, false);
      } finally { await narrow.mf.dispose(); }
    });

    it('type is immutable: credential RPCs on an email inbox are not_found', async () => {
      const o = owner();
      const e = await h.create(o, 'email');
      isErr(await h.rpc('createCredential', o, e.id, { name: 'x' }), 'not_found');
      isErr(await h.rpc('listCredentials', o, e.id), 'not_found');
      isErr(await h.rpc('revokeCredential', o, e.id, `cred_${b32(26)}`), 'not_found');
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM credentials WHERE inbox_id=?').bind(e.id).first()).n, 0);
    });
  });

  // ---------------------------------------------------------------- isolation
  describe('owner isolation (DESIGN: RPC, owner scoping)', () => {
    it("owner B cannot see or touch owner A's inbox, messages, attachments or credentials", async () => {
      const A = owner(), B = owner();
      const ah = await h.create(A, 'http');
      const ae = await h.create(A, 'email');
      const bh = await h.create(B, 'http');
      assert.equal((await postOpen(h, ah, '/hook', { body: 'secret-a' })).status, 200);
      const att = mailWithAttachment({ to: ae.address });
      assert.equal((await h.email({ to: ae.address, raw: att.raw })).rejectReason, undefined);
      const am = (await h.list(A, ah.id)).messages[0];
      const aem = (await h.list(A, ae.id)).messages[0];
      const cred = await h.rpc('createCredential', A, ah.id, { name: 'alice' });
      assertOk(cred);

      const missingIbx = `ibx_${b32(26)}`, missingMsg = `msg_${b32(26)}`;
      const pairs = [
        ['getInbox', [ah.id], [missingIbx]],
        ['destroyInbox', [ah.id], [missingIbx]],
        ['listMessages', [ah.id, {}], [missingIbx, {}]],
        ['getMessage', [ah.id, am.id], [missingIbx, missingMsg]],
        ['getMessageBody', [ah.id, am.id], [missingIbx, missingMsg]],
        ['getAttachment', [ae.id, aem.id, 0], [missingIbx, missingMsg, 0]],
        ['setArchived', [ah.id, am.id, true], [missingIbx, missingMsg, true]],
        ['deleteMessage', [ah.id, am.id], [missingIbx, missingMsg]],
        ['createCredential', [ah.id, { name: 'mallory' }], [missingIbx, { name: 'mallory' }]],
        ['listCredentials', [ah.id], [missingIbx]],
        ['revokeCredential', [ah.id, cred.credential.id], [missingIbx, `cred_${b32(26)}`]],
      ];
      for (const [m, theirs, missing] of pairs) {
        const r1 = await h.rpc(m, B, ...theirs);
        const r2 = await h.rpc(m, B, ...missing);
        assert.deepEqual(r1, NOT_FOUND, `${m} on another owner's handle`);
        assert.deepEqual(r1, r2, `${m}: another owner's handle is indistinguishable from a missing one`);
      }
      // B's own inbox id with A's message handle.
      isErr(await h.rpc('getMessage', B, bh.id, am.id), 'not_found');
      isErr(await h.rpc('getMessageBody', B, bh.id, am.id), 'not_found');
      isErr(await h.rpc('deleteMessage', B, bh.id, am.id), 'not_found');
      isErr(await h.rpc('revokeCredential', B, bh.id, cred.credential.id), 'not_found');
      // A's own other inbox with A's message handle: messages are scoped to their inbox.
      isErr(await h.rpc('getMessage', A, ae.id, am.id), 'not_found');
      assert.deepEqual((await h.rpc('listInboxes', B)).inboxes.map(i => i.id), [bh.id]);

      // Nothing of A's changed.
      assert.equal((await h.rpc('getInbox', A, ah.id)).state, 'active');
      assert.equal((await h.rpc('getInbox', A, ah.id)).closed, true);
      assert.equal((await h.rpc('getMessage', A, ah.id, am.id)).archived, false);
      assert.equal((await h.rpc('listCredentials', A, ah.id)).credentials.length, 1);
      assert.equal((await h.rpc('getAttachment', A, ae.id, aem.id, 0)).response, true);
    });
  });

  // ---------------------------------------------------------------- HTTP reception
  describe('HTTP reception (DESIGN: HTTP reception)', () => {
    it('apex explains itself; deeper and foreign hosts are 404', async () => {
      const discovery = await h.http(`https://${DOMAIN}/llms.txt`);
      assert.equal(discovery.status, 200);
      assert.match(discovery.text, /https:\/\/api\.bayleaf\.dev\/llms\.txt/);
      assert.equal((await h.http(`https://${DOMAIN}/llms.txt`, { method: 'HEAD' })).text, '');
      const discoveryOwner = owner(), discoveryInbox = await h.create(discoveryOwner, 'http');
      assert.equal((await h.http(new URL('/llms.txt', discoveryInbox.url))).status, 200);
      assert.equal((await h.list(discoveryOwner, discoveryInbox.id)).messages[0].preview.path, '/llms.txt', 'Inbox paths stay sender-owned');
      const g = await h.http(`https://${DOMAIN}/`);
      assert.equal(g.status, 200);
      assert.match(g.headers.get('content-type'), /^text\/html/);
      assert.match(g.text, /https:\/\/api\.bayleaf\.dev\/diagnostics\/inboxes/);
      assert.doesNotMatch(g.text, /<script/); // New arrivals default off.
      assert.equal((await h.http(`https://${DOMAIN}/unknown`)).status, 404);
      assert.ok(g.text.length > 0);
      assert.equal((await h.http(`https://${DOMAIN}/`, { method: 'HEAD' })).status, 200);
      assert.equal((await h.http(`https://${DOMAIN}/`, { method: 'POST', body: 'x' })).status, 404);
      const ibx = await h.create(owner(), 'http');
      const deeper = await h.http(`https://x.${nonceOf(ibx)}.${DOMAIN}/`, { method: 'POST', body: 'x' });
      assert.equal(deeper.status, 404);
      assert.equal((await h.http(`https://example.com/`, { method: 'POST', body: 'x' })).status, 404);
      assert.equal((await h.row('inboxes', ibx.id)).message_count, 0);
    });

    it('unknown and email-type hosts are 404 not_found', async () => {
      const u = await h.http(`https://${b32(26)}.${DOMAIN}/x`, { method: 'POST', body: 'x' });
      assert.equal(u.status, 404);
      assert.deepEqual(JSON.parse(u.text), { error: 'not_found' });
      const e = await h.create(owner(), 'email');
      const r = await h.http(`https://${nonceOf(e)}.${DOMAIN}/`, { method: 'POST', body: 'x' });
      assert.equal(r.status, 404);
      assert.deepEqual(JSON.parse(r.text), { error: 'not_found' });
      assert.equal((await h.row('inboxes', e.id)).message_count, 0);
    });

    it('OPTIONS is a fixed CORS preflight and is never captured', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      for (const url of [ibx.url, `https://${b32(26)}.${DOMAIN}/anything`]) {
        const p = await h.http(url, { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'X-Foo, Content-Type' } });
        assert.equal(p.status, 204);
        assert.equal(p.headers.get('access-control-allow-origin'), '*');
        assert.equal(p.headers.get('access-control-allow-methods'), 'GET, HEAD, POST, PUT, PATCH, DELETE');
        assert.equal(p.headers.get('access-control-allow-headers'), 'X-Foo, Content-Type');
        assert.equal(p.headers.get('access-control-max-age'), '86400');
      }
      const d = await h.http(ibx.url, { method: 'OPTIONS' });
      assert.equal(d.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
      const long = await h.http(ibx.url, { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'x'.repeat(3000) } });
      assert.ok((long.headers.get('access-control-allow-headers') ?? '').length <= 1024, 'echo is bounded to 1024 chars');
      assert.equal((await h.row('inboxes', ibx.id)).message_count, 0);
      assert.deepEqual((await h.list(o, ibx.id, { archived: 'all' })).messages, []);
    });

    it('captures exact bytes, path and query with header drop and redaction rules', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      const body = Uint8Array.from({ length: 256 }, (_, i) => i);
      const r = await h.http(new URL('/github/push?a=1&b=%20x', ibx.url).toString(), {
        method: 'POST', body,
        headers: {
          'Content-Type': 'application/octet-stream', 'X-Hub-Signature-256': 'sha256=deadbeef',
          Authorization: 'Bearer open-inbox-secret', Cookie: 'session=cookie-secret',
          'Proxy-Authorization': 'Basic proxy-secret', 'X-Forwarded-For': '203.0.113.9',
          'X-Real-IP': '203.0.113.10', 'True-Client-IP': '203.0.113.11', 'CDN-Loop': 'cloudflare',
          'X-Forwarded-Proto': 'https', 'CF-Ray': 'abc123', 'CF-IPCountry': 'US', 'X-Custom': 'Kept Value',
        },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.text), { ok: true });
      assert.equal(r.headers.get('access-control-allow-origin'), '*');

      const { messages } = await h.list(o, ibx.id);
      assert.equal(messages.length, 1);
      const s = messages[0];
      assert.match(s.id, /^msg_[a-z2-7]+$/);
      assert.equal(s.inbox_id, ibx.id);
      assert.equal(s.type, 'http');
      assert.equal(s.size, 256);
      assert.equal(s.archived, false);
      assert.equal(s.expires_at - s.received_at, Number(LIMITS.RETENTION_SECONDS));
      assert.deepEqual(s.preview, { method: 'POST', path: '/github/push', content_type: 'application/octet-stream', credential_name: null });

      const m = await h.rpc('getMessage', o, ibx.id, s.id);
      assertOk(m);
      const meta = m.meta;
      assert.equal(meta.type, 'http');
      assert.equal(meta.method, 'POST');
      assert.equal(meta.path, '/github/push');
      assert.equal(meta.query, 'a=1&b=%20x');
      assert.equal(meta.content_type, 'application/octet-stream');
      assert.equal(meta.credential, null);
      const names = meta.headers.map(([k]) => k);
      for (const k of names) assert.equal(k, k.toLowerCase(), 'header names lowercased');
      for (const k of names) assert.ok(!k.startsWith('cf-'), `cf-* dropped (${k})`);
      for (const k of ['x-forwarded-for', 'x-real-ip', 'true-client-ip', 'cdn-loop', 'x-forwarded-proto']) assert.ok(!names.includes(k), `${k} dropped`);
      const hv = Object.fromEntries(meta.headers);
      assert.equal(hv['x-hub-signature-256'], 'sha256=deadbeef');
      assert.equal(hv['x-custom'], 'Kept Value');
      assert.equal(hv.authorization, 'Bearer [redacted]');
      assert.equal(hv.cookie, '[redacted]');
      assert.ok(/^(Basic )?\[redacted\]$/.test(hv['proxy-authorization']), 'proxy-authorization redacted');
      const row = await h.row('messages', s.id);
      for (const leak of ['open-inbox-secret', 'cookie-secret', 'proxy-secret', '203.0.113', '127.0.0.1']) {
        assert.ok(!row.meta_json.includes(leak) && !row.search_text.includes(leak), `${leak} not stored`);
      }
      assert.equal(row.state, 'stored');

      const b = await h.rpc('getMessageBody', o, ibx.id, s.id);
      assert.equal(b.response, true);
      assert.equal(b.status, 200);
      assert.deepEqual(b.bytes, body);
      assert.equal(b.headers.get('content-type'), 'application/octet-stream');
      assert.equal(b.headers.get('content-length'), '256');
      const obj = await h.r2.get(`m/${ibx.id}/${s.id}`);
      assert.deepEqual(new Uint8Array(await obj.arrayBuffer()), body);
      const after = await h.rpc('getInbox', o, ibx.id);
      assert.deepEqual(after.usage, { bytes: 256, messages: 1, receipts_today: 1 });
    });

    it('captures every non-OPTIONS method, any path, case-insensitive host with port', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
        const r = await h.http(new URL(`/m/${method.toLowerCase()}?q=${method}`, ibx.url).toString(), { method });
        assert.equal(r.status, 200, method);
        if (method === 'HEAD') assert.equal(r.bytes.length, 0);
        else assert.deepEqual(JSON.parse(r.text), { ok: true });
      }
      const upper = `https://${nonceOf(ibx).toUpperCase()}.${DOMAIN.toUpperCase()}:8443/Case/Path`;
      assert.equal((await h.http(upper, { method: 'POST', body: 'x' })).status, 200);
      const { messages } = await h.list(o, ibx.id);
      assert.equal(messages.length, 6);
      assert.deepEqual(messages.map(m => m.preview.method).sort(), ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT']);
      assert.ok(messages.some(m => m.preview.path === '/Case/Path'), 'path case preserved');
      const g = messages.find(m => m.preview.method === 'GET');
      const body = await h.rpc('getMessageBody', o, ibx.id, g.id);
      assert.equal(body.bytes.length, 0);
      assert.equal(body.headers.get('content-type'), 'application/octet-stream', 'no content type falls back to octet-stream');
    });

    it('413 on Content-Length over the cap and on an oversize stream; the cap itself is accepted', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      const cap = Number(LIMITS.MAX_HTTP_BODY_BYTES);
      assert.equal((await postOpen(h, ibx, '/', { body: new Uint8Array(cap + 1) })).status, 413);
      assert.equal((await postOpen(h, ibx, '/', { body: new Uint8Array(cap * 3), headers: { 'x-harness-stream': '1' } })).status, 413);
      const row = await h.row('inboxes', ibx.id);
      assert.equal(row.message_count, 0);
      assert.equal(row.bytes_stored, 0);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n, 0);
      assert.equal((await postOpen(h, ibx, '/', { body: new Uint8Array(cap) })).status, 200);
      assert.equal((await postOpen(h, ibx, '/', { body: new Uint8Array(cap), headers: { 'x-harness-stream': '1' } })).status, 200);
      assert.equal((await h.row('inboxes', ibx.id)).bytes_stored, cap * 2);
    });

    it('507 inbox_full on inbox bytes, message count and owner bytes', async () => {
      const o = owner();
      const a = await h.create(o, 'http');
      const max = Number(LIMITS.MAX_INBOX_BYTES);
      await h.db.prepare('UPDATE inboxes SET bytes_stored=? WHERE id=?').bind(max - 10, a.id).run();
      const full = await postOpen(h, a, '/', { body: 'x'.repeat(11) });
      assert.equal(full.status, 507);
      assert.deepEqual(JSON.parse(full.text), { error: 'inbox_full' });
      assert.equal((await postOpen(h, a, '/', { body: 'x'.repeat(10) })).status, 200, 'exactly at the cap fits');
      assert.equal((await h.row('inboxes', a.id)).bytes_stored, max);

      const b = await h.create(o, 'http');
      await h.db.prepare('UPDATE inboxes SET message_count=? WHERE id=?').bind(Number(LIMITS.MAX_INBOX_MESSAGES), b.id).run();
      assert.equal((await postOpen(h, b, '/', { body: 'x' })).status, 507);

      const o2 = owner();
      const c = await h.create(o2, 'http');
      const d = await h.create(o2, 'http');
      await h.db.prepare('UPDATE inboxes SET bytes_stored=? WHERE id=?').bind(Number(LIMITS.MAX_OWNER_BYTES) - 10, c.id).run();
      assert.equal((await postOpen(h, d, '/', { body: 'x'.repeat(11) })).status, 507, 'owner cap spans inboxes');
      assert.equal((await postOpen(h, d, '/', { body: 'x'.repeat(10) })).status, 200);
      assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE inbox_id IN (?,?,?) AND state='pending'").bind(a.id, b.id, d.id).first()).n, 0);
    });

    it('429 at the daily cap with Retry-After until UTC midnight; a new day resets the count', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      await h.db.prepare('UPDATE inboxes SET day=?, day_count=? WHERE id=?').bind(today(), Number(LIMITS.MAX_DAILY_RECEIPTS), ibx.id).run();
      const r = await postOpen(h, ibx, '/', { body: 'x' });
      assert.equal(r.status, 429);
      const expected = 86400 - (now() % 86400);
      const ra = Number(r.headers.get('retry-after'));
      assert.ok(Number.isInteger(ra) && ra > 0 && Math.abs(ra - expected) <= 5, `Retry-After ${ra} ~ ${expected}`);
      assert.equal((await h.row('inboxes', ibx.id)).message_count, 0);
      await h.db.prepare('UPDATE inboxes SET day=?, day_count=? WHERE id=?').bind('2000-01-01', Number(LIMITS.MAX_DAILY_RECEIPTS), ibx.id).run();
      assert.equal((await postOpen(h, ibx, '/', { body: 'x' })).status, 200);
      const row = await h.row('inboxes', ibx.id);
      assert.equal(row.day, today());
      assert.equal(row.day_count, 1);
      assert.equal((await h.rpc('getInbox', o, ibx.id)).usage.receipts_today, 1);
    });
  });

  // ---------------------------------------------------------------- credentials
  describe('credentials (DESIGN: HTTP reception step 3, RPC credentials)', () => {
    it('token is shown once, hashed at rest, and creating one closes the inbox', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      const t0 = now();
      const c = await h.rpc('createCredential', o, ibx.id, { name: 'alice' });
      assert.equal(c.inbox_closed, true);
      assert.match(c.notice, /does not reopen/);
      assertOk(c);
      assert.match(c.token, /^sk-bayleaf-inbox-[0-9a-f]{64}$/);
      assert.match(c.credential.id, /^cred_[a-z2-7]+$/);
      assert.equal(c.credential.kind, 'bearer');
      assert.equal(c.credential.name, 'alice');
      assert.equal(c.credential.hint, c.token.slice(-4));
      assert.equal(c.credential.expires_at, null);
      assert.equal(c.credential.last_used_at, null);
      assert.ok(Math.abs(c.credential.created_at - t0) < 30);
      assert.equal(c.credential.token, undefined);
      assert.equal((await h.rpc('getInbox', o, ibx.id)).closed, true);
      const listed = await h.rpc('listCredentials', o, ibx.id);
      assert.deepEqual(listed, { credentials: [c.credential] });
      assert.ok(!JSON.stringify(listed).includes(c.token.slice(17, 40)));
      const row = await h.row('credentials', c.credential.id);
      assert.equal(row.secret_hash, sha256(c.token));
      assert.ok(!Object.values(row).some(v => typeof v === 'string' && v.includes(c.token.slice(17))), 'token not stored');
      const d = await h.rpc('createCredential', o, ibx.id, {});
      assertOk(d);
      assert.match(d.credential.name, /^token-[0-9a-f]{4}$/);
      assert.notEqual(d.token, c.token);
    });

    it('access:"closed" denies anonymous delivery from creation until a credential exists (#116)', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http', { access: 'closed' });
      assert.equal(ibx.closed, true);
      assert.equal((await h.rpc('listInboxes', o)).inboxes[0].closed, true);
      assert.deepEqual(await h.rpc('listCredentials', o, ibx.id), { credentials: [] });
      for (const method of ['POST', 'GET', 'HEAD']) {
        const r = await postOpen(h, ibx, '/hook', { method, ...(method === 'POST' ? { body: 'early' } : {}) });
        assert.equal(r.status, 401, `${method} before any credential`);
        assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="bayleaf-inbox"');
      }
      assert.equal((await h.row('inboxes', ibx.id)).message_count, 0, 'the anonymous window never existed');
      const c = await h.rpc('createCredential', o, ibx.id, { name: 'ci' });
      assertOk(c);
      assert.equal((await postOpen(h, ibx, '/hook', { body: 'x', headers: { Authorization: `Bearer ${c.token}` } })).status, 200);
      assert.equal((await postOpen(h, ibx, '/hook', { body: 'x' })).status, 401);
      assert.equal((await h.list(o, ibx.id)).messages[0].preview.credential_name, 'ci');
    });

    it('validates credential inputs and caps credentials per inbox', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      for (const bad of [{ name: 'x'.repeat(65) }, { name: 'tab\there' }, { name: 'nl\nhere' }, { extra: 1 },
        { expires_at: now() - 10 }, { expires_at: now() + 2 * 366 * 86400 }, { expires_at: 'tomorrow' }, { name: 5 }]) {
        isErr(await h.rpc('createCredential', o, ibx.id, bad), 'invalid');
      }
      assert.equal((await h.rpc('getInbox', o, ibx.id)).closed, false, 'failed creates do not close the inbox');
      const ok = await h.rpc('createCredential', o, ibx.id, { name: 'x'.repeat(64), expires_at: now() + 86400 });
      assertOk(ok);
      assert.ok(Math.abs(ok.credential.expires_at - (now() + 86400)) < 30);
      assertOk(await h.rpc('createCredential', o, ibx.id, {}));
      assertOk(await h.rpc('createCredential', o, ibx.id, {}));
      isErr(await h.rpc('createCredential', o, ibx.id, {}), 'limit');
    });

    it('closed inbox: exact 401 challenges, scoped tokens, attribution, case-insensitive scheme', async () => {
      const o = owner();
      const x = await h.create(o, 'http');
      const y = await h.create(o, 'http');
      const z = await h.create(o, 'http');
      const cx = await h.rpc('createCredential', o, x.id, { name: 'alice' });
      const cy = await h.rpc('createCredential', o, y.id, { name: 'bob' });
      assertOk(cx); assertOk(cy);

      const missing = await postOpen(h, x, '/', { body: 'no auth' });
      assert.equal(missing.status, 401);
      assert.equal(missing.headers.get('www-authenticate'), 'Bearer realm="bayleaf-inbox"');
      const wrong = await postOpen(h, x, '/', { body: 'bad', headers: { Authorization: `Bearer sk-bayleaf-inbox-${'0'.repeat(64)}` } });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.headers.get('www-authenticate'), 'Bearer realm="bayleaf-inbox", error="invalid_token"');
      const basic = await postOpen(h, x, '/', { body: 'bad', headers: { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } });
      assert.equal(basic.status, 401);
      const crossed = await postOpen(h, x, '/', { body: 'cross', headers: { Authorization: `Bearer ${cy.token}` } });
      assert.equal(crossed.status, 401, "inbox Y's token does not open inbox X");
      assert.equal(crossed.headers.get('www-authenticate'), 'Bearer realm="bayleaf-inbox", error="invalid_token"');
      assert.equal((await h.row('inboxes', x.id)).message_count, 0, 'failures store nothing');

      const good = await postOpen(h, x, '/hook', { body: 'hello', headers: { Authorization: `Bearer ${cx.token}`, 'Content-Type': 'text/plain' } });
      assert.equal(good.status, 200);
      assert.equal((await postOpen(h, x, '/hook2', { body: 'hi', headers: { Authorization: `bEaReR ${cx.token}` } })).status, 200);
      const { messages } = await h.list(o, x.id);
      assert.equal(messages.length, 2);
      for (const m of messages) assert.equal(m.preview.credential_name, 'alice');
      const full = await h.rpc('getMessage', o, x.id, messages.find(m => m.preview.path === '/hook').id);
      assert.deepEqual(full.meta.credential, { id: cx.credential.id, name: 'alice' });
      assert.equal(Object.fromEntries(full.meta.headers).authorization, 'Bearer [redacted]');
      const rows = (await h.db.prepare('SELECT meta_json, search_text FROM messages WHERE inbox_id=?').bind(x.id).all()).results;
      for (const r of rows) assert.ok(!r.meta_json.includes(cx.token) && !r.search_text.includes(cx.token.slice(17)), 'token never stored');
      const used = (await h.rpc('listCredentials', o, x.id)).credentials[0];
      assert.ok(Number.isInteger(used.last_used_at) && Math.abs(used.last_used_at - now()) < 60, 'last_used_at recorded');

      // An open inbox ignores Authorization and attributes nothing.
      assert.equal((await postOpen(h, z, '/', { body: 'x', headers: { Authorization: `Bearer ${cx.token}` } })).status, 200);
      const zm = (await h.list(o, z.id)).messages[0];
      assert.equal(zm.preview.credential_name, null);
    });

    it('expired credentials are rejected but not deleted', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      const c = await h.rpc('createCredential', o, ibx.id, { name: 'temp', expires_at: now() + 3600 });
      assertOk(c);
      assert.equal((await postOpen(h, ibx, '/', { body: 'x', headers: { Authorization: `Bearer ${c.token}` } })).status, 200);
      await h.db.prepare('UPDATE credentials SET expires_at=? WHERE id=?').bind(now() - 1, c.credential.id).run();
      const r = await postOpen(h, ibx, '/', { body: 'x', headers: { Authorization: `Bearer ${c.token}` } });
      assert.equal(r.status, 401);
      assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="bayleaf-inbox", error="invalid_token"');
      assert.ok(await h.row('credentials', c.credential.id), 'expired row still present');
      assert.equal((await h.rpc('getInbox', o, ibx.id)).closed, true, 'an expired credential row still closes the inbox');
      assert.equal((await postOpen(h, ibx, '/', { body: 'x' })).status, 401);
    });

    it('revocation is a hard delete; revoking the last credential never reopens the inbox', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      const a = await h.rpc('createCredential', o, ibx.id, { name: 'a' });
      const b = await h.rpc('createCredential', o, ibx.id, { name: 'b' });
      assert.deepEqual(await h.rpc('revokeCredential', o, ibx.id, a.credential.id), { id: a.credential.id, revoked: true });
      assert.equal(await h.row('credentials', a.credential.id), null);
      isErr(await h.rpc('revokeCredential', o, ibx.id, a.credential.id), 'not_found');
      assert.equal((await postOpen(h, ibx, '/', { body: 'x', headers: { Authorization: `Bearer ${a.token}` } })).status, 401);
      assert.equal((await postOpen(h, ibx, '/', { body: 'x', headers: { Authorization: `Bearer ${b.token}` } })).status, 200);
      assert.equal((await h.rpc('getInbox', o, ibx.id)).closed, true);
      await h.rpc('revokeCredential', o, ibx.id, b.credential.id);
      assert.equal((await h.rpc('getInbox', o, ibx.id)).closed, true);
      assert.equal((await postOpen(h, ibx, '/', { body: 'x' })).status, 401, 'closed with zero keys denies arrivals');
      assert.equal((await postOpen(h, ibx, '/', { body: 'x', headers: { Authorization: `Bearer ${b.token}` } })).status, 401);
      assert.deepEqual(await h.rpc('listCredentials', o, ibx.id), { credentials: [] });
      const c = await h.rpc('createCredential', o, ibx.id, {});
      assert.equal((await postOpen(h, ibx, '/', { body: 'x', headers: { Authorization: `Bearer ${c.token}` } })).status, 200);
    });

    it('reservation rechecks auth after a slow body: enabled, revoked, expired and destroyed', async () => {
      for (const change of ['enabled', 'revoked', 'expired', 'destroyed']) {
        const o = owner(), ibx = await h.create(o, 'http');
        const c = change === 'enabled' ? null : await h.rpc('createCredential', o, ibx.id, {});
        const statements = change === 'enabled'
          ? [{ sql: 'UPDATE inboxes SET auth_required=1 WHERE id=?', args: [ibx.id] }]
          : change === 'revoked'
            ? [{ sql: 'DELETE FROM credentials WHERE id=?', args: [c.credential.id] }]
            : change === 'expired'
              ? [{ sql: 'UPDATE credentials SET expires_at=? WHERE id=?', args: [now() - 1, c.credential.id] }]
              : [{ sql: "UPDATE inboxes SET state='destroying' WHERE id=?", args: [ibx.id] }];
        assert.equal(await h.slowBody(ibx, c ? { Authorization: `Bearer ${c.token}` } : {}, statements), change === 'destroyed' ? 404 : 401, change);
        assert.equal((await h.row('inboxes', ibx.id)).message_count, 0);
        assert.deepEqual(await h.objects(`m/${ibx.id}/`), []);
      }
    });
  });

  // ---------------------------------------------------------------- email
  describe('email reception (DESIGN: Email reception)', () => {
    it('routes by envelope recipient only, case-insensitively; Bcc-style delivery works', async () => {
      const o = owner();
      const a = await h.create(o, 'email');
      const b = await h.create(o, 'email');
      // Header To names inbox B, envelope says A.
      const r1 = await h.email({ to: a.address, raw: mail({ to: b.address, subject: 'envelope wins' }) });
      assert.equal(r1.outcome, 'ok');
      assert.equal(r1.rejectReason, undefined);
      // Header To is unrelated, as with Bcc.
      const r2 = await h.email({ to: a.address, raw: mail({ to: 'list@example.com', subject: 'bcc copy' }) });
      assert.equal(r2.rejectReason, undefined);
      // Upper-case envelope recipient.
      const r3 = await h.email({ to: a.address.toUpperCase(), raw: mail({ subject: 'shouting' }) });
      assert.equal(r3.rejectReason, undefined);
      assert.equal((await h.list(o, a.id)).messages.length, 3);
      assert.equal((await h.list(o, b.id)).messages.length, 0);
      const subjects = (await h.list(o, a.id)).messages.map(m => m.preview.subject).sort();
      assert.deepEqual(subjects, ['bcc copy', 'envelope wins', 'shouting']);
      const shout = (await h.list(o, a.id, { q: 'shouting' })).messages[0];
      assert.equal((await h.rpc('getMessage', o, a.id, shout.id)).meta.envelope_to, a.address, 'envelope_to lowercased');
    });

    it('rejects unknown, foreign-domain, plus-addressed, http-type and too-large mail', async () => {
      const o = owner();
      const e = await h.create(o, 'email');
      const w = await h.create(o, 'http');
      const nonce = nonceOf(e);
      for (const to of [`${b32(26)}@${DOMAIN}`, `${nonce}@example.com`, `${nonce}@sub.${DOMAIN}`, `${nonce}+tag@${DOMAIN}`, `${nonceOf(w)}@${DOMAIN}`]) {
        const r = await h.email({ to, raw: mail({ to }) });
        assert.equal(r.rejectReason, '5.1.1 Address not found', to);
      }
      const big = mail({ to: e.address, body: 'y'.repeat(Number(LIMITS.MAX_EMAIL_BYTES) + 100) });
      assert.equal((await h.email({ to: e.address, raw: big })).rejectReason, '5.3.4 Message too large');
      await h.db.prepare('UPDATE inboxes SET bytes_stored=? WHERE id=?').bind(Number(LIMITS.MAX_INBOX_BYTES), e.id).run();
      assert.equal((await h.email({ to: e.address, raw: mail({ to: e.address }) })).rejectReason, '5.2.2 Mailbox full');
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id IN (?,?)').bind(e.id, w.id).first()).n, 0);
    });

    it('multipart with Unicode subject and binary attachment: metadata, exact raw, exact attachment', async () => {
      const o = owner();
      const a = await h.create(o, 'email');
      const other = await h.create(o, 'email');
      const m = mailWithAttachment({ to: other.address });
      const res = await h.email({ from: 'zoe@example.org', to: a.address, raw: m.raw });
      assert.equal(res.outcome, 'ok');
      assert.equal(res.rejectReason, undefined);
      const [s] = (await h.list(o, a.id)).messages;
      assert.equal(s.type, 'email');
      assert.equal(s.size, m.raw.length);
      assert.equal(s.preview.subject, m.subject);
      assert.equal(s.preview.attachments, 1);
      assert.ok(JSON.stringify(s.preview.from).includes('zoe@example.org'));
      const { meta } = await h.rpc('getMessage', o, a.id, s.id);
      assert.equal(meta.type, 'email');
      assert.equal(meta.envelope_from, 'zoe@example.org');
      assert.equal(meta.envelope_to, a.address);
      assert.deepEqual(meta.from, { address: 'zoe@example.org', name: 'Zoë' });
      assert.ok(JSON.stringify(meta.to).includes(other.address));
      assert.equal(meta.subject, m.subject);
      assert.equal(Date.parse(meta.date), Date.parse('2026-10-20T12:00:00Z'));
      assert.ok(String(meta.message_id).includes('multi-1@example.org'));
      assert.ok(String(meta.in_reply_to).includes('earlier@example.org'));
      assert.deepEqual(meta.authentication_results, m.authResults);
      assert.equal(meta.parse_error, false);
      assert.deepEqual(meta.attachments, [{ index: 0, filename: 'résumé.bin', mime_type: 'application/octet-stream',
        size: 256, disposition: 'attachment', content_id: null }]);

      const raw = await h.rpc('getMessageBody', o, a.id, s.id);
      assert.equal(raw.status, 200);
      assert.equal(raw.headers.get('content-type'), 'message/rfc822');
      assert.equal(raw.headers.get('content-length'), String(m.raw.length));
      assert.deepEqual(raw.bytes, new Uint8Array(m.raw));

      const att = await h.rpc('getAttachment', o, a.id, s.id, 0);
      assert.equal(att.response, true);
      assert.equal(att.status, 200);
      assert.deepEqual(att.bytes, m.attachment);
      assert.equal(att.headers.get('content-type'), 'application/octet-stream');
      assert.equal(att.headers.get('content-disposition'), "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.bin");
      const out = await h.rpc('getAttachment', o, a.id, s.id, 1);
      assert.ok(out.error === 'not_found' || out.error === 'invalid', 'index past the end is an error');
      for (const idx of [-1, 1.5, '0']) {
        const r = await h.rpc('getAttachment', o, a.id, s.id, idx);
        assert.ok(r.error === 'invalid' || r.error === 'not_found', `index ${JSON.stringify(idx)}`);
      }

      // Search over subject (lowercased Unicode), body and sender.
      for (const q of ['grüße', 'UNIQUE-TOKEN-XYZ', 'zoe@example.org']) {
        assert.deepEqual((await h.list(o, a.id, { q })).messages.map(x => x.id), [s.id], q);
      }
    });

    it('getAttachment on an http message is an error', async () => {
      const o = owner();
      const w = await h.create(o, 'http');
      await postOpen(h, w, '/', { body: 'x' });
      const [m] = (await h.list(o, w.id)).messages;
      const r = await h.rpc('getAttachment', o, w.id, m.id, 0);
      assert.ok(r.error === 'not_found' || r.error === 'invalid');
    });

    it('rejects parser resource exhaustion and preserves accepted malformed raw bytes', async () => {
      const o = owner();
      const a = await h.create(o, 'email');
      let deep = 'Message-ID: <deep@example.org>\r\n';
      for (let i = 0; i < 300; i++) deep += `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`;
      deep += 'Content-Type: text/plain\r\n\r\nhi\r\n';
      const deepBytes = new TextEncoder().encode(deep);
      await assert.rejects(PostalMime.parse(deepBytes), 'fixture must make postal-mime throw');
      const r = await h.emailDirect({ to: a.address, raw: deepBytes });
      assert.equal(r.outcome, 'ok', r.threw);
      assert.equal(r.rejectReason, '5.3.4 MIME resource limit exceeded');
      const garbage = Uint8Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 255);
      assert.equal((await h.emailDirect({ to: a.address, raw: garbage })).rejectReason, undefined);
      const { messages } = await h.list(o, a.id);
      assert.equal(messages.length, 1);
      const bySize = Object.fromEntries(messages.map(m => [m.size, m]));
      assert.deepEqual((await h.rpc('getMessageBody', o, a.id, bySize[512].id)).bytes, garbage);
    });
  });

  // ---------------------------------------------------------------- messages API
  describe('messages API (DESIGN: RPC listMessages, summaries)', () => {
    it('orders by received_at DESC, id DESC and paginates without gaps or duplicates', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      for (let i = 0; i < 7; i++) assert.equal((await postOpen(h, ibx, `/p${i}`, { body: `m${i}` })).status, 200);
      const base = now();
      const rows = (await h.db.prepare('SELECT id FROM messages WHERE inbox_id=?').bind(ibx.id).all()).results;
      // Pairs of equal received_at exercise the id tie-break.
      for (const [i, r] of rows.entries()) await h.db.prepare('UPDATE messages SET received_at=? WHERE id=?').bind(base - Math.floor(i / 2), r.id).run();
      const expected = (await h.db.prepare('SELECT id FROM messages WHERE inbox_id=? ORDER BY received_at DESC, id DESC').bind(ibx.id).all()).results.map(r => r.id);
      const all = await h.list(o, ibx.id);
      assert.deepEqual(all.messages.map(m => m.id), expected);
      assert.equal(all.next_cursor, null);
      const seen = [];
      let cursor, pages = 0;
      do {
        const page = await h.list(o, ibx.id, cursor ? { limit: 3, cursor } : { limit: 3 });
        assert.ok(page.messages.length <= 3);
        seen.push(...page.messages.map(m => m.id));
        cursor = page.next_cursor;
        if (cursor !== null) assert.match(cursor, /^[A-Za-z0-9_-]+$/, 'cursor is base64url');
        pages++;
      } while (cursor && pages < 10);
      assert.equal(pages, 3);
      assert.deepEqual(seen, expected);
      assert.equal((await h.list(o, ibx.id, { limit: 100 })).messages.length, 7);
      assert.equal((await h.list(o, ibx.id, { limit: 1 })).messages.length, 1);
    });

    it('validates list options', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      for (const opts of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }, { cursor: '!!not-base64!!' },
        { archived: 'yes' }, { q: '' }, { q: 'x'.repeat(201) }, { unknown: true }]) {
        isErr(await h.rpc('listMessages', o, ibx.id, opts), 'invalid');
      }
      assertOk(await h.rpc('listMessages', o, ibx.id, { q: 'x'.repeat(200), archived: 'all', limit: 100 }));
    });

    it('archive filtering and summaries; reads never change expires_at', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      for (let i = 0; i < 3; i++) await postOpen(h, ibx, `/a${i}`, { body: `a${i}` });
      const ids = (await h.list(o, ibx.id)).messages.map(m => m.id);
      const before = (await h.db.prepare('SELECT id, expires_at, received_at FROM messages WHERE inbox_id=? ORDER BY id').bind(ibx.id).all()).results;
      for (const r of before) assert.equal(r.expires_at, r.received_at + Number(LIMITS.RETENTION_SECONDS));
      const s = await h.rpc('setArchived', o, ibx.id, ids[0], true);
      assertOk(s);
      assert.equal(s.id, ids[0]);
      assert.equal(s.archived, true);
      isErr(await h.rpc('setArchived', o, ibx.id, ids[0], 'yes'), 'invalid');
      assert.deepEqual((await h.list(o, ibx.id)).messages.map(m => m.id), ids.slice(1));
      assert.deepEqual((await h.list(o, ibx.id, { archived: false })).messages.map(m => m.id), ids.slice(1));
      assert.deepEqual((await h.list(o, ibx.id, { archived: true })).messages.map(m => m.id), [ids[0]]);
      assert.deepEqual((await h.list(o, ibx.id, { archived: 'all' })).messages.map(m => m.id), ids);
      for (const id of ids) {
        await h.rpc('getMessage', o, ibx.id, id);
        await h.rpc('getMessageBody', o, ibx.id, id);
      }
      await h.list(o, ibx.id, { q: 'a1' });
      assert.equal((await h.rpc('setArchived', o, ibx.id, ids[0], false)).archived, false);
      assert.deepEqual((await h.list(o, ibx.id)).messages.map(m => m.id), ids);
      const afterRows = (await h.db.prepare('SELECT id, expires_at, received_at FROM messages WHERE inbox_id=? ORDER BY id').bind(ibx.id).all()).results;
      assert.deepEqual(afterRows, before, 'archive and reads leave retention untouched');
    });

    it('search is a case-insensitive substring match with LIKE wildcards escaped', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      const bodies = { pct: '100% sure', under: 'snake a_b case', near: 'snake axb case', plain: 'fifty percent', slash: 'back\\slash here', json: '{"Event":"PushHappened"}' };
      const idOf = {};
      for (const [k, body] of Object.entries(bodies)) {
        const ct = k === 'json' ? 'application/json' : 'text/plain; charset=utf-8';
        assert.equal((await postOpen(h, ibx, `/${k}`, { body, headers: { 'Content-Type': ct } })).status, 200);
      }
      for (const m of (await h.list(o, ibx.id)).messages) idOf[m.preview.path.slice(1)] = m.id;
      const q = async term => (await h.list(o, ibx.id, { q: term })).messages.map(m => m.id).sort();
      assert.deepEqual(await q('%'), [idOf.pct]);
      assert.deepEqual(await q('_'), [idOf.under]);
      assert.deepEqual(await q('a_b'), [idOf.under]);
      assert.deepEqual(await q('\\'), [idOf.slash]);
      assert.deepEqual(await q('pushhappened'), [idOf.json]);
      assert.deepEqual(await q('PERCENT'), [idOf.plain]);
      assert.deepEqual(await q('/near'), [idOf.near], 'path is indexed');
      assert.deepEqual(await q('no-such-text-anywhere'), []);
    });

    it('binary bodies are not indexed as text', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      await postOpen(h, ibx, '/bin', { body: 'needle-in-binary', headers: { 'Content-Type': 'application/octet-stream' } });
      assert.deepEqual((await h.list(o, ibx.id, { q: 'needle-in-binary' })).messages, []);
    });
  });

  // ---------------------------------------------------------------- retention and cleanup
  describe('retention and cleanup (DESIGN: Lifecycle and cleanup)', () => {
    it('expired messages vanish from every read before the sweep, then the sweep removes them', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      await postOpen(h, ibx, '/keep', { body: 'keeper', headers: { 'Content-Type': 'text/plain' } });
      await postOpen(h, ibx, '/gone', { body: 'expiring-needle', headers: { 'Content-Type': 'text/plain' } });
      const msgs = (await h.list(o, ibx.id)).messages;
      const gone = msgs.find(m => m.preview.path === '/gone');
      const keep = msgs.find(m => m.preview.path === '/keep');
      await h.db.prepare('UPDATE messages SET expires_at=? WHERE id=?').bind(now() - 1, gone.id).run();
      assert.deepEqual((await h.list(o, ibx.id, { archived: 'all' })).messages.map(m => m.id), [keep.id]);
      assert.deepEqual((await h.list(o, ibx.id, { q: 'expiring-needle' })).messages, []);
      isErr(await h.rpc('getMessage', o, ibx.id, gone.id), 'not_found');
      isErr(await h.rpc('getMessageBody', o, ibx.id, gone.id), 'not_found');
      isErr(await h.rpc('setArchived', o, ibx.id, gone.id, true), 'not_found');
      assert.equal((await h.row('messages', gone.id)).state, 'stored', 'still present until the sweep');
      await h.sweep();
      assert.equal(await h.row('messages', gone.id), null);
      assert.deepEqual(await h.objects(`m/${ibx.id}/`), [`m/${ibx.id}/${keep.id}`]);
      const row = await h.row('inboxes', ibx.id);
      assert.equal(row.message_count, 1);
      assert.equal(row.bytes_stored, 'keeper'.length);
    });

    it('cleans more than 100 expired messages across bounded runs', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      const live = await plant(h, ibx.id, { size: 5 });
      for (let i = 0; i < 120; i++) await plant(h, ibx.id, { received_at: now() - 100, expires_at: now() - 10 - i, size: 3 });
      assert.equal((await h.row('inboxes', ibx.id)).message_count, 121);
      let runs = 0;
      while (runs < 12) {
        await h.sweep();
        runs++;
        const left = (await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n;
        if (left === 1) break;
      }
      assert.deepEqual((await h.db.prepare('SELECT id FROM messages WHERE inbox_id=?').bind(ibx.id).all()).results.map(r => r.id), [live]);
      assert.deepEqual(await h.objects(`m/${ibx.id}/`), [`m/${ibx.id}/${live}`]);
      const row = await h.row('inboxes', ibx.id);
      assert.equal(row.message_count, 1);
      assert.equal(row.bytes_stored, 5);
    });

    it('deleteMessage removes object and row and releases quota', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      await postOpen(h, ibx, '/', { body: 'delete me' });
      await postOpen(h, ibx, '/', { body: 'stay' });
      const [m1, m2] = (await h.list(o, ibx.id)).messages;
      assert.deepEqual(await h.rpc('deleteMessage', o, ibx.id, m1.id), { id: m1.id, deleted: true });
      assert.equal(await h.row('messages', m1.id), null);
      assert.equal(await h.r2.head(`m/${ibx.id}/${m1.id}`), null);
      isErr(await h.rpc('getMessage', o, ibx.id, m1.id), 'not_found');
      isErr(await h.rpc('deleteMessage', o, ibx.id, m1.id), 'not_found');
      const usage = (await h.rpc('getInbox', o, ibx.id)).usage;
      assert.equal(usage.messages, 1);
      assert.equal(usage.bytes, m2.size);
    });

    it('sweeps stale pending and stuck deleting rows; fresh pending rows stay hidden and survive', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      const stale = await plant(h, ibx.id, { state: 'pending', received_at: now() - Number(LIMITS.DESTROY_QUIESCE_SECONDS) - 60 });
      const fresh = await plant(h, ibx.id, { state: 'pending', received_at: now() });
      const stuck = await plant(h, ibx.id, { state: 'deleting' });
      const listed = await h.list(o, ibx.id, { archived: 'all' });
      assert.deepEqual(listed.messages, [], 'pending and deleting rows are invisible');
      isErr(await h.rpc('getMessage', o, ibx.id, fresh), 'not_found');
      await h.sweep();
      assert.equal(await h.row('messages', stale), null);
      assert.equal(await h.row('messages', stuck), null);
      assert.equal(await h.r2.head(`m/${ibx.id}/${stale}`), null);
      assert.equal(await h.r2.head(`m/${ibx.id}/${stuck}`), null);
      assert.equal((await h.row('messages', fresh)).state, 'pending');
      const row = await h.row('inboxes', ibx.id);
      assert.equal(row.message_count, 1);
      assert.equal(row.bytes_stored, 3);
      // A stale writer can complete after its row was removed. Keep sweeping this
      // prefix, but never delete fresh pending or accepted objects alongside it.
      const live = await plant(h, ibx.id, { size: 4 });
      await h.r2.put(`m/${ibx.id}/${stale}`, 'late stale put');
      await h.sweep();
      assert.equal(await h.r2.head(`m/${ibx.id}/${stale}`), null);
      assert.ok(await h.r2.head(`m/${ibx.id}/${fresh}`));
      assert.ok(await h.r2.head(`m/${ibx.id}/${live}`));
      assert.ok(await h.db.prepare('SELECT inbox_id FROM cleanup_prefixes WHERE inbox_id=?').bind(ibx.id).first());
    });
  });

  // ---------------------------------------------------------------- destruction
  describe('destruction (DESIGN: Inbox destruction)', () => {
    it('hides everything at once, finalizes only after quiescence and an empty prefix, never resurrects', async () => {
      const o = owner();
      const ibx = await h.create(o, 'http');
      const c = await h.rpc('createCredential', o, ibx.id, { name: 'alice' });
      const auth = { Authorization: `Bearer ${c.token}` };
      for (let i = 0; i < 3; i++) assert.equal((await postOpen(h, ibx, '/', { body: `d${i}`, headers: auth })).status, 200);
      const [m] = (await h.list(o, ibx.id)).messages;

      const destroying = await h.rpc('destroyInbox', o, ibx.id);
      assertDestroy(destroying, ibx.id);
      assert.deepEqual(await h.rpc('destroyInbox', o, ibx.id), destroying, 'idempotent');
      assert.equal((await h.rpc('getInbox', o, ibx.id)).cleanup_not_before, destroying.cleanup_not_before);
      assert.equal((await h.rpc('getInbox', o, ibx.id)).state, 'destroying');
      assert.equal((await h.rpc('listInboxes', o)).inboxes.find(i => i.id === ibx.id).state, 'destroying');
      const recv = await postOpen(h, ibx, '/', { body: 'late', headers: auth });
      assert.equal(recv.status, 404);
      assert.deepEqual(JSON.parse(recv.text), { error: 'not_found' });
      assert.equal((await postOpen(h, ibx, '/', { body: 'late' })).status, 404);
      for (const [method, args] of [['listMessages', [ibx.id, {}]], ['getMessage', [ibx.id, m.id]], ['getMessageBody', [ibx.id, m.id]],
        ['setArchived', [ibx.id, m.id, true]], ['deleteMessage', [ibx.id, m.id]], ['listCredentials', [ibx.id]],
        ['createCredential', [ibx.id, {}]], ['revokeCredential', [ibx.id, c.credential.id]]]) {
        isErr(await h.rpc(method, o, ...args), 'not_found');
      }
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM credentials WHERE inbox_id=?').bind(ibx.id).first()).n, 0, 'credentials deleted immediately');

      // An orphan object (for example from a receiver that raced the destroy) must be reconciled.
      await h.r2.put(`m/${ibx.id}/msg_orphan`, 'orphan');
      // Not yet quiesced: messages may be cleaned but the inbox row must remain.
      await h.sweep();
      await h.sweep();
      assert.ok(await h.row('inboxes', ibx.id), 'no finalize before DESTROY_QUIESCE_SECONDS');
      assert.equal((await h.rpc('getInbox', o, ibx.id)).state, 'destroying');

      await h.db.prepare('UPDATE inboxes SET destroy_requested_at=? WHERE id=?').bind(now() - Number(LIMITS.DESTROY_QUIESCE_SECONDS) - 5, ibx.id).run();
      let gone = false;
      for (let i = 0; i < 6 && !gone; i++) {
        await h.sweep();
        gone = (await h.row('inboxes', ibx.id)) === null;
        if (gone) assert.deepEqual(await h.objects(`m/${ibx.id}/`), [], 'row disappears only after the prefix is empty');
      }
      assert.ok(gone, 'eventually finalized');
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n, 0);
      isErr(await h.rpc('getInbox', o, ibx.id), 'not_found');
      isErr(await h.rpc('destroyInbox', o, ibx.id), 'not_found');
      assert.ok(!(await h.rpc('listInboxes', o)).inboxes.some(i => i.id === ibx.id));

      // The address never resolves again and later arrivals create nothing.
      assert.equal((await postOpen(h, ibx, '/', { body: 'zombie', headers: auth })).status, 404);
      assert.equal((await postOpen(h, ibx, '/', { body: 'zombie' })).status, 404);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM inboxes WHERE nonce=?').bind(nonceOf(ibx)).first()).n, 0);
      assert.deepEqual(await h.objects(`m/${ibx.id}/`), []);
      const fresh = await h.create(o, 'http');
      assert.notEqual(nonceOf(fresh), nonceOf(ibx));
      // An empty prefix at finalization does not fence provider writes already in
      // flight. Its id-only reconciliation record survives indefinitely.
      await h.r2.put(`m/${ibx.id}/msg_after_finalization`, 'delayed provider write');
      await h.sweep();
      assert.deepEqual(await h.objects(`m/${ibx.id}/`), []);
      assert.ok(await h.db.prepare('SELECT inbox_id FROM cleanup_prefixes WHERE inbox_id=?').bind(ibx.id).first());
    });

    it('a destroying email inbox rejects mail at once and its address never comes back', async () => {
      const o = owner();
      const e = await h.create(o, 'email');
      assert.equal((await h.email({ to: e.address, raw: mail({ to: e.address }) })).rejectReason, undefined);
      await h.rpc('destroyInbox', o, e.id);
      assert.equal((await h.email({ to: e.address, raw: mail({ to: e.address }) })).rejectReason, '5.1.1 Address not found');
      await h.db.prepare('UPDATE inboxes SET destroy_requested_at=? WHERE id=?').bind(now() - 10000, e.id).run();
      for (let i = 0; i < 4 && await h.row('inboxes', e.id); i++) await h.sweep();
      assert.equal(await h.row('inboxes', e.id), null);
      assert.deepEqual(await h.objects(`m/${e.id}/`), []);
      assert.equal((await h.email({ to: e.address, raw: mail({ to: e.address }) })).rejectReason, '5.1.1 Address not found');
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM inboxes WHERE nonce=?').bind(nonceOf(e)).first()).n, 0);
    });
  });
});

// ================================================================ rate limits

describe('burst rate limits (DESIGN: Limits, ACCEPT_LIMIT / REJECT_LIMIT)', () => {
  let h;
  before(async () => {
    h = await harness({ ratelimits: { accept: 3, reject: 2 } });
    // Miniflare's local limiter is exact but uses wall-clock-aligned 60 s windows.
    // Avoid starting near a window boundary so counts cannot reset mid-test.
    const into = Date.now() % 60000;
    if (into > 45000) await new Promise(r => setTimeout(r, 60500 - into));
  });
  after(async () => { await h?.mf.dispose(); });

  it('auth failures spend REJECT_LIMIT only; accepts spend ACCEPT_LIMIT; both 429 with Retry-After: 60', async () => {
    const o = owner();
    const ibx = await h.create(o, 'http');
    const other = await h.create(o, 'http');
    const c = await h.rpc('createCredential', o, ibx.id, {});
    const bad = { Authorization: `Bearer sk-bayleaf-inbox-${'f'.repeat(64)}` };
    assert.equal((await postOpen(h, ibx, '/', { body: 'x', headers: bad })).status, 401);
    assert.equal((await postOpen(h, ibx, '/', { body: 'x' })).status, 401);
    const limited = await postOpen(h, ibx, '/', { body: 'x', headers: bad });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    const good = { Authorization: `Bearer ${c.token}` };
    for (let i = 0; i < 3; i++) assert.equal((await postOpen(h, ibx, '/', { body: `ok${i}`, headers: good })).status, 200, 'exhausted rejects do not block a valid token');
    const over = await postOpen(h, ibx, '/', { body: 'x', headers: good });
    assert.equal(over.status, 429);
    assert.equal(over.headers.get('retry-after'), '60');
    assert.equal((await h.row('inboxes', ibx.id)).message_count, 3);
    assert.equal((await postOpen(h, other, '/', { body: 'x' })).status, 200, 'limits are keyed per inbox');
  });

  it('email over ACCEPT_LIMIT is rejected with 4.7.0', async () => {
    const o = owner();
    const e = await h.create(o, 'email');
    for (let i = 0; i < 3; i++) assert.equal((await h.email({ to: e.address, raw: mail({ to: e.address }) })).rejectReason, undefined);
    assert.equal((await h.email({ to: e.address, raw: mail({ to: e.address }) })).rejectReason, '4.7.0 Rate limited, try later');
    assert.equal((await h.row('inboxes', e.id)).message_count, 3);
  });
});

// ================================================================ feature flag and misconfiguration

describe('feature flag and fail-closed configuration (DESIGN: Feature flag, Limits)', () => {
  for (const [label, value] of [['unset', undefined], ['"TRUE"', 'TRUE'], ['"1"', '1']]) {
    it(`INBOXES_ENABLED ${label} disables fetch, email and RPC`, async () => {
      const h = await harness({ vars: { INBOXES_ENABLED: value } });
      try {
        const o = owner();
        assert.deepEqual(await h.rpc('createInbox', o, { type: 'http', access: 'open' }), { error: 'disabled' });
        assert.deepEqual(await h.rpc('listInboxes', o), { error: 'disabled' });
        // Plant an inbox directly to show that even a real one is unreachable.
        const nonce = b32(26), mailNonce = b32(26);
        await h.db.prepare("INSERT INTO inboxes (id, owner, type, nonce, state, created_at) VALUES (?,?,?,?,'active',?)")
          .bind(`ibx_${b32(26)}`, o, 'http', nonce, now()).run();
        await h.db.prepare("INSERT INTO inboxes (id, owner, type, nonce, state, created_at) VALUES (?,?,?,?,'active',?)")
          .bind(`ibx_${b32(26)}`, o, 'email', mailNonce, now()).run();
        assert.equal((await h.http(`https://${nonce}.${DOMAIN}/`, { method: 'POST', body: 'x' })).status, 503);
        const to = `${mailNonce}@${DOMAIN}`;
        assert.equal((await h.email({ to, raw: mail({ to }) })).rejectReason, 'Inbox service unavailable');
        assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages').first()).n, 0);
      } finally { await h.mf.dispose(); }
    });
  }

  it('missing rate-limit bindings fail closed with 503', async () => {
    const h = await harness({ ratelimits: null });
    try {
      const o = owner();
      const ibx = await h.create(o, 'http');
      assert.equal((await postOpen(h, ibx, '/', { body: 'x' })).status, 503);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages').first()).n, 0);
    } finally { await h.mf.dispose(); }
  });
});

// ---------------------------------------------------------------- fixtures

function mailWithAttachment({ to }) {
  const subject = 'Grüße – 東京 ✓';
  const attachment = Uint8Array.from({ length: 256 }, (_, i) => 255 - i);
  const b64 = Buffer.from(attachment).toString('base64').replace(/.{76}/g, '$&\r\n');
  const authResults = [
    'mx.cloudflare.net; dkim=pass header.d=example.org header.s=s1 header.b=AbCd',
    'mx.cloudflare.net; spf=pass smtp.mailfrom=example.org',
  ];
  const raw = Buffer.from([
    'From: =?UTF-8?Q?Zo=C3=AB?= <zoe@example.org>',
    `To: <${to}>`,
    `Subject: ${encSubject(subject)}`,
    'Date: Tue, 20 Oct 2026 12:00:00 +0000',
    'Message-ID: <multi-1@example.org>',
    'In-Reply-To: <earlier@example.org>',
    ...authResults.map(v => `Authentication-Results: ${v}`),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUNDARY42"',
    '',
    '--BOUNDARY42',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Hello from the multipart test, marker unique-token-xyz.',
    '--BOUNDARY42',
    'Content-Type: application/octet-stream',
    "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.bin",
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--BOUNDARY42--',
    '',
  ].join('\r\n'), 'utf8');
  return { raw, subject, attachment, authResults };
}

describe('readable text for agents (DESIGN: getMessageText)', () => {
  let h;
  before(async () => { h = await harness({ vars: { MAX_TEXT_CHARS: '40', MAX_EMAIL_BYTES: '70000' } }); });
  after(async () => { await h?.mf.dispose(); });
  const first = async (o, ibx) => (await h.list(o, ibx.id)).messages[0];

  it('email: text part, HTML fallback, truncation, isolation', async () => {
    const o = owner(), ibx = await h.create(o, 'email');
    await h.email({ to: ibx.address, raw: mail({ to: ibx.address, body: 'short text body' }) });
    const m = await first(o, ibx);
    assert.deepEqual(await h.rpc('getMessageText', o, ibx.id, m.id),
      { id: m.id, type: 'email', source: 'text', text: 'short text body\n', truncated: false });
    isErr(await h.rpc('getMessageText', owner(), ibx.id, m.id), 'not_found');

    const ibx2 = await h.create(o, 'email');
    const html = Buffer.from([`From: a@example.org`, `To: ${ibx2.address}`, 'Subject: h', `Message-ID: <${b32(8)}@x>`,
      'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '',
      '<p>Fish &amp; chips</p><script>steal()</script><p>dessert, all of it, more and more words</p>', ''].join('\r\n'));
    await h.email({ to: ibx2.address, raw: html });
    const t = await h.rpc('getMessageText', o, ibx2.id, (await first(o, ibx2)).id);
    assert.equal(t.source, 'html');
    assert.equal(t.truncated, true);
    assert.equal(t.text.length, 40);
    assert.ok(t.text.startsWith('Fish & chips') && !t.text.includes('steal') && !t.text.includes('<'));
  });

  it('http: textual body decoded, binary is none, expired hidden', async () => {
    const o = owner(), ibx = await h.create(o, 'http');
    await postOpen(h, ibx, '/', { body: '{"ok":1}', headers: { 'Content-Type': 'application/json' } });
    const j = await first(o, ibx);
    assert.deepEqual(await h.rpc('getMessageText', o, ibx.id, j.id),
      { id: j.id, type: 'http', source: 'body', text: '{"ok":1}', truncated: false });
    const bin = await h.create(o, 'http');
    await postOpen(h, bin, '/', { body: new Uint8Array([0, 1, 2]), headers: { 'Content-Type': 'image/png' } });
    const b = await first(o, bin);
    assert.equal((await h.rpc('getMessageText', o, bin.id, b.id)).source, 'none');
    await h.db.prepare('UPDATE messages SET expires_at=1 WHERE id=?').bind(j.id).run();
    isErr(await h.rpc('getMessageText', o, ibx.id, j.id), 'not_found');
  });

  it('hostile 64k unmatched tags have bounded scanning and conservatively report truncation', { timeout: 30000 }, async () => {
    const o = owner(), ibx = await h.create(o, 'email');
    const raw = Buffer.from('From: a@example.org\r\nContent-Type: text/html\r\n\r\n' + '<'.repeat(65536));
    // Plant exact raw bytes to bypass the reception byte cap (headers add bytes).
    const id = await plant(h, ibx.id, { size: raw.length });
    await h.r2.put(`m/${ibx.id}/${id}`, raw);
    await h.db.prepare('UPDATE messages SET meta_json=? WHERE id=?')
      .bind(JSON.stringify({ type: 'email', parse_error: false }), id).run();
    const text = await h.rpc('getMessageText', o, ibx.id, id);
    assert.equal(text.source, 'html');
    assert.equal(text.text, '');
    assert.equal(text.truncated, true, 'input bound, not only output bound, is disclosed');
    // Reception exercises the same scanner for the search index.
    const other = await h.create(o, 'email');
    const received = await h.emailDirect({ to: other.address,
      raw: Buffer.from('From: a@example.org\r\nContent-Type: text/html\r\n\r\n' + '<'.repeat(64000)) });
    assert.equal(received.rejectReason, undefined);
    assert.equal(received.outcome, 'ok');
    assert.equal((await h.list(o, other.id)).messages.length, 1);
  });
});

describe('durable delayed-write reconciliation', () => {
  let h;
  before(async () => { h = await harness(); });
  after(async () => { await h?.mf.dispose(); });

  it('reconciles a delayed R2 put after inbox finalization even when inline delete fails', { timeout: 30000 }, async () => {
    const o = owner(), ibx = await h.create(o, 'http'), latch = b32(16);
    const receiving = postOpen(h, ibx, '/', { body: 'delayed', headers: { 'x-harness-delay-put': latch } });
    await h.putControl(latch, 'wait');
    try {
      assert.equal((await h.row('inboxes', ibx.id)).message_count, 1, 'put is paused after reservation');
      await h.rpc('destroyInbox', o, ibx.id);
      await h.db.prepare('UPDATE inboxes SET destroy_requested_at=? WHERE id=?').bind(now() - 10000, ibx.id).run();
      await h.sweep();
      assert.equal(await h.row('inboxes', ibx.id), null);
    } finally {
      await h.putControl(latch, 'release');
    }
    assert.equal((await receiving).status, 404);
    assert.equal((await h.objects(`m/${ibx.id}/`)).length, 1, 'failed inline cleanup leaves the late write');
    await h.sweep();
    assert.deepEqual(await h.objects(`m/${ibx.id}/`), []);
    await h.r2.put(`m/${ibx.id}/msg_even_later`, 'another late completion');
    await h.sweep();
    assert.deepEqual(await h.objects(`m/${ibx.id}/`), []);
  });

  it('persisted round-robin progress reaches prefixes beyond a full sweep batch', async () => {
    const prefixes = Array.from({ length: 55 }, () => `ibx_${b32(26)}`);
    for (const id of prefixes) {
      await h.db.prepare('INSERT INTO cleanup_prefixes (inbox_id) VALUES (?)').bind(id).run();
      await h.r2.put(`m/${id}/msg_orphan`, 'orphan');
    }
    await h.sweep();
    await h.sweep();
    for (const id of prefixes) assert.deepEqual(await h.objects(`m/${id}/`), []);
    const paged = prefixes[0];
    for (let i = 0; i < 65; i++) await h.r2.put(`m/${paged}/msg_${String(i).padStart(3, '0')}`, 'late');
    for (let i = 0; i < 4; i++) await h.sweep();
    assert.deepEqual(await h.objects(`m/${paged}/`), [], 'R2 cursor survives bounded page traversal');
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM cleanup_prefixes').first()).n, 56, 'empty prefixes are retained');
  });
});

exportTests({ harness, owner, mail, postOpen, sha256, plant, isErr, now, b32 });

describe('endpoint lifetimes (DESIGN: Endpoint lifetimes)', () => {
  let h;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h?.mf.dispose(); });
  // Time travel: move an inbox's lifetime into the past without waiting.
  const lapse = (id, ago = 1) => h.db.prepare('UPDATE inboxes SET expires_at=? WHERE id=?').bind(now() - ago, id).run();
  const QUIESCE = Number(LIMITS.DESTROY_QUIESCE_SECONDS);

  it('preserves pagination after the entire SQL page expires during a read', async () => {
    const o = owner(), box = await h.create(o, 'http');
    const deadline = now() + 2;
    await plant(h, box.id, { received_at: now(), expires_at: deadline });
    await plant(h, box.id, { received_at: now() - 1, expires_at: deadline });
    const tail = await plant(h, box.id, { received_at: now() - 2 });
    const latch = b32(16);
    const pending = h.delayed('listMessages', [o, box.id, { limit: 2 }],
      'after:SELECT id, inbox_id, received_at', latch);
    await h.putControl(latch, 'wait');
    try { await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline * 1000 - Date.now()) + 100)); }
    finally { await h.putControl(latch, 'release'); }
    const page = await (await pending).json();
    assert.deepEqual(page.messages, []);
    assert.ok(page.next_cursor);
    const next = await h.rpc('listMessages', o, box.id, { limit: 2, cursor: page.next_cursor });
    assert.deepEqual(next.messages.map(m => m.id), [tail]);
    assert.equal(next.next_cursor, null);
  });

  it('removes a minted credential when expiry wins the post-commit check', async () => {
    const o = owner(), box = await h.create(o, 'http');
    const latch = b32(16);
    const pending = h.delayed('createCredential', [o, box.id, {}], 'after:INSERT INTO credentials', latch);
    await h.putControl(latch, 'wait');
    try { await lapse(box.id); } finally { await h.putControl(latch, 'release'); }
    isErr(await (await pending).json(), 'not_found');
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM credentials WHERE inbox_id=?').bind(box.id).first()).n, 0);
    assert.equal((await h.row('inboxes', box.id)).auth_required, 1);
  });

  it('bounds expired backlog admission while existing destruction and reconciliation progress', async () => {
    const local = await harness({ vars: { INBOX_TELEMETRY_ENABLED: 'true',
      INBOX_TELEMETRY_WRITE_SECRET: 'synthetic-inboxes-writer-for-local-tests' } });
    try {
      const old = await local.create(owner(), 'http');
      await local.rpc('destroyInbox', (await local.row('inboxes', old.id)).owner, old.id);
      await local.db.prepare('UPDATE inboxes SET destroy_requested_at=? WHERE id=?').bind(now() - QUIESCE - 10, old.id).run();
      const orphan = 'ibx_' + b32(16);
      await local.db.prepare('INSERT INTO cleanup_prefixes(inbox_id,turn) VALUES (?,0)').bind(orphan).run();
      await local.r2.put(`m/${orphan}/late`, 'synthetic');
      for (let i = 0; i < 12; i++) {
        const box = await local.create(owner(), 'http');
        await local.db.prepare('UPDATE inboxes SET expires_at=? WHERE id=?').bind(now() - QUIESCE - 10, box.id).run();
      }
      const measured = await (await local.delayed('sweep', [], 'no-gate', '')).json();
      assert.ok(measured.dbCalls < 100, JSON.stringify(measured));
      assert.ok(measured.dbStatements < 150, JSON.stringify(measured));
      console.log(JSON.stringify({ lifetime_backlog_sweep: measured }));
      assert.equal(await local.row('inboxes', old.id), null);
      assert.equal(await local.r2.get(`m/${orphan}/late`), null);
      assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM inboxes WHERE state='active'").first()).n, 7);
      assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM inboxes WHERE state='destroying'").first()).n, 5);
      await local.sweep();
      assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM inboxes WHERE state='active'").first()).n, 2);
      await local.r2.put(`m/${orphan}/late-again`, 'synthetic');
      const failed = await local.delayed('sweep', [], 'fail-transition', '');
      assert.equal(failed.status, 200, 'admission failure is contained');
      assert.equal(await local.r2.get(`m/${orphan}/late-again`), null);
      assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM inboxes WHERE state='active'").first()).n, 2);
    } finally { await local.mf.dispose(); }
  });

  it('uses execution-time expiry during delayed reservation, stored mark and credential insertion', { timeout: 30000 }, async () => {
    await h.db.prepare('CREATE TABLE observed_stored_marks (inbox_id TEXT)').run();
    await h.db.prepare(`CREATE TRIGGER observe_stored_mark AFTER UPDATE OF state ON messages
      WHEN NEW.state = 'stored' BEGIN INSERT INTO observed_stored_marks VALUES (NEW.inbox_id); END`).run();
    // D1 change counts include trigger writes. Each test has its own database,
    // so this observer cannot affect later successful stored marks.
    for (const point of ['INSERT INTO messages', "UPDATE messages SET state = 'stored'", 'INSERT INTO credentials']) {
      const o = owner(), box = await h.create(o, 'http');
      const deadline = now() + 2;
      await h.db.prepare('UPDATE inboxes SET expires_at=? WHERE id=?').bind(deadline, box.id).run();
      const latch = b32(16), credential = point === 'INSERT INTO credentials';
      const pending = h.delayed(credential ? 'createCredential' : 'receive',
        credential ? [o, box.id, {}] : [box.url], point, latch);
      await h.putControl(latch, 'wait');
      try {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline * 1000 - Date.now()) + 100));
      } finally { await h.putControl(latch, 'release'); }
      const response = await pending;
      if (credential) isErr(await response.json(), 'not_found');
      else assert.equal(response.status, 404, point);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM observed_stored_marks WHERE inbox_id=?').bind(box.id).first()).n, 0,
        'SQL must refuse the stored mark itself, not merely clean up after a late success');
      if (point === 'INSERT INTO messages') assert.equal((await h.row('inboxes', box.id)).day_count, 0,
        'expired SQL reservation must not spend quota');
      assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE inbox_id=? AND state='stored'").bind(box.id).first()).n, 0);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM credentials WHERE inbox_id=?').bind(box.id).first()).n, 0);
    }
  });

  it('revalidates lists and R2-backed body, text and attachment reads after awaited work', { timeout: 30000 }, async () => {
    const cases = [
      ['listMessages', 'http', 'FROM messages', false],
      ['listCredentials', 'http', 'FROM credentials', false],
      ['getMessageBody', 'http', 'R2 read', true],
      ['getMessageText', 'http', 'R2 read', true],
      ['getMessageText', 'email', 'R2 read', true],
      ['getAttachment', 'email', 'R2 read', true],
    ];
    for (const [method, type, point, messageArg] of cases) {
      const o = owner(), box = await h.create(o, type);
      if (type === 'email') await h.email({ to: box.address, raw: mailWithAttachment({ to: box.address }).raw });
      else await postOpen(h, box, '/', { body: 'read me', headers: { 'Content-Type': 'text/plain' } });
      const [msg] = (await h.list(o, box.id)).messages;
      if (method === 'listCredentials') assertOk(await h.rpc('createCredential', o, box.id, {}));
      const args = [o, box.id, ...(messageArg ? [msg.id] : []), ...(method === 'getAttachment' ? [0] : [])];
      // Same delayed path must still succeed for a legacy, unlimited inbox.
      for (const expire of [false, true]) {
        const latch = b32(16);
        const pending = h.delayed(method, args, point, latch);
        await h.putControl(latch, 'wait');
        try {
          if (expire) await h.db.prepare('UPDATE inboxes SET expires_at=unixepoch() WHERE id=?').bind(box.id).run();
        } finally { await h.putControl(latch, 'release'); }
        const response = await pending;
        if (expire) isErr(await response.json(), 'not_found');
        else if (['getMessageBody', 'getAttachment'].includes(method)) assert.ok((await response.arrayBuffer()).byteLength > 0);
        else assertOk(await response.json());
      }
    }
  });

  it('presets respect a deployment maximum below the preset lifetime', async () => {
    const capped = await harness({ vars: { MAX_INBOX_TTL_SECONDS: '60' } });
    try {
      const o = owner();
      isErr(await capped.rpc('createInbox', o, { type: 'http', access: 'open', preset: 'experiment' }), 'invalid');
      const box = await capped.create(o, 'http');
      isErr(await capped.rpc('updateInbox', o, box.id, { preset: 'experiment' }), 'invalid');
      assertOk(await capped.rpc('updateInbox', o, box.id, { ttl_seconds: 60 }));
    } finally { await capped.mf.dispose(); }
  });

  it('creates with the 15-minute experiment preset or a bounded ttl_seconds; default has none', async () => {
    const o = owner();
    const t0 = now();
    const exp = await h.create(o, 'http', { preset: 'experiment' });
    assert.ok(Math.abs(exp.expires_at - (exp.created_at + 900)) <= 1);
    assert.ok(exp.created_at >= t0 - 1);
    assert.equal(exp.state, 'active');
    const ttl = await h.create(o, 'email', { ttl_seconds: 3600 });
    assert.equal(ttl.expires_at, ttl.created_at + 3600);
    const plain = await h.create(o, 'http');
    assert.equal(plain.expires_at, null);
    assert.equal((await h.row('inboxes', plain.id)).expires_at, null);
    assert.deepEqual((await h.rpc('listInboxes', o)).inboxes.find(i => i.id === exp.id), exp);
    const p = owner();
    for (const bad of [{ ttl_seconds: 59 }, { ttl_seconds: 2592001 }, { ttl_seconds: 900.5 }, { ttl_seconds: '900' },
      { preset: 'forever' }, { preset: 'constructor' }, { preset: 'experiment', ttl_seconds: 900 }, { ttl_seconds: null }])
      isErr(await h.rpc('createInbox', p, { type: 'http', access: 'open', ...bad }), 'invalid');
    assertOk(await h.rpc('createInbox', p, { type: 'http', access: 'open', ttl_seconds: 2592000 }));
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM inboxes WHERE owner=?').bind(p).first()).n, 1);
  });

  it('refuses email and HTTP (including valid credentials) the moment the lifetime ends, before any sweep', async () => {
    const o = owner();
    const open = await h.create(o, 'http', { preset: 'experiment' });
    const closed = await h.create(o, 'http', { preset: 'experiment' });
    const mailbox = await h.create(o, 'email', { preset: 'experiment' });
    const c = await h.rpc('createCredential', o, closed.id, { name: 'sender' });
    assert.equal((await postOpen(h, open, '/', { body: 'before' })).status, 200);
    assert.equal((await postOpen(h, closed, '/', { body: 'before', headers: { Authorization: `Bearer ${c.token}` } })).status, 200);
    assert.equal((await h.email({ to: mailbox.address, raw: mail() })).rejectReason, undefined);
    for (const ibx of [open, closed, mailbox]) await lapse(ibx.id);
    const gone = await postOpen(h, open, '/', { body: 'after' });
    assert.equal(gone.status, 404);
    assert.deepEqual(JSON.parse(gone.text), NOT_FOUND);
    assert.equal((await h.http(open.url, { method: 'GET' })).status, 404);
    assert.equal((await postOpen(h, closed, '/', { body: 'after', headers: { Authorization: `Bearer ${c.token}` } })).status, 404);
    // Refused at lookup, before authentication: never a 401 that confirms the endpoint.
    assert.equal((await postOpen(h, closed, '/', { body: 'after' })).status, 404);
    assert.equal((await postOpen(h, closed, '/', { body: 'after', headers: { Authorization: `Bearer sk-bayleaf-inbox-${'0'.repeat(64)}` } })).status, 404);
    assert.equal((await h.email({ to: mailbox.address, raw: mail() })).rejectReason, '5.1.1 Address not found');
    // Refused at the address lookup, before size or rate checks.
    assert.equal((await h.emailDirect({ to: mailbox.address, raw: mail(), rawSize: 10 ** 9 })).rejectReason, '5.1.1 Address not found');
    for (const ibx of [open, closed, mailbox]) assert.equal((await h.row('inboxes', ibx.id)).message_count, 1);
  });

  it('owner reads and writes stop at expiry; the inbox reports destroying with cleanup_not_before', async () => {
    const o = owner();
    const ibx = await h.create(o, 'http', { ttl_seconds: 600 });
    const c = await h.rpc('createCredential', o, ibx.id, {});
    assert.equal((await postOpen(h, ibx, '/', { body: 'kept', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'text/plain' } })).status, 200);
    const [m] = (await h.list(o, ibx.id)).messages;
    await lapse(ibx.id, 5);
    const ended = (await h.row('inboxes', ibx.id)).expires_at;
    isErr(await h.rpc('listMessages', o, ibx.id, {}), 'not_found');
    isErr(await h.rpc('getMessage', o, ibx.id, m.id), 'not_found');
    isErr(await h.rpc('getMessageText', o, ibx.id, m.id), 'not_found');
    isErr(await h.rpc('getMessageBody', o, ibx.id, m.id), 'not_found');
    isErr(await h.rpc('setArchived', o, ibx.id, m.id, true), 'not_found');
    isErr(await h.rpc('deleteMessage', o, ibx.id, m.id), 'not_found');
    isErr(await h.rpc('createCredential', o, ibx.id, {}), 'not_found');
    isErr(await h.rpc('listCredentials', o, ibx.id), 'not_found');
    isErr(await h.rpc('revokeCredential', o, ibx.id, c.credential.id), 'not_found');
    isErr(await h.rpc('updateInbox', o, ibx.id, { ttl_seconds: 60 }), 'not_found');
    const view = await h.rpc('getInbox', o, ibx.id);
    assert.equal(view.state, 'destroying');
    assert.equal(view.expires_at, ended);
    assert.equal(view.cleanup_not_before, ended + QUIESCE);
    assert.equal((await h.row('inboxes', ibx.id)).state, 'active', 'computed at read time, not yet transitioned');
    // An owner's explicit destroy of an expired inbox joins the same path, anchored at expiry.
    assertDestroy(await h.rpc('destroyInbox', o, ibx.id), ibx.id);
    const row = await h.row('inboxes', ibx.id);
    assert.equal(row.state, 'destroying');
    assert.equal(row.destroy_requested_at, ended);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM credentials WHERE inbox_id=?').bind(ibx.id).first()).n, 0);
  });

  it('reads, arrivals, credentials and archive changes never renew; updateInbox only shortens or sets', async () => {
    const o = owner();
    const ibx = await h.create(o, 'http', { ttl_seconds: 3600 });
    const set = ibx.expires_at;
    const c = await h.rpc('createCredential', o, ibx.id, {});
    for (let i = 0; i < 3; i++)
      assert.equal((await postOpen(h, ibx, '/', { body: `n${i}`, headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'text/plain' } })).status, 200);
    const [m] = (await h.list(o, ibx.id)).messages;
    assertOk(await h.rpc('getMessage', o, ibx.id, m.id));
    assertOk(await h.rpc('getMessageText', o, ibx.id, m.id));
    assertOk(await h.rpc('setArchived', o, ibx.id, m.id, true));
    assertOk(await h.rpc('setArchived', o, ibx.id, m.id, false));
    assertOk(await h.rpc('listCredentials', o, ibx.id));
    assertOk(await h.rpc('revokeCredential', o, ibx.id, c.credential.id));
    assertOk(await h.rpc('listInboxes', o));
    assert.equal((await h.row('inboxes', ibx.id)).expires_at, set);
    assert.equal((await h.rpc('getInbox', o, ibx.id)).expires_at, set);
    // Lengthening is a conflict and changes nothing; shortening and presets work.
    isErr(await h.rpc('updateInbox', o, ibx.id, { ttl_seconds: 7200 }), 'conflict');
    assert.equal((await h.row('inboxes', ibx.id)).expires_at, set);
    const shorter = await h.rpc('updateInbox', o, ibx.id, { preset: 'experiment' });
    assertOk(shorter);
    assert.ok(shorter.expires_at < set && Math.abs(shorter.expires_at - (now() + 900)) <= 1);
    isErr(await h.rpc('updateInbox', o, ibx.id, { ttl_seconds: 1800 }), 'conflict');
    for (const bad of [{}, { ttl_seconds: 10 }, { preset: 'experiment', ttl_seconds: 900 }, { label: 'x' }])
      isErr(await h.rpc('updateInbox', o, ibx.id, bad), 'invalid');
    // An explicit owner action may give an unlimited inbox a lifetime.
    const plain = await h.create(o, 'email');
    const given = await h.rpc('updateInbox', o, plain.id, { ttl_seconds: 120 });
    assert.equal(given.expires_at > now(), true);
    isErr(await h.rpc('updateInbox', owner(), plain.id, { ttl_seconds: 60 }), 'not_found');
  });

  it('rechecks the lifetime at reservation after a slow upload, and at the stored mark after a slow put', { timeout: 30000 }, async () => {
    const o = owner();
    const ibx = await h.create(o, 'http', { preset: 'experiment' });
    const statements = [{ sql: 'UPDATE inboxes SET expires_at=? WHERE id=?', args: [now() - 1, ibx.id] }];
    assert.equal(await h.slowBody(ibx, {}, statements), 404);
    assert.equal((await h.row('inboxes', ibx.id)).message_count, 0);
    assert.equal((await h.row('inboxes', ibx.id)).day_count, 0, 'refused at reservation: no quota spent');
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(ibx.id).first()).n, 0);
    assert.deepEqual(await h.objects(`m/${ibx.id}/`), []);

    // Reserved while live, then the lifetime ends during the R2 put.
    const late = await h.create(o, 'http', { preset: 'experiment' });
    const latch = b32(16);
    const receiving = postOpen(h, late, '/', { body: 'in flight', headers: { 'x-harness-delay-put': latch } });
    await h.putControl(latch, 'wait');
    try { await lapse(late.id); } finally { await h.putControl(latch, 'release'); }
    assert.equal((await receiving).status, 404);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE inbox_id=? AND state='stored'").bind(late.id).first()).n, 0);
    // The harness makes the receiver's own cleanup delete fail; the shared destroy
    // path and prefix reconciliation remove the leftover object and row.
    await lapse(late.id, QUIESCE + 10);
    await h.sweep();
    await h.sweep(); // Admission follows existing cleanup; process it next run.
    assert.equal(await h.row('inboxes', late.id), null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM messages WHERE inbox_id=?').bind(late.id).first()).n, 0);
    assert.deepEqual(await h.objects(`m/${late.id}/`), []);
  });

  it('the sweep moves expired inboxes into the shared destruction path, then finalizes after quiescence', async () => {
    const o = owner();
    const ibx = await h.create(o, 'http', { preset: 'experiment' });
    const c = await h.rpc('createCredential', o, ibx.id, {});
    assert.equal((await postOpen(h, ibx, '/', { body: 'a', headers: { Authorization: `Bearer ${c.token}` } })).status, 200);
    await plant(h, ibx.id);
    await lapse(ibx.id, 10);
    const ended = (await h.row('inboxes', ibx.id)).expires_at;
    await h.sweep();
    await h.sweep(); // Newly admitted destruction gets its bounded cleanup turn.
    const row = await h.row('inboxes', ibx.id);
    assert.equal(row.state, 'destroying');
    assert.equal(row.destroy_requested_at, ended, 'quiescence is anchored at expiry');
    assert.equal(row.message_count, 0);
    assert.equal(row.bytes_stored, 0);
    assert.deepEqual(await h.objects(`m/${ibx.id}/`), []);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM credentials WHERE inbox_id=?').bind(ibx.id).first()).n, 0);
    assert.ok(await h.db.prepare('SELECT 1 FROM cleanup_prefixes WHERE inbox_id=?').bind(ibx.id).first(), 'durable cleanup record');
    const view = await h.rpc('getInbox', o, ibx.id);
    assert.equal(view.state, 'destroying');
    assert.equal(view.cleanup_not_before, ended + QUIESCE);
    // Quiescence passes (time travel), the next sweep finalizes exactly as for destroyInbox.
    await h.db.prepare('UPDATE inboxes SET destroy_requested_at=? WHERE id=?').bind(now() - QUIESCE - 5, ibx.id).run();
    await h.sweep();
    isErr(await h.rpc('getInbox', o, ibx.id), 'not_found');
    assert.ok(await h.db.prepare('SELECT 1 FROM cleanup_prefixes WHERE inbox_id=?').bind(ibx.id).first(), 'tombstone survives finalization');
  });

  it('inboxes without a lifetime, including rows from before the migration, are untouched by the sweep', async () => {
    const o = owner();
    const plain = await h.create(o, 'http');
    const legacy = `ibx_${b32(26)}`, legacyNonce = b32(26);
    // Shaped like a 0001-era insert: no expires_at column named at all.
    await h.db.prepare(`INSERT INTO inboxes (id, owner, type, nonce, label, state, created_at)
      VALUES (?, ?, 'http', ?, NULL, 'active', ?)`).bind(legacy, o, legacyNonce, now() - 400 * 86400).run();
    await h.db.prepare('UPDATE inboxes SET created_at=? WHERE id=?').bind(now() - 400 * 86400, plain.id).run();
    await h.sweep();
    for (const id of [plain.id, legacy]) {
      const view = await h.rpc('getInbox', o, id);
      assert.equal(view.state, 'active');
      assert.equal(view.expires_at, null);
    }
    assert.equal((await h.http(`https://${legacyNonce}.${DOMAIN}/hook`, { method: 'POST', body: 'still here' })).status, 200);
    assert.equal((await postOpen(h, plain, '/', { body: 'still here' })).status, 200);
    assert.equal((await h.list(o, legacy)).messages.length, 1);
  });
});

describe('qualification resource guards and retirement fences', () => {
  let h;
  before(async () => { h = await harness({ vars: {
    MAX_EMAIL_BYTES: '1048576', MAX_INBOX_BYTES: '4194304', MAX_OWNER_BYTES: '8388608',
  } }); });
  after(async () => { await h?.mf.dispose(); });

  it('rejects excessive MIME lines before parsing on receipt and legacy text/attachment reads', async () => {
    const o = owner(), box = await h.create(o, 'email');
    const raw = Buffer.from('Content-Type: text/plain\r\n\r\n' + '\n'.repeat(350001));
    const received = await h.emailDirect({ to: box.address, raw });
    assert.equal(received.rejectReason, '5.3.4 MIME resource limit exceeded');
    assert.equal((await h.row('inboxes', box.id)).message_count, 0);
    const message = await plant(h, box.id, { size: raw.length });
    await h.r2.put(`m/${box.id}/${message}`, raw);
    await h.db.prepare('UPDATE messages SET meta_json=? WHERE id=?').bind(JSON.stringify({
      type: 'email', parse_error: false, attachments: [{ index: 0 }],
    }), message).run();
    isErr(await h.rpc('getMessageText', o, box.id, message), 'resource_limit');
    isErr(await h.rpc('getAttachment', o, box.id, message, 0), 'resource_limit');
    assert.deepEqual((await h.rpc('getMessageBody', o, box.id, message)).bytes, new Uint8Array(raw));
  });

  it('durably fences reads, creation and reception, even if active rows are restored', async () => {
    const o = owner(), box = await h.create(o, 'http');
    const credential = await h.rpc('createCredential', o, box.id, {});
    assert.deepEqual(await h.rpc('retireOwner', o), { retired: true });
    assert.deepEqual(await h.rpc('retireOwner', o), { retired: true });
    isErr(await h.rpc('getInbox', o, box.id), 'not_found');
    isErr(await h.rpc('createInbox', o, { type: 'email' }), 'not_found');
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE inbox_id=?').bind(box.id).first()).n, 0);
    await h.db.prepare("UPDATE inboxes SET state='active',destroy_requested_at=NULL WHERE id=?").bind(box.id).run();
    assert.equal((await h.http(box.url, { method: 'POST', body: 'late',
      headers: { Authorization: `Bearer ${credential.token}` } })).status, 404);
    isErr(await h.rpc('getInbox', o, box.id), 'not_found');
    assert.ok((await h.create(owner(), 'email')).id, 'independent generation remains usable');
  });

  it('keeps encoded nested messages inert instead of bypassing raw-line guards recursively', async () => {
    const o = owner(), box = await h.create(o, 'email');
    const nested = Buffer.from('Content-Type: text/plain\r\n\r\n' + '\n'.repeat(350001));
    const encoded = nested.toString('base64').match(/.{1,76}/g).join('\r\n');
    const raw = Buffer.from('Content-Type: message/rfc822\r\nContent-Transfer-Encoding: base64\r\n\r\n' + encoded);
    assert.equal((await h.emailDirect({ to: box.address, raw })).rejectReason, undefined);
    const message = (await h.list(o, box.id)).messages[0];
    assert.equal((await h.rpc('getMessageText', o, box.id, message.id)).source, 'none');
    assert.deepEqual((await h.rpc('getAttachment', o, box.id, message.id, 0)).bytes, new Uint8Array(nested));
    assert.deepEqual((await h.rpc('getMessageBody', o, box.id, message.id)).bytes, new Uint8Array(raw));
  });

  it('rechecks a fence atomically at reservation after a slow HTTP body', async () => {
    const o = owner(), box = await h.create(o, 'http');
    const status = await h.slowBody(box, [], [{
      sql: 'INSERT INTO retired_owners(owner,retired_at) VALUES (?,?)', args: [o, now()],
    }]);
    assert.equal(status, 404);
    assert.equal((await h.row('inboxes', box.id)).message_count, 0);
  });

  it('permits trusted retirement while user-facing reception/RPC is disabled', async () => {
    const off = await harness({ vars: { INBOXES_ENABLED: 'false' } });
    try {
      const o = owner();
      assert.deepEqual(await off.rpc('retireOwner', o), { retired: true });
      assert.ok(await off.db.prepare('SELECT owner FROM retired_owners WHERE owner=?').bind(o).first());
      isErr(await off.rpc('retireOwner', 'bad'), 'invalid');
    } finally { await off.mf.dispose(); }
  });
});
