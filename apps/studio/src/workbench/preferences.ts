import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export type Theme = 'system' | 'light' | 'dark';
export interface Preferences {
  version: 1;
  theme: Theme;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

export const PREFERENCES_KEY = 'corral:workbench:v1';
const defaults: Preferences = { version: 1, theme: 'system', sidebarOpen: true, sidebarWidth: 256 };

export function parsePreferences(raw: string | null): Preferences {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (value?.version !== 1) return { ...defaults };
    return {
      version: 1,
      theme: ['system', 'light', 'dark'].includes(value.theme) ? value.theme : 'system',
      sidebarOpen: typeof value.sidebarOpen === 'boolean' ? value.sidebarOpen : true,
      sidebarWidth:
        typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)
          ? Math.min(420, Math.max(220, value.sidebarWidth))
          : 256,
    };
  } catch {
    return { ...defaults };
  }
}

function read(): Preferences {
  try {
    return parsePreferences(globalThis.localStorage?.getItem(PREFERENCES_KEY) ?? null);
  } catch {
    return { ...defaults };
  }
}

export const preferences = createStore<Preferences>(() => read());
export const usePreferences = () => useStore(preferences);

export function changePreferences(patch: Partial<Omit<Preferences, 'version'>>) {
  const next = parsePreferences(JSON.stringify({ ...preferences.getState(), ...patch }));
  preferences.setState(next);
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    /* Session only. */
  }
}

export function applyTheme(theme: Theme) {
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}
