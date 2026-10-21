import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Share main's real D1/R2 harness and TTL/events migrations, not the export
// worktree's older harness. This module registers cases only when explicitly called.
export function exportTests({ harness, owner, mail, postOpen, sha256, plant, isErr, now, b32 }) {
// ---------------------------------------------------------------- portable export

// Minimal ustar reader that also verifies each header checksum and the end-of-archive marker.
function untar(bytes) {
  const text = (h, at, len) => new TextDecoder().decode(h.subarray(at, at + len)).replace(/\0.*$/s, '');
  const entries = [];
  let at = 0;
  for (;;) {
    assert.ok(at + 512 <= bytes.length, 'archive ends with two zero blocks');
    const h = bytes.subarray(at, at + 512);
    if (h.every(b => b === 0)) {
      assert.ok(bytes.subarray(at, at + 1024).length === 1024 && bytes.subarray(at, at + 1024).every(b => b === 0));
      assert.equal(bytes.length, at + 1024, 'nothing after the end marker');
      return entries;
    }
    const sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    assert.equal(parseInt(text(h, 148, 8).trim(), 8), sum, 'header checksum');
    assert.equal(text(h, 257, 6), 'ustar');
    const size = parseInt(text(h, 124, 12), 8);
    entries.push({ name: text(h, 0, 100), size, mtime: parseInt(text(h, 136, 12), 8),
      data: bytes.slice(at + 512, at + 512 + size) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
}
async function exportPage(h, o, inboxId, opts) {
  const r = await h.rpc('exportInbox', o, inboxId, ...(opts === undefined ? [] : [opts]));
  assert.equal(r.response, true, `export returned ${JSON.stringify(r)}`);
  assert.equal(r.streamError, false, 'export stream completed');
  const entries = untar(r.bytes);
  const manifests = entries.filter(e => e.name.startsWith('manifests/'));
  assert.equal(manifests.length, 1);
  assert.equal(entries.at(-1), manifests[0], 'manifest is the last entry');
  const manifest = JSON.parse(new TextDecoder().decode(manifests[0].data));
  if (manifest.inbox.type === 'http') {
    assert.equal(manifest.har, 'receipts.har');
    const files = entries.filter(e => e.name === manifest.har);
    assert.equal(files.length, 1, 'one HAR per HTTP export page');
    const har = JSON.parse(new TextDecoder().decode(files[0].data));
    assertHar(har);
    assert.deepEqual(har.log.entries.map(e => e._receiptId), manifest.receipts.map(r => r.id), 'HAR and manifest ordering parity');
  } else {
    assert.equal(manifest.har, null);
    assert.ok(!entries.some(e => e.name.endsWith('.har')), 'no HAR for email exports');
  }
  return { r, entries, manifest,
    payload: name => entries.find(e => e.name === name)?.data };
}
// Plant a stored receipt with distinct bytes and a chosen receipt time.
async function plantBytes(h, inboxId, bytes, fields = {}) {
  const id = await plant(h, inboxId, { size: bytes.length, ...fields });
  await h.r2.put(`m/${inboxId}/${id}`, bytes);
  return id;
}

describe('portable export (DESIGN: Portable export)', () => {
  let h;
  before(async () => { h = await harness({ vars: { MAX_EXPORT_BYTES: '100' } }); });
  after(async () => { await h?.mf.dispose(); });

  it('exports exact email and http payloads with a documented manifest, readable by system tar', async () => {
    const o = owner();
    const mailbox = await h.create(o, 'email', { label: 'reports' });
    const raw = mail({ to: mailbox.address, subject: 'export me', body: 'exact bytes\r\nline two' });
    assert.equal((await h.email({ to: mailbox.address, raw })).rejectReason, undefined);
    const [received] = (await h.list(o, mailbox.id)).messages;
    const exact = (await h.rpc('getMessageBody', o, mailbox.id, received.id)).bytes;
    await h.rpc('setArchived', o, mailbox.id, received.id, true);

    const page = await exportPage(h, o, mailbox.id);
    assert.equal(page.r.headers.get('content-type'), 'application/x-tar');
    assert.match(page.r.headers.get('content-disposition'), /^attachment; filename="ibx_[a-z2-7]{26}-export\.tar"$/);
    assert.equal(page.r.headers.get('x-inbox-export-next-cursor'), null);
    const m = page.manifest;
    assert.equal(m.format, 'bayleaf-inbox-export');
    assert.equal(m.version, 1);
    assert.deepEqual(m.inbox, { id: mailbox.id, type: 'email', label: 'reports', address: mailbox.address, created_at: mailbox.created_at });
    assert.equal(m.order, 'received_at_asc');
    assert.equal(m.cursor, null); assert.equal(m.next_cursor, null);
    assert.deepEqual(m.omitted, []);
    assert.equal(m.receipts.length, 1);
    const [rec] = m.receipts;
    assert.equal(rec.file, `payloads/${received.id}.eml`);
    assert.deepEqual(page.payload(rec.file), exact, 'exact raw MIME');
    assert.equal(rec.sha256, sha256(Buffer.from(exact)));
    assert.equal(rec.size, exact.length);
    assert.equal(rec.archived, true, 'archived receipts are included and marked');
    assert.equal(rec.received_at, received.received_at);
    assert.equal(rec.expires_at, received.expires_at);
    assert.equal(rec.meta.subject, 'export me');
    assert.equal(page.entries[0].mtime, received.received_at);

    const web = await h.create(o, 'http');
    assert.equal((await postOpen(h, web, '/hooks/push?a=1&b=2', { body: '{"k":"v"}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-value', 'X-Hub-Signature-256': 'sha256=abc' } })).status, 200);
    const [hit] = (await h.list(o, web.id)).messages;
    const hp = await exportPage(h, o, web.id, {});
    const [hr] = hp.manifest.receipts;
    assert.equal(hp.manifest.inbox.url, web.url);
    assert.equal(hp.manifest.inbox.address, undefined);
    assert.equal(hr.file, `payloads/${hit.id}.body`);
    assert.equal(new TextDecoder().decode(hp.payload(hr.file)), '{"k":"v"}');
    assert.equal(hr.meta.method, 'POST');
    assert.equal(hr.meta.path, '/hooks/push');
    assert.equal(hr.meta.query, 'a=1&b=2');
    const headers = Object.fromEntries(hr.meta.headers);
    assert.equal(headers.authorization, 'Bearer [redacted]', 'headers are exported as stored, redacted');
    assert.equal(headers['x-hub-signature-256'], 'sha256=abc');
    assert.ok(!JSON.stringify(hp.manifest).includes('secret-value'));

    // Interoperability: the platform tar lists and extracts the same bytes.
    const dir = await mkdtemp(join(tmpdir(), 'inbox-export-'));
    try {
      await writeFile(join(dir, 'page.tar'), hp.r.bytes);
      const names = execFileSync('tar', ['-tf', join(dir, 'page.tar')], { encoding: 'utf8' }).trim().split('\n');
      assert.deepEqual(names, [hr.file, 'receipts.har', `manifests/${hit.id}.json`]);
      assert.equal(execFileSync('tar', ['-xOf', join(dir, 'page.tar'), hr.file], { encoding: 'utf8' }), '{"k":"v"}');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('pages oldest first by count and byte budget, with stable cursors in header and manifest', async () => {
    const o = owner();
    const ibx = await h.create(o, 'http');
    const base = now() - 1000;
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await plantBytes(h, ibx.id, Buffer.from(`payload-${i}`), { received_at: base + i }));
    const big = await plantBytes(h, ibx.id, Buffer.alloc(300, 7), { received_at: base + 10 }); // over MAX_EXPORT_BYTES alone
    const tail = await plantBytes(h, ibx.id, Buffer.from('tail'), { received_at: base + 11 });
    const seen = [];
    let cursor, pages = 0;
    do {
      const p = await exportPage(h, o, ibx.id, cursor ? { cursor, limit: 2 } : { limit: 2 });
      pages++;
      for (const rec of p.manifest.receipts) {
        assert.equal(sha256(Buffer.from(p.payload(rec.file))), rec.sha256);
        seen.push(rec.id);
      }
      assert.equal(p.r.headers.get('x-inbox-export-next-cursor'), p.manifest.next_cursor);
      assert.equal(p.manifest.cursor, cursor ?? null);
      assert.ok(p.manifest.receipts.reduce((n, r) => n + r.size, 0) <= 100 || p.manifest.receipts.length === 1, 'byte budget');
      cursor = p.manifest.next_cursor;
    } while (cursor && pages < 20);
    assert.deepEqual(seen, [...ids, big, tail], 'every receipt exactly once, oldest first');
    assert.equal(pages, 5, 'pages of 2, 2, 1, the oversized receipt alone, then the tail');
  });

  it('exports only visible receipts, never extends retention, and reports vanished ones', async () => {
    const o = owner();
    const ibx = await h.create(o, 'http');
    const keep = await plantBytes(h, ibx.id, Buffer.from('keep'));
    await plantBytes(h, ibx.id, Buffer.from('expired'), { expires_at: now() - 1 });
    await plantBytes(h, ibx.id, Buffer.from('pending'), { state: 'pending' });
    await plantBytes(h, ibx.id, Buffer.from('deleting'), { state: 'deleting' });
    const vanished = await plantBytes(h, ibx.id, Buffer.from('gone'));
    await h.r2.delete(`m/${ibx.id}/${vanished}`); // as if deleted between listing and copying
    const before = await h.row('messages', keep);
    const p = await exportPage(h, o, ibx.id);
    assert.deepEqual(p.manifest.receipts.map(r => r.id), [keep]);
    assert.deepEqual(p.manifest.omitted, [vanished]);
    assert.deepEqual(p.entries.map(e => e.name).filter(n => n.startsWith('payloads/')), [`payloads/${keep}.body`]);
    assert.deepEqual(await h.row('messages', keep), before, 'export writes nothing: retention and archive state unchanged');
  });

  it('advances past a fully omitted page without losing the next visible receipt', async () => {
    const o = owner(), ibx = await h.create(o, 'http'), base = now() - 100;
    const gone = await plantBytes(h, ibx.id, Buffer.from('gone'), { received_at: base });
    const kept = await plantBytes(h, ibx.id, Buffer.from('kept'), { received_at: base + 1 });
    await h.r2.delete(`m/${ibx.id}/${gone}`);
    const first = await exportPage(h, o, ibx.id, { limit: 1 });
    assert.deepEqual(first.manifest.receipts, []);
    assert.deepEqual(first.manifest.omitted, [gone]);
    assert.ok(first.manifest.next_cursor);
    assert.equal(first.r.headers.get('x-inbox-export-next-cursor'), first.manifest.next_cursor);
    const next = await exportPage(h, o, ibx.id, { limit: 1, cursor: first.manifest.next_cursor });
    assert.deepEqual(next.manifest.receipts.map(r => r.id), [kept]);
    assert.equal(next.manifest.next_cursor, null);
  });

  it('empty inboxes export a manifest only; corrupt objects truncate the stream', async () => {
    const o = owner();
    const ibx = await h.create(o, 'email');
    const empty = await exportPage(h, o, ibx.id);
    assert.deepEqual(empty.entries.map(e => e.name), ['manifests/empty.json']);
    assert.deepEqual(empty.manifest.receipts, []);
    const id = await plantBytes(h, ibx.id, Buffer.from('abcdef'));
    await h.db.prepare('UPDATE messages SET size = 5 WHERE id = ?').bind(id).run();
    const broken = await h.rpc('exportInbox', o, ibx.id);
    assert.equal(broken.streamError, true, 'a size mismatch errors the stream rather than producing a silent partial entry');
  });

  it('is owner-scoped, validates input and refuses destroying inboxes', async () => {
    const o = owner(), other = owner();
    const ibx = await h.create(o, 'http');
    await plantBytes(h, ibx.id, Buffer.from('x'));
    isErr(await h.rpc('exportInbox', other, ibx.id), 'not_found');
    isErr(await h.rpc('exportInbox', o, `ibx_${b32(26)}`), 'not_found');
    for (const opts of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { archived: 'all' }, { cursor: 'nope' },
      { cursor: Buffer.from(`${now()}:msg_${b32(26)}`).toString('base64url') }, 'x'])
      isErr(await h.rpc('exportInbox', o, ibx.id, opts), 'invalid');
    isErr(await h.rpc('exportInbox', o, 'msg_nope'), 'invalid');
    await h.rpc('destroyInbox', o, ibx.id);
    isErr(await h.rpc('exportInbox', o, ibx.id), 'not_found');
  });

  it('is disabled with the feature flag', async () => {
    const off = await harness({ vars: { INBOXES_ENABLED: 'false' } });
    try { isErr(await off.rpc('exportInbox', owner(), `ibx_${b32(26)}`), 'disabled'); }
    finally { await off.mf.dispose(); }
  });
});

// Structural check of BayLeaf's HAR-shaped reconstruction, NOT HAR 1.2 validation.
// Unknown underscore fields are extensions, not replacements for required HAR fields.
// Unknown durations deliberately use -1, violating HAR 1.2's timing requirements.
// Never turn unknown measurements into 0 merely to satisfy a validator.
function assertHar(value) {
  const string = x => assert.equal(typeof x, 'string');
  const number = x => assert.ok(typeof x === 'number' && Number.isFinite(x));
  const object = x => assert.ok(x && typeof x === 'object' && !Array.isArray(x));
  const pairs = xs => {
    assert.ok(Array.isArray(xs));
    for (const x of xs) { string(x.name); string(x.value); }
  };
  object(value); object(value.log);
  assert.equal(value.log.version, '1.2');
  string(value.log.creator.name); string(value.log.creator.version);
  assert.match(value.log.comment, /Not conformant HAR 1\.2/);
  assert.ok(Array.isArray(value.log.entries));
  for (const entry of value.log.entries) {
    string(entry.startedDateTime);
    assert.ok(Number.isFinite(Date.parse(entry.startedDateTime)));
    number(entry.time); assert.equal(entry.time, -1, 'total duration is unknown, not zero');
    object(entry.cache); object(entry.timings);
    for (const name of ['send', 'wait', 'receive']) { number(entry.timings[name]); assert.equal(entry.timings[name], -1); }
    for (const name of ['blocked', 'dns', 'connect', 'ssl']) {
      if (entry.timings[name] !== undefined) { number(entry.timings[name]); assert.ok(entry.timings[name] >= -1); }
    }
    assert.equal(entry._timingsUnknown, true);
    assert.equal(entry.response._observed, false);
    assert.equal(entry.response.status, 0, 'status unknown, not inferred from persistence');
    assert.equal(entry.response.content._captured, false);
    assert.equal(entry.response.content.text, undefined);
    for (const key of ['request', 'response']) {
      const obj = entry[key]; object(obj); string(obj.httpVersion);
      pairs(obj.headers); assert.ok(Array.isArray(obj.cookies));
      for (const k of ['headersSize', 'bodySize']) { number(obj[k]); assert.ok(Number.isInteger(obj[k]) && obj[k] >= -1); }
    }
    const req = entry.request, res = entry.response;
    string(req.method); string(req.url); assert.equal(new URL(req.url).protocol, 'https:');
    pairs(req.queryString);
    if (req.postData) {
      string(req.postData.mimeType);
      if ('text' in req.postData) string(req.postData.text);
      assert.ok(!('encoding' in req.postData), 'HAR 1.2 defines no request postData.encoding');
    }
    number(res.status); assert.ok(Number.isInteger(res.status)); string(res.statusText); string(res.redirectURL);
    object(res.content); number(res.content.size); assert.ok(res.content.size >= 0); string(res.content.mimeType);
    if ('text' in res.content) string(res.content.text);
  }
}

async function receiptHar(h, own, ibx, mid) {
  const result = await h.rpc('getMessageHar', own, ibx.id, mid);
  assert.equal(result.response, true, JSON.stringify(result));
  assert.equal(result.headers.get('content-type'), 'application/json');
  assert.equal(result.headers.get('content-disposition'), `attachment; filename="${mid}.har"`);
  const har = JSON.parse(new TextDecoder().decode(result.bytes));
  assertHar(har);
  assert.equal(har.log.entries.length, 1);
  return har.log.entries[0];
}

describe('HAR 1.2 reconstruction (DESIGN: HAR rendering)', () => {
  let h;
  before(async () => { h = await harness({ vars: { MAX_HAR_TEXT_BYTES: '32', MAX_HAR_PAGE_TEXT_BYTES: '48' } }); });
  after(async () => { await h?.mf.dispose(); });

  it('renders requests while distinguishing expected acknowledgement from an unknown observed response', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    const payload = '{"text":"東京"}';
    const got = await postOpen(h, ibx, '/hook%20one?x=one+two&x=%E6%9D%B1%E4%BA%AC&empty', {
      body: payload, headers: { 'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Basic secret', Cookie: 'private=secret', 'Proxy-Authorization': 'Basic proxy-secret',
        'X-Forwarded-For': '192.0.2.1', 'X-Real-IP': '192.0.2.2', 'CF-Custom': 'edge-secret' },
    });
    assert.equal(got.status, 200);
    const [msg] = (await h.list(own, ibx.id)).messages;
    await h.rpc('setArchived', own, ibx.id, msg.id, true);
    const before = await h.row('messages', msg.id);
    const e = await receiptHar(h, own, ibx, msg.id);
    assert.equal(e.startedDateTime, new Date(msg.received_at * 1000).toISOString());
    assert.equal(e._expiresAt, new Date(msg.expires_at * 1000).toISOString());
    assert.equal(e._archived, true); assert.equal(e._receiptId, msg.id);
    assert.equal(e.request.method, 'POST');
    assert.equal(e.request.url, ibx.url + 'hook%20one?x=one+two&x=%E6%9D%B1%E4%BA%AC&empty');
    assert.deepEqual(e.request.queryString, [{ name: 'x', value: 'one two' }, { name: 'x', value: '東京' }, { name: 'empty', value: '' }]);
    assert.equal(e.request.httpVersion, 'unknown'); assert.equal(e.response.httpVersion, 'unknown');
    assert.equal(e.request.headersSize, -1); assert.equal(e.request.bodySize, Buffer.byteLength(payload));
    assert.deepEqual(e.request.postData, { mimeType: 'application/json; charset=utf-8', text: payload, _sha256: sha256(payload) });
    const headers = Object.fromEntries(e.request.headers.map(x => [x.name, x.value]));
    assert.equal(headers.authorization, 'Basic [redacted]');
    assert.equal(headers.cookie, '[redacted]'); assert.equal(headers['proxy-authorization'], '[redacted]');
    assert.deepEqual(e._redacted.sort(), ['authorization', 'cookie', 'proxy-authorization']);
    assert.equal(e._headersNormalized, true); assert.ok(e._dropped.includes('cf-*'));
    assert.ok(e._dropped.includes('x-forwarded-for')); assert.equal(e._headersTruncated, undefined);
    assert.ok(!JSON.stringify(e).includes('edge-secret') && !JSON.stringify(e).includes('192.0.2.1'));
    assert.deepEqual(e._expectedAcknowledgement.headers.map(x => [x.name, x.value]).sort(), [...got.headers]
      .filter(([name]) => ['content-type', 'access-control-allow-origin'].includes(name)).sort());
    assert.equal(e._expectedAcknowledgement.status, 200); assert.equal(e._expectedAcknowledgement._observed, false);
    assert.equal(e._expectedAcknowledgement.content.text, got.text);
    assert.equal(e._expectedAcknowledgement.bodySize, got.bytes.length);
    assert.deepEqual(e.response.headers, []); assert.equal(e.response.bodySize, -1);
    assert.equal(e.response.content.text, undefined); assert.equal(e._timingsUnknown, true);
    assert.deepEqual(await h.row('messages', msg.id), before, 'HAR rendering changes no storage or retention');
  });

  it('references binary and non-UTF-8 bodies without lossy text or invented encoding', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    for (const [type, data] of [['application/octet-stream', Buffer.from([0, 255, 128, 1])],
      ['text/plain', Buffer.from([0x61, 0xff])], ['text/plain; charset=iso-8859-1', Buffer.from('ascii')],
      ['text/plain; charset=us-ascii', Buffer.from('東京')]]) {
      assert.equal((await postOpen(h, ibx, '/', { headers: { 'Content-Type': type }, body: data })).status, 200);
      const msg = (await h.list(own, ibx.id)).messages.find(m => m.preview.content_type === type);
      const e = await receiptHar(h, own, ibx, msg.id);
      assert.deepEqual(e.request.postData, { mimeType: type, _file: `payloads/${msg.id}.body`, _sha256: sha256(data) });
    }
  });

  it('falls back to exact files above the per-body and per-page caps with manifest ordering parity', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    const base = now() - 10;
    const ids = [];
    for (const [i, size] of [24, 24, 24, 33].entries()) {
      const id = await plantBytes(h, ibx.id, Buffer.alloc(size, 65 + i), { received_at: base + i });
      const meta = { type: 'http', method: 'POST', path: '/', query: '', headers: [['content-type', 'text/plain']], content_type: 'text/plain' };
      await h.db.prepare('UPDATE messages SET meta_json=? WHERE id=?').bind(JSON.stringify(meta), id).run();
      ids.push(id);
    }
    const p = await exportPage(h, own, ibx.id);
    const har = JSON.parse(new TextDecoder().decode(p.payload(p.manifest.har)));
    assert.deepEqual(har.log.entries.map(e => e._receiptId), ids);
    for (const [i, e] of har.log.entries.entries()) {
      const pd = e.request.postData, rec = p.manifest.receipts[i];
      assert.equal(pd._sha256, rec.sha256);
      if (i < 2) {
        assert.equal(pd.text, String.fromCharCode(65 + i).repeat(24)); assert.equal(pd._file, undefined);
      } else {
        assert.equal(pd.text, undefined); assert.equal(pd._file, rec.file); assert.equal(pd._truncated, true);
      }
    }
    const standalone = await receiptHar(h, own, ibx, ids[2]);
    assert.equal(standalone.request.postData.text, 'C'.repeat(24), 'standalone has only the per-body cap');
    const oversized = await receiptHar(h, own, ibx, ids[3]);
    assert.equal(oversized.request.postData.text, undefined); assert.equal(oversized.request.postData._truncated, true);
  });

  it('keeps a large streamed textual body intact while HAR uses only a capped file reference', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    const data = Buffer.alloc(300000, 97), id = await plantBytes(h, ibx.id, data);
    await h.db.prepare('UPDATE messages SET meta_json=? WHERE id=?').bind(JSON.stringify({ type: 'http', method: 'PUT',
      path: '/large', query: '', headers: [], content_type: 'text/plain' }), id).run();
    const p = await exportPage(h, own, ibx.id);
    assert.deepEqual(Buffer.from(p.payload(`payloads/${id}.body`)), data);
    const e = await receiptHar(h, own, ibx, id);
    assert.deepEqual(e.request.postData, { mimeType: 'text/plain', _file: `payloads/${id}.body`, _sha256: sha256(data), _truncated: true });
  });

  it('reports header truncation and reconstructs HEAD with no request or response body', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    assert.equal((await h.http(ibx.url, { method: 'HEAD', headers: { 'x-large': 'x'.repeat(17000) } })).status, 200);
    const [msg] = (await h.list(own, ibx.id)).messages;
    const e = await receiptHar(h, own, ibx, msg.id);
    assert.equal(e._headersTruncated, true); assert.equal(e.request.bodySize, 0);
    assert.equal(e.request.postData, undefined); assert.equal(e.response.content.size, 0); assert.equal(e.response.bodySize, -1);
    assert.equal(e.response.content.text, undefined);
    assert.deepEqual(e.response.headers, []);
    assert.equal(e._expectedAcknowledgement.content.text, undefined);
    assert.equal(e._expectedAcknowledgement.bodySize, 0);
    assert.deepEqual(e._expectedAcknowledgement.headers, [{ name: 'access-control-allow-origin', value: '*' }]);
  });

  it('excludes expired/deleted/pending receipts from HAR and enforces owner, type and feature gates', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    const keep = await plantBytes(h, ibx.id, Buffer.from('keep'));
    const expired = await plantBytes(h, ibx.id, Buffer.from('expired'), { expires_at: now() - 1 });
    const pending = await plantBytes(h, ibx.id, Buffer.from('pending'), { state: 'pending' });
    const deleted = await plantBytes(h, ibx.id, Buffer.from('deleted'));
    await h.rpc('deleteMessage', own, ibx.id, deleted);
    for (const mid of [expired, pending, deleted]) isErr(await h.rpc('getMessageHar', own, ibx.id, mid), 'not_found');
    isErr(await h.rpc('getMessageHar', owner(), ibx.id, keep), 'not_found');
    isErr(await h.rpc('getMessageHar', 'bad-owner', ibx.id, keep), 'invalid');
    isErr(await h.rpc('getMessageHar', own, ibx.id, 'invalid'), 'invalid');
    const p = await exportPage(h, own, ibx.id);
    assert.deepEqual(p.manifest.receipts.map(r => r.id), [keep]);
    const mail = await h.create(own, 'email');
    const emid = await plantBytes(h, mail.id, Buffer.from('mail'));
    isErr(await h.rpc('getMessageHar', own, mail.id, emid), 'unsupported');
    isErr(await h.rpc('getMessageHar', owner(), mail.id, emid), 'not_found');
    await h.rpc('destroyInbox', own, ibx.id);
    isErr(await h.rpc('getMessageHar', own, ibx.id, keep), 'not_found');
    const off = await harness({ vars: { INBOXES_ENABLED: 'false' } });
    try { isErr(await off.rpc('getMessageHar', own, ibx.id, keep), 'disabled'); } finally { await off.mf.dispose(); }
  });

  it('never infers sender acknowledgement or durations even for directly planted stored receipts', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    const mid = await plantBytes(h, ibx.id, Buffer.from('persisted without running a response handler'));
    const e = await receiptHar(h, own, ibx, mid);
    assert.equal(e.response.status, 0);
    assert.equal(e.response._observed, false);
    assert.equal(e.response.content.text, undefined);
    assert.ok(Object.values(e.timings).every(x => x === -1));
    assert.equal(e.time, -1);
    assert.equal(e._expectedAcknowledgement.status, 200);
    assert.equal(e._expectedAcknowledgement._observed, false);
  });

  it('emits an empty HAR log for an empty HTTP inbox', async () => {
    const own = owner(), ibx = await h.create(own, 'http');
    const p = await exportPage(h, own, ibx.id);
    assert.deepEqual(p.entries.map(e => e.name), ['receipts.har', 'manifests/empty.json']);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(p.payload('receipts.har'))).log.entries, []);
  });
});

