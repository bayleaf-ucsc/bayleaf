// Operator workbench: one panel per operator question, drawn from private reads.
// Every panel shows how much of its window was actually read; nothing missing
// is drawn as zero and nothing cumulative is summed.
const $ = selector => document.querySelector(selector);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const SERVICES = ['landing', 'chat', 'api', 'sandbox', 'proxies', 'inboxes'];
const NETWORKS = ['campus-network', 'other-network', 'unknown'];
const COLORS = ['#205444', '#b0702c', '#4f6fa0', '#8a4f7d', '#7a9a3a', '#3f8f8a'];
// Expected export cadence per source/class. Late is a prompt to look, not an outage.
const CADENCE = { 'owui/metrics': 5 * MIN, 'daytona/metrics': MIN, 'inboxes/metrics': 15 * MIN, 'probe/probes': HOUR,
  'chat-retention/deletions': DAY, 'api-retention/deletions': DAY, 'sandbox-reaper/deletions': DAY, 'daytona/lifecycle': null };
const JOBS = ['chat-retention/chat-retention', 'api-retention/user-retention', 'sandbox-reaper/sandbox-reaper'];

// Templates escape every interpolation unless it is already markup.
class Markup { constructor(text) { this.text = text; } }
const escapeText = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fragment = value => value == null || value === false ? '' : value instanceof Markup ? value.text
  : Array.isArray(value) ? value.map(fragment).join('') : escapeText(value);
const html = (strings, ...values) => new Markup(strings.reduce((out, text, i) => out + text + (i < values.length ? fragment(values[i]) : ''), ''));

const n = value => value == null || Number.isNaN(value) ? 'Unknown' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
const time = value => new Date(value).toLocaleString();
const ago = ms => ms < HOUR ? `${n(ms / MIN)} min` : ms < 2 * DAY ? `${n(ms / HOUR)} h` : `${n(ms / DAY)} d`;
const json = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const tally = (rows, key, weight = () => 1) => rows.reduce((out, row) => { const k = key(row); out[k] = (out[k] || 0) + weight(row); return out; }, {});
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const niceMax = value => { if (!(value > 0)) return 1; const p = 10 ** Math.floor(Math.log10(value)); return Math.ceil(value / p * 2) / 2 * p; };

const badge = (text, tone = '') => html`<span class="badge ${tone}">${text}</span>`;
const cards = items => html`<div class="cards">${items.map(([label, value, note]) => html`<div class="stat"><strong>${value}</strong><span>${label}</span>${note ? html`<small>${note}</small>` : ''}</div>`)}</div>`;
const table = (heads, rows) => html`<div class="scroll"><table><thead><tr>${heads.map(h => html`<th>${h}</th>`)}</tr></thead><tbody>${rows.map(row => html`<tr>${row.map(cell => html`<td>${cell}</td>`)}</tr>`)}</tbody></table></div>`;
const bars = values => {
  const sorted = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...sorted.map(([, value]) => value));
  return sorted.length ? html`<div class="bars">${sorted.slice(0, 12).map(([label, value]) => html`<div class="barrow"><span>${label}</span><div class="track"><div class="fill" style="width:${value / max * 100}%"></div></div><span>${n(value)}</span></div>`)}</div>` : html`<p>No observations in this window.</p>`;
};

const covered = (data, win) => (data.spans || []).reduce((sum, [start, end]) => sum + end - start, 0) / (win.to - win.readFrom);
const coverage = (label, data, win) => data.error ? html`<p class="warning">${label}: ${data.error}</p>`
  : data.bucketed ? html`<p class="note">${label} aggregated by the collector: each point is the newest export in its bucket (${[...new Set(data.rows.map(row => row.bucket))].sort((a, b) => a - b).map(ago).join(', ')}).${data.complete ? '' : ' Some series overflowed even daily buckets; totals are lower bounds.'}</p>`
  : data.complete ? ''
  : data.sampled ? html`<p class="warning">${label} sampled: ${n(covered(data, win) * 100)}% of the readable window, in ${n(data.spans.length)} evenly spaced spans including the latest ten minutes. Shaded chart bands mark what was read; gaps between them are unread, not empty. Totals are lower bounds.</p>`
  : html`<p class="warning">${label}: partial coverage. Totals are lower bounds.</p>`;
