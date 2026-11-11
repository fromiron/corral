import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeTheme } from './json.ts';
import type { Palette } from './palette.ts';
import {
  addPersonalTheme,
  findPersonalTheme,
  importPersonalTheme,
  loadPersonalThemes,
  numberedName,
  PERSONAL_THEME_LIMIT,
  PERSONAL_THEMES_KEY,
  personalThemes,
  removePersonalTheme,
  updatePersonalTheme,
} from './storage.ts';

const palette = (name: string): Palette => ({
  name,
  base: 'dark',
  ui: {
    background: '#202020',
    foreground: '#f0f0f0',
    muted: '#b0b0b0',
    emphasis: '#7aa2f7',
    selection: '#404858',
    error: '#ff8080',
    success: '#80e080',
    warning: '#f0d060',
    info: '#80c0ff',
  },
  syntax: {
    comment: '#808080',
    keyword: '#ff79c6',
    string: '#f1fa8c',
    number: '#bd93f9',
    function: '#50fa7b',
    type: '#8be9fd',
    variable: '#f8f8f2',
    constant: '#bd93f9',
  },
  terminal: Array.from({ length: 16 }, () => '#123456'),
});

let values: Map<string, string>;
let failWrites = false;
let ids = 0;
const nextId = () => `id-${++ids}`;
const fileOf = (value: Palette | Record<string, unknown>) =>
  new Blob([typeof value === 'object' && 'ui' in value ? serializeTheme(value as Palette) : '']);

beforeEach(() => {
  values = new Map();
  failWrites = false;
  ids = 0;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new DOMException('full', 'QuotaExceededError');
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  });
  loadPersonalThemes();
});
afterEach(() => vi.unstubAllGlobals());

describe('personal themes on this device', () => {
  it('adds, updates and removes a theme, keeping it in its own key', () => {
    const added = addPersonalTheme(palette('Mine'), nextId);
    if (!added.ok) throw new Error(added.error);
    expect(added.theme.id).toBe('id-1');
    expect(findPersonalTheme('id-1')?.palette.name).toBe('Mine');
    expect(values.has(PERSONAL_THEMES_KEY)).toBe(true);
    // Not inside the preferences record.
    expect(values.has('corral:workbench:v1')).toBe(false);
    const updated = updatePersonalTheme('id-1', { ...palette('Mine'), name: 'Ours' });
    expect(updated.ok).toBe(true);
    loadPersonalThemes();
    expect(findPersonalTheme('id-1')?.palette.name).toBe('Ours');
    expect(removePersonalTheme('id-1')).toEqual({ ok: true });
    expect(personalThemes.getState()).toEqual([]);
    expect(updatePersonalTheme('id-1', palette('Gone'))).toEqual({ ok: false, error: 'missing' });
  });

  it('refuses a 21st theme, from the editor or from a file, with the limit as the reason', async () => {
    for (let index = 0; index < PERSONAL_THEME_LIMIT; index++)
      expect(addPersonalTheme(palette(`Theme ${index}`), nextId).ok).toBe(true);
    expect(addPersonalTheme(palette('One more'), nextId)).toEqual({ ok: false, error: 'limit' });
    expect(await importPersonalTheme(fileOf(palette('Imported')), nextId)).toEqual({
      ok: false,
      error: 'limit',
    });
    expect(personalThemes.getState()).toHaveLength(PERSONAL_THEME_LIMIT);
  });

  it('makes the id on this device, never from the file', async () => {
    const withId = JSON.stringify({ ...JSON.parse(serializeTheme(palette('X'))), id: 'evil' });
    expect(await importPersonalTheme(new Blob([withId]), nextId)).toEqual({
      ok: false,
      error: 'fields',
    });
    const imported = await importPersonalTheme(fileOf(palette('X')), () => 'local-1');
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.theme.id).toBe('local-1');
  });

  it('numbers a duplicate name on import and leaves the existing theme untouched', async () => {
    const first = addPersonalTheme(palette('Harbor'), nextId);
    if (!first.ok) throw new Error(first.error);
    const before = JSON.stringify(first.theme);
    const changed = { ...palette('Harbor'), ui: { ...palette('Harbor').ui, error: '#ff0000' } };
    const second = await importPersonalTheme(fileOf(changed), nextId);
    if (!second.ok) throw new Error(second.error);
    expect(second.theme.palette.name).toBe('Harbor (2)');
    expect(second.theme.palette.ui.error).toBe('#ff0000');
    const third = await importPersonalTheme(fileOf(palette('Harbor')), nextId);
    if (!third.ok) throw new Error(third.error);
    expect(third.theme.palette.name).toBe('Harbor (3)');
    expect(JSON.stringify(findPersonalTheme(first.theme.id))).toBe(before);
    expect(personalThemes.getState()).toHaveLength(3);
  });

  it('keeps a numbered name within 40 characters', () => {
    const long = 'n'.repeat(40);
    expect(numberedName(long, [long])).toBe(`${'n'.repeat(36)} (2)`);
    expect([...numberedName(long, [long])].length).toBe(40);
    expect(numberedName('Free', ['Other'])).toBe('Free');
  });

  it('rejects a broken file whole and adds nothing', async () => {
    const result = await importPersonalTheme(
      new Blob([serializeTheme(palette('Bad')).replace('#ff8080', 'red; background: url(x)')]),
      nextId,
    );
    expect(result).toEqual({ ok: false, error: 'color' });
    expect(personalThemes.getState()).toEqual([]);
    expect(values.has(PERSONAL_THEMES_KEY)).toBe(false);
  });

  it('reports a write that throws as a failure and keeps nothing that looks saved', async () => {
    const kept = addPersonalTheme(palette('Kept'), nextId);
    if (!kept.ok) throw new Error(kept.error);
    const stored = values.get(PERSONAL_THEMES_KEY);
    failWrites = true;
    expect(addPersonalTheme(palette('New'), nextId)).toEqual({ ok: false, error: 'storage' });
    expect(updatePersonalTheme(kept.theme.id, palette('Renamed'))).toEqual({
      ok: false,
      error: 'storage',
    });
    expect(await importPersonalTheme(fileOf(palette('File')), nextId)).toEqual({
      ok: false,
      error: 'storage',
    });
    expect(removePersonalTheme(kept.theme.id)).toEqual({ ok: false, error: 'storage' });
    expect(personalThemes.getState().map((theme) => theme.palette.name)).toEqual(['Kept']);
    expect(values.get(PERSONAL_THEMES_KEY)).toBe(stored);
  });

  it('skips a stored theme it cannot read and reads the rest', () => {
    const good = JSON.parse(serializeTheme(palette('Good')));
    delete good.corralTheme;
    values.set(
      PERSONAL_THEMES_KEY,
      JSON.stringify({
        version: 1,
        themes: [
          { id: 'good', palette: good },
          { id: 'bad', palette: { ...good, ui: { ...good.ui, info: 'blue' } } },
          { id: 'BAD ID', palette: good },
        ],
      }),
    );
    loadPersonalThemes();
    expect(personalThemes.getState().map((theme) => theme.id)).toEqual(['good']);
    values.set(PERSONAL_THEMES_KEY, '{');
    loadPersonalThemes();
    expect(personalThemes.getState()).toEqual([]);
  });

  it('reads nothing when storage itself cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    loadPersonalThemes();
    expect(personalThemes.getState()).toEqual([]);
  });
});
