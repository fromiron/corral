// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { PREFERENCES_KEY, parsePreferences, preferences } from '../workbench/preferences.ts';
import { applyAppearance, chooseAppearance } from '../workbench/themes/appearance.ts';
import { BUILTIN_THEMES } from '../workbench/themes/builtin.ts';
import { addPersonalTheme, loadPersonalThemes } from '../workbench/themes/storage.ts';
import { SettingsPage } from './SettingsPage.tsx';

// Settings › General's Appearance gallery (docs/specs/features/themes.md, 사용자 관측 동작): one
// choice among cards, each a picture of the app in that theme.

vi.mock('../services.tsx', () => ({ useServices: () => ({ mode: 'browser' }) }));
vi.mock('../CommandPalette.tsx', () => ({ ShortcutTable: () => null }));
vi.mock('./FilesViews.tsx', () => ({ WorkFolderSection: () => null }));
vi.mock('./ProjectToolSettings.tsx', () => ({ WorkspaceToolSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const D = messages.Desktop;
const html = document.documentElement;
const builtin = (id: string) => {
  const theme = BUILTIN_THEMES.find((each) => each.id === id);
  if (!theme) throw new Error(`No built-in theme ${id}`);
  return theme.palette;
};

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  loadPersonalThemes();
});
afterEach(() => {
  applyAppearance({ ...parsePreferences(null), theme: 'light' });
  vi.unstubAllGlobals();
  preferences.setState(parsePreferences(null), true);
});

async function show() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <SettingsPage section="general" />
      </IntlProvider>,
    ),
  );
  const gallery = container.querySelector<HTMLElement>('[data-appearance]');
  if (!gallery) throw new Error('No appearance gallery');
  const radios = () => [...gallery.querySelectorAll<HTMLElement>('[role="radio"]')];
  const names = (within: Element) =>
    [...within.querySelectorAll('[role="radio"]')].map((radio) => radio.getAttribute('aria-label'));
  /** The radios of the group labelled `label`, or of the unlabelled first grid when null. */
  const group = (label: string | null) => {
    if (label === null) {
      const first = gallery.querySelector('[role="radiogroup"] > div');
      return first ? names(first) : [];
    }
    const labelled = [...gallery.querySelectorAll('[role="group"]')].find(
      (each) =>
        document.getElementById(each.getAttribute('aria-labelledby') ?? '')?.textContent === label,
    );
    if (!labelled) throw new Error(`No group ${label}`);
    return names(labelled);
  };
  const card = (name: string) => {
    const found = radios().find((radio) => radio.getAttribute('aria-label') === name);
    if (!found) throw new Error(`No card ${name}`);
    return found;
  };
  const checked = () =>
    radios()
      .filter((radio) => radio.getAttribute('aria-checked') === 'true')
      .map((radio) => radio.getAttribute('aria-label'));
  const choose = (name: string) => act(async () => card(name).click());
  const press = (key: string) =>
    act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  return {
    gallery,
    radios,
    group,
    card,
    checked,
    choose,
    press,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it('lists system, light and dark, then the built-in themes, with no personal cards while none exist', async () => {
  const view = await show();
  try {
    expect(view.group(null)).toEqual([D.system, D.light, D.dark]);
    expect(view.group(D.builtinThemes)).toEqual(BUILTIN_THEMES.map((theme) => theme.palette.name));
    expect(view.group(D.personalThemes)).toEqual([]);
    expect(view.checked()).toEqual([D.system]);
  } finally {
    await view.close();
  }
});

it('adds the personal themes as a third group', async () => {
  const source = BUILTIN_THEMES[0]?.palette;
  if (!source) throw new Error('No built-in theme');
  const saved = addPersonalTheme({ ...source, name: 'My harbor' }, () => 'harbor');
  if (!saved.ok) throw new Error(saved.error);
  const view = await show();
  try {
    expect(view.group(D.personalThemes)).toEqual(['My harbor']);
  } finally {
    await view.close();
  }
});

it('applies and saves a chosen theme at once, and choosing light afterwards clears it', async () => {
  const view = await show();
  try {
    await view.choose('Nord');
    expect(html.style.getPropertyValue('--surface-1')).toBe('#2e3440');
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null)).toMatchObject({
      theme: 'dark',
      palette: 'builtin:nord',
    });
    expect(view.checked()).toEqual(['Nord']);
    await view.choose(D.light);
    expect(html.style.getPropertyValue('--surface-1')).toBe('');
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null)).toMatchObject({
      theme: 'light',
      palette: null,
    });
    expect(view.checked()).toEqual([D.light]);
  } finally {
    await view.close();
  }
});

