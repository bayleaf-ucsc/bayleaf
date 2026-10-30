// BayLeaf Pouch offline copy: serves the pinned app shell from Cache Storage.
//
// Browsers re-fetch this file and replace it whenever its bytes change, without
// asking, so it is kept tiny and does nothing but serve. Pinning, checking for
// updates and verifying hashes happen in the page (src/offline.js), inside the
// script whose hash the CSP names. This file is listed in SHA256SUMS, and the
// page shows whether the served copy matches the hash it was built with.
//
// Handled: same-origin GETs of the shell (/, /pouch.html, the manifest, icons),
// cache-first from the one cache named pouch-shell-<sha256 of pouch.html>.
// Everything else (api.bayleaf.dev, /models/**, /SHA256SUMS, /sw.js) is not
// intercepted: the browser fetches it as if this worker did not exist. Nor is any URL
// with a query string: the page fetches a release as /pouch.html?fresh, which
// must come from the server, not from this cache. (A query, not cache:
// 'no-store', because request.cache is not reliably preserved: Chromium under
// DevTools-style interception reports 'reload'.)
const SHELL = new Set(['/', '/pouch.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const r = event.request;
  if (r.method !== 'GET' || url.search || url.origin !== self.location.origin || !SHELL.has(url.pathname)) return;
  event.respondWith((async () => {
    for (const name of await caches.keys()) {
      if (!name.startsWith('pouch-shell-')) continue;
      const c = await caches.open(name);
      if (!(await c.match('/'))) continue; // '/' is written last: an unfinished copy is skipped
      const hit = await c.match(url.pathname);
      if (hit) return hit;
    }
    return fetch(r); // no offline copy yet (or it was removed)
  })());
});