const panel = ({ title, question, reads, win, body, wide }) => html`<section class="${wide ? 'wide' : ''}"><p class="eyebrow">${question}</p><h2>${title}</h2>${reads.map(([label, data]) => coverage(label, data, win))}${body}<p class="small">${reads.map(([label, data]) => `${label}: ${n(data.rows.length)} rows, ${n(data.queries ?? 0)} queries`).join(' · ')}</p></section>`;

// One frame for every time chart: shared x scale, read spans, UTC midnights.
function timeChart({ win, max, label, unit, spans, body, legend }) {
  const x = t => 44 + (t - win.from) / (win.to - win.from) * 492;
  const y = v => 110 - v / max * 90;
  const span = win.to - win.from;
  const tick = t => span <= DAY ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date(t).toLocaleDateString([], span <= 8 * DAY ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: span > 100 * DAY ? 'numeric' : undefined });
  const midnights = [];
  // Daily marks stop helping past a month; the reset is still explained in the notes.
  if (span <= 31 * DAY) for (let t = Math.ceil(win.from / DAY) * DAY; t < win.to; t += DAY) midnights.push(t);
  const beyond = x(win.readFrom) - x(win.from) > 2;
  return html`<figure class="trend"><figcaption><strong>${label}</strong> <span class="small">${unit}</span>${legend || ''}</figcaption><svg viewBox="0 0 550 146" role="group" aria-label="${label} over time, zero to ${n(max)} ${unit}">
    ${beyond ? html`<g class="beyond"><rect x="44" y="20" width="${x(win.readFrom) - 44}" height="90"><title>Beyond the 90-day retention maximum: no data can exist here</title></rect>${x(win.readFrom) - 44 > 110 ? html`<text x="${(44 + x(win.readFrom)) / 2}" y="68" text-anchor="middle">beyond 90-day retention</text>` : ''}</g>` : ''}
    <g class="trend-read">${(spans || []).map(([s, e]) => html`<rect x="${x(s)}" y="20" width="${Math.max(1, x(e) - x(s))}" height="90"/>`)}</g>
    <g class="trend-grid"><path d="M44 20 H536 M44 65 H536 M44 110 H536"/></g>
    <g class="midnight">${midnights.map(t => html`<path d="M${x(t)} 16 V110"><title>UTC midnight, ${time(t)}</title></path>`)}</g>
    <g class="trend-label"><text x="36" y="24" text-anchor="end">${n(max)}</text><text x="36" y="69" text-anchor="end">${n(max / 2)}</text><text x="36" y="114" text-anchor="end">0</text>
    <text x="44" y="135">${tick(win.from)}</text><text x="290" y="135" text-anchor="middle">${tick((win.from + win.to) / 2)}</text><text x="536" y="135" text-anchor="end">${tick(win.to)}</text></g>
    ${body({ x, y })}</svg></figure>`;
}
// Steps join adjacent exports only (gap at most maxGap); a null sample is a conflict gap.
const steps = (samples, maxGap, color, unit, dots = samples.length <= 400) => ({ x, y }) => {
  let previous = null;
  const segments = [], circles = [];
  for (const [t, v] of samples) {
    if (v == null) { previous = null; continue; }
    if (previous && t - previous[0] <= maxGap) segments.push(`M ${x(previous[0])} ${y(previous[1])} H ${x(t)} V ${y(v)}`);
    if (dots) circles.push(html`<circle cx="${x(t)}" cy="${y(v)}" r="2.5" tabindex="0" style="fill:${color}" aria-label="${time(t)}: ${n(v)} ${unit}"><title>${time(t)}: ${n(v)} ${unit}</title></circle>`);
    previous = [t, v];
  }
  return html`<path class="trend-line" style="stroke:${color}" d="${segments.join(' ')}"/><g class="trend-points">${circles}</g>`;
};

