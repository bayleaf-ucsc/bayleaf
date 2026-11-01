#!/usr/bin/env node
/**
 * Verify a live HF artifact gateway against the checked-in registry (issue #121):
 * the catalog matches src/hfReleases.json, and every approved file downloads,
 * in 20 MiB ranges, to its registered size and SHA-256.
 *
 *   node scripts/verify-hf-release.mjs [--gateway https://api.bayleaf.dev] [--repo <namespace/repo>] [--catalog-only]
 *
 * --catalog-only compares hashes without downloading: the cheap check a client
 * release (such as Pouch's deploy) can run when its own lock has not changed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const gateway = arg('gateway', 'https://api.bayleaf.dev').replace(/\/$/, '');
const only = arg('repo');
const PART = 20 * 2 ** 20, PARALLEL = 4;
const { releases } = JSON.parse(readFileSync(new URL('../src/hfReleases.json', import.meta.url)));
if (only && !releases.some((r) => r.repo === only)) { console.log(`FAIL ${only}: not in src/hfReleases.json`); process.exit(1); }
let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };

for (const release of releases.filter((r) => !only || r.repo === only)) {
  const r = await fetch(`${gateway}/hf/catalog/${release.repo}`);
  if (!r.ok) { fail(`${release.repo}: catalog HTTP ${r.status}`); continue; }
  const live = (await r.json()).releases.find((x) => x.revision === release.revision);
  if (!live) { fail(`${release.repo}@${release.revision}: not in the live catalog`); continue; }
  for (const f of release.files) {
    const l = live.files.find((x) => x.path === f.path);
    if (!l || l.sha256 !== f.sha256 || l.bytes !== f.bytes) fail(`${f.path}: live catalog differs from the registry`);
    else if (!l.mirrored) fail(`${f.path}: not mirrored`);
  }
  if (process.argv.includes('--catalog-only')) { console.log(`ok   ${release.repo}@${release.revision.slice(0, 12)} catalog`); continue; }
  for (const f of release.files) {
    const t0 = Date.now(), parts = [];
    for (let at = 0; at < f.bytes; at += PART) parts.push([at, Math.min(at + PART, f.bytes) - 1]);
    const bufs = new Array(parts.length);
    let next = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (next < parts.length) {
        const i = next++, [a, b] = parts[i];
        const res = await fetch(f.bytes ? `${gateway}/hf/${release.repo}/resolve/${release.revision}/${f.path}` : 'about:blank', { headers: { Range: `bytes=${a}-${b}` } });
        if (res.status !== 206 || res.headers.get('content-range') !== `bytes ${a}-${b}/${f.bytes}`) throw new Error(`${f.path} ${a}-${b}: HTTP ${res.status} ${res.headers.get('content-range')}`);
        bufs[i] = Buffer.from(await res.arrayBuffer());
      }
    }));
    const h = createHash('sha256');
    for (const b of bufs) h.update(b);
    const got = h.digest('hex'), size = bufs.reduce((n, b) => n + b.length, 0);
    if (got !== f.sha256 || size !== f.bytes) fail(`${f.path}: downloaded ${size} bytes, SHA-256 ${got}`);
    else console.log(`ok   ${f.path} ${size} bytes in ${Date.now() - t0} ms`);
  }
}
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('PASS');
