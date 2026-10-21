#!/usr/bin/env node
// Adversarial and near-limit MIME resource benchmark for BayLeaf Inboxes (#97).
// Results and interpretation: qualification/mime-bench.md. Local only: no network,
// no deployment, synthetic messages only.
//
// Two tiers, because neither alone answers the production question:
//
// - workerd tier: the real Worker bundle in Miniflare's workerd with real local D1/R2,
//   the real email() handler (through the same email-harness wrapper idea as the test
//   suite, so unparseable input is reachable) and real InboxManagement RPC reads over a
//   service binding. Reports accept/reject, Node-side wall time, CPU seconds consumed by
//   the whole workerd process and its peak RSS growth. Miniflare enforces neither the
//   128 MB isolate limit nor CPU limits, and the process numbers include the local
//   D1/R2 simulators and the wrapper's buffers. They are not isolate measurements.
// - V8 replica tier: the same functions from src/worker.js (readBounded, PostalMime
//   options, emailMeta, emailSearch, htmlToText), bundled for Node, in a fresh child per
//   case and phase with --max-old-space-size=128. Reports child-thread CPU (including
//   instrumentation), sampled heap+ArrayBuffer estimates and RSS growth. An OOM is
//   a warning, not a production-limit measurement: the cap limits V8 old-space only,
//   not total memory or external buffers. BENCH_LIVE=1 adds forced GC at samples.
//
// Usage (from inbox/):
//   node qualification/mime-bench.mjs                 # both tiers, all cases
//   node qualification/mime-bench.mjs --only a,b      # selected cases
//   node qualification/mime-bench.mjs --tier v8|workerd
//   node qualification/mime-bench.mjs --json out.json # also write raw results

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
let WORK;
const MAX_EMAIL_BYTES = 26214400;
const TARGET = MAX_EMAIL_BYTES - 16384; // near the limit, with room for headers
const DOMAIN = 'bayleaf-inboxes.dev';
const run = promisify(execFile);
// BENCH_WORKER_SRC (relative to inbox/, inside src/) compares another copy of the Worker.
const WORKER_SRC = process.env.BENCH_WORKER_SRC ?? 'src/worker.js';

// ---------------------------------------------------------------- case generation

// Deterministic filler so runs are comparable. xorshift32 over printable ASCII.
function rng(seed = 0x9e3779b9) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}
function words(bytes, seed) {
  const next = rng(seed), out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) {
    const r = next() % 64;
    out[i] = r < 9 ? 0x20 : 0x61 + (r % 26);
  }
  return out;
}
function randomBytes(bytes, seed) {
  const next = rng(seed), out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 4) out.writeUInt32LE(next(), Math.min(i, bytes - 4));
  return out;
}
const wrap76 = s => s.replace(/.{1,76}/g, '$&\r\n');
const CRLF = '\r\n';
function headers(extra = [], { subject = 'benchmark', contentType } = {}) {
  return [
    'From: "Bench Sender" <sender@example.org>', `To: someone@${DOMAIN}`, `Subject: ${subject}`,
    'Date: Tue, 20 Oct 2026 12:00:00 +0000', '<bench@example.org>'.replace(/^/, 'Message-ID: '),
    'MIME-Version: 1.0', ...(contentType ? [`Content-Type: ${contentType}`] : []), ...extra,
  ].join(CRLF) + CRLF + CRLF;
}
const b = (...parts) => Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'utf8') : p)));

// Quoted-printable of a UTF-8 buffer: every non-ASCII byte becomes =XX (3x expansion).
function qp(buf) {
  let line = '', out = [];
  for (const byte of buf) {
    const tok = byte >= 33 && byte <= 126 && byte !== 61 ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    if (line.length + tok.length > 75) { out.push(line + '='); line = ''; }
    line += tok;
  }
  out.push(line);
  return out.join(CRLF) + CRLF;
}
function cjk(chars) {
  // CJK ideographs plus astral emoji: two-byte JS strings, 3- and 4-byte UTF-8.
  let s = '';
  const next = rng(7);
  for (let i = 0; i < chars; i++) s += i % 7 === 6 ? '\u{1F600}' : String.fromCharCode(0x4e00 + (next() % 20000));
  return s;
}

