import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { checkPalette, readThemeFile, type ThemeFileError } from './json.ts';
import { PALETTE_NAME_MAX, type Palette } from './palette.ts';

/**
 * Personal themes live in this device's browser storage only, under their own key (not the
 * preferences record). Nothing here is sent to the server, the vault, diagnostics or logs.
 */
export const PERSONAL_THEMES_KEY = 'corral:themes:v1';
export const PERSONAL_THEME_LIMIT = 20;

export interface PersonalTheme {
  /** Made on this device; the preference refers to it as `custom:<id>`. */
  readonly id: string;
  readonly palette: Palette;
}
export type ThemeSaveError = 'limit' | 'storage' | 'missing' | ThemeFileError;
export type ThemeSave = { ok: true; theme: PersonalTheme } | { ok: false; error: ThemeSaveError };

const LOCAL_ID = /^[a-z0-9-]{1,64}$/;
const newId = () => crypto.randomUUID();

function read(): PersonalTheme[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(PERSONAL_THEMES_KEY) ?? 'null');
    if (value?.version !== 1 || !Array.isArray(value.themes)) return [];
    // A stored theme that no longer reads as a theme is skipped, never repaired.
    return value.themes.flatMap((entry: unknown) => {
      const { id, palette } = (entry ?? {}) as { id?: unknown; palette?: unknown };
      const checked = checkPalette(palette);
      return typeof id === 'string' && LOCAL_ID.test(id) && checked.ok
        ? [{ id, palette: checked.palette }]
        : [];
    });
  } catch {
    return [];
  }
}

export const personalThemes = createStore<readonly PersonalTheme[]>(() => read());
export const usePersonalThemes = () => useStore(personalThemes);

/** Rereads storage (startup, and tests). */
export function loadPersonalThemes() {
  personalThemes.setState(read(), true);
}

export function findPersonalTheme(id: string): PersonalTheme | null {
  return personalThemes.getState().find((theme) => theme.id === id) ?? null;
}

export function canAddPersonalTheme(): boolean {
  return personalThemes.getState().length < PERSONAL_THEME_LIMIT;
}

/** Writes first; the list in memory changes only when the write succeeded. */
function commit(next: readonly PersonalTheme[]): boolean {
  try {
    globalThis.localStorage.setItem(
      PERSONAL_THEMES_KEY,
      JSON.stringify({ version: 1, themes: next }),
    );
  } catch {
    return false;
  }
  personalThemes.setState(next, true);
  return true;
}

export function addPersonalTheme(palette: Palette, makeId: () => string = newId): ThemeSave {
  if (!canAddPersonalTheme()) return { ok: false, error: 'limit' };
  const checked = checkPalette(palette);
  if (!checked.ok) return checked;
  const id = makeId();
  if (!LOCAL_ID.test(id) || findPersonalTheme(id)) throw new Error('Unusable theme id');
  const theme = { id, palette: checked.palette };
  return commit([...personalThemes.getState(), theme])
    ? { ok: true, theme }
    : { ok: false, error: 'storage' };
}

export function updatePersonalTheme(id: string, palette: Palette): ThemeSave {
  if (!findPersonalTheme(id)) return { ok: false, error: 'missing' };
  const checked = checkPalette(palette);
  if (!checked.ok) return checked;
  const theme = { id, palette: checked.palette };
  return commit(personalThemes.getState().map((each) => (each.id === id ? theme : each)))
    ? { ok: true, theme }
    : { ok: false, error: 'storage' };
}

export function removePersonalTheme(
  id: string,
): { ok: true } | { ok: false; error: 'missing' | 'storage' } {
  if (!findPersonalTheme(id)) return { ok: false, error: 'missing' };
  return commit(personalThemes.getState().filter((theme) => theme.id !== id))
    ? { ok: true }
    : { ok: false, error: 'storage' };
}

/** `name`, or `name (2)`, `name (3)`… when taken, shortened to stay within 40 characters. */
export function numberedName(name: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(name)) return name;
  for (let number = 2; ; number++) {
    const suffix = ` (${number})`;
    const candidate = `${[...name].slice(0, PALETTE_NAME_MAX - suffix.length).join('')}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** Adds a Corral theme file as a personal theme under a new local id; it is not applied. */
export async function importPersonalTheme(
  file: Blob,
  makeId: () => string = newId,
): Promise<ThemeSave> {
  if (!canAddPersonalTheme()) return { ok: false, error: 'limit' };
  const parsed = await readThemeFile(file);
  if (!parsed.ok) return parsed;
  const name = numberedName(
    parsed.palette.name,
    personalThemes.getState().map((theme) => theme.palette.name),
  );
  return addPersonalTheme({ ...parsed.palette, name }, makeId);
}
