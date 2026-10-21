import integrations from '../integrations.json' with { type: 'json' };
import { DAY, retentionMs } from './policies.js';

const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

// One group per retention class, so each receiver gate and retention value is stated once.
const CLASSES = [
  ['browser', 'Browser arrivals'], ['metrics', 'Service metrics'],
  ['probes', 'Synthetic probes'], ['deletions', 'Deletion reports'],
  ['lifecycle', 'Sandbox lifecycle'],
];

// Pure renderer; the optional record is a build-time/operator record, never request data.
// Read only public switches and bounded retention configuration, never D1 or credentials.
export function renderDashboard(env = {}, record = integrations) {
  const globalEnabled = env.TELEMETRY_ENABLED === 'true';
  const browserEnabled = env.BROWSER_ENABLED === 'true';
  const gate = kind => !globalEnabled ? '<span class="closed">Receiver closed</span>'
    : kind === 'browser' && !browserEnabled ? '<span class="closed">Receiver closed: browser switch off</span>'
      : kind === 'lifecycle' && env.DAYTONA_WEBHOOKS_ENABLED !== 'true'
        ? '<span class="closed">Receiver closed: Daytona webhook switch off</span>'
      : '<span class="open">Receiver open</span>';
  const retention = kind => {
    try { return `Kept ${retentionMs(env, kind) / DAY} days`; }
    catch { return '<span class="closed">Retention misconfigured (must be 1–90 days)</span>'; }
  };
  const groups = CLASSES.map(([kind, label]) => {
    const rows = record.sources.filter(source => source.kind === kind).map(source => `<li>
<span class="name">${escape(source.name)}</span>
<span class="detail">${source.enabled === true ? '' : '<strong>Not enabled.</strong> '}${source.receiver === 'daytona-otlp' && env.DAYTONA_OTLP_ENABLED !== 'true' ? '<strong>Receiver closed: Daytona OTLP switch off.</strong> ' : ''}${escape(source.verification)}</span></li>`).join('');
    return `<section class="group" aria-labelledby="class-${kind}">
<h3 id="class-${kind}">${label}</h3>
<p class="meta">${gate(kind)} · ${retention(kind)}</p>
${rows ? `<ul class="sources">${rows}</ul>` : '<p class="detail">No sources recorded.</p>'}</section>`;
  }).join('\n');
  // An open gate is only a capability, so say so whenever anything is open.
  const caveat = '<p class="aside">An open receiver accepts valid submissions; it does not show that any source is sending.</p>';
  const summary = !globalEnabled
    ? '<p class="state closed">Ingestion is off.</p><p>The kill switch is engaged. This collector is rejecting all telemetry.</p>'
    : !browserEnabled
      ? `<p class="state open">Ingestion is on for services.</p><p>Browser arrivals are switched off and rejected.</p>${caveat}`
      : `<p class="state open">Ingestion is on.</p>${caveat}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BayLeaf telemetry collector</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.6; color: #333; background: #fff; }
h1 { color: #1a1a1a; margin-bottom: .25rem; } h2 { color: #2a5298; margin: 2.25rem 0 .25rem; }
h3 { color: #1a1a1a; font-size: 1rem; margin: 0; } a { color: #2a5298; }
a:focus-visible { outline: 3px solid #2a5298; outline-offset: 3px; }
.tagline { color: #555; margin-top: 0; }
.state { font-size: 1.25rem; font-weight: 600; margin: 1.5rem 0 0; } .state + p { margin-top: .25rem; }
.open { color: #1e5a3a; } .closed { color: #8a1c1c; }
.aside, .detail, footer { color: #555; font-size: .9rem; }
.meta { margin: 0 0 .4rem; color: #555; font-variant-caps: all-small-caps; letter-spacing: .04em; font-size: .95rem; }
.meta span { font-weight: 600; }
.group { border-top: 1px solid #eee; padding: 1rem 0 .5rem; }
.sources { list-style: none; margin: 0; padding: 0; }
.sources li { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0 1rem; margin: .2rem 0; }
.sources .detail { text-align: right; }
footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #eee; }
footer p { margin: 0 0 .75rem; }
@media (max-width: 600px) { body { padding: 1rem; } h1 { font-size: 1.6rem; line-height: 1.25; } .sources li { display: block; margin-bottom: .6rem; line-height: 1.4; } .sources .detail { display: block; text-align: left; } }
</style></head><body><main>
<h1>BayLeaf telemetry collector</h1>
<p class="tagline">How this collector is configured. It never shows collected records, counts, or activity.</p>
${summary}
<h2>Sources</h2>
<p class="aside">Checked by the operator on <strong>${escape(record.recordedOn)}</strong>. The collector cannot see source-side switches, so this is a dated record, not live health.</p>
${groups}
</main><footer>
<p>Retention is the configured maximum. A lower limit set earlier stays in force, and purge delays or provider backups can keep deleted data recoverable for longer.</p>
<a href="/docs">API reference</a> · <a href="/docs/openapi.json">OpenAPI</a> · <a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/PRIVACY.md">Privacy notice</a> · <a href="https://status.bayleaf.dev">Service availability</a></footer></body></html>`;
}

// Route GET/HEAD / here BEFORE the ingestion kill switch. No database binding is needed.
export function dashboard(request, env = {}) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null,
    { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  return new Response(request.method === 'HEAD' ? null : renderDashboard(env), { headers });
}