// Global gauges: one value per export time; disagreeing duplicates become gaps.
function gauge(points, name, attributes) {
  const samples = new Map();
  for (const row of points) {
    if (row.name !== name || (attributes !== undefined && row.attributes_json !== attributes)) continue;
    const existing = samples.get(row.observed_at), value = row.conflict ? null : row.value;
    samples.set(row.observed_at, existing === undefined ? value : existing === value ? existing : null);
  }
  return [...samples].sort((a, b) => a[0] - b[0]);
}
// Adjacent exports, or adjacent collector buckets when aggregated upstream.
const joinGap = (points, name, cadence) => Math.max(cadence, 1.5 * (points.find(row => row.name === name)?.bucket ?? 0));
const latest = samples => { const last = samples.at(-1); return !last ? 'Unknown' : last[1] == null ? 'Conflicting' : n(last[1]); };

// Cumulative counters: per exact series, only between adjacent exports of one
// unbroken run (same start, non-decreasing). Resets and unread gaps attribute nothing.
function cumulativeDeltas(points, name, maxGap) {
  const series = new Map();
  for (const row of points.filter(row => row.name === name && row.temporality === 'cumulative')) {
    const key = `${row.source}|${row.attributes_json}`;
    if (!series.has(key)) series.set(key, new Map());
    const byTime = series.get(key), existing = byTime.get(row.observed_at);
    byTime.set(row.observed_at, existing && (existing.value !== row.value || existing.count !== row.count) ? null : row);
  }
  const deltas = [];
  for (const byTime of series.values()) {
    const ordered = [...byTime].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1], b = ordered[i];
      if (!a || !b || b.start_at !== a.start_at || b.observed_at - a.observed_at > maxGap) continue;
      const value = (b.value ?? b.count) - (a.value ?? a.count);
      if (value < 0) continue;
      deltas.push({ from: a.observed_at, to: b.observed_at, value, sum: b.sum != null && a.sum != null ? b.sum - a.sum : null, attributes: json(b.attributes_json) });
    }
  }
  return deltas;
}
// Observed rate per bucket: delta over the distinct export intervals actually seen.
function rates(deltas, win, buckets) {
  const out = Array.from({ length: buckets }, () => ({ value: 0, intervals: new Map() }));
  for (const d of deltas) {
    const bucket = out[Math.min(buckets - 1, Math.floor((d.to - win.from) / (win.to - win.from) * buckets))];
    if (!bucket) continue;
    bucket.value += d.value;
    bucket.intervals.set(`${d.from}-${d.to}`, d.to - d.from);
  }
  return out.map(({ value, intervals }) => { const ms = [...intervals.values()].reduce((a, b) => a + b, 0); return ms ? value / ms * HOUR : null; });
}
const rateBars = (values, win, color = COLORS[0]) => ({ x, y }) => {
  const width = 492 / values.length;
  return html`<g class="rate-bars">${values.map((value, i) => value == null ? '' : html`<rect x="${44 + i * width + 1}" y="${y(value)}" width="${Math.max(1, width - 2)}" height="${110 - y(value)}" style="fill:${color}"><title>${time(win.from + i * (win.to - win.from) / values.length)}: ${n(value)} per hour</title></rect>`)}</g>`;
};