it('is one radio group: every card is in it, the applied one alone is checked and holds the tab stop', async () => {
  const saved = addPersonalTheme({ ...builtin('nord'), name: 'Harbor' }, () => 'harbor');
  if (!saved.ok) throw new Error(saved.error);
  chooseAppearance('builtin:dracula');
  const view = await show();
  try {
    const groups = view.gallery.querySelectorAll('[role="radiogroup"]');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.querySelectorAll('[role="radio"]')).toHaveLength(
      3 + BUILTIN_THEMES.length + 1,
    );
    expect(view.radios()).toHaveLength(3 + BUILTIN_THEMES.length + 1);
    expect(view.checked()).toEqual(['Dracula']);
    expect(
      view
        .radios()
        .filter((radio) => radio.tabIndex === 0)
        .map((radio) => radio.ariaLabel),
    ).toEqual(['Dracula']);
  } finally {
    await view.close();
  }
});

it("draws each theme's card in that theme's own colors, whatever is applied", async () => {
  chooseAppearance('builtin:dracula');
  const view = await show();
  try {
    expect(html.style.getPropertyValue('--surface-1')).toBe(builtin('dracula').ui.background);
    for (const name of ['Nord', 'Solarized Light', 'Monokai']) {
      const palette = BUILTIN_THEMES.find((theme) => theme.palette.name === name)?.palette;
      const scope = view.card(name).querySelector<HTMLElement>('[data-palette-scope]');
      expect(scope?.style.getPropertyValue('--surface-1')).toBe(palette?.ui.background);
      expect(scope?.style.getPropertyValue('--foreground')).toBe(palette?.ui.foreground);
      expect(scope?.classList.contains(palette?.base ?? '')).toBe(true);
    }
    // Light and dark are the kit's own colors: the scope class alone, no theme values.
    for (const [name, base] of [
      [D.light, 'light'],
      [D.dark, 'dark'],
    ] as const) {
      const scope = view.card(name).querySelector<HTMLElement>('[data-palette-scope]');
      expect(scope?.classList.contains(base)).toBe(true);
      expect(scope?.getAttribute('style')).toBeNull();
    }
  } finally {
    await view.close();
  }
});

it('shows light and dark side by side on the System card', async () => {
  const view = await show();
  try {
    const scopes = [...view.card(D.system).querySelectorAll('[data-palette-scope]')];
    expect(scopes.map((scope) => scope.getAttribute('data-palette-scope'))).toEqual([
      'light',
      'dark',
    ]);
  } finally {
    await view.close();
  }
});

it('moves and applies with the arrow keys, Home and End', async () => {
  chooseAppearance('builtin:monokai');
  const view = await show();
  try {
    await act(async () => view.card('Monokai').focus());
    await view.press('ArrowRight');
    expect(document.activeElement).toBe(view.card('Dracula'));
    expect(view.checked()).toEqual(['Dracula']);
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: 'builtin:dracula' });
    expect(html.style.getPropertyValue('--surface-1')).toBe(builtin('dracula').ui.background);
    await view.press('ArrowLeft');
    await view.press('ArrowLeft');
    expect(view.checked()).toEqual([D.dark]);
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: null });
    await view.press('Home');
    expect(document.activeElement).toBe(view.card(D.system));
    expect(preferences.getState()).toMatchObject({ theme: 'system', palette: null });
    await view.press('End');
    const last = BUILTIN_THEMES.at(-1)?.palette;
    expect(view.checked()).toEqual([last?.name]);
    expect(html.style.getPropertyValue('--surface-1')).toBe(last?.ui.background);
  } finally {
    await view.close();
  }
});

it('ends the personal group with the New theme tile and keeps no separate list of names', async () => {
  for (const [id, name] of [
    ['harbor', 'Harbor'],
    ['dawn', 'Dawn'],
  ] as const) {
    const saved = addPersonalTheme({ ...builtin('nord'), name }, () => id);
    if (!saved.ok) throw new Error(saved.error);
  }
  const view = await show();
  try {
    const personal = view.gallery.querySelector('[data-personal-themes]');
    const tiles = [...(personal?.querySelectorAll('[role="radio"], [data-theme-new]') ?? [])];
    expect(tiles.map((tile) => tile.getAttribute('aria-label') ?? tile.textContent)).toEqual([
      'Harbor',
      'Dawn',
      messages.Themes.newTheme,
    ]);
    expect(tiles.at(-1)?.tagName).toBe('BUTTON');
    expect(personal?.querySelector('ul, ol, li, select')).toBeNull();
    // Each name appears once in the gallery, on its card (what is read, not hidden sizers).
    const read = view.gallery.cloneNode(true) as HTMLElement;
    for (const hidden of read.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    expect(read.textContent?.split('Harbor')).toHaveLength(2);
  } finally {
    await view.close();
  }
});
