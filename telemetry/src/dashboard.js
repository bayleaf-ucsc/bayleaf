import integrations from '../integrations.json' with { type: 'json' };
import { DAY, retentionMs } from './policies.js';

const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

// Pure renderer; the optional record is a build-time/operator record, never request data.
// Read only public switches and bounded retention configuration, never D1 or credentials.
export function renderDashboard(env = {}, record = integrations) {
  const globalEnabled = env.TELEMETRY_ENABLED === 'true';
  const browserEnabled = env.BROWSER_ENABLED === 'true';
  const gate = kind => !globalEnabled ? 'Blocked: global ingestion disabled'
    : kind === 'browser' && !browserEnabled ? 'Blocked: browser ingestion disabled'
      : 'Open by receiver switches';
  const rows = record.sources.map(source => `<tr>
<th scope="row">${escape(source.name)}</th>
<td>${source.enabled === true ? 'Enabled (recorded)' : 'Disabled (recorded)'}</td>
<td>${escape(source.verification)}</td><td>${gate(source.kind)}</td></tr>`).join('');
  const retention = ['browser', 'metrics', 'probes', 'deletions'].map(kind => {
    let configured;
    try { configured = `${retentionMs(env, kind) / DAY} days`; }
    catch { configured = 'Invalid configuration (allowed: 1–90 days)'; }
    return `<li>${escape(kind)}: ${configured}</li>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BayLeaf collector status</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1000px; margin: 0 auto; padding: 2rem; line-height: 1.6; color: #333; background: #fff; }
h1 { color: #1a1a1a; } h2, a { color: #2a5298; }
h2 { margin-top: 2rem; } a:focus-visible { outline: 3px solid #2a5298; outline-offset: 3px; }
.note { background: #f8f9fa; padding: 1rem 1.25rem; color: #444; }
.table-scroll { overflow-x: auto; } .table-scroll:focus-visible { outline: 3px solid #2a5298; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: .65rem; border-bottom: 1px solid #eee; } thead { background: #f8f9fa; }
th { font-weight: 600; } footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #eee; }
@media (max-width: 600px) { body { padding: 1rem; } th, td { padding: .5rem; } }
</style></head><body><main>
<h1>BayLeaf collector status</h1>
<p>Integration and configuration only. No telemetry records, user counts, or last-seen activity are published here.</p>
<h2>Receiver configuration</h2>
<p><strong>Global ingestion: ${globalEnabled ? 'Enabled' : 'Disabled'}</strong><br>
Browser switch: ${browserEnabled ? 'Enabled' : 'Disabled'}<br>
Browser admission: ${gate('browser')}<br>Service admission: ${gate('metrics')}</p>
<p>These values reflect this receiver’s current deployment configuration (<code>TELEMETRY_ENABLED</code> and <code>BROWSER_ENABLED</code>). An open gate does not establish source activation, successful authentication, or receiver health.</p>
<h2>Source integrations</h2>
<p class="note">Operator record dated <strong>${escape(record.recordedOn)}</strong>, not live health. Source switches are recorded separately from receiver admission: this collector cannot remotely inspect source switches. A recorded enabled source cannot ingest while its receiver gate is blocked.</p>
<div class="table-scroll" role="region" aria-label="Source integration status" tabindex="0"><table>
<caption>Recorded source switches and verification, alongside current receiver gates</caption>
<thead><tr><th scope="col">Source</th><th scope="col">Source switch (recorded)</th><th scope="col">Verification (recorded)</th><th scope="col">Receiver gate (current configuration)</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<h2>Configured retention</h2>
<p>Approved production setting: 90 days for each class. Current receiver configuration:</p><ul>${retention}</ul>
<p>Configuration is not a measurement of stored data. A previously lowered durable retention ceiling can be stricter. Purge delays and provider backups can extend recoverability beyond the configured period.</p>
</main><footer><a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/PRIVACY.md">Privacy notice</a> · <a href="https://status.bayleaf.dev">Service availability</a></footer></body></html>`;
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
