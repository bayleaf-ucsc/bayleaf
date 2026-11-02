// Ubiquitous language guard (LANGUAGE.md): first-party code must not say the
// terms the 2026-10-31 realignment retired. It scans what Pouch itself writes:
// every src/**/*.ts (the app bundle and the workers, which the built page does
// not contain), sw.js, and the markup and inline scripts of pouch.html and
// viewer.html. Vendored packages are out of scope: their words are not ours to
// rename. Each .ts file passes through esbuild's transform first, so types and
// comments drop out and only strings and code that can reach a user or agent
// remain. Each banned pattern says what replaced it; FOREIGN names another
// vocabulary a pattern collides with; ALLOW lists deliberate exceptions by the
// text around the match, with the reason.
// Run: node test/ul-node.mjs
import { transformSync } from 'esbuild';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const BANNED = [
  { re: /\b[Ll]anes?\b/g, use: 'Provider (BayLeaf Sealed, Transformers.js)' },
  { re: /\bLocal (lane|model|turn)\b|["'`]Local:|\bLocal is\b|\bLocal works\b/g, use: 'Transformers.js' },
  { re: /(?<!BayLeaf )\bSealed (lane|model list)\b|["'`]Sealed:/g, use: 'BayLeaf Sealed' },
  { re: /\bQueue(d|s)?\b|\bqueues it\b|"queue"|'queue'|data-mode="queue"/g, use: 'Follow-up (queuing is the strategy, not the name)' },
  { re: /(?<!\w)\(s[1-9]\d*\)|\b(id|ids|handle) s[1-9]\d*\b|["'`]s[1-9]\d*["'`]|\bs[1-9]\d*, s[1-9]\d*\b|main \(s1\)/g, use: 'a-handles: a1 (main), a2, ...',
    // libav/ffmpeg sample formats (s16, s32, s64 and planar s16p, ...) are bit
    // depths in the media tools' ffmpeg vocabulary, not session handles. A match
    // is foreign only when every s-token in it is one of them.
    foreign: (m) => m.match(/s\d+p?/g).every((t) => /^s(?:16|24|32|64)p?$/.test(t)) },
  { re: /\bSessions in this scope\b|\bsessions of (this|your) scope\b|\bmessage another session\b/g, use: 'agents of this session' },
  // The add-ons realignment (2026-11-01).
  { re: /\b(pdf|media|Transformers\.js) runtime\b/g, use: 'the add-on\'s name (pdf.js, libav.js, Transformers.js)' },
  { re: /\b[Tt]he local model\b|\bIn-browser models?\b/g, use: 'LFM3 or Transformers.js' },
  { re: /\bnot downloaded\b|\bResume download\b|\bStop download\b|\bRemove the model\b|\bLoad from (folder|files)\b|\bDownload the model\b/g, use: 'add-on verbs: not installed, Install, Stop, Remove, Install from folder' },
  { re: /`models(?: (?:get|list|status|remove|verify)\b[^`]*)?`|\bmodels (?:get|status|verify) [a-z]|defineCommand\(["']models["']/g, use: 'the `addons` command (no alias)' },
  { re: /\bInstall app\b|\bUninstall offline copy\b|\b[Ee]ngine jobs?\b/g, use: 'Add to this device, Remove offline copy, jobs on workers' },
];
// [matched text, context substring, reason]
const ALLOW = [
  ['"queue"', 'sendMode === "queue"', 'settings.ts reads (and migrates) the follow-up mode older builds saved as "queue"'],
];

// The first-party sources, as text a user or agent could meet.
const sources = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) sources.push(p); } };
walk(join(root, 'src'));
const texts = sources.map((f) => [f, transformSync(readFileSync(f, 'utf8'), { loader: 'ts', legalComments: 'none' }).code]);
for (const f of ['sw.js', 'pouch.html', 'viewer.html']) texts.push([join(root, f), readFileSync(join(root, f), 'utf8')]);

const hits = [];
for (const [file, text] of texts) {
  for (const { re, use, foreign } of BANNED) {
    for (const m of text.matchAll(re)) {
      if (foreign?.(m[0])) continue;
      const ctx = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, ' ');
      if (!ALLOW.find(([term, sub]) => term === m[0] && ctx.includes(sub))) hits.push({ file: file.slice(root.length + 1), term: m[0], use, ctx });
    }
  }
}
if (hits.length) {
  for (const h of hits.slice(0, 40)) console.log(`FAIL ${h.file}: "${h.term}" (use: ${h.use}) ... ${h.ctx} ...`);
  console.log(`${hits.length} retired term(s) in first-party sources`);
  process.exit(1);
}
// The guard must be able to fail: the retired terms are still detectable, and
// the sample-format exemption does not swallow a real handle.
const probe = 'Queued · after this turn | Local lane | main (s1) | "s3" | `models get x` | the pdf runtime';
const caught = BANNED.filter(({ re }) => new RegExp(re.source).test(probe)).length;
if (caught < 5) { console.log(`FAIL the patterns no longer catch the retired terms (${caught})`); process.exit(1); }
const handles = BANNED.find((b) => b.foreign);
if (!handles.foreign('"s16"') || handles.foreign('"s3"') || handles.foreign('s16, s3')) { console.log('FAIL the sample-format exemption covers a session handle'); process.exit(1); }
console.log(`ul-node: 0 retired terms in ${texts.length} first-party sources (${ALLOW.length} allowlisted context)`);
