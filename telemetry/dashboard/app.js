const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? 'Unknown').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const n = value => value == null ? 'Unknown' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
const time = value => new Date(value).toLocaleString();
const json = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const group = (rows, key) => rows.reduce((out, row) => { const label = key(row); out[label] = (out[label] || 0) + 1; return out; }, {});
const cards = items => `<div class="cards">${items.map(([label, value]) => `<div class="stat"><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`).join('')}</div>`;
const bars = values => {
  const sorted = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...sorted.map(([, value]) => value));
  return sorted.length ? `<div class="bars">${sorted.slice(0, 12).map(([label, value]) => `<div class="barrow"><span>${escape(label)}</span><div class="track"><div class="fill" style="width:${value / max * 100}%"></div></div><span>${n(value)}</span></div>`).join('')}</div>` : '<p>No observations in this window.</p>';
};
const table = (heads, rows) => `<div class="scroll"><table><thead><tr>${heads.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const coverage = data => data.error ? `<p class="warning">${escape(data.error)}</p>` : !data.complete ? '<p class="warning">Partial coverage: read budget or same-millisecond row cap reached. Counts below are lower bounds, not totals.</p>' : '';
const section = (title, data, body, wide = false) => `<section class="${wide ? 'wide' : ''}"><h2>${title}</h2>${coverage(data)}${body}<p class="small">${n(data.rows.length)} retained rows read${data.queries ? ` · ${data.queries} bounded queries` : ''}</p></section>`;
let expiryTimer;

function userTrend(points, name, label, from, to) {
  const samples = new Map();
  for (const row of points.filter(row => row.name === name)) {
    const existing = samples.get(row.observed_at);
    samples.set(row.observed_at, existing === undefined ? row.value : existing === row.value ? existing : null);
  }
  const ordered = [...samples].sort((a, b) => a[0] - b[0]);
  const values = ordered.filter(([, value]) => value != null);
  if (!values.length) return `<div class="user-trend"><h3>${escape(label)}</h3><p>No unambiguous samples in this window.</p></div>`;
  const maximum = Math.max(2, Math.ceil(Math.max(...values.map(([, value]) => value)) / 2) * 2);
  const x = timestamp => 44 + (timestamp - from) / (to - from) * 492;
  const y = value => 110 - value / maximum * 90;
  let previous = null;
  const segments = [], circles = [];
  for (const [timestamp, value] of ordered) {
    if (value == null) { previous = null; continue; }
    // Native exports are five minutes apart. Do not connect across missed exports.
    if (previous && timestamp - previous[0] <= 7.5 * 60_000) {
      segments.push(`<path d="M ${x(previous[0])} ${y(previous[1])} H ${x(timestamp)} V ${y(value)}"/>`);
    }
    circles.push(`<circle cx="${x(timestamp)}" cy="${y(value)}" r="3" tabindex="0" aria-label="${escape(time(timestamp))}: ${n(value)} users"><title>${escape(time(timestamp))}: ${n(value)} users</title></circle>`);
    previous = [timestamp, value];
  }
  const shortTime = timestamp => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<div class="user-trend"><h3>${escape(label)} <span class="small">users</span></h3><svg viewBox="0 0 550 146" role="group" aria-label="${escape(label)} over time, zero to ${n(maximum)} users"><g class="trend-grid"><path d="M44 20 H536 M44 65 H536 M44 110 H536"/></g><g class="trend-label"><text x="36" y="24" text-anchor="end">${n(maximum)}</text><text x="36" y="69" text-anchor="end">${n(maximum / 2)}</text><text x="36" y="114" text-anchor="end">0</text><text x="44" y="135">${escape(shortTime(from))}</text><text x="290" y="135" text-anchor="middle">${escape(shortTime((from + to) / 2))}</text><text x="536" y="135" text-anchor="end">${escape(shortTime(to))}</text></g><g class="trend-line">${segments.join('')}</g><g class="trend-points">${circles.join('')}</g></svg></div>`;
}

