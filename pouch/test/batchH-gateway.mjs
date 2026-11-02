// Batch H, the one live check against the BayLeaf HF gateway (public, keyless):
// HEAD every pinned LFM3 file (size and ETag against models.lock.json), CORS for
// Pouch's origin, a full ranged download of one small file through the app's own
// code (src/assets.ts fillFile, hashed against the lock), and one 32 MiB range of
// the weights compared with the same bytes of the local verified copy
// (~/.cache/bayleaf-pouch/models, from fetch-models.mjs).   node test/batchH-gateway.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, fillFile, rangeSource, CHUNK } from '../src/assets.ts';
import { createModelStore } from '../src/models.ts';
import { CACHE } from '../fetch-models.mjs';

const lock = JSON.parse(readFileSync(new URL('../models.lock.json', import.meta.url), 'utf8'));
const m = lock.models[0];
const store = createModelStore([m]);
const H = (b) => createHash('sha256').update(b).digest('hex');
let n = 0;
const ok = (s) => { n++; console.log('ok', s); };

for (const f of m.files) {
  const r = await fetch(store.urlOf(m, f), { method: 'HEAD', headers: { Origin: 'https://pouch.bayleaf.dev' } });
  assert.equal(r.status, 200, f.name);
  assert.equal(Number(r.headers.get('content-length')), f.bytes, `${f.name} size`);
  assert.equal(r.headers.get('etag')?.replaceAll('"', ''), f.sha256, `${f.name} ETag is the pinned SHA-256`);
  assert.equal(r.headers.get('x-repo-commit'), m.revision);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
}
ok(`HEAD ${m.files.length} files: sizes and ETags equal models.lock.json, commit ${m.revision.slice(0, 12)}, CORS *`);

const small = m.files.find((f) => f.name === 'tokenizer_config.json');
const st = await openStore('gateway-check');
const s = await fillFile(st, 'k', small, rangeSource(store.urlOf(m, small)), { chunk: 4096 });
assert.ok(s.verified);
ok(`${small.name}: downloaded in ${Math.ceil(small.bytes / 4096)} ranges by the app's loader, SHA-256 equals the lock`);

const w = m.files.find((f) => f.name.endsWith('onnx_data'));
const from = 10 * CHUNK, to = from + CHUNK;
const t0 = Date.now();
const r = await fetch(store.urlOf(m, w), { headers: { Range: `bytes=${from}-${to - 1}` } });
assert.equal(r.status, 206);
assert.equal(r.headers.get('content-range'), `bytes ${from}-${to - 1}/${w.bytes}`);
const got = Buffer.from(await r.arrayBuffer());
assert.equal(got.length, CHUNK);
const local = join(CACHE, m.id, m.revision, w.name);
if (existsSync(local)) {
  const fd = openSync(local, 'r'), buf = Buffer.alloc(CHUNK);
  readSync(fd, buf, 0, CHUNK, from); closeSync(fd);
  assert.equal(H(got), H(buf));
  ok(`weights bytes ${from}-${to - 1} (32 MiB, ${Date.now() - t0} ms): SHA-256 ${H(got).slice(0, 16)}... equals the local verified copy`);
} else ok(`weights 32 MiB range: 206 with the right Content-Range (no local copy to compare; run node fetch-models.mjs)`);
const bad = await fetch(store.urlOf(m, w).replace(m.revision, '0'.repeat(40)), { method: 'HEAD' });
assert.equal(bad.status, 404);
ok('an unpinned revision: 404');
console.log(`\n${n} passed`);
