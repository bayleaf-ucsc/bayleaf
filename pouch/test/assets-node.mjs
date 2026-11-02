// Assets (node): resuming a chunked file whose last state was saved without its
// verdict.   node test/assets-node.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { openStore, fillFile, blobSource, fileState } from '../src/assets.ts';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const H = (b) => createHash('sha256').update(b).digest('hex');
const C = 64 * 1024;

// A reload between storing the last chunk and recording the verdict leaves every
// chunk kept but no hash state after the last one (it is never saved). The next
// fill must not crash on it: it fetches the last chunk again and finishes.
await t('fillFile: resumes when every chunk is kept but the verdict was not recorded', async () => {
  for (const chunks of [1, 4]) {
    const data = randomBytes(chunks * C - 7), f = { name: 'w.bin', bytes: data.length, sha256: H(data) };
    const real = await openStore(`t-verdict-${chunks}`);
    const st = { ...real, put: async (k, b) => { if (k.endsWith('.state') && JSON.parse(await b.text()).verified) throw new Error('reloaded'); return real.put(k, b); } };
    await assert.rejects(fillFile(st, 'k', f, blobSource(new Blob([data])), { chunk: C }), /reloaded/);
    assert.equal((await fileState(real, 'k', f, C)).complete, false);
    const asked = [];
    const source = async (i, from, to) => { asked.push(i); return new Uint8Array(data.subarray(from, to)); };
    const s = await fillFile(real, 'k', f, source, { chunk: C });
    assert.ok(s.verified);
    assert.deepEqual(asked, [chunks - 1], 'only the last chunk is fetched again');
    assert.ok((await fileState(real, 'k', f, C)).complete);
  }
});

console.log(`${n} assets tests passed`);
