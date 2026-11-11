import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { isPaletteId, type PaletteId } from './themes/palette.ts';

export type ChatDensity = 'results' | 'basic' | 'detailed';
export type Theme = 'system' | 'light' | 'dark';
/** The design kit's size step for the whole app. */
export type InterfaceDensity = 'default' | 'compact';
export interface Preferences {
  version: 1;
  /** Light or dark; under a named theme, that theme's base (the vault carries only this). */
  theme: Theme;
  /** A named theme (themes/appearance.ts), or null for the kit's own palette. */
  palette: PaletteId | null;
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** Enter sends and Shift+Enter adds a line, or Ctrl/⌘+Enter sends and Enter adds a line. */
  sendKey: 'enter' | 'mod-enter';
  /** Desktop app: a system notification when something needs the person (off by default). */
  notify: boolean;
  chatDensity: ChatDensity;
  density: InterfaceDensity;
}

export const PREFERENCES_KEY = 'corral:workbench:v1';
const defaults: Preferences = {
  version: 1,
  theme: 'system',
  palette: null,
  sidebarOpen: true,
  sidebarWidth: 256,
  sendKey: 'enter',
  notify: false,
  chatDensity: 'basic',
  density: 'default',
};

export function parsePreferences(raw: string | null): Preferences {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (value?.version !== 1) return { ...defaults };
    return {
      version: 1,
      theme: ['system', 'light', 'dark'].includes(value.theme) ? value.theme : 'system',
      palette: isPaletteId(value.palette) ? value.palette : null,
      sidebarOpen: typeof value.sidebarOpen === 'boolean' ? value.sidebarOpen : true,
      sidebarWidth:
        typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)
          ? Math.min(420, Math.max(220, value.sidebarWidth))
          : 256,
      sendKey: value.sendKey === 'mod-enter' ? 'mod-enter' : 'enter',
      notify: value.notify === true,
      chatDensity:
        value.chatDensity === 'results' || value.chatDensity === 'detailed'
          ? value.chatDensity
          : 'basic',
      density: value.density === 'compact' ? 'compact' : 'default',
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

/** Applies the theme to the page; returns whether it is dark. */
export function applyTheme(theme: Theme): boolean {
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('light', !dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  return dark;
}

/** Whether a key press in a request box sends it, per the person's choice; never mid-IME. */
export function isSendKey(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  sendKey: Preferences['sendKey'],
): boolean {
  if (event.key !== 'Enter' || event.altKey) return false;
  if (sendKey === 'mod-enter') return event.ctrlKey || event.metaKey;
  return !event.shiftKey;
}
