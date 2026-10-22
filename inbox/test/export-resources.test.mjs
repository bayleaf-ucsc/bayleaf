// Controllable R2 streams and real SQLite: cancellation and async TTL boundaries.
// The ordinary inbox suite separately exercises native workerd DigestStream/R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { database } from '../../telemetry/test/d1.js';

crypto.DigestStream = class extends WritableStream {
  constructor() {
    const hash = createHash('sha256');
    let resolve, reject;
    const digest = new Promise((yes, no) => { resolve = yes; reject = no; });
    super({ write: x => hash.update(x), close: () => resolve(hash.digest()), abort: () => reject(new Error('aborted')) });
    this.digest = digest;
  }
};
const bundle = await build({ entryPoints: [new URL('../src/worker.js', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'entrypoint', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'entrypoint', namespace: 'shim' }));
    b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents:
      'export class WorkerEntrypoint { constructor(ctx,env) { this.env=env; } }' }));
  } }] });
const { InboxManagement } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const owner = 'synthetic-export-owner';
const mid = `msg_${'a'.repeat(26)}`;
const now = () => Math.floor(Date.now() / 1000);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function setup(t, source) {
  const DB = database(); t.after(() => DB.close());
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    DB.sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const env = { DB, INBOXES_ENABLED: 'true', BLOBS: { get: source } };
  const rpc = new InboxManagement({}, env);
  const inbox = await rpc.createInbox(owner, { type: 'http', access: 'open' });
  DB.sql.prepare(`INSERT INTO messages(id,inbox_id,state,received_at,expires_at,archived,size,meta_json,search_text)
    VALUES(?,?,'stored',?,?,0,3,?,'')`).run(mid, inbox.id, now(), now() + 3600,
    JSON.stringify({ method: 'POST', path: '/', query: '', headers: [], content_type: 'text/plain' }));
  return { rpc, inbox, DB, expire: () => DB.sql.prepare('UPDATE inboxes SET expires_at=? WHERE id=?').run(now() - 1, inbox.id) };
}