const CASES = {
  'decoded-text-lines': {
    note: 'base64 text decodes to 2 million LF bytes, with a second HTML part to exercise derived conversion',
    build: () => b(headers([], { contentType: 'multipart/mixed; boundary="B"' }),
      '--B\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n',
      wrap76(Buffer.alloc(2_000_000, 10).toString('base64')),
      '--B\r\nContent-Type: text/html\r\n\r\n<p>small</p>\r\n--B--\r\n'),
  },
  'baseline-small': {
    note: '1 KiB plain text',
    build: () => b(headers([], { contentType: 'text/plain; charset=utf-8' }), words(1024, 1)),
  },
  'near-limit-attachment': {
    note: 'one base64 attachment, raw just under 25 MiB',
    build: () => {
      const head = headers([], { contentType: 'multipart/mixed; boundary="B"' });
      const decoded = Math.floor((TARGET - 400) / (4 / 3 * 78 / 76));
      return b(head, '--B\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n',
        '--B\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="big.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n',
        wrap76(randomBytes(decoded, 2).toString('base64')), '--B--\r\n');
    },
  },
  'near-limit-text-base64': {
    note: 'text/plain body, base64, ~18.6 MB decoded ASCII',
    build: () => {
      const decoded = Math.floor((TARGET - 400) / (4 / 3 * 78 / 76));
      return b(headers(['Content-Transfer-Encoding: base64'], { contentType: 'text/plain; charset=utf-8' }),
        wrap76(words(decoded, 3).toString('base64')));
    },
  },
  'near-limit-text-unicode-qp': {
    note: 'text/plain CJK+emoji, quoted-printable (3x), ~8 MB decoded UTF-8',
    build: () => {
      const text = Buffer.from(cjk(2_700_000), 'utf8');
      return b(headers(['Content-Transfer-Encoding: quoted-printable'], { contentType: 'text/plain; charset=utf-8' }),
        qp(text.subarray(0, Math.floor((TARGET - 400) / 3.12))));
    },
  },
  'near-limit-html-only': {
    note: 'text/html only (no text part), tag-dense, 8bit',
    build: () => {
      const unit = '<div class="x"><p>row <b>bold</b> &amp; <i>it</i></p><script>var a=1<2;</script></div>\r\n';
      return b(headers(['Content-Transfer-Encoding: 8bit'], { contentType: 'text/html; charset=utf-8' }),
        unit.repeat(Math.floor((TARGET - 400) / unit.length)));
    },
  },
  'qp-soft-break-bomb': {
    note: 'QP body made only of soft line breaks (decodes to nothing)',
    build: () => b(headers(['Content-Transfer-Encoding: quoted-printable'], { contentType: 'text/plain' }),
      '=\r\n'.repeat(Math.floor((TARGET - 400) / 3))),
  },
  'qp-escape-dense': {
    note: 'QP body of =XX escapes only (worst-case decoder density)',
    build: () => b(headers(['Content-Transfer-Encoding: quoted-printable'], { contentType: 'application/octet-stream; name=x.bin' }),
      ('=00'.repeat(25) + '=\r\n').repeat(Math.floor((TARGET - 400) / 78))),
  },
  'base64-whitespace-garbage': {
    note: 'base64 text part with a space and junk byte after every symbol',
    build: () => {
      const unit = 'Q !';
      return b(headers(['Content-Transfer-Encoding: base64'], { contentType: 'text/plain' }),
        (unit.repeat(25) + '\r\n').repeat(Math.floor((TARGET - 400) / 77)));
    },
  },
  'long-line': {
    note: 'single 7bit text line of ~25 MiB, no CRLF',
    build: () => b(headers([], { contentType: 'text/plain' }), words(TARGET - 400, 4).map(c => (c === 0x20 ? 0x61 : c))),
  },
  'many-tiny-parts-9k': {
    note: '9,000 one-byte attachments (under postal-mime maxPartCount 10,000)',
    build: () => {
      const parts = [];
      for (let i = 0; i < 9000; i++) parts.push(`--B\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="p${i}.bin"\r\n\r\nx\r\n`);
      return b(headers([], { contentType: 'multipart/mixed; boundary="B"' }), parts.join(''), '--B--\r\n');
    },
  },
  'many-empty-parts-1m': {
    note: '1,000,000 empty parts (~7 MB), past maxPartCount',
    build: () => b(headers([], { contentType: 'multipart/mixed; boundary="B"' }), '--B\r\n\r\n'.repeat(1_000_000), '--B--\r\n'),
  },
  'many-text-parts-9k': {
    note: '9,000 inline text/plain parts (concatenated text)',
    build: () => {
      const unit = '--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + 'line of text '.repeat(150) + '\r\n';
      return b(headers([], { contentType: 'multipart/mixed; boundary="B"' }), unit.repeat(9000), '--B--\r\n');
    },
  },
  'many-attachments-450x40k': {
    note: '450 base64 attachments of 40 KiB each (listing caps at 200)',
    build: () => {
      const parts = [];
      for (let i = 0; i < 450; i++) parts.push(`--B\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename="img-${i}.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(randomBytes(40960, 100 + i).toString('base64'))}`);
      return b(headers([], { contentType: 'multipart/mixed; boundary="B"' }), parts.join(''), '--B--\r\n');
    },
  },
  'nesting-250': {
    note: 'multipart nesting depth 250 (just under postal-mime 256)',
    build: () => nested(250),
  },
  'nesting-20k': {
    note: 'multipart nesting depth 20,000, past the depth limit',
    build: () => nested(20000),
  },
  'rfc822-nesting-12': {
    note: 'message/rfc822 inside message/rfc822, 12 levels, 1 MiB innermost',
    build: () => {
      let inner = b(headers([], { contentType: 'text/plain' }), words(1 << 20, 5));
      for (let i = 0; i < 12; i++) inner = b(headers([], { contentType: 'message/rfc822', subject: `fwd ${i}` }), inner);
      return inner;
    },
  },
  'huge-single-header': {
    note: 'one 20 MiB unfolded X- header line',
    build: () => b('X-Junk: ', words(20 << 20, 6), CRLF, headers([], { contentType: 'text/plain' }), 'body'),
  },
  'header-1-9MiB-folded': {
    note: '1.9 MiB of folded header continuation lines (under maxHeadersSize 2 MiB)',
    build: () => b('X-Fold: start', ('\r\n ' + 'a'.repeat(60)).repeat(Math.floor(1.9 * (1 << 20) / 63)), CRLF,
      headers([], { contentType: 'text/plain' }), 'body'),
  },
  'many-headers-1m': {
    note: '1,000,000 short header lines (~12 MB)',
    build: () => b('X-H: v\r\n'.repeat(1_000_000), headers([], { contentType: 'text/plain' }), 'body'),
  },
  'subject-encoded-words-1-9MiB': {
    note: 'Subject of ~1.9 MiB UTF-8 B encoded-words (clipped to 998 chars)',
    build: () => {
      const word = `=?UTF-8?B?${Buffer.from('\u{1F600}中文', 'utf8').toString('base64')}?=`;
      const subject = Array(Math.floor(1.9 * (1 << 20) / (word.length + 3))).fill(word).join('\r\n ');
      return b(headers([], { contentType: 'text/plain', subject }), 'body');
    },
  },
  'subject-unicode-998': {
    note: '998-character emoji/CJK subject and RFC 2231 Unicode filename',
    build: () => {
      const s = cjk(998);
      const subject = Array.from(s.match(/.{1,10}/gu), w => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
      const fname = encodeURIComponent(cjk(120));
      return b(headers([], { contentType: 'multipart/mixed; boundary="B"', subject }),
        `--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${cjk(2000)}\r\n`,
        `--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8''${fname}\r\n\r\nPDF\r\n--B--\r\n`);
    },
  },
  'rfc2231-continuations-50k': {
    note: 'filename split into 50,000 RFC 2231 continuations (in a 1.9 MiB header)',
    build: () => {
      const conts = Array.from({ length: 50000 }, (_, i) => `filename*${i}*=a%41`).join(';\r\n ');
      return b(headers([], { contentType: 'multipart/mixed; boundary="B"' }),
        `--B\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment;\r\n ${conts}\r\n\r\nx\r\n--B--\r\n`);
    },
  },
  'addresses-60k': {
    note: 'To: header with 60,000 addresses (~1.9 MiB)',
    build: () => {
      const to = Array.from({ length: 60000 }, (_, i) => `u${i}@e.org`).join(',\r\n ');
      return b(`To: ${to}\r\n`, headers([], { contentType: 'text/plain' }).replace(/^To: .*\r\n/m, ''), 'body');
    },
  },
  'boundary-never-appears': {
    note: 'multipart declares boundary, body of 25 MiB never contains it',
    build: () => b(headers([], { contentType: 'multipart/mixed; boundary="NEVER"' }), words(TARGET - 400, 8)),
  },
  'boundary-prefix-lines': {
    note: '25 MiB of lines that start with the boundary but do not match it',
    build: () => {
      const unit = '--BOUNDARYX not quite\r\n--BOUNDAR\r\n--BOUNDARY-\r\n';
      return b(headers([], { contentType: 'multipart/mixed; boundary="BOUNDARY"' }), '--BOUNDARY\r\nContent-Type: text/plain\r\n\r\n',
        unit.repeat(Math.floor((TARGET - 500) / unit.length)), '--BOUNDARY--\r\n');
    },
  },
  'boundary-empty-and-unclosed': {
    note: 'empty boundary parameter, 200 unclosed nested multiparts, 25 MiB tail',
    build: () => {
      let head = '';
      for (let i = 0; i < 200; i++) head += `--L${i}\r\nContent-Type: multipart/mixed; boundary="L${i + 1}"\r\n\r\n`;
      return b(headers([], { contentType: 'multipart/mixed; boundary="L0"' }), head,
        '--L200\r\nContent-Type: multipart/alternative; boundary=""\r\n\r\n--\r\n', words(TARGET - 30000, 9));
    },
  },
  'declared-over-limit': {
    note: 'rawSize = 25 MiB + 1 declared by the platform',
    rawSize: MAX_EMAIL_BYTES + 1,
    build: () => b(headers([], { contentType: 'text/plain' }), 'tiny'),
  },
  'stream-over-limit': {
    note: 'rawSize claims 1 KiB but the stream carries 25 MiB + 1 byte',
    rawSize: 1024,
    build: () => b(headers([], { contentType: 'text/plain' }), words(MAX_EMAIL_BYTES + 1, 10)),
  },
};

function nested(depth) {
  let open = '', close = '';
  for (let i = 0; i < depth; i++) {
    open += `--N${i}\r\nContent-Type: multipart/mixed; boundary="N${i + 1}"\r\n\r\n`;
    close = `--N${i + 1}--\r\n` + close;
  }
  return b(headers([], { contentType: 'multipart/mixed; boundary="N0"' }), open,
    `--N${depth}\r\nContent-Type: text/plain\r\n\r\ndeep\r\n`, close, '--N0--\r\n');
}

// ---------------------------------------------------------------- V8 replica child

// Runs inside a fresh `node --max-old-space-size=128` child. Prints one JSON line.
async function child(replica, file, phase, rawSize) {
  const w = await import(replica);
  const raw = readFileSync(file); // stands in for the platform's delivered chunks
  const chunk = 65536;
  const stream = () => new ReadableStream({
    start() {}, pull(c) {
      if (this.at === undefined) this.at = 0;
      if (this.at >= raw.length) return c.close();
      // Fresh chunk copies, as the platform delivers new memory per read.
      c.enqueue(raw.slice(this.at, Math.min(raw.length, this.at + chunk)));
      sample();
      this.at += chunk;
    },
  });
  // Live-ish memory: sample heapUsed + ArrayBuffer bytes on every 256th parsed line,
  // after each part finalizes and on every delivered chunk. Uncollected garbage counts,
  // so this is an upper bound on live memory but far less noisy than RSS high-water.
  let peak = 0, ticks = 0;
  // BENCH_LIVE=1 forces a full GC before each (sparser) sample: CPU is then meaningless,
  // but the peak approximates truly live memory at the sampled points.
  const live = process.env.BENCH_LIVE === '1';
  const mask = live ? 4095 : 255;
  const sample = () => { if (live) globalThis.gc(); const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.arrayBuffers); };
  const proto = w.PostalMime.prototype;
  for (const name of ['processLine', 'finalize']) {
    const original = proto[name];
    proto[name] = async function (...a) {
      if (name !== 'processLine' || (++ticks & mask) === 0) sample();
      const result = await original.apply(this, a);
      if (name === 'finalize') sample();
      return result;
    };
  }
  globalThis.gc?.();
  const base = process.memoryUsage();
  const rss0 = process.resourceUsage().maxRSS, cpu0 = process.threadCpuUsage(), t0 = performance.now();
  const out = { phase };
  const message = { from: 'sender@example.org', to: `x@${DOMAIN}`, rawSize, headers: new Headers() };
  if (phase === 'receive') {
    if (rawSize > MAX_EMAIL_BYTES) out.outcome = 'reject:size(declared)';
    else {
      const bytes = await w.readBounded(stream(), MAX_EMAIL_BYTES);
      if (bytes === null) out.outcome = 'reject:size(stream)';
      else {
        let parsed = null;
        try { parsed = await w.parseEmail(bytes, MAX_EMAIL_BYTES); }
        catch (e) {
          if (e instanceof w.MimeResourceLimit) out.outcome = 'reject:resource';
          else out.parse_error = String(e.message).slice(0, 80);
        }
        const meta = w.emailMeta(message, message.to, parsed);
        const metaJson = JSON.stringify(meta);
        const search = w.emailSearch(meta, parsed, 32768);
        Object.assign(out, { outcome: out.outcome || 'stored', meta_bytes: metaJson.length, search_chars: search.length,
          attachments: meta.attachments.length, truncated: !!meta.attachments_truncated, subject_chars: meta.subject?.length ?? 0 });
      }
    }
  } else {
    // Read paths parse the stored raw object again (a single ArrayBuffer from R2).
    const bytes = new Uint8Array(raw);
    let parsed = null;
    try { parsed = await w.parseEmail(bytes.buffer, MAX_EMAIL_BYTES); }
    catch (e) { out.parse_error = e instanceof w.MimeResourceLimit ? 'resource_limit' : String(e.message).slice(0, 80); }
    if (phase === 'text' && parsed) {
      const max = 262144;
      const r = parsed.text ? { source: 'text', text: parsed.text.slice(0, max) }
        : parsed.html ? { source: 'html', ...w.htmlToText(parsed.html, max) } : { source: 'none', text: '' };
      Object.assign(out, { source: r.source, chars: r.text.length });
    }
    if (phase === 'attachment' && parsed) {
      const list = parsed.attachments.slice(0, 200);
      const part = list[list.length - 1];
      if (part) out.bytes = typeof part.content === 'string' ? Buffer.byteLength(part.content) : part.content.byteLength;
    }
  }
  const cpu = process.threadCpuUsage(cpu0);
  out.cpu_ms = Math.round((cpu.user + cpu.system) / 1000);
  out.wall_ms = Math.round(performance.now() - t0);
  sample();
  out.rss_growth_mb = Math.round((process.resourceUsage().maxRSS - rss0) / 1024 * 10) / 10;
  // Absolute peak (includes the delivered raw bytes and ~4 MB of Node's own heap) and
  // growth above the pre-work state.
  out.mem_peak_mb = Math.round(peak / 1048576 * 10) / 10;
  out.mem_growth_mb = Math.round((peak - base.heapUsed - base.arrayBuffers) / 1048576 * 10) / 10;
  // The harness's own file buffer has no production counterpart (chunks or the R2
  // read are the platform's copy), so subtract it for an isolate-equivalent estimate.
  out.isolate_est_mb = Math.round((peak - raw.length) / 1048576 * 10) / 10;
  process.stdout.write(JSON.stringify(out) + '\n');
}

