#!/usr/bin/env node
/**
 * Author the file inventory for an HF artifact gateway release (issue #121).
 *
 *   node scripts/hf-release.mjs <namespace/repo> <40-hex commit> <path>...
 *
 * Prints the `files` array for src/hfReleases.json. Every entry is tied to the
 * pinned commit: LFS files take their SHA-256 from the commit's LFS pointer
 * (`lfs.oid`); small files are downloaded, their git blob SHA-1 is checked
 * against the commit's tree `oid`, and their SHA-256 is computed here. The
 * Worker's mirror later refuses any bytes whose SHA-256 differs (R2 verifies
 * the checksum on write), so a wrong inventory fails closed, not open.
 *
 * Reads HF_TOKEN from the environment if set (only sent to huggingface.co).
 * Metadata fields (license, distribution, qualification) are written by hand:
 * they record human decisions, not facts this script can establish.
 */
import { createHash } from 'node:crypto';

const [repo, revision, ...paths] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[0-9a-f]{40}$/.test(revision ?? '') || !paths.length) {
  console.error('usage: node scripts/hf-release.mjs <namespace/repo> <40-hex commit> <path>...');
  process.exit(2);
}
const auth = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
const hub = 'https://huggingface.co';

const info = await fetch(`${hub}/api/models/${repo}/paths-info/${revision}`, {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }),
});
if (!info.ok) throw new Error(`paths-info: HTTP ${info.status}`);
const entries = new Map((await info.json()).map((e) => [e.path, e]));

// Download from the pinned commit. The token goes only to huggingface.co; a
// redirect elsewhere (HF's storage bridge) is followed without it.
async function download(path) {
  let url = `${hub}/${repo}/resolve/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(url, { redirect: 'manual', headers: new URL(url).hostname === 'huggingface.co' ? auth : {} });
    if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.get('location'), url).href; continue; }
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error(`${path}: too many redirects`);
}

const files = [];
for (const path of paths) {
  const e = entries.get(path);
  if (!e || e.type !== 'file') throw new Error(`${path}: not a file at ${revision}`);
  if (e.lfs) {
    if (e.lfs.size !== e.size) throw new Error(`${path}: LFS size mismatch`);
    files.push({ path, bytes: e.size, sha256: e.lfs.oid, git_oid: e.oid, lfs: true });
    continue;
  }
  const bytes = await download(path);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== e.size || blob !== e.oid) throw new Error(`${path}: bytes do not match the commit's git blob`);
  files.push({ path, bytes: e.size, sha256: createHash('sha256').update(bytes).digest('hex'), git_oid: e.oid, lfs: false });
}
console.log(JSON.stringify(files, null, 2));
