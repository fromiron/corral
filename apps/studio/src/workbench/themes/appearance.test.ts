// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, PREFERENCES_KEY, parsePreferences, preferences } from '../preferences.ts';
import {
  appearanceOf,
  appliedAppearance,
  applyAppearance,
  chooseAppearance,
  deletePersonalTheme,
  endPreview,
  findPalette,
  previewPalette,
} from './appearance.ts';
import { BUILTIN_THEMES } from './builtin.ts';
import type { Palette } from './palette.ts';
import { addPersonalTheme, loadPersonalThemes, PERSONAL_THEMES_KEY } from './storage.ts';
import { PALETTE_TOKENS } from './tokens.ts';

const monokai = BUILTIN_THEMES.find((theme) => theme.id === 'monokai')?.palette as Palette;
const latte = BUILTIN_THEMES.find((theme) => theme.id === 'catppuccin-latte')?.palette as Palette;
const html = document.documentElement;

let values: Map<string, string>;
let writes: string[];
beforeEach(() => {
  values = new Map();
  writes = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  preferences.setState(parsePreferences(null), true);
  loadPersonalThemes();
});
afterEach(() => {
  endPreview();
  applyAppearance({ ...parsePreferences(null), theme: 'light' });
  html.className = '';
  html.removeAttribute('style');
  delete html.dataset.theme;
  vi.unstubAllGlobals();
});

const themeTokensOnRoot = () => PALETTE_TOKENS.filter((name) => html.style.getPropertyValue(name));

describe('choosing an appearance', () => {
  it('sets theme and clears palette for system, light and dark', () => {
    preferences.setState({ ...preferences.getState(), palette: 'builtin:monokai', theme: 'dark' });
    for (const choice of ['system', 'light', 'dark'] as const) {
      expect(chooseAppearance(choice)).toBe(true);
      expect(preferences.getState()).toMatchObject({ theme: choice, palette: null });
    }
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null).palette).toBeNull();
  });

  it('sets the palette and the theme to its base for a named theme, and persists both', () => {
    expect(chooseAppearance('builtin:monokai')).toBe(true);
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: 'builtin:monokai' });
    expect(chooseAppearance('builtin:catppuccin-latte')).toBe(true);
    expect(preferences.getState()).toMatchObject({
      theme: 'light',
      palette: 'builtin:catppuccin-latte',
    });
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null)).toMatchObject({
      theme: 'light',
      palette: 'builtin:catppuccin-latte',
    });
    expect(appearanceOf(preferences.getState())).toBe('builtin:catppuccin-latte');
  });

  it('refuses a named theme it cannot find and changes nothing', () => {
    expect(chooseAppearance('builtin:nope')).toBe(false);
    expect(chooseAppearance('custom:gone')).toBe(false);
    expect(preferences.getState()).toMatchObject({ theme: 'system', palette: null });
    expect(writes).toEqual([]);
  });

  it('finds built-in and personal themes by id', () => {
    const saved = addPersonalTheme({ ...latte, name: 'Mine' }, () => 'mine');
    if (!saved.ok) throw new Error(saved.error);
    expect(findPalette('builtin:monokai')).toBe(monokai);
    expect(findPalette('custom:mine')?.name).toBe('Mine');
    expect(findPalette('custom:other')).toBeNull();
  });
});

