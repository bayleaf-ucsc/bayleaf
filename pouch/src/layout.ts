// The frame: sessions sidebar (left), chat (center), at most one panel
// (right) chosen from the icon rail, and the handles that size them. On
// phones the sidebar is a drawer, a panel is a full-screen sheet over the
// chat, and the rail is a bottom bar.
//
// Preferences live in localStorage, not IndexedDB: they must be readable
// synchronously at boot or the frame would jump. Erase all clears them too.
import { $ } from './dom.ts';
import { dismissible } from './dismiss.ts';

const KEY = 'pouch.layout';
const SIDE = { def: 260, min: 200, max: 480 };
const PANEL_MIN = 240, CHAT_MIN = 360, OVERLAY_MIN = 480;
export type PanelName = 'files' | 'terminal' | 'usage' | 'trust' | 'settings' | 'editor';
const DEFAULT_W: Record<PanelName, number | (() => number)> = { files: 300, terminal: 420, usage: 320, trust: 360, settings: 340, editor: () => Math.round(innerWidth * 0.5) };
const isPanel = (v: unknown): v is PanelName => typeof v === 'string' && Object.hasOwn(DEFAULT_W, v);
const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));

export interface LayoutPrefs { widths: Partial<Record<PanelName, number>>; sideW?: number; side?: boolean; panel?: PanelName | null }
// Stored prefs are whatever an older build (or a hand edit) left: keep only
// the fields that have the right shape, so a bad one falls back to its default.
const isWidth = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function parsePrefs(raw: unknown): LayoutPrefs {
  const o: Record<string, unknown> = raw && typeof raw === 'object' ? { ...raw } : {};
  const widths: LayoutPrefs['widths'] = {};
  if (o.widths && typeof o.widths === 'object') {
    for (const [k, v] of Object.entries(o.widths)) if (isPanel(k) && isWidth(v)) widths[k] = v;
  }
  return {
    widths,
    ...(isWidth(o.sideW) ? { sideW: o.sideW } : {}),
    ...(typeof o.side === 'boolean' ? { side: o.side } : {}),
    ...(o.panel === null || isPanel(o.panel) ? { panel: o.panel } : {}),
  };
}
export interface Layout {
  open(name: PanelName | 'chat' | null | undefined): void;
  toggle(name: PanelName): void;
  close(): void;
  current(): PanelName | null;
  narrow(): boolean;
  overlaid(): boolean;
  setSide(open: boolean, persist?: boolean): void;
  sideOpen(): boolean;
}
export function createLayout({ onPanel }: { onPanel?(panel: PanelName | null): void } = {}): Layout {
  const NARROW = matchMedia('(max-width: 860px)');
  let prefs = parsePrefs(null);
  try { prefs = parsePrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { /* corrupt or blocked: defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };
  const app = $('app');
  const narrow = () => NARROW.matches;
  let panel: PanelName | null = null;

  const sideOpen = () => app.classList.contains('side-open');
  const sideW = () => clamp(prefs.sideW ?? SIDE.def, SIDE.min, SIDE.max);
  const railW = () => $('rail').getBoundingClientRect().width || 44;
  // A panel may grow until the chat would drop below CHAT_MIN.
  const panelMax = () => Math.max(PANEL_MIN, innerWidth - railW() - CHAT_MIN);
  const defaultW = (p: PanelName) => { const d = DEFAULT_W[p]; return typeof d === 'function' ? d() : d; };
  const panelW = (p: PanelName) => clamp(prefs.widths[p] ?? defaultW(p), PANEL_MIN, panelMax());

  // Desktop with a panel open: when the chat would drop below OVERLAY_MIN,
  // the sessions sidebar floats over the chat instead of taking a column.
  const overlay = () => !narrow() && sideOpen() && !!panel && innerWidth - railW() - sideW() - panelW(panel) < OVERLAY_MIN;
  function apply() {
    app.classList.toggle('side-overlay', overlay());
    $('backdrop').hidden = !(sideOpen() && (narrow() || overlay()));
    app.style.setProperty('--side-w', sideW() + 'px');
    app.style.setProperty('--panel-w', (panel ? panelW(panel) : 0) + 'px');
    const ph = $('panel-handle'), sh = $('side-handle');
    if (panel) Object.assign(ph, { ariaValueNow: String(panelW(panel)), ariaValueMin: String(PANEL_MIN), ariaValueMax: String(panelMax()) });
    Object.assign(sh, { ariaValueNow: String(sideW()), ariaValueMin: String(SIDE.min), ariaValueMax: String(SIDE.max) });
  }

  function setSide(open: boolean, persist = true) {
    app.classList.toggle('side-open', open);
    const f = $('flipper'), label = open ? 'Hide sessions' : 'Show sessions';
    f.setAttribute('aria-expanded', String(open)); f.ariaLabel = label; f.title = label;
    if (persist && !narrow()) { prefs.side = open; save(); }
    apply();
    if (open && (narrow() || overlay())) $('new').focus();
  }

  function open(name: PanelName | 'chat' | null | undefined) {
    panel = name && name !== 'chat' ? name : null;
    app.dataset.panel = panel ?? '';
    for (const b of $('rail').querySelectorAll<HTMLElement>('button[data-panel]')) {
      b.setAttribute('aria-pressed', String(b.dataset.panel === (panel ?? 'chat')));
    }
    if (narrow()) { if (sideOpen()) setSide(false, false); }
    else { prefs.panel = panel; save(); }
    apply();
    onPanel?.(panel);
  }
  const toggle = (name: PanelName) => open(panel === name ? null : name);

  // One routine for both handles. dir is +1 when dragging right widens.
  function resizer(handle: HTMLElement, { get, set, reset, dir }: { get(): number; set(w: number, persist: boolean): void; reset(): void; dir: number }) {
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
    get: () => (panel ? panelW(panel) : 0),
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
  // A floating sidebar (phone drawer or desktop overlay) closes back to the composer.
  const dismiss = () => { setSide(false, false); $('input').focus(); };
  $('side-close').onclick = dismiss;
  $('backdrop').onclick = dismiss;
  $('rail').addEventListener('click', (e) => {
    const p = e.target instanceof Element ? e.target.closest<HTMLElement>('button[data-panel]')?.dataset.panel : undefined;
    if (p === 'chat') open(null);
    else if (isPanel(p)) toggle(p);
  });
  for (const b of document.querySelectorAll('.panel-close')) b.addEventListener('click', () => open(null));
  // A floating sidebar is a drawer: outside or Esc closes it (src/dismiss.ts).
  dismissible({ layer: 1, isOpen: () => (narrow() || overlay()) && sideOpen(), inside: () => [$('sidebar'), $('flipper')],
    close: (how) => (how === 'esc' ? dismiss() : setSide(false, false)) });
  // A keystroke is never lost to the sidebar: typing on a session row, the
  // flipper or nothing in particular goes to the composer (the floating
  // sidebar closes first). Text fields, dialogs and shortcuts keep their keys.
  document.addEventListener('keydown', (e) => {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const t = document.activeElement;
    if (t && (t.closest('input, textarea, select, [contenteditable], .cm-editor, #panel-host, #rail') || t === $('input'))) return;
    if (!(t === document.body || !t || t.closest('#sidebar') || t === $('flipper'))) return;
    if (sideOpen() && (narrow() || overlay())) setSide(false, false);
    if (!$<HTMLTextAreaElement>('input').disabled) $('input').focus(); // the key itself lands in the box
  });
  addEventListener('resize', apply);
  // Crossing the phone breakpoint: a drawer never stays open, the desktop frame comes back.
  addEventListener('resize', () => { if (!narrow()) apply(); }, { passive: true });
  NARROW.addEventListener('change', () => { setSide(!narrow() && !!prefs.side, false); open(narrow() ? null : panel); });

  // Boot: phones start on the chat; desktops restore the last panel (Files
  // on a first visit, since files work before signing in). After a reload no
  // file is open, so a remembered Editor comes back as Files.
  setSide(!narrow() && !!prefs.side, false);
  open(narrow() ? null : prefs.panel === undefined || prefs.panel === 'editor' ? 'files' : prefs.panel);

  // An overlaid sidebar behaves like the phone drawer: a press outside it
  // closes it for now (the remembered preference stays open).
  const overlaid = () => app.classList.contains('side-overlay');
  return { open, toggle, close: () => open(null), current: () => panel, narrow, overlaid, setSide, sideOpen };
}
