// Sampled process-tree RSS, not JS heap alone. RSS can double-count shared pages.
// Apple IOAccelerator is system-wide, not this process's GPU allocation.
import { execFileSync } from 'node:child_process';

export const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), n = sorted.length;
  return n ? (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2 : null;
};
export function processMemory(text, profile) {
  const rows = text.trim().split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
    .map((m) => ({ pid: +m[1], parent: +m[2], rss: +m[3], command: m[4] }));
  const flag = `--user-data-dir=${profile}`;
  const ids = new Set(rows.filter((r) => { const i = r.command.indexOf(flag); return i >= 0 && (i + flag.length === r.command.length || /\s/.test(r.command[i + flag.length])); }).map((r) => r.pid));
  let previous;
  do { previous = ids.size; for (const r of rows) if (ids.has(r.parent)) ids.add(r.pid); } while (ids.size !== previous);
  return ids.size ? rows.filter((r) => ids.has(r.pid)).reduce((s, r) => s + r.rss, 0) : null;
}
export function readMemory(profile) {
  let chromeRssKB = null, gpuInUseBytes = null;
  try { chromeRssKB = processMemory(execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', timeout: 3000 }), profile); } catch {}
  if (process.platform === 'darwin') try {
    const text = execFileSync('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { encoding: 'utf8', timeout: 3000 });
    const counters = [...text.matchAll(/"In use system memory"\s*=\s*(\d+)/g)].map((m) => +m[1]);
    if (counters.length) gpuInUseBytes = counters.reduce((s, n) => s + n, 0);
  } catch {}
  return { chromeRssKB, gpuInUseBytes };
}
export function memorySummary(samples) {
  const peak = (key) => { const values = samples.map((s) => s[key]).filter(Number.isFinite); return values.length ? Math.max(...values) : null; };
  const base = samples[0] ?? {}, last = samples.at(-1) ?? {}, gpuPeak = peak('gpuInUseBytes');
  return { samples: samples.length, before: base, after: last, chromeRssPeakKB: peak('chromeRssKB'),
    gpuPeakDeltaBytes: Number.isFinite(base.gpuInUseBytes) && gpuPeak !== null ? gpuPeak - base.gpuInUseBytes : null };
}
export async function measure(operation, { sample = () => ({}), intervalMs = 500 } = {}) {
  const samples = [sample()], start = performance.now();
  const timer = setInterval(() => samples.push(sample()), intervalMs);
  try { return { value: await operation(), measurement: finish() }; }
  catch (error) { error.measurement = finish(); throw error; }
  finally { clearInterval(timer); }
  function finish() { samples.push(sample()); return { wall_ms: performance.now() - start, interval_ms: intervalMs, ...memorySummary(samples) }; }
}
export function generationMetrics(g) {
  const rate = (n, ms) => Number.isFinite(n) && Number.isFinite(ms) && ms > 0 ? n / (ms / 1000) : null;
  return { input_tokens: g.input_tokens, output_tokens: g.output_tokens, ttft_ms: g.ttft_ms,
    generation_ms: g.generation_ms, decode_ms: g.decode_ms,
    prefill_tok_s: rate(g.input_tokens, g.ttft_ms), decode_tok_s: g.output_tokens > 1 ? rate(g.output_tokens - 1, g.decode_ms) : null };
}