async function buildReplica() {
  const { build } = createRequire(import.meta.url)('esbuild');
  const source = await readFile(join(ROOT, WORKER_SRC), 'utf8');
  const out = (await build({
    absWorkingDir: ROOT, bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
    stdin: { resolveDir: join(ROOT, 'src'), sourcefile: 'worker.js',
      contents: `${source}\nexport { readBounded, emailMeta, emailSearch, htmlToText, PARSE_OPTIONS, PostalMime, parseEmail, MimeResourceLimit };\n` },
    plugins: [{ name: 'stub-workers', setup(pb) {
      pb.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
      pb.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class WorkerEntrypoint { constructor(c, e) { this.ctx = c; this.env = e; } }' }));
    } }],
  })).outputFiles[0].text;
  const path = join(WORK, 'replica.mjs');
  await writeFile(path, out);
  return path;
}

function runChild(replica, file, phase, rawSize) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['--max-old-space-size=128', '--expose-gc', SELF, '--child', replica, file, phase, String(rawSize)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').pop();
      try { resolve(JSON.parse(line)); } catch {
        resolve({ phase, outcome: /heap out of memory|Reached heap limit/i.test(stderr) ? 'heap-oom(128MiB-old-space)' : signal ? `killed:${signal}` : `crash:${code}`,
          stderr: stderr.slice(-300) });
      }
    });
  });
}

