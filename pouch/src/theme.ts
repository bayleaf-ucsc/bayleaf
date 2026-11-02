// Local-only preference, erased with the rest of Pouch's localStorage.
export const THEME_KEY = 'pouch.theme';
export type ThemePreference = 'system' | 'light' | 'dark';
const choices: readonly string[] = ['system', 'light', 'dark'];
type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface ThemeOptions {
  root?: Pick<HTMLElement, 'dataset' | 'dispatchEvent'>;
  storage?: ThemeStorage;
  media?: Pick<MediaQueryList, 'matches' | 'addEventListener'>;
  control?: HTMLSelectElement | null;
}
export interface Theme { set(value: string): void; readonly preference: ThemePreference }
export function createTheme({ root = document.documentElement, storage,
  media = matchMedia('(prefers-color-scheme: dark)'), control = document.getElementById('theme-preference') as HTMLSelectElement | null }: ThemeOptions = {}): Theme {
  let preference = 'system' as ThemePreference;
  try { storage ??= localStorage; const saved = storage.getItem(THEME_KEY); if (choices.includes(saved!)) preference = saved as ThemePreference; } catch {}
  function apply() {
    root.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    if (control) control.value = preference;
    root.dispatchEvent(new Event('pouch-theme'));
  }
  function set(value: string) {
    preference = (choices.includes(value) ? value : 'system') as ThemePreference;
    try { storage!.setItem(THEME_KEY, preference); } catch {}
    apply();
  }
  media.addEventListener('change', apply);
  control?.addEventListener('change', () => set(control.value));
  apply();
  return { set, get preference() { return preference; } };
}
