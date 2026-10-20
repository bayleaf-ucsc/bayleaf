import { openapi } from './openapi.js';

// Same plain Scalar CDN shell as api/src/routes/docs.ts. Unlike the API's
// floating CDN URL, pin this new surface. No runtime package dependency.
export const SCALAR_URL = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.75.1/dist/browser/standalone.js';
export const DOCS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BayLeaf telemetry API reference</title></head><body>
<nav aria-label="Documentation links"><a href="/">Collector status</a> · <a href="/docs/openapi.json">Raw OpenAPI (no external script)</a></nav>
<p>This reference loads a pinned Scalar renderer from jsDelivr. The CDN sees the script request, not telemetry records. Interactive requests are disabled. Do not enter credentials here.</p>
<script id="api-reference" data-url="/docs/openapi.json" data-configuration='{"hideClientButton":true,"hideTestRequestButton":true,"hideSearch":false,"persistAuth":false,"telemetry":false,"withDefaultFonts":false,"proxyUrl":""}'></script>
<script src="${SCALAR_URL}" referrerpolicy="no-referrer" crossorigin="anonymous"></script>
</body></html>`;

// Runs before ingestion switches. No env, credentials, query reflection or D1.
export function documentation(request) {
  const json = new URL(request.url).pathname === '/docs/openapi.json';
  const headers = { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': json ? "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
      : "default-src 'none'; script-src https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.75.1/dist/browser/standalone.js; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; font-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  return new Response(request.method === 'HEAD' ? null : json ? JSON.stringify(openapi) : DOCS_HTML, { headers });
}