// ---------------------------------------------------------------- workerd tier

const WRAPPER = `
import * as mod from './${WORKER_SRC}';
export * from './${WORKER_SRC}';
const inner = mod.default;
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.hostname === 'drain.invalid') return Response.json({ bytes: (await req.arrayBuffer()).byteLength });
    if (u.hostname === 'email-harness.invalid') {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const t0 = Date.now();
      let rejectReason = null, threw = null;
      const message = {
        from: 'sender@example.org', to: u.searchParams.get('to'),
        rawSize: Number(u.searchParams.get('rawSize') ?? bytes.byteLength),
        headers: new Headers(), raw: new Response(bytes).body,
        setReject(reason) { rejectReason = String(reason); },
        async forward() { throw new Error('forward is not permitted'); },
        async reply() { throw new Error('reply is not permitted'); },
      };
      try { await inner.email(message, env, ctx); } catch (e) { threw = String((e && e.message) || e); }
      return Response.json({ rejectReason, threw, inner_ms: Date.now() - t0 });
    }
    return inner.fetch(req, env, ctx);
  },
  email: (m, e, c) => inner.email(m, e, c),
  scheduled: (c, e, x) => inner.scheduled(c, e, x),
};`;
const RPC = `export default { async fetch(req, env) {
  const method = new URL(req.url).pathname.split('/')[2];
  const args = await req.json();
  const r = await env.INBOXES[method](...args);
  if (r instanceof Response) { const buf = await r.arrayBuffer(); return new Response(buf, { headers: { 'x-rpc-status': String(r.status) } }); }
  return Response.json(r);
} };`;

