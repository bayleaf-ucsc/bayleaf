// Print the standard tables for one or more pouch-qualify-v1 results files.
//
//   node summarize.mjs results/a.json [results/b.json ...] [--against results/quant-q4f16-agent.json]
//
// Table 1: pass/n per task and setup, with core, held-out and all totals.
// Table 2: failure classes per setup (parse, cap, wrong, timeout, load, other).
// Table 3: perf, when the file has a perf block (GPU deltas marked noisy).
// --against compares per-trial classes with a legacy run2/run-quant trace file
// (the reproduction check: same setup name, task and trial index).
import { readFileSync } from 'node:fs';
import { CORE_NAMES, HELD_OUT_NAMES, FIVE } from './tasks.mjs';
import { median } from './measurements.mjs';

const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--against');
const against = process.argv.includes('--against') ? process.argv[process.argv.indexOf('--against') + 1] : null;
const table = (head, rows) => console.log(['| ' + head.join(' | ') + ' |', '|' + head.map((_, i) => i ? '---:' : '---').join('|') + '|', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n') + '\n');
const sum = (tasks, names, k) => names.filter((t) => tasks[t]).reduce((s, t) => s + tasks[t][k], 0);
const frac = (tasks, names) => names.some((t) => tasks[t]) ? `${sum(tasks, names, 'pass')}/${sum(tasks, names, 'n')}` : '–';
const number = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
const peak = (values) => { const finite = values.filter(Number.isFinite); return finite.length ? Math.max(...finite) : null; };
const rssGB = (n) => Number.isFinite(n) ? n * 1024 / 1e9 : null;

for (const f of files) {
  const r = JSON.parse(readFileSync(f, 'utf8'));
  console.log(`## ${f}\n${r.model.repo}@${r.model.revision.slice(0, 8)} ${JSON.stringify(r.model.dtype)}, ${r.browser ?? '?'}, ${r.load?.adapter?.architecture ?? 'no adapter'}, runtime ${r.runtime?.transformers ?? '?'}/${r.runtime?.ort ?? '?'}${r.runtime?.matchesLock ? ' (lock)' : ''}; external requests ${r.externalRequests.length}${r.fatal ? '; FATAL ' + r.fatal.slice(0, 120) : ''}${r.loadError ? '; LOAD ERROR' : ''}\n`);
  const setups = Object.entries(r.setups ?? {});
  if (setups.length) {
    const tasks = [...new Set(setups.flatMap(([, s]) => Object.keys(s.tasks)))];
    table(['setup (recipe / tools, sha)', ...tasks, 'five', 'core', 'held-out', 'all'], setups.map(([n, s]) => [`${n} (${s.recipe} / ${s.toolLayer}, ${s.recipeSha256.slice(0, 8)})`, ...tasks.map((t) => s.tasks[t] ? `${s.tasks[t].pass}/${s.tasks[t].n}` : '–'), frac(s.tasks, FIVE), frac(s.tasks, CORE_NAMES), frac(s.tasks, HELD_OUT_NAMES), frac(s.tasks, tasks)]));
    const K = ['parse', 'cap', 'wrong', 'timeout', 'load', 'other'];
    table(['setup', ...K, 'tool errors', 'median trial ms'], setups.map(([n, s]) => {
      const t = Object.keys(s.tasks), ms = t.flatMap((x) => s.tasks[x].ms).sort((a, b) => a - b);
      return [n, ...K.map((k) => sum(s.tasks, t, k)), sum(s.tasks, t, 'toolErrors'), ms[ms.length >> 1] ?? '–'];
    }));
    table(['setup', 'median TTFT ms / turn', 'median prefill proxy tok/s', 'median decode tok/s', 'input / output tokens', 'sampled Chrome RSS peak GB'], setups.map(([n, s]) => {
      const trials = Object.values(s.tasks).flatMap((t) => t.trials ?? []), generations = trials.flatMap((t) => t.generations ?? []);
      return [n, number(median(generations.map((g) => g.ttft_ms))), number(median(generations.map((g) => g.prefill_tok_s))), number(median(generations.map((g) => g.decode_tok_s))),
        generations.length ? `${generations.reduce((n, g) => n + g.input_tokens, 0)} / ${generations.reduce((n, g) => n + g.output_tokens, 0)}` : 'n/a', number(rssGB(peak(trials.map((t) => t.measurement?.chromeRssPeakKB))), 2)];
    }));
  }
  if (r.measurements) {
    table(['download GB', 'initial load ms', 'sampled run Chrome RSS peak GB', 'load RSS peak GB', 'max operation GPU Δ GB (system-wide, noisy)'],
      [[number(r.model.download_bytes / 1e9, 2), number(r.load?.load_ms), number(rssGB(peak(r.measurements.map((m) => m.chromeRssPeakKB))), 2), number(rssGB(r.load?.measurement?.chromeRssPeakKB), 2), number((peak(r.measurements.map((m) => m.gpuPeakDeltaBytes)) ?? NaN) / 1e9, 2)]]);
    console.log('Memory peaks are sampled lower bounds. Chrome RSS may double-count shared pages. GPU is system-wide, not model VRAM; never add it to RSS. Missing metrics: n/a. Prefill rate uses input tokens / TTFT (end-to-end proxy).\n');
  }
  if (r.perf?.context) {
    table(['context mode', 'tokens', 'prefill tok/s', 'decode tok/s', 'sampled RSS peak GB', 'status'], Object.entries(r.perf.context).flatMap(([mode, rows]) => rows.map((row) => [mode, row.length ?? row.past, number(row.prefillTokS), number(row.decodeTokS), number(row.chromeRssPeakGB, 2), row.error ?? 'completed'])));
  } else if (r.perf) {
    const p = r.perf;
    table(['download', 'load cold / warm', 'TTFT ~1k / ~4k', 'decode tok/s ~1k / ~4k', 'Chrome RSS peak', 'GPU Δ load / peak (noisy)'],
      [[`${(r.model.download_bytes / 1e9).toFixed(2)} GB`, `${number(p.coldLoadMs)} / ${number(p.warmLoadMs)} ms`, `${number(p['~1k']?.ttft_ms)} / ${number(p['~4k']?.ttft_ms)} ms`, `${number(p['~1k']?.decode_tok_s)} / ${number(p['~4k']?.decode_tok_s)}`, `${number(p.chromeRssPeakGB, 2)} GB`, `${number(p.gpuLoadDeltaGB, 2)} / ${number(p.gpuPeakDeltaGB, 2)} GB`]]);
  }
  if (against) {
    const legacy = JSON.parse(readFileSync(against, 'utf8')).trials;
    let same = 0, n = 0;
    for (const [sn, s] of setups) for (const [tn, row] of Object.entries(s.tasks)) for (const t of row.trials) {
      const old = legacy.find((x) => (x.setup ?? x.variant) === sn && x.task === tn && x.trial === t.trial);
      if (!old) continue; n++;
      const match = old.cls === t.cls && old.rounds === t.rounds; same += match;
      if (!match) console.log(`differs: ${sn} ${tn} trial ${t.trial}: legacy ${old.cls}/${old.rounds} rounds, now ${t.cls}/${t.rounds}`);
    }
    console.log(`reproduction vs ${against}: ${same}/${n} trials match on class and round count\n`);
  }
}
