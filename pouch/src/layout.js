// The frame: sessions sidebar (left), chat (center), at most one panel
// (right) chosen from the icon rail, and the handles that size them. On
// phones the sidebar is a drawer, a panel is a full-screen sheet over the
// chat, and the rail is a bottom bar.
//
// Preferences live in localStorage, not IndexedDB: they must be readable
// synchronously at boot or the frame would jump. Erase all clears them too.
import { $ } from './dom.js';

const KEY = 'pouch.layout';
const NARROW = matchMedia('(max-width: 860px)');
const SIDE = { def: 260, min: 200, max: 480 };
const PANEL_MIN = 240, CHAT_MIN = 360;
const DEFAULT_W = { files: 300, usage: 320, trust: 360, settings: 340, editor: () => Math.round(innerWidth * 0.5) };
const clamp = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));

export function createLayout({ onPanel } = {}) {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { /* corrupt or blocked: defaults */ }
  prefs.widths ??= {};
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };
  const app = $('app');
  const narrow = () => NARROW.matches;
  let panel = null;

  const sideOpen = () => app.classList.contains('side-open');
  const sideW = () => clamp(prefs.sideW ?? SIDE.def, SIDE.min, SIDE.max);
  const railW = () => $('rail').getBoundingClientRect().width || 44;
  // A panel may grow until the chat would drop below CHAT_MIN.
  const panelMax = () => Math.max(PANEL_MIN, innerWidth - railW() - (sideOpen() ? sideW() : 0) - CHAT_MIN);
  const defaultW = (p) => (typeof DEFAULT_W[p] === 'function' ? DEFAULT_W[p]() : DEFAULT_W[p]);
  const panelW = (p) => clamp(prefs.widths[p] ?? defaultW(p), PANEL_MIN, panelMax());

  function apply() {
    app.style.setProperty('--side-w', sideW() + 'px');
    app.style.setProperty('--panel-w', (panel ? panelW(panel) : 0) + 'px');
    const ph = $('panel-handle'), sh = $('side-handle');
    if (panel) Object.assign(ph, { ariaValueNow: String(panelW(panel)), ariaValueMin: String(PANEL_MIN), ariaValueMax: String(panelMax()) });
    Object.assign(sh, { ariaValueNow: String(sideW()), ariaValueMin: String(SIDE.min), ariaValueMax: String(SIDE.max) });
  }

  function setSide(open, persist = true) {
    app.classList.toggle('side-open', open);
    const f = $('flipper'), label = open ? 'Hide sessions' : 'Show sessions';
    f.setAttribute('aria-expanded', String(open)); f.ariaLabel = label; f.title = label;
    $('backdrop').hidden = !(open && narrow());
    if (persist && !narrow()) { prefs.side = open; save(); }
    if (open && narrow()) $('new').focus();
    apply();
  }

  function open(name) {
    panel = name && name !== 'chat' ? name : null;
    app.dataset.panel = panel ?? '';
    for (const b of $('rail').querySelectorAll('button[data-panel]')) {
      b.setAttribute('aria-pressed', String(b.dataset.panel === (panel ?? 'chat')));
    }
    if (narrow()) { if (sideOpen()) setSide(false, false); }
    else { prefs.panel = panel; save(); }
    apply();
    onPanel?.(panel);
  }
  const toggle = (name) => open(panel === name ? null : name);

  // One routine for both handles. dir is +1 when dragging right widens.
  function resizer(handle, { get, set, reset, dir }) {
    handle.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = get();
      document.body.classList.add('resizing'); handle.classList.add('active');
      handle.onpointermove = (ev) => set(w0 + dir * (ev.clientX - x0), false);
      handle.onpointerup = handle.onpointercancel = () => {
        handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
        document.body.classList.remove('resizing'); handle.classList.remove('active');
        set(get(), true);
      };
    };
    handle.onkeydown = (e) => {
      const step = e.shiftKey ? 64 : 16;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        set(get() + (e.key === 'ArrowRight' ? step : -step) * dir, true);
      } else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); reset(); }
    };
    handle.ondblclick = reset;
  }
  resizer($('panel-handle'), {
    dir: -1, // the handle is on the panel's left edge
    get: () => panelW(panel),
    set: (w, persist) => { if (!panel) return; prefs.widths[panel] = clamp(w, PANEL_MIN, panelMax()); apply(); if (persist) save(); },
    reset: () => { if (!panel) return; delete prefs.widths[panel]; save(); apply(); },
  });
  resizer($('side-handle'), {
    dir: 1,
    get: sideW,
    set: (w, persist) => { prefs.sideW = clamp(w, SIDE.min, SIDE.max); apply(); if (persist) save(); },
    reset: () => { delete prefs.sideW; save(); apply(); },
  });

  $('flipper').onclick = () => setSide(!sideOpen());
  $('side-close').onclick = () => setSide(false, false);
  $('backdrop').onclick = () => setSide(false, false);
  $('rail').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-panel]');
    if (b) b.dataset.panel === 'chat' ? open(null) : toggle(b.dataset.panel);
  });
  for (const b of document.querySelectorAll('.panel-close')) b.addEventListener('click', () => open(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && narrow() && sideOpen() && !document.querySelector('dialog[open]')) setSide(false, false);
  });
  addEventListener('resize', apply);
  // Crossing the phone breakpoint: a drawer never stays open, the desktop frame comes back.
  NARROW.addEventListener('change', () => { setSide(!narrow() && !!prefs.side, false); open(narrow() ? null : panel); });

  // Boot: phones start on the chat; desktops restore the last panel (Files
  // on a first visit, since files work before signing in). After a reload no
  // file is open, so a remembered Editor comes back as Files.
  setSide(!narrow() && !!prefs.side, false);
  open(narrow() ? null : prefs.panel === undefined || prefs.panel === 'editor' ? 'files' : prefs.panel);

  return { open, toggle, close: () => open(null), current: () => panel, narrow, setSide, sideOpen };
}
