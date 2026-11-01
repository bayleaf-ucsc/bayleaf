// summarize-context.mjs: markdown tables for qualify.mjs --lengths runs (perf.context).
//   node summarize-context.mjs results/context-*.json
// Rows with repeats show the median prefill/decode and the needle tally over repeats.
import { readFileSync } from 'node:fs';
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const fmt = (x, d = 1) => x == null ? '' : (+x).toFixed(d);
const sec = (ms) => ms == null ? '' : fmt(ms / 1000, 2);
for (const path of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(path, 'utf8'));
  for (const [mode, rows] of Object.entries(r.perf?.context ?? {})) {
    console.log(`\n### ${path.split('/').pop()}: ${mode}\n`);
    if (mode.startsWith('tail')) {
      console.log('| context end | past | chunk ms | ms/token | decode tok/s | finite | RSS peak GB | GPU Δ peak GB | error |\n|---:|---:|---:|---:|---:|---|---:|---:|---|');
      for (const x of rows) console.log(`| ${x.length ?? x.past + x.chunk} | ${x.past ?? ''} | ${x.chunkMs ?? ''} | ${x.chunkMs ? fmt(x.chunkMs / x.chunk, 2) : ''} | ${fmt(x.decodeTokS)} | ${x.finite ?? ''} | ${fmt(x.chromeRssPeakGB, 2)} | ${fmt(x.gpuDeltaPeakGB, 2)} | ${(x.error ?? '').slice(0, 120).replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
      continue;
    }
    console.log('| length | n | prefill s | prefill tok/s | TTFT s | decode tok/s | RSS peak GB | GPU Δ peak GB | needles 10/50/90% | sliding KV len | error |\n|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|');
    for (const N of [...new Set(rows.map((x) => x.length))]) {
      const rs = rows.filter((x) => x.length === N), ok = rs.filter((x) => !x.error);
      const needles = [0, 1, 2].map((i) => `${ok.filter((x) => x.needles?.[i]?.pass).length}/${ok.length}`).join(' ');
      console.log(`| ${N} | ${rs.length} | ${sec(median(ok.map((x) => x.prefillMs)))} | ${fmt(median(ok.map((x) => x.prefillTokS)), 0)} | ${sec(median(ok.map((x) => x.ttftMs)))} | ${fmt(median(ok.map((x) => x.decodeTokS)))} | ${fmt(Math.max(...rs.map((x) => x.chromeRssPeakGB ?? 0)), 2)} | ${fmt(Math.max(...rs.map((x) => x.gpuDeltaPeakGB ?? 0)), 2)} | ${ok.length ? needles : ''} | ${ok[0]?.kvShapes?.['sliding (layer 4)']?.[2] ?? ''} | ${(rs.find((x) => x.error)?.error ?? '').slice(0, 140).replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
    }
  }
}
