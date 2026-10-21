/** Small diagnostic surfaces, not another application or account system. */
import { arrivalScript } from '../../../telemetry/browser/runtime';

type Kind = 'proxies' | 'inboxes';
export type Tone = 'ok' | 'warn' | 'off' | 'info';

export const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!));
export const diagnosticPath = (kind: Kind) => `/diagnostics/${kind}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
/** Absolute UTC time, short enough for a table cell. */
export const clock = (seconds: number): string => {
  const d = new Date(seconds * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};
/** Relative to the snapshot time; the page never updates itself. */
export const relative = (seconds: number, now: number): string => {
  const delta = seconds - now, span = Math.abs(delta);
  if (span < 60) return delta > 0 ? 'in under a minute' : 'just now';
  const [n, unit] = span < 3600 ? [Math.round(span / 60), 'min'] : span < 172800 ? [Math.round(span / 3600), 'h'] : [Math.round(span / 86400), 'd'];
  return delta >= 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
};
/** Relative label with the exact moment kept machine-readable and visible on hover. */
export const when = (seconds: number, now: number): string =>
  `<time datetime="${new Date(seconds * 1000).toISOString()}" title="${new Date(seconds * 1000).toISOString()}">${relative(seconds, now)}</time>`;
export const bytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = n / 1024, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[i]}`;
};
export const count = (n: number): string => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
export const pill = (tone: Tone, label: string): string => `<span class="pill" data-tone="${tone}">${escape(label)}</span>`;
/** A labelled usage bar; the text carries the meaning, the bar is decoration. */
export const meter = (label: string, used: string, limit: string, fraction: number): string => {
  const pct = Math.max(0, Math.min(100, Math.round((Number.isFinite(fraction) ? fraction : 0) * 100)));
  return `<div class="meter"><div class="meter-label"><span>${escape(label)}</span><span>${used} <span class="muted">of ${limit}</span></span></div><div class="bar${pct >= 90 ? ' high' : ''}" aria-hidden="true"><span style="width:${pct}%"></span></div></div>`;
};