test('cancelling after tar header releases an unread R2 body without cancelling a locked stream', async t => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  const h = await setup(t, async () => ({ size: 3, body }));
  const page = await h.rpc.exportInbox(owner, h.inbox.id, {});
  const reader = page.body.getReader();
  assert.equal((await reader.read()).value.length, 512);
  await reader.cancel();
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('cancelling interrupts a pending R2 read and aborts its unfinished digest', { timeout: 2000 }, async t => {
  let cancelled = 0;
  const reading = deferred();
  const body = new ReadableStream({ pull() { reading.resolve(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const h = await setup(t, async () => ({ size: 3, body }));
  const page = await h.rpc.exportInbox(owner, h.inbox.id, {}), reader = page.body.getReader();
  await reader.read();
  const pending = reader.read();
  await reading.promise;
  await reader.cancel();
  assert.equal((await pending).done, true);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('cancelling while R2 get is pending releases the eventual object', async t => {
  const getting = deferred(), supplied = deferred();
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  const h = await setup(t, async () => { getting.resolve(); return supplied.promise; });
  const page = await h.rpc.exportInbox(owner, h.inbox.id, {}), reader = page.body.getReader();
  const pending = reader.read();
  await getting.promise;
  const stopped = reader.cancel();
  supplied.resolve({ size: 3, body });
  await stopped;
  assert.equal((await pending).done, true);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('expiry during R2 get prevents standalone HAR and releases its body', async t => {
  let cancelled = 0, h;
  const body = new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  h = await setup(t, async () => { h.expire(); return { size: 3, body }; });
  assert.deepEqual(await h.rpc.getMessageHar(owner, h.inbox.id, mid), { error: 'not_found' });
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.deepEqual(await h.rpc.exportInbox(owner, h.inbox.id, {}), { error: 'not_found' });
});

test('retirement during R2 get fences an open export even after its inbox is restored active', async t => {
  let h, cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  h = await setup(t, async () => {
    assert.deepEqual(await h.rpc.retireOwner(owner), { retired: true });
    h.DB.sql.prepare("UPDATE inboxes SET state='active',destroy_requested_at=NULL").run();
    return { size: 3, body };
  });
  const page = await h.rpc.exportInbox(owner, h.inbox.id, {});
  await assert.rejects(page.arrayBuffer(), /export interrupted/);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.deepEqual(await h.rpc.getMessageHar(owner, h.inbox.id, mid), { error: 'not_found' });
  assert.deepEqual(await h.rpc.createInbox(owner, { type: 'http', access: 'open' }), { error: 'not_found' });
});

test('expiry during body copy truncates export and denies standalone HAR', async t => {
  let h;
  h = await setup(t, async () => ({ size: 3, body: new ReadableStream({ pull(c) {
    h.expire(); c.enqueue(new Uint8Array([65, 66, 67])); c.close();
  } }, { highWaterMark: 0 }) }));
  const page = await h.rpc.exportInbox(owner, h.inbox.id, {});
  await assert.rejects(page.arrayBuffer(), /export interrupted/);
  h.DB.sql.prepare('UPDATE inboxes SET expires_at=NULL').run();
  assert.deepEqual(await h.rpc.getMessageHar(owner, h.inbox.id, mid), { error: 'not_found' });
});

test('deletion during R2 get omits the receipt before any payload header', async t => {
  let h, cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  h = await setup(t, async () => {
    h.DB.sql.prepare("UPDATE messages SET state='deleting' WHERE id=?").run(mid);
    return { size: 3, body };
  });
  const page = await h.rpc.exportInbox(owner, h.inbox.id, {});
  const text = await page.text();
  assert.ok(!text.includes(`payloads/${mid}.body`));
  assert.ok(text.includes(`"omitted": [\n    "${mid}"`));
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('metadata budget pages independently of payload bytes and always makes progress', async t => {
  const h = await setup(t, async () => ({ size: 3, body: new Response('abc').body }));
  h.rpc.env.MAX_EXPORT_META_BYTES = '1';
  const other = `msg_${'b'.repeat(26)}`;
  h.DB.sql.prepare(`INSERT INTO messages SELECT ?,inbox_id,state,received_at+1,expires_at,archived,size,meta_json,search_text FROM messages WHERE id=?`).run(other, mid);
  const first = await h.rpc.exportInbox(owner, h.inbox.id, {});
  const cursor = first.headers.get('X-Inbox-Export-Next-Cursor');
  assert.ok(cursor);
  const text = await first.text();
  assert.ok(text.includes(`payloads/${mid}.body`));
  assert.ok(!text.includes(`payloads/${other}.body`));
  const last = await h.rpc.exportInbox(owner, h.inbox.id, { cursor });
  assert.equal(last.headers.get('X-Inbox-Export-Next-Cursor'), null);
  assert.ok((await last.text()).includes(`payloads/${other}.body`));
});

test('har-validator accepts the profile but does not enforce the frozen timing requirements', {
  skip: !process.env.HAR_VALIDATOR_MODULE,
}, async t => {
  const { default: validator } = await import(process.env.HAR_VALIDATOR_MODULE);
  const h = await setup(t, async () => ({ size: 3, body: new Response('abc').body }));
  const res = await h.rpc.getMessageHar(owner, h.inbox.id, mid);
  const har = await res.json();
  assert.equal(har.log._profile, 'bayleaf-inbox-receipt-1');
  await validator.har(har);
  // har-schema 2.0.0 uses the ignored keyword `min` in timings.json and does not
  // enforce the total sum. This pass is compatibility evidence, not conformance.
  const entry = har.log.entries[0];
  assert.equal(entry.time, -1);
  assert.ok(['send', 'wait', 'receive'].every(k => entry.timings[k] < 0));
});

test('Insomnia HAR importer preserves inline text but ignores custom exact-body references', {
  skip: !process.env.HAR_IMPORTER_MODULE,
}, async t => {
  const { convert } = await import(process.env.HAR_IMPORTER_MODULE);
  const h = await setup(t, async () => ({ size: 3, body: new Response('abc').body }));
  const inline = await h.rpc.getMessageHar(owner, h.inbox.id, mid);
  const requests = convert(await inline.text());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, h.inbox.url);
  assert.equal(requests[0].body.text, 'abc');
  h.rpc.env.MAX_HAR_TEXT_BYTES = '1';
  const referenced = await h.rpc.getMessageHar(owner, h.inbox.id, mid);
  const har = await referenced.json();
  assert.equal(har.log.entries[0].request.postData._file, `payloads/${mid}.body`);
  assert.equal(convert(JSON.stringify(har))[0].body.text, '', 'manual body attachment is necessary');
});
