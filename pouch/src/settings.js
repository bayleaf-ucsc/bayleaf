// Local display defaults, not model reasoning controls. Erase all clears localStorage.
import { createTheme } from './theme.js';
export const SETTINGS_KEY = 'pouch.display';
export function createSettings({ storage = localStorage, doc = document } = {}) {
  let prefs = {};
  try { prefs = JSON.parse(storage.getItem(SETTINGS_KEY)) ?? {}; } catch {}
  const states = new Map();
  const get = (kind) => prefs[kind] === true;
  for (const kind of ['reasoning', 'tools']) {
    const control = doc.getElementById(kind + '-expanded');
    if (!control) continue;
    control.checked = get(kind);
    control.onchange = () => {
      prefs[kind] = control.checked;
      try { storage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); } catch {}
    };
  }
  // While Pouch works, Enter steers (default) or queues (JOURNEYS D25).
  const mode = doc.getElementById('send-mode');
  if (mode) {
    mode.value = prefs.sendMode === 'queue' ? 'queue' : 'steer';
    mode.onchange = () => {
      prefs.sendMode = mode.value;
      try { storage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); } catch {}
      doc.dispatchEvent(new Event('pouch-sendmode'));
    };
  }
  return {
    theme: createTheme(), get,
    sendMode: () => (prefs.sendMode === 'queue' ? 'queue' : 'steer'),
    // Snapshot a default on first appearance. Explicit closes must be remembered too.
    bind(details, key, kind) {
      if (!states.has(key)) states.set(key, get(kind));
      details.open = states.get(key);
      details.ontoggle = () => { if (details.isConnected) states.set(key, details.open); };
      return details;
    },
  };
}
