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

const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--against');
const against = process.argv.includes('--against') ? process.argv[process.argv.indexOf('--against') + 1] : null;
const table = (head, rows) => console.log(['| ' + head.join(' | ') + ' |', '|' + head.map((_, i) => i ? '---:' : '---').join('|') + '|', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n') + '\n');
const sum = (tasks, names, k) => names.filter((t) => tasks[t]).reduce((s, t) => s + tasks[t][k], 0);
const frac = (tasks, names) => names.some((t) => tasks[t]) ? `${sum(tasks, names, 'pass')}/${sum(tasks, names, 'n')}` : '–';

for (const f of files) {
  const r = JSON.parse(readFileSync(f, 'utf8'));
  console.log(`## ${f}\n${r.model.repo}@${r.model.revision.slice(0, 8)} ${r.model.dtype}, ${r.browser ?? '?'}, ${r.load?.adapter?.architecture ?? 'no adapter'}, runtime ${r.runtime?.transformers}/${r.runtime?.ort}${r.runtime?.matchesLock ? ' (lock)' : ''}; external requests ${r.externalRequests.length}${r.fatal ? '; FATAL ' + r.fatal.slice(0, 120) : ''}${r.loadError ? '; LOAD ERROR' : ''}\n`);
  const setups = Object.entries(r.setups ?? {});
  if (setups.length) {
    const tasks = [...new Set(setups.flatMap(([, s]) => Object.keys(s.tasks)))];
    table(['setup (recipe / tools, sha)', ...tasks, 'five', 'core', 'held-out', 'all'], setups.map(([n, s]) => [`${n} (${s.recipe} / ${s.toolLayer}, ${s.recipeSha256.slice(0, 8)})`, ...tasks.map((t) => s.tasks[t] ? `${s.tasks[t].pass}/${s.tasks[t].n}` : '–'), frac(s.tasks, FIVE), frac(s.tasks, CORE_NAMES), frac(s.tasks, HELD_OUT_NAMES), frac(s.tasks, tasks)]));
    const K = ['parse', 'cap', 'wrong', 'timeout', 'load', 'other'];
    table(['setup', ...K, 'tool errors', 'median trial ms'], setups.map(([n, s]) => {
      const t = Object.keys(s.tasks), ms = t.flatMap((x) => s.tasks[x].ms).sort((a, b) => a - b);
      return [n, ...K.map((k) => sum(s.tasks, t, k)), sum(s.tasks, t, 'toolErrors'), ms[ms.length >> 1] ?? '–'];
    }));
  }
  if (r.perf) {
    const p = r.perf;
    table(['download', 'load cold / warm', 'TTFT ~1k / ~4k', 'decode tok/s ~1k / ~4k', 'Chrome RSS peak', 'GPU Δ load / peak (noisy)'],
      [[`${(r.model.download_bytes / 1e9).toFixed(2)} GB`, `${p.coldLoadMs} / ${p.warmLoadMs} ms`, `${p['~1k'].ttft_ms} / ${p['~4k'].ttft_ms} ms`, `${p['~1k'].decode_tok_s} / ${p['~4k'].decode_tok_s}`, `${p.chromeRssPeakGB} GB`, `${p.gpuLoadDeltaGB ?? '?'} / ${p.gpuPeakDeltaGB ?? '?'} GB`]]);
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
