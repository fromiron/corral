// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { parsePreferences } from '../preferences.ts';
import { applyAppearance } from '../themes/appearance.ts';
import { BUILTIN_THEMES } from '../themes/builtin.ts';
import { createXterm } from './xterm.ts';

const made = vi.hoisted(() => ({
  terminals: [] as { options: Record<string, unknown> }[],
  opened: [] as string[],
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      made.terminals.push(this);
    }
    loadAddon() {}
    open() {
      made.opened.push(String(this.options.fontFamily));
    }
    onData() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../theme-colors.ts', () => ({
  resolvedThemeColors: (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, '#171717'])),
}));

const tokyo = BUILTIN_THEMES.find((theme) => theme.id === 'tokyo-night')?.palette;
afterEach(() => {
  applyAppearance({ ...parsePreferences(null), theme: 'light' });
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--font-mono');
  Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
});

it('recolors the same terminal with a named theme’s sixteen colors, and back to xterm’s own', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  applyAppearance({ ...parsePreferences(null), theme: 'light' });
  const runtime = await createXterm(document.createElement('div'), 80, 24, () => {});
  const terminal = made.terminals[0];
  if (!terminal) throw new Error('No terminal');
  const theme = () => terminal.options.theme as Record<string, string>;
  expect(terminal.options.minimumContrastRatio).toBe(4.5);
  expect(Object.keys(theme()).sort()).toEqual([
    'background',
    'cursor',
    'cursorAccent',
    'foreground',
  ]);

  applyAppearance({ ...parsePreferences(null), theme: 'dark', palette: 'builtin:tokyo-night' });
  expect(theme().red).toBe(tokyo?.terminal[1]);
  expect(theme().brightWhite).toBe(tokyo?.terminal[15]);
  expect(theme().selectionBackground).toBe(tokyo?.ui.selection);
  expect(terminal.options.minimumContrastRatio).toBe(4.5);

  applyAppearance({ ...parsePreferences(null), theme: 'light' });
  expect(Object.keys(theme()).sort()).toEqual([
    'background',
    'cursor',
    'cursorAccent',
    'foreground',
  ]);
  expect(made.terminals).toHaveLength(1);
  runtime.dispose();
});

it('opens the terminal in the monospace family of the token, once its faces have loaded', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  document.documentElement.style.setProperty('--font-mono', '"JetBrains Mono", monospace');
  const loaded: string[] = [];
  const face = (family: string, subset: string) => ({
    family,
    load: async () => {
      await Promise.resolve();
      loaded.push(subset);
    },
  });
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: new Set([face('"JetBrains Mono"', 'latin'), face('"JetBrains Mono"', 'greek')]),
  });
  made.opened.length = 0;
  const runtime = await createXterm(document.createElement('div'), 80, 24, () => {});
  expect(made.terminals.at(-1)?.options.fontFamily).toBe('"JetBrains Mono", monospace');
  expect(loaded).toEqual(['latin', 'greek']);
  expect(made.opened).toEqual(['"JetBrains Mono", monospace']);
  runtime.dispose();
});
