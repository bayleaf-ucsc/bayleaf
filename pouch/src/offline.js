// The offline copy: a pinned, hash-checked app shell that sw.js serves.
//
// Hosted pages (https, or http://localhost while testing) register /sw.js and
// pin the shell once: every file is fetched fresh (?fresh, which sw.js never
// answers, plus no-store for the HTTP cache) and checked against
// /SHA256SUMS before it enters the cache pouch-shell-<sha256 of pouch.html>.
// From then on the browser loads that copy, online or not, and it never
// changes underneath the user. check() compares the pinned hash with the
// published one; update() repeats the pin with a fresh SHA256SUMS and only
// swaps the cache if every file matches. Nothing here updates by itself.
//
// A file:// copy has no service worker: it behaves exactly as before.

const SHELL = ['pouch.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
const PREFIX = 'pouch-shell-';
const OFF = 'pouch.offline'; // 'off' after Uninstall; Erase all clears it
const KEEP = ['content-type', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy'];

const hex = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const short = (h) => (h ? h.slice(0, 12) : '?');

async function fetchSums() {
  const r = await fetch('/SHA256SUMS?fresh', { cache: 'no-store' });
  if (!r.ok) throw new Error(`SHA256SUMS: HTTP ${r.status}`);
  const sums = {};
  for (const line of (await r.text()).split('\n')) { const m = line.match(/^([0-9a-f]{64}) {2}(\S+)$/); if (m) sums[m[2]] = m[1]; }
  if (!sums['pouch.html']) throw new Error('SHA256SUMS lists no pouch.html');
  return sums;
}

export function createOffline({ swSha256 }) {
  const sw = globalThis.navigator?.serviceWorker;
  const supported = !!(sw && globalThis.isSecureContext && /^https?:$/.test(location.protocol) && globalThis.caches);
  const state = { supported, published: null, checkedAt: null, error: null, swScript: null, installPrompt: null };

  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; }); // Chromium only

  // A copy is complete once '/' is in it: pin() writes that entry last, so a
  // pin cut short (a reload, a closed tab) is not mistaken for a copy.
  async function pinned() {
    if (!supported) return null;
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && (await (await caches.open(k)).match('/'))) return k.slice(PREFIX.length);
    return null;
  }

  // Fetch, verify, then swap. A mismatch throws before any cache is touched.
  async function pin(sums) {
    const files = [];
    for (const path of SHELL) {
      const r = await fetch('/' + path + '?fresh', { cache: 'no-store' });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      const body = await r.arrayBuffer(), got = await hex(body);
      if (got !== sums[path]) throw new Error(`${path} as served (${short(got)}) does not match SHA256SUMS (${short(sums[path])})`);
      // Keep the security headers: the CSP header adds what the meta tag cannot (frame-ancestors).
      const headers = new Headers();
      for (const h of KEEP) if (r.headers.has(h)) headers.set(h, r.headers.get(h));
      files.push([path, body, headers]);
    }
    const name = PREFIX + sums['pouch.html'];
    await caches.delete(name);
    const c = await caches.open(name);
    for (const [path, body, headers] of files) await c.put('/' + path, new Response(body, { headers }));
    await c.put('/', new Response(files[0][1], { headers: files[0][2] })); // last: marks the copy complete
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== name) await caches.delete(k);
    return sums['pouch.html'];
  }

  return {
    state, supported, pinned,
    enabled: () => { try { return localStorage.getItem(OFF) !== 'off'; } catch { return true; } },
    // Served by the worker from the pinned cache, rather than from the network.
    servedOffline: () => !!sw?.controller,
    installed: () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,

    async start() {
      if (!supported || !this.enabled()) return;
      await sw.register('/sw.js', { scope: '/' });
      if (!(await pinned()) && navigator.onLine) await pin(await fetchSums());
    },

    // { pinned, published, update } where update means the published build differs.
    async check() {
      state.error = null;
      try { const sums = await fetchSums(); state.published = sums['pouch.html']; state.checkedAt = new Date(); }
      catch (e) { state.error = e.message; }
      const p = await pinned();
      return { pinned: p, published: state.published, update: !!(p && state.published && state.published !== p) };
    },

    // Only on the user's click. Throws (and keeps the running copy) on any mismatch.
    async update() {
      const sums = await fetchSums();
      state.published = sums['pouch.html']; state.checkedAt = new Date();
      return pin(sums);
    },

    async uninstall({ remember = true } = {}) {
      if (remember) try { localStorage.setItem(OFF, 'off'); } catch {}
      for (const r of (await sw?.getRegistrations?.()) ?? []) await r.unregister();
      if (globalThis.caches) for (const k of await caches.keys()) if (k.startsWith(PREFIX)) await caches.delete(k);
    },
    async keep() { try { localStorage.removeItem(OFF); } catch {} return this.start(); },

    // Does the worker script the server publishes match the one this build expects?
    async swMatches() {
      if (!supported) return null;
      try { const r = await fetch('/sw.js?fresh', { cache: 'no-store' }); state.swScript = r.ok ? await hex(await r.arrayBuffer()) : null; }
      catch { state.swScript = null; }
      return state.swScript ? state.swScript === swSha256 : null;
    },
  };
}
