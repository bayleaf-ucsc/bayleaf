// Offline copy and updates (offline.ts, sw.js).

import { $, el } from '../dom.ts';
import { createOffline, short, type Offline } from '../offline.ts';
import type { App } from './app.ts';

export interface InstallRegion {
  checkUpdate(manual?: boolean): Promise<void>;
  // Redraws Settings > Trust's offline copy facts; note replaces the note line.
  renderCopy(note?: string, cls?: string): Promise<void>;
  shellCopy: Offline;
}

// Chromium's install prompt (offline.ts keeps it as a plain Event): lib.dom does not declare it.
interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<unknown> }
function canPrompt(e: Event | null): e is BeforeInstallPromptEvent {
  return e?.type === 'beforeinstallprompt' && 'prompt' in e && typeof e.prompt === 'function';
}
const errText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function createInstallRegion(app: App): InstallRegion {
  // ── Offline copy and updates (offline.ts, sw.js) ──────────────────────
  // The hosted page keeps a hash-checked copy of itself; it changes only on Update.
  const SW_EXPECTED = typeof SW_SHA256 !== 'undefined' ? SW_SHA256 : null; // eslint-disable-line no-undef (build.mjs define)
  const shellCopy = createOffline({ swSha256: SW_EXPECTED ?? '' }); // '' outside a build: no served sw.js hash matches it
  async function renderCopy(note?: string, cls = '') {
    const f = $('copy-facts');
    const row = (label: string, value: string, c = '') => { const dd = el('dd', { textContent: value, className: c }); f.append(el('dt', { textContent: label }), dd); return dd; };
    const pinned = await shellCopy.pinned().catch(() => null);
    const st = shellCopy.state;
    f.replaceChildren();
    row('Running from', location.protocol === 'file:' ? 'a file on this device' : shellCopy.servedOffline() ? 'the offline copy in this browser' : 'the network');
    const copy = row('Offline copy', !shellCopy.supported ? 'not available here (no service worker)' : pinned ? 'sha256 ' + short(pinned) : shellCopy.enabled() ? 'not kept yet' : 'uninstalled', pinned ? 'ok' : '');
    if (pinned) copy.prepend(swatch(pinned));
    if (shellCopy.supported) {
      const published = row('Published', st.published ? `sha256 ${short(st.published)} (checked ${st.checkedAt?.toLocaleTimeString() ?? 'just now'})` : st.error ? 'not checked: ' + st.error : 'not checked yet',
        st.published && pinned ? (st.published === pinned ? 'ok' : 'pending') : '');
      if (st.published) published.prepend(swatch(st.published));
      const m = await shellCopy.swMatches();
      row('Service worker', m == null ? 'could not check sw.js' : m ? `sw.js matches this build (${short(SW_EXPECTED)})` : `sw.js differs from this build: expected ${short(SW_EXPECTED)}, served ${short(st.swScript)}`, m == null ? '' : m ? 'ok' : 'bad');
    }
    row('Installed', shellCopy.installed() ? 'yes: running as an app' : 'no: in a browser tab');
    const persisted = await navigator.storage?.persisted?.().catch(() => null);
    row('Storage', persisted ? 'persistent: the browser keeps it until you erase it' : 'best effort: the browser may clear it when space is low', persisted ? 'ok' : 'pending');
    $('copy-check').hidden = !shellCopy.supported || !pinned;
    $('copy-keep').hidden = !shellCopy.supported || !!pinned || shellCopy.enabled();
    $('copy-remove').hidden = !pinned;
    $('copy-install').hidden = !shellCopy.state.installPrompt || shellCopy.installed();
    if (note !== undefined) { $('copy-note').textContent = note; $('copy-note').className = cls; }
  }
  // Build identity (continuity): a swatch from the first byte of the page's
  // sha256, so the same build always shows the same color and a new one a
  // visibly different one. The hash beside it stays the authority.
  function swatch(hash: string | null) {
    const n = parseInt(String(hash).slice(0, 2), 16);
    const s = el('span', { className: 'build-swatch', role: 'img', ariaLabel: `build color ${n}`, title: `Build color from sha256 ${short(hash)}` });
    s.style.setProperty('--seed', String(Number.isFinite(n) ? n : 0));
    return s;
  }
  async function checkUpdate(manual?: boolean) {
    const r = await shellCopy.check();
    if (r.update) {
      $('update-swatches')?.replaceChildren(swatch(r.pinned), ' to ', swatch(r.published));
      $('update-text').textContent = `Update available. This copy is sha256 ${short(r.pinned)}; the published build is sha256 ${short(r.published)}. Nothing changes until you press Update, which checks the new files against SHA256SUMS first.`;
      $('update').hidden = false;
    } else $('update').hidden = true;
    if (manual) renderCopy(shellCopy.state.error ? 'Could not check: ' + shellCopy.state.error : r.update ? 'An update is available (see the notice above the chat).' : 'This copy is the published build.', shellCopy.state.error ? 'bad' : '');
    else if (app.state.layout.current() === 'trust') renderCopy();
  }
  async function applyUpdate() {
    const btn = $<HTMLButtonElement>('update-go'); btn.disabled = true;
    const was = await shellCopy.pinned();
    try {
      await shellCopy.update();
      location.reload();
    } catch (e) {
      const msg = `Update refused: ${errText(e)}. Still running sha256 ${short(was)}; nothing was changed.`;
      $('update-text').textContent = msg; $('update').classList.add('bad');
      app.state.status(msg, 'bad'); renderCopy(msg, 'bad');
    } finally { btn.disabled = false; }
  }
  $('update-go').onclick = applyUpdate;
  $('update-later').onclick = () => { $('update').hidden = true; };
  $('copy-check').onclick = () => checkUpdate(true);
  $('copy-remove').onclick = async () => {
    if (!(await app.tree.ask('Uninstall the offline copy? Pouch then loads from the network each time (and not without it). Files and sessions stay.', 'Uninstall', 'danger'))) return;
    await shellCopy.uninstall();
    renderCopy('Offline copy removed. This tab keeps running; reloading loads the published build from the network.');
  };
  $('copy-keep').onclick = async () => {
    try { await shellCopy.keep(); renderCopy('Offline copy kept.'); } catch (e) { renderCopy('Could not keep a copy: ' + errText(e), 'bad'); }
  };
  $('copy-install').onclick = async () => { const p = shellCopy.state.installPrompt; shellCopy.state.installPrompt = null; if (canPrompt(p)) await p.prompt(); renderCopy(); };
  $('settings-copy').onclick = () => app.state.layout.open('trust');
  // An installed app: ask once more for persistent storage (files, sessions, the Local model).
  addEventListener('appinstalled', () => { navigator.storage.persist?.().catch(() => {}); renderCopy(); });

  return {
    checkUpdate,
    renderCopy,
    shellCopy,
  };
}