function upPanel({ probes, status }, win) {
  const layers = Object.keys(tally(probes.rows, row => row.layer));
  const rows = layers.map(layer => {
    const runs = probes.rows.filter(row => row.layer === layer).sort((a, b) => a.observed_at - b.observed_at);
    const last = runs.at(-1);
    const gap = runs.length > 1 ? median(runs.slice(1).map((row, i) => row.observed_at - runs[i].observed_at)) : null;
    const late = gap && win.to - last.observed_at > 3 * gap;
    const maxDuration = Math.max(1, ...runs.map(row => row.duration_ms));
    const edge = 4 + (win.readFrom - win.from) / (win.to - win.from) * 232;
    const strip = html`<svg class="strip" viewBox="0 0 240 36" role="img" aria-label="${layer} runs over the window">${edge > 6 ? html`<rect class="beyond-strip" x="0" y="0" width="${edge}" height="36"><title>Beyond the 90-day retention maximum</title></rect>` : ''}${runs.map(row => {
      const failed = row.outcome !== 'success';
      const cx = 4 + (row.observed_at - win.from) / (win.to - win.from) * 232;
      return html`<circle class="${failed ? 'fail' : 'ok'}" cx="${cx}" cy="${failed ? 6 : 32 - row.duration_ms / maxDuration * 24}" r="${failed ? 3.5 : 2}"><title>${time(row.observed_at)}: ${row.outcome}, ${n(row.duration_ms / 1000)} s${failed ? `, ${json(row.extensions_json).result ?? ''}` : ''}</title></circle>`;
    })}</svg>`;
    const ok = runs.filter(row => row.outcome === 'success').length;
    return [layer, strip, html`${ok}/${runs.length} ${ok < runs.length ? badge(`${runs.length - ok} failed`, 'bad') : ''}`,
      `${n(median(runs.map(row => row.duration_ms)) / 1000)} s`, html`${badge(last.outcome, last.outcome === 'success' ? 'good' : 'bad')} ${ago(win.to - last.observed_at)} ago ${late ? badge('late', 'warn') : ''}`];
  });
  const seen = new Map(status.rows.map(row => [`${row.source}/${row.class}`, row]));
  const sources = [...new Set([...Object.keys(CADENCE), ...seen.keys()])].map(key => {
    const row = seen.get(key), cadence = CADENCE[key];
    const age = row ? win.to - row.observed_at : null;
    const state = !row ? badge('not seen in window', 'warn') : cadence === null ? badge('event-driven')
      : cadence === undefined ? badge('no expectation') : age > 2 * cadence + 2 * MIN ? badge('late', 'warn') : badge('on schedule', 'good');
    return [key, row ? time(row.observed_at) : '–', age == null ? '–' : `${ago(age)} ago`, cadence ? `every ${ago(cadence)}` : '–', state];
  });
  return panel({ title: 'Is everything up?', question: 'Synthetic probes and source freshness', reads: [['Probes', probes], ['Sources', status]], win, wide: true,
    body: html`${table(['Probe layer', 'Runs (height = duration, red = failure)', 'Successful', 'Median', 'Latest'], rows)}
      <h3>Sources</h3>${table(['Source / class', 'Last accepted', 'Age', 'Expected', 'State'], sources)}
      <p class="small">Probes are synthetic samples, not user requests or an availability SLA. “Late” compares age with the expected or observed cadence; it prompts a look, it does not prove an outage. Missing sources remain unknown.</p>` });
}