describe('applying an appearance', () => {
  it('writes the theme tokens, its base class and color-scheme on the root', () => {
    expect(
      applyAppearance({ ...preferences.getState(), theme: 'dark', palette: 'builtin:monokai' }),
    ).toBe(true);
    expect(html.style.getPropertyValue('--surface-1')).toBe('#272822');
    expect(html.style.getPropertyValue('--muted-foreground')).toBe(monokai.ui.muted);
    expect(html.style.getPropertyValue('--syntax-keyword')).toBe(monokai.syntax.keyword);
    expect(themeTokensOnRoot()).toEqual([...PALETTE_TOKENS]);
    expect(html.classList.contains('dark')).toBe(true);
    expect(html.classList.contains('light')).toBe(false);
    expect(html.style.colorScheme).toBe('dark');
    expect(appliedAppearance.getState()).toEqual({ palette: monokai, dark: true });
  });

  it('uses the base of the theme even when the OS is dark and the theme is light', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(
      applyAppearance({
        ...preferences.getState(),
        theme: 'light',
        palette: 'builtin:catppuccin-latte',
      }),
    ).toBe(false);
    expect(html.classList.contains('light')).toBe(true);
    expect(html.style.colorScheme).toBe('light');
  });

  it('leaves nothing behind on the way back to light', () => {
    // The root exactly as the light path left it before themes existed.
    html.removeAttribute('style');
    html.className = '';
    applyTheme('light');
    const reference = { style: html.style.cssText, classes: html.className };
    const head = document.head.innerHTML;
    applyAppearance({ ...preferences.getState(), theme: 'dark', palette: 'builtin:monokai' });
    expect(html.style.cssText).not.toBe(reference.style);
    applyAppearance({ ...preferences.getState(), theme: 'light', palette: null });
    expect(themeTokensOnRoot()).toEqual([]);
    expect(html.style.cssText).toBe(reference.style);
    expect(html.className).toBe(reference.classes);
    expect(document.head.innerHTML).toBe(head);
    expect(document.querySelectorAll('style')).toHaveLength(0);
    expect(appliedAppearance.getState()).toEqual({ palette: null, dark: false });
  });

  it('draws a missing personal theme with the theme alone, clears it, and shows no error', () => {
    preferences.setState({ ...preferences.getState(), theme: 'dark', palette: 'custom:gone' });
    expect(() => applyAppearance()).not.toThrow();
    expect(themeTokensOnRoot()).toEqual([]);
    expect(html.classList.contains('dark')).toBe(true);
    expect(preferences.getState().palette).toBeNull();
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null)).toMatchObject({
      theme: 'dark',
      palette: null,
    });
  });

  it('treats a stored personal theme it cannot read as missing', () => {
    values.set(
      PERSONAL_THEMES_KEY,
      JSON.stringify({ version: 1, themes: [{ id: 'broken', palette: { name: 'x' } }] }),
    );
    loadPersonalThemes();
    preferences.setState({ ...preferences.getState(), theme: 'light', palette: 'custom:broken' });
    applyAppearance();
    expect(themeTokensOnRoot()).toEqual([]);
    expect(preferences.getState().palette).toBeNull();
  });

  it('previews a draft on the root without writing storage, then returns to the saved choice', () => {
    chooseAppearance('light');
    applyAppearance();
    writes = [];
    const draft = { ...monokai, ui: { ...monokai.ui, muted: '#777766' } };
    previewPalette(draft);
    expect(html.style.getPropertyValue('--muted-foreground')).toBe('#777766');
    expect(html.classList.contains('dark')).toBe(true);
    expect(appliedAppearance.getState()).toEqual({ palette: draft, dark: true });
    // A change to the draft goes through the same path.
    previewPalette({ ...draft, ui: { ...draft.ui, muted: '#888877' } });
    expect(html.style.getPropertyValue('--muted-foreground')).toBe('#888877');
    // An apply from elsewhere (an OS change, a rerender) keeps the draft on screen.
    applyAppearance();
    expect(html.style.getPropertyValue('--muted-foreground')).toBe('#888877');
    expect(writes).toEqual([]);
    expect(preferences.getState()).toMatchObject({ theme: 'light', palette: null });
    endPreview();
    expect(themeTokensOnRoot()).toEqual([]);
    expect(html.classList.contains('light')).toBe(true);
    expect(writes).toEqual([]);
  });

  it('tells listeners whether the screen is dark after every apply', () => {
    const seen: boolean[] = [];
    const stop = appliedAppearance.subscribe((state) => seen.push(state.dark));
    applyAppearance({ ...preferences.getState(), theme: 'dark', palette: null });
    applyAppearance({ ...preferences.getState(), theme: 'light', palette: 'builtin:monokai' });
    stop();
    expect(seen).toEqual([true, true]);
  });
});

describe('deleting the applied personal theme', () => {
  it('falls back to the light or dark of its base', () => {
    const saved = addPersonalTheme({ ...monokai, name: 'Mine' }, () => 'mine');
    if (!saved.ok) throw new Error(saved.error);
    chooseAppearance('custom:mine');
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: 'custom:mine' });
    expect(deletePersonalTheme('mine')).toEqual({ ok: true });
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: null });
  });

  it('leaves the appearance alone when another theme is applied', () => {
    const saved = addPersonalTheme({ ...latte, name: 'Other' }, () => 'other');
    if (!saved.ok) throw new Error(saved.error);
    chooseAppearance('builtin:monokai');
    expect(deletePersonalTheme('other')).toEqual({ ok: true });
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: 'builtin:monokai' });
  });
});