async function workerdHarness() {
  const require = createRequire(import.meta.url);
  const { build } = require('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const bundle = (await build({ absWorkingDir: ROOT, bundle: true, write: false, format: 'esm', platform: 'browser',
    external: ['cloudflare:workers', 'node:*'], stdin: { resolveDir: ROOT, contents: WRAPPER, sourcefile: 'bench-wrapper.js' } })).outputFiles[0].text;
  const before = new Set(await workerdPids());
  const mf = new Miniflare(convertV4MiniflareOptions({ unsafeTriggerHandlers: true, workers: [
    { name: 'inbox', modules: true, script: bundle, compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BLOBS'],
      bindings: { INBOXES_ENABLED: 'true', INBOX_DOMAIN: DOMAIN, MAX_INBOX_BYTES: '4294967296', MAX_OWNER_BYTES: '8589934592',
        MAX_DAILY_RECEIPTS: '100000', MAX_INBOXES_PER_OWNER: '1000' },
      ratelimits: { ACCEPT_LIMIT: { namespace_id: '1', simple: { limit: 100000, period: 60 } },
        REJECT_LIMIT: { namespace_id: '2', simple: { limit: 100000, period: 60 } } },
      outboundService: () => { throw new Error('no network'); } },
    { name: 'rpc', modules: true, script: RPC, compatibilityDate: '2026-08-01',
      serviceBindings: { INBOXES: { name: 'inbox', entrypoint: 'InboxManagement' } } },
  ] }));
  const db = await mf.getD1Database('DB', 'inbox');
  const migration = (await Promise.all((await readdir(join(ROOT, 'migrations'))).filter(f => f.endsWith('.sql')).sort().map(f => readFile(join(ROOT, 'migrations', f), 'utf8'))))
    .join('\n').replace(/--.*$/gm, '').match(/\s*(?:CREATE TRIGGER[\s\S]*?END|[^;]+);/g).map(s => s.trim());
  for (const stmt of migration) await db.prepare(stmt).run();
  const inbox = await mf.getWorker('inbox'), rpcWorker = await mf.getWorker('rpc');
  const pids = (await workerdPids()).filter(p => !before.has(p));
  const rpc = async (method, ...args) => {
    const r = await rpcWorker.fetch(`https://rpc.test/rpc/${method}`, { method: 'POST', body: JSON.stringify(args) });
    if (r.headers.has('x-rpc-status')) return { status: Number(r.headers.get('x-rpc-status')), bytes: (await r.arrayBuffer()).byteLength };
    return r.json();
  };
  return { mf, inbox, rpc, pids };
}