function render(data) {
  const { browser, metrics, probes, deletions, status } = data.classes;
  const arrivals = browser.rows;
  const buckets = Array.from({ length: 24 }, () => []);
  for (const row of arrivals) buckets[Math.min(23, Math.floor((row.observed_at - data.from) / (data.to - data.from) * 24))].push(row);
  const max = Math.max(1, ...buckets.map(rows => rows.length));
  const chart = `<div class="chart" role="group" aria-label="Arrival timeline. Focus or hover over a time bucket for its service and network breakdown.">${buckets.map((rows, i) => `<div class="column" tabindex="0" data-bucket="${i}" style="--bar-height:${rows.length / max * 100}%" aria-label="${escape(time(data.from + i * (data.to - data.from) / 24))}: ${rows.length} observations" aria-describedby="arrival-breakdown"></div>`).join('')}</div><div id="arrival-breakdown" class="arrival-tooltip" role="tooltip" hidden></div>`;
  const unique = new Map();
  for (const row of metrics.rows) {
    const { id, batch_id, received_at, expires_at, point_index, ...point } = row;
    unique.set(JSON.stringify(point), row);
  }
  const points = [...unique.values()];
  const userCharts = [['webui.users.total', 'Total users'], ['webui.users.active', 'Active users'], ['webui.users.active.today', 'Active today']]
    .map(([name, label]) => userTrend(points, name, label, data.from, data.to)).join('');
  const gauges = ['webui.users.total', 'webui.users.active', 'webui.users.active.today'].map(name => {
    const samples = points.filter(row => row.name === name).sort((a, b) => b.observed_at - a.observed_at);
    const latest = samples[0];
    const conflicts = latest && samples.filter(row => row.observed_at === latest.observed_at).some(row => row.value !== latest.value);
    return [name.replace('webui.users.', '').replaceAll('.', ' '), conflicts ? 'Conflicting' : n(latest?.value)];
  });
  const probeGroups = Object.entries(group(probes.rows, row => row.layer));
  const probeTable = probeGroups.map(([layer, count]) => {
    const rows = probes.rows.filter(row => row.layer === layer);
    const sorted = rows.map(row => row.duration_ms).sort((a, b) => a - b);
    const latest = rows.reduce((a, b) => a.observed_at > b.observed_at ? a : b);
    return [layer, count, `${rows.filter(row => row.outcome === 'success').length}/${count}`, `${n(sorted[Math.floor(sorted.length / 2)] / 1000)} s`, latest.outcome, time(latest.observed_at)];
  });
  $('#dashboard').innerHTML =
    section('Public arrivals', browser, cards([['Arrival observations', n(arrivals.length)], ['Services observed', n(new Set(arrivals.map(row => row.destination)).size)]]) + chart + '<h3>By service</h3>' + bars(group(arrivals, row => row.destination)) + '<h3>Network location, not affiliation</h3>' + bars(group(arrivals, row => row.network_location)) + '<h3>Referring hostnames</h3>' + bars(group(arrivals, row => row.referring_hostname ?? 'Unknown (not necessarily direct)')) + '<p class="small">Observations are not unique visitors. No deduplication or visitor identity.</p>') +
    section('Chat metrics', metrics, cards(gauges) + '<p class="small">Latest global user snapshots in the selected window, never summed. “Active” follows the native OWUI definition, not concurrent generation.</p>' + userCharts + '<p class="small">Separate vertical scales, each starting at zero. Dots are observed snapshots; steps connect adjacent exports only. Hover or focus a dot for its time and value. Missing/conflicting samples are gaps, not zeros.</p><details><summary>Metric samples and recent HTTP measurements</summary>' + table(['Metric', 'Kind', 'Samples', 'Latest sample'], Object.entries(group(points, row => row.name)).map(([name, count]) => [name, points.find(row => row.name === name).kind, count, time(Math.max(...points.filter(row => row.name === name).map(row => row.observed_at)))])) + '<p class="small">Raw preserved windows, not additive traffic totals. Cumulative samples overlap. HTTP duration is not completed-SSE latency.</p>' + table(['Observed', 'Route', 'Kind / window', 'Value / count', 'Mean duration'], points.filter(row => row.name.startsWith('http.')).sort((a, b) => b.observed_at - a.observed_at).slice(0, 25).map(row => [time(row.observed_at), json(row.attributes_json).route, `${row.kind} / ${row.temporality}`, n(row.value ?? row.count), row.kind === 'histogram' && row.count && row.sum != null ? `${n(row.sum / row.count)} ms` : 'Unknown'])) + '</details>') +
    section('Synthetic probes', probes, table(['Layer', 'Runs', 'Successful', 'Median duration', 'Latest outcome', 'Latest observation'], probeTable) + '<details><summary>Recent phase breakdowns and results</summary>' + table(['Observed', 'Layer', 'Result', 'Phases (ms)', 'Events (offset ms)'], probes.rows.slice(-15).reverse().map(row => [time(row.observed_at), row.layer, JSON.stringify(json(row.extensions_json)), JSON.stringify(json(row.phases_json)), JSON.stringify(json(row.events_json))])) + '</details><p class="small">Synthetic samples, not user requests or an availability SLA. Event offsets are separate from additive phases.</p>', true) +
    section('Deletion jobs', deletions, deletions.rows.length ? table(['Observed', 'Source / job', 'Outcome', 'Confirmed deleted', 'Report'], deletions.rows.slice(-30).reverse().map(row => [time(row.observed_at), `${row.source} / ${row.job}`, row.outcome, n(row.deleted), JSON.stringify(json(row.extensions_json))])) : '<p>No retained reports in this window. Scheduled execution may not have occurred yet; this is not zero deletions.</p>') +
    section('Source observations', status, table(['Source', 'Class', 'Last accepted', 'Age at read'], status.rows.map(row => [row.source, row.class, time(row.observed_at), `${n((data.to - row.observed_at) / 60000)} min`])) + '<p class="small">Latest accepted observation within the selected window, not a liveness check. Missing sources remain unknown. Browser arrivals do not create source-status rows.</p>');
  const tooltip = $('#arrival-breakdown');
  const networks = ['campus-network', 'other-network', 'unknown'];
  const services = ['landing', 'chat', 'api', 'sandbox', 'proxies', 'inboxes'];
  const breakdowns = buckets.map(rows => group(rows, row => `${row.destination}/${row.network_location}`));
  // One scale for the whole timeline: a dark cell means the same count in every bucket.
  const cellMax = Math.max(1, ...breakdowns.flatMap(counts => Object.values(counts)));
  const showBreakdown = (column, x, y) => {
    const index = Number(column.dataset.bucket);
    const start = data.from + index * (data.to - data.from) / 24;
    const end = data.from + (index + 1) * (data.to - data.from) / 24;
    tooltip.innerHTML = `<strong>Arrival mix</strong><p class="small">${escape(time(start))}<br>to ${escape(time(end))}</p><div class="heatmap"><span></span><span>Campus</span><span>Other</span><span>Unknown</span>${services.map(service => `<span class="heat-label">${service}</span>${networks.map(network => {
      const count = breakdowns[index][`${service}/${network}`] || 0;
      const strength = count ? .2 + .8 * Math.sqrt(count / cellMax) : 0;
      return `<span class="heat-cell" style="background:rgba(32,100,64,${strength});color:${strength >= .65 ? '#fff' : '#183c32'}" aria-label="${service}, ${network}: ${count} observations${!browser.complete ? ', partial data' : ''}">${n(count)}</span>`;
    }).join('')}`).join('')}</div><p class="small heat-legend"><span class="heat-gradient"></span> Fewer → more</p><p class="small">Same shade scale across the timeline.${!browser.complete ? ' Partial data only.' : ''}</p>`;
    tooltip.hidden = false;
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(x + 16, innerWidth - bounds.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, y + 16 + bounds.height > innerHeight - 8 ? y - bounds.height - 12 : y + 16)}px`;
  };
  for (const column of document.querySelectorAll('[data-bucket]')) {
    column.addEventListener('pointermove', event => showBreakdown(column, event.clientX, event.clientY));
    column.addEventListener('pointerdown', event => showBreakdown(column, event.clientX, event.clientY));
    column.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') tooltip.hidden = true; });
    column.addEventListener('focus', () => { const rect = column.getBoundingClientRect(); showBreakdown(column, rect.left, rect.top); });
    column.addEventListener('blur', () => { tooltip.hidden = true; });
    column.addEventListener('keydown', event => { if (event.key === 'Escape') tooltip.hidden = true; });
  }
  document.onpointerdown = event => { if (!event.target.closest('[data-bucket]')) tooltip.hidden = true; };
  $('#state').textContent = `${time(data.from)} – ${time(data.to)} · Live read, not a continuous monitor. Clears by ${time(data.expires_at)}.`;
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => { $('#dashboard').replaceChildren(); $('#state').textContent = 'Snapshot expired and cleared. Refresh for current retained data.'; }, Math.max(0, data.expires_at - Date.now()));
}

async function refresh(event) {
  event?.preventDefault();
  $('button').disabled = true;
  $('#dashboard').replaceChildren();
  clearTimeout(expiryTimer);
  $('#state').textContent = 'Reading retained data… Dense windows may take a moment.';
  try {
    const response = await fetch('/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours: Number($('#hours').value) }) });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.expires_at <= Date.now()) throw new Error();
    render(data);
  } catch { $('#state').textContent = 'Read unavailable. Check the terminal and try a smaller time window.'; }
  finally { $('button').disabled = false; }
}
$('#controls').addEventListener('submit', refresh);
new EventSource('/events').onmessage = () => location.reload();
window.addEventListener('pagehide', () => $('#dashboard').replaceChildren());
refresh();