function chatPanel({ metrics }, points, win) {
  const sampled = metrics.sampled && !metrics.complete ? metrics.spans : null;
  const users = [['webui.users.total', 'Total users'], ['webui.users.active', 'Active users'], ['webui.users.active.today', 'Active today']]
    .map(([name, label]) => [label, gauge(points, name), joinGap(points, name, 7.5 * MIN)]);
  const requestDeltas = cumulativeDeltas(points, 'http.server.requests', joinGap(points, 'http.server.requests', 7.5 * MIN));
  const durationDeltas = cumulativeDeltas(points, 'http.server.duration', joinGap(points, 'http.server.duration', 7.5 * MIN));
  const seenMs = new Map(requestDeltas.map(d => [`${d.from}-${d.to}`, d.to - d.from]));
  const seenHours = [...seenMs.values()].reduce((a, b) => a + b, 0) / HOUR;
  const total = requestDeltas.reduce((a, d) => a + d.value, 0);
  const errors = requestDeltas.filter(d => Number(d.attributes.status_code) >= 500).reduce((a, d) => a + d.value, 0);
  const durationCount = durationDeltas.reduce((a, d) => a + d.value, 0), durationSum = durationDeltas.reduce((a, d) => a + (d.sum ?? 0), 0);
  const buckets = win.to - win.from <= HOUR ? 12 : 24;
  return panel({ title: 'Is Chat being used?', question: 'Native OWUI user gauges and HTTP counters', reads: [['Metrics', metrics]], win, wide: true,
    body: html`${cards([...users.map(([label, samples]) => [label, latest(samples)]),
        ['HTTP requests per hour', seenHours ? n(total / seenHours) : 'Unknown', `over ${n(seenHours)} h of observed export intervals`],
        ['Server errors (5xx)', total ? `${n(errors / total * 100)}%` : 'Unknown'],
        ['Mean server time', durationCount ? `${n(durationSum / durationCount)} ms` : 'Unknown', 'not completed-SSE latency']])}
      <div class="charts">${users.map(([label, samples, gap]) => timeChart({ win, label, unit: 'users', spans: sampled,
        max: Math.max(2, niceMax(Math.max(0, ...samples.map(([, v]) => v ?? 0)))), body: steps(samples, gap, COLORS[0], 'users') }))}
      ${(() => { const values = rates(requestDeltas, win, buckets); return timeChart({ win, label: 'HTTP requests', unit: 'per hour, observed', spans: sampled,
        max: niceMax(Math.max(0, ...values.map(v => v ?? 0))), body: rateBars(values, win, COLORS[2]) }); })()}</div>
      <div class="split"><div><h3>Requests by route</h3>${bars(tally(requestDeltas, d => d.attributes.route, d => d.value))}</div>
      <div><h3>Requests by status class</h3>${bars(tally(requestDeltas, d => `${String(d.attributes.status_code)[0]}xx`, d => d.value))}</div></div>
      <p class="small">User gauges are global snapshots, never summed. “Active” means native OWUI activity within three minutes, not concurrent generation; “active today” resets at UTC midnight (dashed lines). Request figures are reset-aware deltas between adjacent cumulative exports of each exact series, as observed rates, never totals across unread time. Routes include health checks and websockets, so requests are not chats.</p>` });
}

function arrivalPanel({ browser }, win) {
  const arrivals = browser.rows;
  const buckets = Array.from({ length: 24 }, () => []);
  for (const row of arrivals) buckets[Math.min(23, Math.floor((row.observed_at - win.from) / (win.to - win.from) * 24))].push(row);
  const max = Math.max(1, ...buckets.map(rows => rows.length));
  const beyondBucket = i => win.from + (i + 1) * (win.to - win.from) / 24 <= win.readFrom;
  const chart = html`<div class="chart" role="group" aria-label="Arrival timeline. Focus or hover over a time bucket for its service and network breakdown.">${buckets.map((rows, i) => html`<div class="column${beyondBucket(i) ? ' beyond-column' : ''}" tabindex="0" data-bucket="${i}" style="--bar-height:${rows.length / max * 100}%" aria-label="${time(win.from + i * (win.to - win.from) / 24)}: ${rows.length} observations" aria-describedby="arrival-breakdown"></div>`)}</div><div id="arrival-breakdown" class="arrival-tooltip" role="tooltip" hidden></div>`;
  return panel({ title: 'Who arrives, and from where?', question: 'Public arrivals', reads: [['Arrivals', browser]], win,
    body: html`${cards([['Arrival observations', n(arrivals.length)], ['Services observed', n(new Set(arrivals.map(row => row.destination)).size)]])}${chart}
      <h3>By service</h3>${bars(tally(arrivals, row => row.destination))}
      <h3>Network location, not affiliation</h3>${bars(tally(arrivals, row => row.network_location))}
      <h3>Referring hostnames</h3>${bars(tally(arrivals, row => row.referring_hostname ?? 'Unknown (not necessarily direct)'))}
      <p class="small">Observations are not unique visitors. No deduplication or visitor identity.</p>` });
}

