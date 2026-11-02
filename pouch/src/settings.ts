// Local display defaults, not model reasoning controls. Erase all clears localStorage.
import { createTheme } from './theme.ts';
export const SETTINGS_KEY = 'pouch.display';
export type DisplayKind = 'reasoning' | 'tools';
export type SendMode = 'steer' | 'followup';
// sendMode may hold the legacy 'queue' (below).
interface DisplayPrefs { reasoning?: boolean; tools?: boolean; sendMode?: string }
export type Settings = ReturnType<typeof createSettings>;
export function createSettings({ storage = localStorage, doc = document }: { storage?: Storage; doc?: Document } = {}) {
  let prefs: DisplayPrefs = {};
  // Only an object is prefs: a stored primitive (or nothing) starts from defaults.
  try { const saved: unknown = JSON.parse(storage.getItem(SETTINGS_KEY) ?? 'null'); if (saved && typeof saved === 'object') prefs = saved; } catch {}
  if (prefs.sendMode === 'queue') { prefs.sendMode = 'followup'; try { storage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); } catch {} }
  const states = new Map<string, boolean>();
  const get = (kind: DisplayKind) => prefs[kind] === true;
  for (const kind of ['reasoning', 'tools'] as const) {
    const control = doc.querySelector<HTMLInputElement>(`#${kind}-expanded`);
    if (!control) continue;
    control.checked = get(kind);
    control.onchange = () => {
      prefs[kind] = control.checked;
      try { storage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); } catch {}
    };
  }
  // While Pouch works, Enter sends a Steer (default) or a Follow-up (JOURNEYS
  // D25). Builds before 2026-10-31 saved the follow-up mode as 'queue'.
  const sendMode = (): SendMode => (prefs.sendMode === 'followup' || prefs.sendMode === 'queue' ? 'followup' : 'steer');
  const mode = doc.querySelector<HTMLSelectElement>('#send-mode');
  if (mode) {
    mode.value = sendMode();
    mode.onchange = () => {
      prefs.sendMode = mode.value;
      try { storage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); } catch {}
      doc.dispatchEvent(new Event('pouch-sendmode'));
    };
  }
  return {
    theme: createTheme(), get,
    sendMode,
    // Snapshot a default on first appearance. Explicit closes must be remembered too.
    bind(details: HTMLDetailsElement, key: string, kind: DisplayKind) {
      let open = states.get(key);
      if (open === undefined) { open = get(kind); states.set(key, open); }
      details.open = open;
      details.ontoggle = () => { if (details.isConnected) states.set(key, details.open); };
      return details;
    },
  };
}