describe('content-free export counters', () => {
  it('counts complete pages and exact archive bytes, but not denied, cancelled, failed or standalone HAR reads', async () => {
    const h = await harness({ vars: { INBOX_TELEMETRY_ENABLED: 'true', INBOX_TELEMETRY_WRITE_SECRET: 'synthetic-export-counter-secret' } });
    try {
      const own = owner(), ibx = await h.create(own, 'http');
      const mid = await plantBytes(h, ibx.id, Buffer.from('private-export-content'));
      const a = await exportPage(h, own, ibx.id), b = await exportPage(h, own, ibx.id);
      const query = () => h.db.prepare("SELECT name,transport,outcome,value FROM telemetry_counts WHERE name LIKE 'inbox.export.%' ORDER BY name").all();
      const expected = [
        { name: 'inbox.export.bytes', transport: 'http', outcome: 'emitted', value: a.r.bytes.length + b.r.bytes.length },
        { name: 'inbox.export.pages', transport: 'http', outcome: 'emitted', value: 2 },
      ];
      assert.deepEqual((await query()).results, expected);
      await receiptHar(h, own, ibx, mid);
      isErr(await h.rpc('exportInbox', owner(), ibx.id), 'not_found');
      const rpcWorker = await h.mf.getWorker('rpc');
      const cancelled = await rpcWorker.fetch('https://rpc.test/rpc/exportInbox?cancel=1', {
        method: 'POST', body: JSON.stringify([own, ibx.id, {}]),
      });
      assert.deepEqual(await cancelled.json(), { cancelled: true });
      await h.db.prepare('UPDATE messages SET size=size+1 WHERE id=?').bind(mid).run();
      assert.equal((await h.rpc('exportInbox', own, ibx.id)).streamError, true);
      assert.deepEqual((await query()).results, expected, 'incomplete streams and non-export reads do not count');
      const mail = await h.create(own, 'email');
      const page = await exportPage(h, own, mail.id);
      const email = (await query()).results.filter(r => r.transport === 'email');
      assert.deepEqual(email, [
        { name: 'inbox.export.bytes', transport: 'email', outcome: 'emitted', value: page.r.bytes.length },
        { name: 'inbox.export.pages', transport: 'email', outcome: 'emitted', value: 1 },
      ]);
      assert.ok(!(JSON.stringify((await query()).results)).includes('private-export-content'));
      await h.db.prepare('DROP TABLE telemetry_counts').run();
      await exportPage(h, own, mail.id); // failed counters cannot break export
    } finally { await h.mf.dispose(); }
  });
});
}