function retentionPanel({ deletions }, win) {
  const days = [];
  for (let t = Math.floor(win.from / DAY) * DAY; t < win.to; t += DAY) days.push(t);
  const jobs = [...new Set([...JOBS, ...deletions.rows.map(row => `${row.source}/${row.job}`)])];
  const compact = days.length > 31;
  const strip = jobs.map(job => {
    const runs = deletions.rows.filter(row => `${row.source}/${row.job}` === job);
    return [job, html`<div class="days${compact ? ' compact' : ''}">${days.map(day => {
      const run = runs.filter(row => row.observed_at >= day && row.observed_at < day + DAY).at(-1);
      const label = new Date(day).toLocaleDateString([], { timeZone: 'UTC', month: 'short', day: 'numeric' });
      if (day + DAY <= win.readFrom) return html`<span class="daycell"><span class="day beyond-day" title="${label} UTC: beyond the 90-day retention maximum">${compact ? '' : '·'}</span>${compact ? '' : html`<small>${label}</small>`}</span>`;
      return html`<span class="daycell">${run ? html`<span class="day ${run.outcome}" title="${label} UTC: ${run.outcome}, ${run.deleted} deleted at ${time(run.observed_at)}">${compact ? '' : n(run.deleted)}</span>`
        : html`<span class="day none" title="${label} UTC: no report in this read">${compact ? '' : '–'}</span>`}${compact ? '' : html`<small>${label}</small>`}</span>`;
    })}</div>`];
  });
  const latestReports = jobs.map(job => deletions.rows.filter(row => `${row.source}/${row.job}` === job).at(-1)).filter(Boolean);
  return panel({ title: 'Are retention promises kept?', question: 'Deletion job reports', reads: [['Deletions', deletions]], win,
    body: html`${table(['Job', 'Confirmed deletions per UTC day'], strip)}
      <p class="small">${compact ? 'Hover a day for its count. ' : ''}<span class="day success">n</span> success <span class="day partial">n</span> partial <span class="day failure">n</span> failure <span class="day none">–</span> no report. A missing report never means zero deletions; today may not have run yet.</p>
      ${latestReports.map(row => html`<details><summary>Latest ${row.source}/${row.job}: ${row.outcome}, ${time(row.observed_at)}</summary>${table(['Count', 'Value'], Object.entries(json(row.extensions_json).counts ?? {}).map(([k, v]) => [k, n(v)]))}</details>`)}` });
}

function sandboxPanel({ metrics, lifecycle }, points, win) {
  const sampled = metrics.sampled && !metrics.complete ? metrics.spans : null;
  const seriesOf = name => [...new Set(points.filter(row => row.name === name).map(row => row.attributes_json))].sort();
  const describe = attributes => { const a = json(attributes); return `${a.region ?? '?'} / ${a.sandbox_class ?? '?'}`; };
  const capacity = ['cpu', 'ram', 'storage', 'gpu'].flatMap(resource => seriesOf(`daytona.sandbox.used_${resource}`).map(attributes => {
    const used = gauge(points, `daytona.sandbox.used_${resource}`, attributes).at(-1)?.[1];
    const total = gauge(points, `daytona.sandbox.total_${resource}`, attributes).at(-1)?.[1];
    const share = used != null && total ? used / total : null;
    return [resource, describe(attributes), html`${n(used)} / ${n(total)} ${resource === 'cpu' ? 'cores' : resource === 'gpu' ? '' : 'GiB'}`,
      share == null ? 'Unknown' : html`<div class="track"><div class="fill" style="width:${Math.min(100, share * 100)}%"></div></div> ${n(share * 100)}%`];
  }));
  const cpuSeries = seriesOf('daytona.sandbox.used_cpu').map((attributes, i) => [describe(attributes), gauge(points, 'daytona.sandbox.used_cpu', attributes), COLORS[i % COLORS.length]]);
  const cpuMax = niceMax(Math.max(1, ...cpuSeries.flatMap(([, samples]) => samples.map(([, v]) => v ?? 0))));
  const legend = html` ${cpuSeries.map(([label, , color]) => html`<span class="key"><i style="background:${color}"></i>${label}</span>`)}`;
  const transitions = tally(lifecycle.rows, row => `${row.old_state} → ${row.new_state}`, row => row.count);
  return panel({ title: 'What are the sandboxes doing?', question: 'Daytona organization gauges and lifecycle transitions', reads: [['Metrics', metrics], ['Lifecycle', lifecycle]], win,
    body: html`<h3>Latest capacity</h3>${table(['Resource', 'Region / class', 'Used / total', 'Share'], capacity)}
      ${timeChart({ win, label: 'CPU in use', unit: 'cores', spans: sampled, max: cpuMax, legend, body: o => cpuSeries.map(([, samples, color]) => steps(samples, joinGap(points, 'daytona.sandbox.used_cpu', 1.5 * MIN), color, 'cores')(o)) })}
      <h3>State transitions</h3>${bars(transitions)}
      <p class="small">Region/class series stay separate, never summed. Transitions are fixed 15-minute counts, not a creation census, and acceptance buckets include synthetic traffic.</p>` });
}