async function workerdPids() {
  try {
    // Only our children: concurrent Miniflare suites must not contaminate CPU
    // deltas (or yield negative deltas when another suite exits mid-sample).
    const { stdout } = await run('pgrep', ['-P', String(process.pid), '-x', 'workerd']);
    return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
}
const cpuSeconds = t => t.split(':').reverse().reduce((s, v, i) => s + Number(v) * 60 ** i, 0);
async function procStats(pids) {
  if (!pids.length) return { cpu: NaN, rss: NaN };
  const { stdout } = await run('ps', ['-o', 'time=,rss=', '-p', pids.join(',')]);
  let cpu = 0, rss = 0;
  for (const line of stdout.trim().split('\n')) {
    const [t, r] = line.trim().split(/\s+/);
    cpu += cpuSeconds(t); rss += Number(r);
  }
  return { cpu, rss };
}
// Run fn while sampling workerd RSS; report wall, process CPU delta and peak RSS growth.
async function measured(pids, fn) {
  const s0 = await procStats(pids);
  let peak = s0.rss, live = true;
  const sampler = (async () => { while (live) { try { peak = Math.max(peak, (await procStats(pids)).rss); } catch {} } })();
  const t0 = performance.now();
  let result, error;
  try { result = await fn(); } catch (e) { error = String(e.message || e).slice(0, 120); }
  const wall = performance.now() - t0;
  live = false; await sampler;
  const s1 = await procStats(pids);
  peak = Math.max(peak, s1.rss);
  return { result, error, wall_ms: Math.round(wall), cpu_ms: Math.round((s1.cpu - s0.cpu) * 1000),
    rss_growth_mb: Math.round((peak - s0.rss) / 1024 * 10) / 10 };
}

async function workerdCase(h, name, spec, file) {
  const raw = await readFile(file);
  const out = { name, size: raw.byteLength };
  const drain = await measured(h.pids, async () => (await h.inbox.fetch('https://drain.invalid/', { method: 'POST', body: raw })).json());
  out.transfer_ms = drain.wall_ms;
  const owner = `bench-${name}`.replace(/[^A-Za-z0-9-]/g, '-').padEnd(16, '0').slice(0, 128);
  const ibx = await h.rpc('createInbox', owner, { type: 'email' });
  const q = new URLSearchParams({ to: ibx.address, rawSize: String(spec.rawSize ?? raw.byteLength) });
  const recv = await measured(h.pids, async () => (await h.inbox.fetch(`https://email-harness.invalid/?${q}`, { method: 'POST', body: raw })).json());
  out.receive = { wall_ms: recv.wall_ms, inner_ms: recv.result?.inner_ms, cpu_ms: recv.cpu_ms, rss_growth_mb: recv.rss_growth_mb,
    outcome: recv.error ? `error:${recv.error}` : recv.result.threw ? `threw:${recv.result.threw}` : recv.result.rejectReason ? `reject:${recv.result.rejectReason}` : 'stored' };
  const listing = await h.rpc('listMessages', owner, ibx.id, { limit: 1 });
  const msg = listing.messages?.[0];
  if (!msg) return out;
  const metadata = await measured(h.pids, () => h.rpc('getMessage', owner, ibx.id, msg.id));
  if (metadata.error || metadata.result?.error) throw new Error('metadata read failed');
  const full = metadata.result;
  out.metadata = { wall_ms: metadata.wall_ms, cpu_ms: metadata.cpu_ms };
  out.meta = { parse_error: full.meta.parse_error, attachments: full.meta.attachments.length,
    truncated: !!full.meta.attachments_truncated, subject_chars: full.meta.subject?.length ?? 0 };
  const read = async (label, fn, summarize) => {
    const m = await measured(h.pids, fn);
    out[label] = { wall_ms: m.wall_ms, cpu_ms: m.cpu_ms, rss_growth_mb: m.rss_growth_mb,
      result: m.error ? `error:${m.error}` : summarize(m.result) };
  };
  await read('text', () => h.rpc('getMessageText', owner, ibx.id, msg.id),
    r => (r.error ? `error:${r.error}` : `${r.source}:${r.text.length}${r.truncated ? '+' : ''}`));
  if (out.meta.attachments) {
    await read('attachment', () => h.rpc('getAttachment', owner, ibx.id, msg.id, out.meta.attachments - 1),
      r => (r.error ? `error:${r.error}` : `${r.status}:${r.bytes}B`));
  }
  await read('body', () => h.rpc('getMessageBody', owner, ibx.id, msg.id), r => (r.error ? `error:${r.error}` : `${r.status}:${r.bytes}B`));
  return out;
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--child') return child(args[1], args[2], args[3], Number(args[4]));
  const opt = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  const only = opt('--only')?.split(',');
  const tier = opt('--tier');
  const jsonOut = opt('--json');
  const names = Object.keys(CASES).filter(n => !only || only.includes(n));
  WORK = await mkdtemp(join(ROOT, 'qualification/.mime-bench-'));
  const files = {};
  for (const name of names) {
    const raw = CASES[name].build();
    files[name] = join(WORK, `${name}.eml`);
    await writeFile(files[name], raw);
    console.error(`generated ${name}: ${raw.byteLength} bytes`);
  }
  const results = {};
  if (tier !== 'workerd') {
    const replica = await buildReplica();
    for (const name of names) {
      const size = (await readFile(files[name])).byteLength;
      const rawSize = CASES[name].rawSize ?? size;
      const phases = {};
      for (const phase of ['receive', 'text', 'attachment']) {
        if (phase !== 'receive' && (rawSize > MAX_EMAIL_BYTES || size > MAX_EMAIL_BYTES)) continue;
        phases[phase] = await runChild(replica, files[name], phase, rawSize);
      }
      results[name] = { size, note: CASES[name].note, v8: phases };
      console.error(`v8 ${name}: ${JSON.stringify(phases)}`);
    }
  }
  if (tier !== 'v8') {
    let h = await workerdHarness();
    console.error(`workerd pids: ${h.pids.join(',') || 'none found (CPU/RSS unavailable)'}`);
    for (const name of names) {
      let r;
      try {
        let timer;
        r = await Promise.race([workerdCase(h, name, CASES[name], files[name]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout 300s')), 300000); })])
          .finally(() => clearTimeout(timer));
      } catch (e) {
        r = { name, error: String(e.message || e) };
        await h.mf.dispose().catch(() => {});
        h = await workerdHarness();
      }
      results[name] = { ...(results[name] || { note: CASES[name].note, size: r.size }), workerd: r };
      console.error(`workerd ${name}: ${JSON.stringify(r)}`);
    }
    await h.mf.dispose();
  }
  if (jsonOut) await writeFile(jsonOut, JSON.stringify(results, null, 2));
  printTable(results);
  await rm(WORK, { recursive: true, force: true });
}

function printTable(results) {
  const cell = v => (v === undefined || v === null ? '' : String(v));
  console.log('| case | raw MiB | workerd receive | recv wall/cpu ms | recv RSS+ MB | text read | text wall/cpu ms | attachment read | att wall/cpu ms | V8 recv cpu ms / peak MB | V8 text cpu/peak | V8 att cpu/peak |');
  console.log('|---|---:|---|---:|---:|---|---:|---|---:|---:|---|---|');
  for (const [name, r] of Object.entries(results)) {
    const w = r.workerd || {}, v = r.v8 || {};
    const v8cell = p => (p ? (p.cpu_ms !== undefined ? `${p.cpu_ms} / ${p.isolate_est_mb}` : p.outcome) : '');
    console.log(`| ${name} | ${r.size ? (r.size / 1048576).toFixed(2) : ''} | ${cell(w.receive?.outcome)}${w.meta?.parse_error ? ' (parse_error)' : ''} | ${w.receive ? `${w.receive.wall_ms}/${w.receive.cpu_ms}` : cell(w.error)} | ${cell(w.receive?.rss_growth_mb)} | ${cell(w.text?.result)} | ${w.text ? `${w.text.wall_ms}/${w.text.cpu_ms}` : ''} | ${cell(w.attachment?.result)} | ${w.attachment ? `${w.attachment.wall_ms}/${w.attachment.cpu_ms}` : ''} | ${v8cell(v.receive)}${v.receive?.outcome && v.receive.cpu_ms !== undefined && v.receive.outcome !== 'stored' ? ` ${v.receive.outcome}` : ''} | ${v8cell(v.text)} | ${v8cell(v.attachment)} |`);
  }
}

await main();
