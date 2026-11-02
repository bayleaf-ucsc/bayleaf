// DuckDB test fixtures' expected answers, computed here without DuckDB (story DB2's
// "independent computation"): a small RFC 4180 CSV reader and the summary of
// test/fixtures/duckdb/messy-sales.csv (quoted commas, doubled quotes, a line
// break inside a field, "$85,000" amounts, n/a, mixed-case and padded regions).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseRows(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
export function parseCsv(text) {
  const [head, ...rows] = parseRows(text);
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// [region, month, total, median, orders] sorted as ORDER BY ALL would.
export function messyExpected() {
  const rows = parseCsv(readFileSync(join(import.meta.dirname, 'fixtures/duckdb/messy-sales.csv'), 'utf8'));
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.region.trim().toUpperCase()}\t${r.order_date.slice(0, 7)}`;
    const amount = r.amount === 'n/a' || r.amount === '' ? null : Number(r.amount.replace(/[$,]/g, ''));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(amount);
  }
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, xs]) => {
    const [region, month] = k.split('\t'), nums = xs.filter((x) => x !== null);
    return [region, month, nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100 : null, nums.length ? median(nums) : null, xs.length];
  });
}
