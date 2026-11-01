// Local-only preference, erased with the rest of Pouch's localStorage.
export const THEME_KEY = 'pouch.theme';
const choices = ['system', 'light', 'dark'];
export function createTheme({ root = document.documentElement, storage,
  media = matchMedia('(prefers-color-scheme: dark)'), control = document.getElementById('theme-preference') } = {}) {
  let preference = 'system';
  try { storage ??= localStorage; const saved = storage.getItem(THEME_KEY); if (choices.includes(saved)) preference = saved; } catch {}
  function apply() {
    root.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    if (control) control.value = preference;
    root.dispatchEvent(new Event('pouch-theme'));
  }
  function set(value) {
    preference = choices.includes(value) ? value : 'system';
    try { storage.setItem(THEME_KEY, preference); } catch {}
    apply();
  }
  media.addEventListener('change', apply);
  control?.addEventListener('change', () => set(control.value));
  apply();
  return { set, get preference() { return preference; } };
}