export function diagnosticHeaders(arrivals = false): Headers {
  return new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src ${arrivals ? "'unsafe-inline'" : "'none'"}; connect-src ${arrivals ? 'https://telemetry.bayleaf.dev' : "'none'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
}

const STYLE = `
:root{--bg:#f6f8f4;--card:#fff;--ink:#24352b;--muted:#48594e;--line:#d3e2d7;--line-strong:#b7cebe;--brand:#1e5a3a;--brand-dark:#16432b;--soft:#eaf2ec;--focus:#2a5298;--warn-bg:#fbf3e2;--warn-ink:#6a4710;--warn-dot:#b5651d;--off-dot:#8a998f;--info-dot:#2a5298;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:1rem/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
main{max-width:720px;margin:auto;padding:1rem 1.25rem 2.5rem}
a{color:var(--brand);text-underline-offset:.2em}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:4px}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem;padding:.25rem 0 1rem;border-bottom:1px solid var(--line);font-size:.875rem}
.brand{display:inline-flex;align-items:center;gap:.45rem;color:var(--ink);text-decoration:none;font-weight:650}
.brand svg{flex:none}
.brand .sep{color:var(--line-strong);font-weight:400}
.brand .svc{font-weight:500;color:var(--muted)}
.top nav{display:flex;flex-wrap:wrap;gap:.25rem 1rem;align-items:center;color:var(--muted)}
.top nav a{color:var(--muted)}
.top nav a:hover{color:var(--brand)}
header.page{margin:1.75rem 0 1.25rem}
h1{font-size:clamp(1.45rem,4.5vw,1.85rem);line-height:1.2;letter-spacing:-.02em;margin:0 0 .4rem;font-weight:700}
h1 .pill{vertical-align:.3em;margin-left:.4rem}
h2{font-size:1rem;line-height:1.3;margin:0}
h3{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:1.1rem 0 .4rem}
p{margin:0 0 .75rem}
.lede{color:var(--muted);font-size:1.05rem;max-width:60ch;margin:0}
.muted{color:var(--muted)}
.small{font-size:.875rem}
.banner{display:flex;gap:.6rem;align-items:flex-start;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:.75rem .9rem;margin:0 0 1rem;font-size:.925rem}
.banner[data-tone=warn]{background:var(--warn-bg);border-color:#ecd9b0;color:var(--warn-ink)}
.banner p{margin:0}
.banner strong{display:block}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:.75rem;margin:0 0 1.25rem;padding:0;list-style:none}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.85rem 1rem}
.tile h2{margin-bottom:.25rem}
.tile p{margin:0;color:var(--muted);font-size:.925rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;margin:0 0 1rem;overflow-wrap:anywhere}
.card-head{display:flex;flex-wrap:wrap;gap:.4rem .6rem;align-items:center;justify-content:space-between;margin-bottom:.6rem}
.card-head .pills{display:flex;flex-wrap:wrap;gap:.35rem}
.actions{display:flex;flex-wrap:wrap;gap:.75rem 1.25rem;align-items:center;margin:1.25rem 0}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:.6rem 1.1rem;border-radius:8px;background:var(--brand);color:#fff;font-weight:600;text-decoration:none}
.button:hover{background:var(--brand-dark)}
.pill{display:inline-flex;align-items:center;gap:.35rem;padding:.1rem .55rem;border-radius:999px;font-size:.78rem;font-weight:600;line-height:1.5;white-space:nowrap;background:var(--soft);color:var(--brand-dark)}
.pill::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:var(--brand)}
.pill[data-tone=warn]{background:var(--warn-bg);color:var(--warn-ink)}
.pill[data-tone=warn]::before{background:var(--warn-dot)}
.pill[data-tone=off]{background:#eef0ee;color:var(--muted)}
.pill[data-tone=off]::before{background:var(--off-dot)}
.pill[data-tone=info]{background:#e9eef8;color:#1f3d73}
.pill[data-tone=info]::before{background:var(--info-dot)}
.snapshot{display:flex;flex-wrap:wrap;gap:.25rem 1rem;align-items:baseline;justify-content:space-between;margin:0 0 .75rem;font-size:.875rem;color:var(--muted)}
.stats{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;margin:0;padding:0;list-style:none;color:var(--ink)}
.stats b{font-variant-numeric:tabular-nums}
.rows{list-style:none;margin:0 0 1rem;padding:0;background:var(--card);border:1px solid var(--line);border-radius:12px}
.rows li{display:grid;grid-template-columns:1fr auto;gap:.35rem 1rem;align-items:center;padding:.8rem 1rem;border-top:1px solid var(--line)}
.rows li:first-child{border-top:0}
.rows .host{font-family:var(--mono);font-size:.875rem;overflow-wrap:anywhere;word-break:break-all}
.rows .meta{grid-column:1;display:flex;flex-wrap:wrap;gap:.25rem .75rem;align-items:center;font-size:.85rem;color:var(--muted)}
.rows .go{grid-column:2;grid-row:1 / span 2;font-weight:600;white-space:nowrap}
.rows li[data-state=off] .host{color:var(--muted)}
.addr{display:block;font-family:var(--mono);font-size:.85rem;background:var(--soft);border-radius:8px;padding:.55rem .7rem;word-break:break-all;user-select:all;-webkit-user-select:all}
.hint{font-size:.8rem;color:var(--muted);margin:.35rem 0 0}
.meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.6rem 1.25rem;margin-top:1rem}
.meter-label{display:flex;justify-content:space-between;gap:.5rem;font-size:.85rem;margin-bottom:.3rem;font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:999px;background:var(--soft);overflow:hidden}
.bar span{display:block;height:100%;min-width:2px;background:var(--brand);border-radius:inherit}
.bar.high span{background:var(--warn-dot)}
table{width:100%;border-collapse:collapse;font-size:.875rem;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:600;color:var(--muted);font-size:.78rem;padding:.3rem .5rem .3rem 0;border-bottom:1px solid var(--line)}
td{padding:.45rem .5rem .45rem 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
th:last-child,td:last-child{text-align:right;padding-right:0}
td small{display:block;color:var(--muted);font-size:.75rem}
.empty{background:var(--card);border:1px dashed var(--line-strong);border-radius:12px;padding:1.25rem;text-align:center;color:var(--muted);margin:0 0 1rem}
.empty p{margin:0}
.empty p+p{margin-top:.4rem}
details{margin:1rem 0;border-top:1px solid var(--line);padding-top:.5rem}
summary{cursor:pointer;color:var(--brand);font-weight:600;font-size:.925rem;padding:.35rem 0;min-height:44px;display:flex;align-items:center}
details ul{margin:.25rem 0 .5rem;padding-left:1.15rem;color:var(--muted);font-size:.9rem}
details li{margin:.3rem 0}
footer{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.85rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:.25rem 1rem}
footer a{color:var(--muted)}
time{font-variant-numeric:tabular-nums}
@media (max-width:480px){main{padding:.75rem 1rem 2rem}.rows li{grid-template-columns:1fr}.rows .go{grid-column:1;grid-row:auto}.card{padding:.9rem}}
`;

const LEAF = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5C11 3.6 4.4 8.4 4.4 15.2c0 1.5.4 2.9 1 4L3.5 21l1.3 1 1.8-1.9c1.2.8 2.7 1.3 4.3 1.3 6.6 0 10.2-7 9.6-17.9Z" fill="#1e5a3a"/><path d="M6.6 20.1C9 15.6 12 12 16 9" stroke="#eaf2ec" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>';

export interface PageOptions {
  /** Service named beside the BayLeaf mark. */
  service?: 'Proxies' | 'Inboxes';
  lede?: string;
  /** Trusted HTML placed beside the title, such as a status pill. */
  badge?: string;
  /** Signed-in owner email; adds the account line. */
  account?: string;
  arrival?: Kind;
}

export function diagnosticPage(title: string, body: string, options: PageOptions = {}): string {
  const { service, lede, badge, account, arrival } = options;
  const nav = account
    ? `<nav aria-label="Account"><span>${escape(account)}</span><a href="/logout">Sign out</a></nav>`
    : '<nav aria-label="BayLeaf"><a href="https://sandbox.bayleaf.dev/">Sandboxes</a><a href="https://api.bayleaf.dev/llms.txt">Agent guide</a></nav>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(title.startsWith('BayLeaf') ? title : `${title} · BayLeaf${service ? ' ' + service : ''}`)}</title><style>${STYLE}</style></head><body><main><div class="top"><a class="brand" href="https://bayleaf.dev/">${LEAF}<span>BayLeaf</span>${service ? `<span class="sep" aria-hidden="true">/</span><span class="svc">${service}</span>` : ''}</a>${nav}</div><header class="page"><h1>${escape(title)}${badge ?? ''}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</header>${body}<footer><a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/PRIVACY.md">Privacy and retention</a><a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/SUPPORT.md">Get help</a></footer></main>${arrival ? `<script>${arrivalScript(arrival)}</script>` : ''}</body></html>`;
}

const tiles = (items: [string, string][]) =>
  `<ul class="tiles">${items.map(([h, p]) => `<li class="tile"><h2>${h}</h2><p>${p}</p></li>`).join('')}</ul>`;
const noWake = '<li>Diagnostics and their sign-in never create, wake or probe a sandbox. Sandboxes has its own setup and resume controls.</li>';

export function publicDiagnosticPage(kind: Kind, enabled: boolean, arrivals: boolean, unavailable = false): string {
  const owner = `https://api.bayleaf.dev${diagnosticPath(kind)}`;
  const off = enabled ? '' : `<div class="banner" data-tone="warn" role="status"><p><strong>${kind === 'proxies' ? 'The preview gateway' : 'Reception'} is switched off on this deployment.</strong>Existing links and addresses will not respond until it is re-enabled.</p></div>`;
  const arrival = arrivals ? kind : undefined;
  if (kind === 'proxies' && unavailable) {
    return diagnosticPage('This preview link is not available', `${off}${tiles([
      ['Someone shared it with you', 'Ask them for a fresh link. Links expire on their own, even while the app keeps running.'],
      ['It is your preview', 'Check which of your links are still valid, or ask your agent to expose the app again.'],
    ])}<div class="actions"><a class="button" href="${owner}">Check your previews</a><a href="https://sandbox.bayleaf.dev/">Open Sandboxes</a></div>`,
    { service: 'Proxies', arrival, lede: 'It may be mistyped, expired or revoked. Every case shows this same page, so nothing about the owner or app is revealed.' });
  }
  if (kind === 'proxies') {
    return diagnosticPage('BayLeaf Proxies', `${off}${tiles([
      ['Public links', 'Anyone with the full link can open the app.'],
      ['Private links', 'Only the owner can open it, after BayLeaf sign-in. Other accounts are refused.'],
      ['Expiry', 'Links lapse independently of the app. Ask whoever shared one for a fresh link.'],
    ])}<div class="actions"><a class="button" href="${owner}">Check your previews</a><a href="https://sandbox.bayleaf.dev/">Manage apps in Sandboxes</a></div><details><summary>What the owner view shows</summary><ul><li>Each of your retained links with its access mode and expiry. It reports gateway permission, not whether the app is running.</li><li>Expired links disappear after hourly cleanup; revoked links are never listed.</li>${noWake}</ul></details>`,
    { service: 'Proxies', arrival, lede: 'Temporary links to web apps running in BayLeaf sandboxes. Open the full link your agent gave you: this address on its own leads nowhere.' });
  }
  return diagnosticPage('BayLeaf Inboxes', `${off}<div class="banner" data-tone="warn"><p><strong>Messages are stored for up to 90 days.</strong>This is not zero-data-retention: the operator can technically read stored content, and provider recovery copies can outlast deletion. Treat everything received as untrusted.</p></div>${tiles([
    ['Webhook URLs', 'Accept deliveries over HTTP, optionally restricted by credential. Opening one in a browser also counts as a delivery.'],
    ['Email addresses', 'Accept mail from any sender. Sender authentication is not available yet.'],
    ['Passive by design', 'Receiving never wakes an agent, runs a model or sends a reply.'],
  ])}<div class="actions"><a class="button" href="${owner}">Check your inboxes</a><a href="https://api.bayleaf.dev/llms.txt#inboxes-receive-email-and-webhooks-while-you-are-away">Create one with your agent</a></div><details><summary>What the owner view shows</summary><ul><li>Each inbox's address, reception mode, storage and daily quota.</li><li>Times and sizes of the most recent receipts. Never bodies, subjects, senders, paths, headers or credentials.</li>${noWake}</ul></details>`,
  { service: 'Inboxes', arrival, badge: pill('info', 'Operator pilot'),
    lede: 'Email addresses and webhook URLs that collect messages while your clients, sandbox and agents are offline.' });
}
