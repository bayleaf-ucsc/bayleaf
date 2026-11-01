// The response headers Pouch is served with: deploy.mjs writes them as
// Cloudflare's _headers file, and the browser tests serve the same rules
// (headersFor), so a test sees what production sends.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The report viewer's policy is the meta tag in viewer.html; the header adds
// what a meta tag cannot carry: who may frame it, and an opaque origin even
// when the file is opened on its own (sandbox).
export function viewerCsp(dir) {
  const csp = readFileSync(join(dir, 'viewer.html'), 'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
  if (!csp) throw new Error('viewer.html has no CSP');
  return csp;
}
export const VIEWER_PERMISSIONS = 'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=()';

// Rules for one path merge (same header: comma-joined), so Cache-Control is
// set per path, never on /*: the page and checksums are never cached; sw.js,
// the viewer and the manifest are revalidated every time (no-cache), so a
// release reaches them at once; icons may be cached for a day; the
// content-hash-named model files are immutable. /viewer.html detaches the
// page's CSP, frame and permission headers and sets its own ("! Name" removes
// what an earlier rule attached; checked against wrangler dev, 2026-10-31).
export function headersFile(csp, vcsp) {
  return `/
  Cache-Control: no-store, no-transform
/pouch.html
  Cache-Control: no-store, no-transform
/SHA256SUMS
  Cache-Control: no-store, no-transform
/sw.js
  Cache-Control: no-cache, no-transform
/manifest.webmanifest
  Cache-Control: no-cache, no-transform
/icons/*
  Cache-Control: public, max-age=86400
/models/*
  Cache-Control: public, max-age=31536000, immutable
/*
  NEL: {"max_age":0}
  Report-To: {"group":"cf-nel","max_age":0,"endpoints":[]}
  Content-Security-Policy: ${csp}; frame-ancestors 'none'; object-src 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000
  X-Robots-Tag: noindex
/viewer.html
  ! Content-Security-Policy
  ! X-Frame-Options
  ! Permissions-Policy
  Content-Security-Policy: ${vcsp}; frame-ancestors 'self'; sandbox allow-scripts
  X-Frame-Options: SAMEORIGIN
  Permissions-Policy: ${VIEWER_PERMISSIONS}
  Cache-Control: no-cache, no-transform
`;
}

// The headers a path gets under a _headers file, as Cloudflare applies them:
// every matching rule in order; detaches first, then attaches (comma-joined).
export function headersFor(file, path) {
  const out = {};
  let match = false;
  for (const line of file.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      const p = line.trim();
      match = p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p;
      continue;
    }
    if (!match) continue;
    const t = line.trim();
    if (t.startsWith('! ')) { delete out[t.slice(2).toLowerCase()]; continue; }
    const i = t.indexOf(':'), k = t.slice(0, i).toLowerCase(), v = t.slice(i + 1).trim();
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}