function inboxPanel({ metrics }, points, win) {
  const totals = tally(points.filter(row => row.source === 'inboxes' && row.temporality === 'delta'),
    row => `${row.name}|${row.attributes_json}`, row => row.value ?? 0);
  const rows = Object.entries(totals).sort().map(([key, value]) => {
    const [name, attributes] = key.split('|'), a = json(attributes);
    return [name.replace('inbox.', ''), a.transport ?? '–', a.outcome ?? '–', name.endsWith('bytes') ? `${n(value / 1024)} KiB` : n(value)];
  });
  return panel({ title: 'Are inboxes receiving?', question: 'Inboxes 15-minute aggregates', reads: [['Metrics', metrics]], win,
    body: html`${rows.length ? table(['Measure', 'Transport', 'Outcome', 'Total in read spans'], rows) : html`<p>No Inboxes aggregates in this window.</p>`}
      <p class="small">Delta counts are additive within what was read. Export counters are completed generations, not client delivery. No addresses, inbox identifiers or content are collected.</p>` });
}

function inventoryPanel({ metrics, probes }, points, win) {
  const names = Object.entries(tally(points, row => row.name)).sort();
  return panel({ title: 'Raw inventory', question: 'For inspection, not interpretation', reads: [['Metrics', metrics]], win, wide: true,
    body: html`<details><summary>Metric names, series and samples</summary>${table(['Metric', 'Kind', 'Unit', 'Series', 'Samples', 'Latest sample'], names.map(([name, count]) => {
      const rows = points.filter(row => row.name === name);
      return [name, rows[0].kind, rows[0].unit, n(new Set(rows.map(row => `${row.source}|${row.attributes_json}`)).size), n(count), time(Math.max(...rows.map(row => row.observed_at)))];
    }))}</details>
    <details><summary>Recent probe phase breakdowns</summary>${table(['Observed', 'Layer', 'Result', 'Phases (ms)', 'Events (offset ms)'], probes.rows.slice(-15).reverse().map(row => [time(row.observed_at), row.layer, JSON.stringify(json(row.extensions_json)), JSON.stringify(json(row.phases_json)), JSON.stringify(json(row.events_json))]))}
    <p class="small">Event offsets are separate from additive phases.</p></details>` });
}

let expiryTimer;
function render(data) {
  const win = { from: data.from, to: data.to, readFrom: data.read_from ?? data.from };
  const empty = { rows: [], complete: false, error: 'Not read.' };
  const classes = Object.fromEntries(['browser', 'metrics', 'probes', 'deletions', 'lifecycle', 'status'].map(k => [k, data.classes[k] ?? empty]));
  // Overlapping reads can return a point twice; identity is content, not row id.
  const unique = new Map();
  for (const row of classes.metrics.rows) {
    const { id, batch_id, received_at, expires_at, point_index, ...point } = row;
    unique.set(JSON.stringify(point), row);
  }
  const points = [...unique.values()];
  $('#dashboard').innerHTML = html`${upPanel(classes, win)}${chatPanel(classes, points, win)}${arrivalPanel(classes, win)}${retentionPanel(classes, win)}${sandboxPanel(classes, points, win)}${inboxPanel(classes, points, win)}${inventoryPanel(classes, points, win)}`.text;
  bindArrivalTooltip(classes.browser, win);
  const unreadable = win.readFrom - win.from > DAY ? ` Telemetry is kept at most 90 days, so the oldest ${n((win.readFrom - win.from) / DAY)} days of this window hold nothing by design (hatched).` : '';
  $('#state').textContent = `${time(data.from)} – ${time(data.to)} · Live read, not a continuous monitor. Clears by ${time(data.expires_at)}.${unreadable}`;
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => { $('#dashboard').replaceChildren(); $('#state').textContent = 'Snapshot expired and cleared. Refresh for current retained data.'; }, Math.max(0, data.expires_at - Date.now()));
}

