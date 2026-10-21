#!/usr/bin/env node
// Explicit synthetic production smoke. Only resources created by this run;
// credentials, receipt URLs and content never printed or persisted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function unpack(bytes) {
  const files = new Map();
  for (let at = 0; ; ) {
    assert.ok(at + 1024 <= bytes.length, 'truncated tar');
    const header = bytes.subarray(at, at + 512);
    if (header.every(b => b === 0)) {
      assert.equal(at + 1024, bytes.length);
      assert.ok(bytes.subarray(at).every(b => b === 0));
      return files;
    }
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    assert.equal(parseInt(text(148, 8), 8), sum);
    const name = text(0, 100), size = parseInt(text(124, 12), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && at + 512 + size <= bytes.length);
    assert.ok(!files.has(name));
    files.set(name, bytes.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
}

export async function qualify() {
  if (!process.argv.includes('--live') || !process.env.BAYLEAF_API_KEY)
    throw new Error('Requires --live and BAYLEAF_API_KEY supplied privately.');
  const base = process.env.BAYLEAF_API_BASE || 'https://api.bayleaf.dev';
  assert.equal(new URL(base).protocol, 'https:');
  const headers = { Authorization: `Bearer ${process.env.BAYLEAF_API_KEY}`, 'Content-Type': 'application/json' };
  const request = (path, init = {}) => fetch(base + path, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const json = async (path, init) => {
    const r = await request(path, init);
    assert.ok(r.ok, `Owner operation HTTP ${r.status}`);
    return r.json();
  };
  let box;
  try {
    box = await json('/inboxes', { method: 'POST', body: JSON.stringify({ type: 'http', ttl_seconds: 60, label: 'Disposable export qualification' }) });
    assert.ok(Number.isSafeInteger(box.expires_at));
    const sender = await json(`/inboxes/${box.id}/credentials`, { method: 'POST', body: JSON.stringify({ name: 'synthetic sender', expires_at: box.expires_at }) });
    const payloads = [Buffer.from('{"qualification":"synthetic export"}'), Buffer.alloc(1024 * 1024, 97)];
    for (const body of payloads) {
      const r = await fetch(box.url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${sender.token}`, 'Content-Type': 'text/plain; charset=utf-8' } });
      assert.equal(r.status, 200); await r.body.cancel();
    }
    const expected = new Set(payloads.map(hash));
    let cursor, pages = 0, bytes = 0, references = 0;
    const seen = new Set();
    do {
      const r = await request(`/inboxes/${box.id}/export?limit=1${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/x-tar');
      assert.equal(r.headers.get('content-security-policy'), 'sandbox');
      const archive = Buffer.from(await r.arrayBuffer()); bytes += archive.length; pages++;
      const files = unpack(archive), manifests = [...files.keys()].filter(k => k.startsWith('manifests/'));
      assert.equal(manifests.length, 1);
      const manifest = JSON.parse(files.get(manifests[0]));
      assert.equal(manifest.receipts.length, 1); assert.deepEqual(manifest.omitted, []);
      const rec = manifest.receipts[0], body = files.get(rec.file);
      assert.ok(body && expected.has(hash(body))); assert.equal(hash(body), rec.sha256);
      assert.ok(!seen.has(rec.id)); seen.add(rec.id);
      const har = JSON.parse(files.get('receipts.har'));
      assert.equal(har.log._profile, 'bayleaf-inbox-receipt-1');
      const entry = har.log.entries[0];
      assert.equal(entry.response.status, 0); assert.equal(entry.time, -1);
      assert.equal(entry.request.postData._sha256, rec.sha256);
      if (body.length > 262144) {
        assert.equal(entry.request.postData._file, rec.file);
        assert.equal(entry.request.postData.text, undefined); references++;
      } else assert.equal(entry.request.postData.text, body.toString());
      const single = await json(`/inboxes/${box.id}/messages/${rec.id}/har`);
      assert.deepEqual(single, har);
      cursor = r.headers.get('x-inbox-export-next-cursor');
      assert.equal(cursor, manifest.next_cursor);
      assert.ok(pages <= payloads.length);
    } while (cursor);
    assert.equal(seen.size, 2); assert.equal(references, 1);
    // One wait, no polling: real endpoint expiry must deny further exports.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, box.expires_at * 1000 - Date.now()) + 1100));
    const expired = await request(`/inboxes/${box.id}/export`);
    assert.equal(expired.status, 404); await expired.body.cancel();
    console.log(JSON.stringify({ pages, archiveBytes: bytes, exactHashes: true, externalFileReferences: references,
      standaloneHarParity: true, expiryDenied: true, maximumSyntheticPayloadBytes: 1048576 }));
  } finally {
    if (box?.id) {
      const r = await request(`/inboxes/${box.id}`, { method: 'DELETE' });
      await r.body?.cancel();
      if (![202, 404].includes(r.status)) throw new Error(`Exact-resource cleanup HTTP ${r.status}`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  qualify().catch(error => { console.error(error.message); process.exitCode = 1; });
