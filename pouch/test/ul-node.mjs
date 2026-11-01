// Ubiquitous language guard (LANGUAGE.md): the built page must not say the
// terms the 2026-10-31 realignment retired. It reads dist/pouch.html (run
// `node build.mjs` first) and greps the whole file, markup and bundle alike,
// so a string reaches no user or agent through any path. Each banned pattern
// says what replaced it; ALLOW lists deliberate exceptions by the text around
// the match, with the reason.
// Run: node test/ul-node.mjs [path/to/pouch.html]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2] ?? resolve(import.meta.dirname, '..', 'dist/pouch.html');
const html = readFileSync(file, 'utf8');

const BANNED = [
  { re: /\b[Ll]anes?\b/g, use: 'Provider (BayLeaf Sealed, Transformers.js)' },
  { re: /\bLocal (lane|model|turn)\b|["'`]Local:|\bLocal is\b|\bLocal works\b/g, use: 'Transformers.js' },
  { re: /(?<!BayLeaf )\bSealed (lane|model list)\b|["'`]Sealed:/g, use: 'BayLeaf Sealed' },
  { re: /\bQueue(d|s)?\b|\bqueues it\b|"queue"|'queue'|data-mode="queue"/g, use: 'Follow-up (queuing is the strategy, not the name)' },
  { re: /(?<!\w)\(s[1-9]\d*\)|\b(id|ids|handle) s[1-9]\d*\b|["'`]s[1-9]\d*["'`]|\bs[1-9]\d*, s[1-9]\d*\b|main \(s1\)/g, use: 'a-handles: a1 (main), a2, ...' },
  { re: /\bSessions in this scope\b|\bsessions of (this|your) scope\b|\bmessage another session\b/g, use: 'agents of this session' },
];
// [pattern source, context substring, reason]
const ALLOW = [
  ["'queue'", "sendMode==='queue'", 'settings.js reads the follow-up mode older builds saved as "queue"'],
  ["'queue'", 'sendMode="followup"', 'settings.js migrates the stored "queue" value on load'],
  ['"queue"', 'sendMode==="queue"', 'the same read, as minified'],
  ['"queue"', 'sendMode="followup"', 'the same migration, as minified'],
];

const hits = [];
for (const { re, use } of BANNED) {
  for (const m of html.matchAll(re)) {
    const ctx = html.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, ' ');
    const allowed = ALLOW.find(([src, sub]) => (src === m[0] || src === re.source) && ctx.includes(sub));
    if (!allowed) hits.push({ term: m[0], use, ctx });
  }
}
if (hits.length) {
  for (const h of hits.slice(0, 40)) console.log(`FAIL "${h.term}" (use: ${h.use}) ... ${h.ctx} ...`);
  console.log(`${hits.length} retired term(s) in ${file}`);
  process.exit(1);
}
// The guard must be able to fail: the retired terms are still detectable.
const probe = 'Queued · after this turn | Local lane | main (s1) | "s3"';
const caught = BANNED.filter(({ re }) => new RegExp(re.source).test(probe)).length;
if (caught < 3) { console.log(`FAIL the patterns no longer catch the retired terms (${caught})`); process.exit(1); }
console.log(`ul-node: 0 retired terms in ${file} (${ALLOW.length} allowlisted contexts)`);