function bindArrivalTooltip(browser, win) {
  const tooltip = $('#arrival-breakdown');
  const buckets = Array.from({ length: 24 }, () => []);
  for (const row of browser.rows) buckets[Math.min(23, Math.floor((row.observed_at - win.from) / (win.to - win.from) * 24))].push(row);
  const breakdowns = buckets.map(rows => tally(rows, row => `${row.destination}/${row.network_location}`));
  // One scale for the whole timeline: a dark cell means the same count in every bucket.
  const cellMax = Math.max(1, ...breakdowns.flatMap(counts => Object.values(counts)));
  const partial = !browser.complete ? ', partial data' : '';
  const show = (column, x, y) => {
    const index = Number(column.dataset.bucket);
    const start = win.from + index * (win.to - win.from) / 24, end = win.from + (index + 1) * (win.to - win.from) / 24;
    tooltip.innerHTML = html`<strong>Arrival mix</strong><p class="small">${time(start)}<br>to ${time(end)}</p><div class="heatmap"><span></span><span>Campus</span><span>Other</span><span>Unknown</span>${SERVICES.map(service => html`<span class="heat-label">${service}</span>${NETWORKS.map(network => {
      const count = breakdowns[index][`${service}/${network}`] || 0;
      const strength = count ? .2 + .8 * Math.sqrt(count / cellMax) : 0;
      return html`<span class="heat-cell" style="background:rgba(32,100,64,${strength});color:${strength >= .65 ? '#fff' : '#183c32'}" aria-label="${service}, ${network}: ${count} observations${partial}">${n(count)}</span>`;
    })}`)}</div><p class="small heat-legend"><span class="heat-gradient"></span> Fewer → more</p><p class="small">Same shade scale across the timeline.${partial ? ' Partial data only.' : ''}</p>`.text;
    tooltip.hidden = false;
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(x + 16, innerWidth - bounds.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, y + 16 + bounds.height > innerHeight - 8 ? y - bounds.height - 12 : y + 16)}px`;
  };
  for (const column of document.querySelectorAll('[data-bucket]')) {
    column.addEventListener('pointermove', event => show(column, event.clientX, event.clientY));
    column.addEventListener('pointerdown', event => show(column, event.clientX, event.clientY));
    column.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') tooltip.hidden = true; });
    column.addEventListener('focus', () => { const rect = column.getBoundingClientRect(); show(column, rect.left, rect.top); });
    column.addEventListener('blur', () => { tooltip.hidden = true; });
    column.addEventListener('keydown', event => { if (event.key === 'Escape') tooltip.hidden = true; });
  }
  document.onpointerdown = event => { if (!event.target.closest('[data-bucket]')) tooltip.hidden = true; };
}

async function refresh(event) {
  event?.preventDefault();
  $('button').disabled = true;
  $('#dashboard').replaceChildren();
  clearTimeout(expiryTimer);
  $('#state').textContent = 'Reading retained data… Dense windows may take a moment.';
  try {
    const response = await fetch('/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours: Number($('#hours').value) }) });
    if (response.status === 429) throw new Error('A read is already running; try again in a moment.');
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.expires_at <= Date.now()) throw new Error();
    render(data);
  } catch (error) { $('#state').textContent = error.message || 'Read unavailable. Check the terminal and try a smaller time window.'; }
  finally { $('button').disabled = false; }
}
$('#controls').addEventListener('submit', refresh);
const events = new EventSource('/events');
events.onmessage = () => location.reload();
// A restarted server mints a new session cookie; reconnecting means this page's is stale.
let connected = false;
events.onopen = () => { if (connected) location.reload(); connected = true; };
window.addEventListener('pagehide', () => $('#dashboard').replaceChildren());
refresh();
