import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import {
  applyTheme,
  changePreferences,
  type Preferences,
  preferences,
  type Theme,
} from '../preferences.ts';
import { findBuiltinTheme } from './builtin.ts';
import { isPaletteId, type Palette, type PaletteId, personalPaletteId } from './palette.ts';
import { findPersonalTheme, removePersonalTheme } from './storage.ts';
import { PALETTE_TOKENS, paletteTokens } from './tokens.ts';

/** The one choice in Settings › General: system, light, dark, or a named theme's id. */
export type Appearance = Theme | PaletteId;

type Choice = Pick<Preferences, 'theme' | 'palette'>;

export function findPalette(id: PaletteId): Palette | null {
  const key = id.slice(id.indexOf(':') + 1);
  return id.startsWith('builtin:')
    ? (findBuiltinTheme(key)?.palette ?? null)
    : (findPersonalTheme(key)?.palette ?? null);
}

export function appearanceOf(choice: Choice): Appearance {
  return choice.palette ?? choice.theme;
}

/**
 * System, light or dark sets `theme` and clears `palette`; a named theme sets `palette` and
 * `theme` to its base, so the vault export carries only the brightness. A named theme that
 * cannot be found changes nothing and returns false.
 */
export function chooseAppearance(choice: Appearance): boolean {
  if (!isPaletteId(choice)) {
    changePreferences({ theme: choice, palette: null });
    return true;
  }
  const palette = findPalette(choice);
  if (!palette) return false;
  changePreferences({ theme: palette.base, palette: choice });
  return true;
}

/** What the root shows now: the named theme in effect (a preview draft included) and darkness. */
export const appliedAppearance = createStore<{ palette: Palette | null; dark: boolean }>(() => ({
  palette: null,
  dark: false,
}));
export const useAppliedPalette = () => useStore(appliedAppearance, (state) => state.palette);

let draft: Palette | null = null;

/**
 * The one apply path: the base's scope class and `color-scheme` through `applyTheme`, then the
 * theme's tokens on the root (or their removal, which leaves the root as the default palette
 * left it). Monaco and xterm follow through the root observer and `appliedAppearance`.
 */
function paint(theme: Theme, palette: Palette | null): boolean {
  const dark = applyTheme(palette ? palette.base : theme);
  const { style } = document.documentElement;
  const tokens = palette ? paletteTokens(palette) : null;
  for (const name of PALETTE_TOKENS) {
    const value = tokens?.[name];
    if (value) style.setProperty(name, value);
    else style.removeProperty(name);
  }
  appliedAppearance.setState({ palette, dark }, true);
  return dark;
}

/**
 * Applies the saved choice (or the preview draft while one is open) and returns whether the
 * screen is dark. A `palette` that cannot be found or read is drawn as `theme` alone and cleared.
 */
export function applyAppearance(choice: Choice = preferences.getState()): boolean {
  if (draft) return paint(choice.theme, draft);
  const palette = choice.palette ? findPalette(choice.palette) : null;
  if (choice.palette && !palette && preferences.getState().palette === choice.palette)
    changePreferences({ palette: null });
  return paint(choice.theme, palette);
}

/** Shows a draft across the app without saving anything; repeat on every change. */
export function previewPalette(palette: Palette) {
  draft = palette;
  paint(preferences.getState().theme, palette);
}

/** Ends a preview and draws the saved choice again. */
export function endPreview() {
  if (!draft) return;
  draft = null;
  applyAppearance();
}

/** Deletes a personal theme; when it was applied, the screen goes to the light or dark of its base. */
export function deletePersonalTheme(id: string) {
  const theme = findPersonalTheme(id);
  const result = removePersonalTheme(id);
  if (result.ok && theme && preferences.getState().palette === personalPaletteId(id))
    changePreferences({ theme: theme.palette.base, palette: null });
  return result;
}
