// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { PREFERENCES_KEY, parsePreferences, preferences } from '../workbench/preferences.ts';
import { SettingsLeavePrompt, SettingsLifecycle } from '../workbench/SettingsLifecycle.tsx';
import { applyAppearance, chooseAppearance, endPreview } from '../workbench/themes/appearance.ts';
import { BUILTIN_THEMES } from '../workbench/themes/builtin.ts';
import { serializeTheme } from '../workbench/themes/json.ts';
import type { Palette } from '../workbench/themes/palette.ts';
import {
  addPersonalTheme,
  loadPersonalThemes,
  PERSONAL_THEME_LIMIT,
  PERSONAL_THEMES_KEY,
  personalThemes,
} from '../workbench/themes/storage.ts';
import { PALETTE_TOKENS } from '../workbench/themes/tokens.ts';
import { SettingsPage } from './SettingsPage.tsx';

// Personal themes in Settings › General (docs/specs/features/themes.md, 개인 테마 and its
// acceptance scenarios): their cards in the Appearance gallery, the editor with its sample, color
// tiles, kit picker and contrast marks, export, import, delete and the cap.

vi.mock('../services.tsx', () => ({ useServices: () => ({ mode: 'browser' }) }));
vi.mock('../CommandPalette.tsx', () => ({ ShortcutTable: () => null }));
vi.mock('./FilesViews.tsx', () => ({ WorkFolderSection: () => null }));
vi.mock('./ProjectToolSettings.tsx', () => ({ WorkspaceToolSettings: () => null }));
// jsdom has no canvas: the screen's resolved kit colors, by the side showing now.
vi.mock('../workbench/theme-colors.ts', () => ({
  resolvedThemeColors: (names: readonly string[]) => {
    const dark = document.documentElement.classList.contains('dark');
    const screen: Record<string, string> = dark
      ? {
          'surface-1': '#171717',
          foreground: '#f5f5f5',
          'muted-foreground': '#b8b8b8',
          emphasis: '#6b97ff',
          selected: '#525252',
          destructive: '#fca5a5',
          success: '#86efac',
          warning: '#fcd34d',
          info: '#93c5fd',
        }
      : {
          'surface-1': '#fafafa',
          foreground: '#171717',
          'muted-foreground': '#666666',
          emphasis: '#2f5fc4',
          selected: '#d4d4d4',
          destructive: '#b91c1c',
          success: '#166534',
          warning: '#92400e',
          info: '#1d4ed8',
        };
    const syntax: Record<string, string> = {
      'syntax-comment': screen['muted-foreground'] as string,
      'syntax-string': screen.success as string,
      'syntax-number': screen.warning as string,
    };
    return Object.fromEntries(
      names.map((name) => [name, screen[name] ?? syntax[name] ?? screen.foreground]),
    );
  },
}));
// The kit select's options as a native list (the editor's base), each group under its label.
vi.mock('@corral/react/design-kit', async (original) => ({
  ...(await original<typeof import('@corral/react/design-kit')>()),
  Select: ({
    label,
    options,
    value,
    onValueChange,
  }: {
    label: string;
    options: { value: string; label: string; group?: string }[];
    value: string;
    onValueChange: (value: string) => void;
  }) => {
    const groups = [...new Set(options.map((option) => option.group ?? ''))];
    return (
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {groups.map((group) => (
          <optgroup key={group} label={group}>
            {options
              .filter((option) => (option.group ?? '') === group)
              .map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    );
  },
}));

const html = document.documentElement;
// jsdom runs no animations; Base UI asks for them when a popup closes.
Element.prototype.getAnimations ??= () => [];
const builtin = (id: string) => BUILTIN_THEMES.find((theme) => theme.id === id)?.palette as Palette;
const monokai = builtin('monokai');
const latte = builtin('catppuccin-latte');
const T = messages.Themes;

let values: Map<string, string>;
let failThemeWrites: boolean;
beforeEach(() => {
  values = new Map();
  failThemeWrites = false;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no layout; the picker's hue slider observes its own width.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === PERSONAL_THEMES_KEY && failThemeWrites)
        throw new DOMException('full', 'QuotaExceededError');
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  preferences.setState(parsePreferences(null), true);
  loadPersonalThemes();
  applyAppearance();
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  endPreview();
  applyAppearance({ ...parsePreferences(null), theme: 'light' });
  html.className = '';
  html.removeAttribute('style');
  delete html.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  preferences.setState(parsePreferences(null), true);
});

/** Adds a personal theme straight to storage (as if made earlier) and returns its id. */
function stored(palette: Palette, id: string) {
  const saved = addPersonalTheme(palette, () => id);
  if (!saved.ok) throw new Error(saved.error);
  return id;
}

async function flush() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** Settings › General inside the settings lifecycle, open while `?settings=` is in the URL. */
async function show() {
  function Shell() {
    const open = useRouterState({
      select: (state) => Boolean((state.location.search as Record<string, unknown>).settings),
    });
    return (
      <SettingsLifecycle>
        {open ? <SettingsPage section="general" /> : null}
        <SettingsLeavePrompt />
      </SettingsLifecycle>
    );
  }
  const root = createRootRoute({ component: Shell });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/projects/$projectId' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/projects/alpha?settings=general'] }),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  cleanups.push(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
  });
  await act(async () => {
    reactRoot.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>,
    );
    await router.load();
  });
  await flush();
  return { container, router };
}

const all = <E extends Element = HTMLElement>(selector: string) => [
  ...document.querySelectorAll<E & HTMLElement>(selector),
];
/** A button by its accessible name (aria-label) or its text. */
const button = (name: string) =>
  all<HTMLButtonElement>('button').find(
    (each) => (each.getAttribute('aria-label') ?? each.textContent?.trim()) === name,
  ) ?? null;
const must = <T,>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`Missing ${what}`);
  return value;
};
/** A field by its visible label, or by its aria-label. */
const field = (label: string) => {
  const byLabel = all<HTMLLabelElement>('label').find((each) => each.textContent === label);
  const input = byLabel?.htmlFor
    ? document.getElementById(byLabel.htmlFor)
    : document.querySelector(`[aria-label="${label}"]`);
  return must(input as HTMLInputElement | null, `field ${label}`);
};
const editor = () => document.querySelector('[data-theme-editor]');
const prompt = () => document.querySelector('[data-settings-guard]');
/** The personal themes' cards, by name, in the gallery's order. */
const cards = () =>
  all('[data-personal-themes] [role="radio"]').map((card) => card.getAttribute('aria-label'));
const card = (name: string) =>
  must(
    all('[data-appearance] [role="radio"]').find(
      (each) => each.getAttribute('aria-label') === name,
    ),
    `card ${name}`,
  );
const checked = () =>
  all('[data-appearance] [role="radio"]')
    .filter((each) => each.getAttribute('aria-checked') === 'true')
    .map((each) => each.getAttribute('aria-label'));
const newTile = () => must(button(T.newTheme), 'New theme tile');
const tokens = () =>
  Object.fromEntries(PALETTE_TOKENS.map((name) => [name, html.style.getPropertyValue(name)]));
/** What an element's aria-describedby points at, as text. */
const described = (element: Element) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
/** A color's tile in the editor, by its name. */
const tile = (name: string) =>
  must(
    all('[data-theme-editor] [data-color-tile]').find(
      (each) => each.getAttribute('aria-label') === name,
    ),
    `tile ${name}`,
  );
/** The value a tile shows for its color. */
const shownValue = (name: string) => described(tile(name)).match(/#[0-9a-f]{6}/i)?.[0];
/** The open picker (a closing one stays mounted until its exit has played). */
const picker = () =>
  document.querySelector<HTMLElement>('[data-slot="color-picker-popup"][data-open]');
const slider = (popup: Element) =>
  must(popup.querySelector<HTMLInputElement>('input[type="range"]'), 'hue slider');
const hexField = () =>
  must(picker()?.querySelector<HTMLInputElement>(`input[aria-label="${T.hex}"]`), 'hex field');

async function click(element: HTMLElement | null) {
  await act(async () => must(element, 'element to click').click());
  await flush();
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function blur(input: HTMLInputElement) {
  await act(async () => input.blur());
}
async function pressEscape(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await flush();
}
/** Waits out a popup's exit. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}
/** Opens a color's picker from its tile (closing one already open) and returns the popup. */
async function openPicker(name: string) {
  const shown = picker();
  if (shown) {
    await pressEscape(must(shown.querySelector<HTMLElement>('input'), 'hex field'));
    await settle();
  }
  await click(tile(name));
  const popup = must(picker(), `picker for ${name}`);
  expect(popup.getAttribute('aria-label')).toBe(name);
  return popup;
}
/** Types a value into a color's picker (it applies as soon as it is a whole #rrggbb). */
async function typeColor(name: string, value: string) {
  if (picker()?.getAttribute('aria-label') !== name) await openPicker(name);
  await type(hexField(), value);
}
/** A menu item's label, without the hidden copy the kit keeps for its width. */
const itemLabel = (item: Element) => {
  const read = item.cloneNode(true) as Element;
  for (const hidden of read.querySelectorAll('.invisible, [aria-hidden="true"]')) hidden.remove();
  return read.textContent?.trim();
};
/** Picks a card menu's item: Edit, Export or Delete. */
async function cardAction(name: string, action: string) {
  await click(button(T.actionsNamed.replace('{name}', name)));
  const item = all('[role="menuitem"]').find((each) => itemLabel(each) === action);
  await click(must(item, `${action} in the menu of ${name}`));
  // The menu hands focus back once its exit has played, before anything else is pressed.
  await settle();
}
async function chooseFile(contents: BlobPart, name = 'theme.json') {
  const input = must(
    document.querySelector<HTMLInputElement>('[data-personal-themes] input[type="file"]'),
    'file input',
  );
  const file = new File([contents], name, { type: 'application/json' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}
/** The reason shown beside Import, and that Import points to it. */
function importReason() {
  const alert = document.querySelector('[data-personal-themes] [role="alert"]');
  const describedBy = button(T.import)?.getAttribute('aria-describedby') ?? '';
  expect(alert?.id && describedBy.split(' ')).toContain(alert?.id);
  return alert?.textContent ?? '';
}

describe('the personal themes in the gallery', () => {
  it('are their label, Import and the New theme tile while there are none', async () => {
    await show();
    const group = must(document.querySelector('[data-personal-themes]'), 'personal group');
    const label = document.getElementById(group.getAttribute('aria-labelledby') ?? '');
    expect(label?.textContent).toBe(messages.Desktop.personalThemes);
    expect(button(T.newTheme)).not.toBeNull();
    expect(button(T.import)).not.toBeNull();
    expect(cards()).toEqual([]);
    expect(group.querySelector('ul, li, p')).toBeNull();
  });

  it('show each theme as a card of the one choice, with Edit, Export and Delete in its menu', async () => {
    stored({ ...monokai, name: 'Harbor' }, 'harbor');
    stored({ ...latte, name: 'Dawn' }, 'dawn');
    stored({ ...monokai, name: 'Ember' }, 'ember');
    await show();
    expect(cards()).toEqual(['Harbor', 'Dawn', 'Ember']);
    expect(document.querySelectorAll('[data-appearance] [role="radiogroup"]')).toHaveLength(1);
    for (const name of ['Harbor', 'Dawn', 'Ember']) {
      const menu = must(button(T.actionsNamed.replace('{name}', name)), `menu of ${name}`);
      // The menu is the card's neighbour, never inside the radio.
      expect(menu.closest('[role="radio"]')).toBeNull();
      await click(menu);
      expect(all('[role="menuitem"]').map(itemLabel)).toEqual([T.edit, T.export, T.delete]);
      await pressEscape(must(document.activeElement as HTMLElement, 'focus in the menu'));
    }
  });
});

describe('a new theme', () => {
  it('copies the applied built-in theme; saving with only the name changed keeps every token', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    const before = tokens();
    await click(newTile());
    expect(editor()).not.toBeNull();
    const name = field(T.name);
    expect(name.value).toBe('Monokai (2)');
    expect(document.activeElement).toBe(name);
    expect(shownValue(T.ui.background)).toBe(monokai.ui.background);
    expect(tokens()).toEqual(before);
    await type(name, 'Harbor');
    await click(button(T.save));
    expect(editor()).toBeNull();
    expect(cards()).toEqual(['Harbor']);
    const [saved] = personalThemes.getState();
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: `custom:${saved?.id}` });
    expect(tokens()).toEqual(before);
    expect(checked()).toEqual(['Harbor']);
    // Focus goes back to the tile that opened the editor.
    expect(document.activeElement).toBe(newTile());
  });

  it('under system copies the side showing now, named after it', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('dark'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    applyAppearance();
    expect(html.classList.contains('dark')).toBe(true);
    await show();
    await click(newTile());
    expect(field(T.name).value).toBe('Dark (2)');
    expect(field(T.base).value).toBe('dark');
    expect(shownValue(T.ui.background)).toBe('#171717');
    expect(shownValue(T.ui.muted)).toBe('#b8b8b8');
    expect(shownValue(T.syntax.comment)).toBe('#b8b8b8');
    expect(shownValue(T.terminal.red)).toBe('#cc0000');
    await click(button(T.save));
    const [saved] = personalThemes.getState();
    expect(saved?.palette).toMatchObject({ name: 'Dark (2)', base: 'dark' });
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: `custom:${saved?.id}` });
  });
});

describe('the editor', () => {
  it('previews a typed color at once, and cancel with discard restores the earlier theme', async () => {
    chooseAppearance('builtin:nord');
    await show();
    const before = tokens();
    await click(newTile());
    // About 3:1 on Nord's background.
    await typeColor(T.ui.muted, '#7e7e7e');
    expect(html.style.getPropertyValue('--muted-foreground')).toBe('#7e7e7e');
    expect(shownValue(T.ui.muted)).toBe('#7e7e7e');
    await click(button(T.cancel));
    expect(prompt()).not.toBeNull();
    expect(editor()).not.toBeNull();
    await click(button(messages.SettingsDialog.discard));
    expect(editor()).toBeNull();
    expect(tokens()).toEqual(before);
    expect(preferences.getState().palette).toBe('builtin:nord');
    expect(values.has(PERSONAL_THEMES_KEY)).toBe(false);
    expect(cards()).toEqual([]);
    expect(document.activeElement).toBe(newTile());
  });

  it('Escape closes an open picker first, then asks the same; keep editing leaves the draft on screen', async () => {
    chooseAppearance('builtin:nord');
    await show();
    const before = tokens();
    await click(newTile());
    await typeColor(T.ui.muted, '#7e7e7e');
    await pressEscape(hexField());
    await settle();
    expect(picker()).toBeNull();
    expect(document.querySelector('[data-slot="color-picker-popup"]')).toBeNull();
    expect(tile(T.ui.muted).getAttribute('aria-expanded')).toBe('false');
    expect(prompt()).toBeNull();
    expect(editor()).not.toBeNull();
    await pressEscape(tile(T.ui.muted));
    expect(prompt()).not.toBeNull();
    await click(button(messages.SettingsDialog.keepEditing));
    expect(editor()).not.toBeNull();
    expect(html.style.getPropertyValue('--muted-foreground')).toBe('#7e7e7e');
    await pressEscape(field(T.name));
    await click(button(messages.SettingsDialog.discard));
    expect(editor()).toBeNull();
    expect(tokens()).toEqual(before);
    expect(values.has(PERSONAL_THEMES_KEY)).toBe(false);
  });

  it('cancel and Escape with nothing changed ask nothing', async () => {
    await show();
    await click(newTile());
    await click(button(T.cancel));
    expect(prompt()).toBeNull();
    expect(editor()).toBeNull();
    await click(newTile());
    await pressEscape(field(T.name));
    expect(prompt()).toBeNull();
    expect(editor()).toBeNull();
  });

  it('guards closing settings while it has changes, and a discard leaves no draft applied', async () => {
    chooseAppearance('builtin:monokai');
    const { router } = await show();
    const before = tokens();
    await click(newTile());
    await typeColor(T.ui.background, '#101010');
    expect(html.style.getPropertyValue('--surface-1')).toBe('#101010');
    // Closing the dialog leaves `?settings=` (navigation.close navigates there).
    const close = () =>
      act(async () => {
        router.history.push('/projects/alpha');
      });
    await close();
    await flush();
    expect(prompt()).not.toBeNull();
    await click(button(messages.SettingsDialog.keepEditing));
    expect(editor()).not.toBeNull();
    expect(router.state.location.search).toEqual({ settings: 'general' });
    expect(html.style.getPropertyValue('--surface-1')).toBe('#101010');
    await close();
    await flush();
    await click(button(messages.SettingsDialog.discard));
    await flush();
    expect(router.state.location.search).toEqual({});
    expect(editor()).toBeNull();
    expect(document.querySelector('[data-personal-themes]')).toBeNull();
    expect(tokens()).toEqual(before);
    expect(values.has(PERSONAL_THEMES_KEY)).toBe(false);
  });

  it('opens the kit picker from a tile: a typed #rrggbb applies; #12345 and red are marked there and never reach the draft or storage; upper case is stored lower case', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(newTile());
    const info = tile(T.ui.info);
    const popup = await openPicker(T.ui.info);
    expect(info.getAttribute('aria-expanded')).toBe('true');
    // Opaque and hex only: one value field, the area and the hue, no alpha and no format menu.
    expect(popup.querySelectorAll('input:not([type="range"])')).toHaveLength(1);
    expect([...popup.querySelectorAll('input[type="range"]')].map((s) => s.ariaLabel)).toEqual([
      T.hue,
    ]);
    expect(popup.querySelector(`[aria-label="${T.area}"]`)).not.toBeNull();
    expect(hexField().value.toLowerCase()).toBe(monokai.ui.info.slice(1));
    for (const bad of ['#12345', 'red']) {
      await type(hexField(), bad);
      await blur(hexField());
      expect(hexField().getAttribute('aria-invalid')).toBe('true');
      expect(described(hexField())).toBe(T.hexInvalid.replace('{format}', '#rrggbb'));
      expect(html.style.getPropertyValue('--info')).toBe(monokai.ui.info);
      expect(shownValue(T.ui.info)).toBe(monokai.ui.info);
    }
    // Saving now stores the color the tile shows, never the text that did not apply.
    await type(field(T.name), 'Kept info');
    await click(button(T.save));
    expect(editor()).toBeNull();
    expect(personalThemes.getState()[0]?.palette.ui.info).toBe(monokai.ui.info);
    await cardAction('Kept info', T.edit);
    await typeColor(T.ui.info, '#ABCDEF');
    expect(hexField().hasAttribute('aria-invalid')).toBe(false);
    expect(html.style.getPropertyValue('--info')).toBe('#abcdef');
    expect(shownValue(T.ui.info)).toBe('#abcdef');
    await click(button(T.save));
    expect(personalThemes.getState()[0]?.palette.ui.info).toBe('#abcdef');
    expect(values.get(PERSONAL_THEMES_KEY)).not.toMatch(/#ABCDEF/);
  });

  it('keeps the picker, the hex field and the draft in step', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(newTile());
    const hue = slider(await openPicker(T.syntax.keyword));
    const before = hexField().value;
    await act(async () => {
      hue.focus();
      hue.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await flush();
    const moved = `#${hexField().value.toLowerCase()}`;
    expect(moved).not.toBe(`#${before.toLowerCase()}`);
    expect(html.style.getPropertyValue('--syntax-keyword')).toBe(moved);
    expect(shownValue(T.syntax.keyword)).toBe(moved);
    await type(hexField(), '#00ff00');
    expect(hue.getAttribute('aria-valuenow')).toBe('120');
    expect(shownValue(T.syntax.keyword)).toBe('#00ff00');
  });

  it("offers the draft's other colors as swatches, so a related color is one press away", async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(newTile());
    const popup = await openPicker(T.ui.warning);
    const yellow = must(
      popup.querySelector<HTMLElement>(`button[aria-label="${T.terminal.yellow}"]`),
      'terminal yellow swatch',
    );
    await click(yellow);
    expect(html.style.getPropertyValue('--warning')).toBe(monokai.terminal[3]);
    expect(shownValue(T.ui.warning)).toBe(monokai.terminal[3]);
  });

  it('shows the contrast of a text color in its picker, and beside its tile only under 4.5:1, in words; saving is never blocked', async () => {
    chooseAppearance('builtin:nord');
    await show();
    await click(newTile());
    const contrast = () => picker()?.querySelector('[data-contrast]')?.textContent ?? '';
    const mark = () => tile(T.ui.muted).querySelector('[data-low-contrast]');
    await typeColor(T.ui.muted, '#9e9e9e');
    expect(contrast()).toContain(T.contrast);
    expect(contrast()).toContain('4.6:1');
    expect(contrast()).not.toContain(T.low);
    // A color that passes shows nothing beside its tile.
    expect(mark()).toBeNull();
    expect(described(tile(T.ui.muted))).not.toContain(':1');
    await type(hexField(), '#7e7e7e');
    expect(contrast()).toContain('3.0:1');
    expect(contrast()).toContain(T.low);
    expect(mark()?.textContent).toContain('3.0:1');
    expect(mark()?.textContent).toContain(T.low);
    expect(described(tile(T.ui.muted))).toContain(T.low);
    // Background, selection and the code and terminal colors are not judged as text.
    const judged = all('[data-theme-editor] [data-color-tile]')
      .filter((each) => each.querySelector('[data-low-contrast]'))
      .map((each) => each.ariaLabel);
    expect(judged).toEqual([T.ui.muted]);
    await openPicker(T.ui.background);
    expect(contrast()).toBe('');
    await click(button(T.save));
    expect(editor()).toBeNull();
    expect(personalThemes.getState()[0]?.palette.ui.muted).toBe('#7e7e7e');
  });

  it('draws a low contrast mark in a color that reads on the draft, even when the text color is the one judged', async () => {
    chooseAppearance('builtin:nord');
    await show();
    await click(newTile());
    // Nord's floor is #2e3440: this text all but disappears on it.
    await typeColor(T.ui.foreground, '#3b4252');
    const mark = must(
      tile(T.ui.foreground).querySelector<HTMLElement>('[data-low-contrast]'),
      'low contrast mark',
    );
    expect(mark.style.color).toBe('rgb(255, 255, 255)');
    expect(picker()?.querySelector<HTMLElement>('[data-contrast]')?.style.color).toBe(
      'rgb(255, 255, 255)',
    );
  });

  it('lays the terminal colors out as two rows of eight tiles, named by color', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(newTile());
    const rows = all('[data-theme-editor] [data-terminal-row]');
    expect(rows.map((row) => row.dataset.terminalRow)).toEqual(['normal', 'bright']);
    const names = Object.values(T.terminal);
    expect(
      rows.map((row) =>
        [...row.querySelectorAll('[data-color-tile]')].map((each) => each.ariaLabel),
      ),
    ).toEqual([names.slice(0, 8), names.slice(8)]);
    expect(names.map(shownValue)).toEqual(monokai.terminal);
    await typeColor(T.terminal.brightBlue, '#123456');
    expect(shownValue(T.terminal.brightBlue)).toBe('#123456');
    const sample = must(editor()?.querySelector('[role="img"]'), 'sample');
    expect(
      sample.querySelector<HTMLElement>('[data-terminal-color="12"]')?.style.backgroundColor,
    ).toBe('rgb(18, 52, 86)');
  });

  it('says so when storage refuses the save, and keeps the editor and the changes', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(newTile());
    await typeColor(T.ui.background, '#101010');
    await type(field(T.name), 'Kept');
    failThemeWrites = true;
    await click(button(T.save));
    expect(editor()?.querySelector('[role="alert"]')?.textContent).toBe(T.saveFailed);
    expect(field(T.name).value).toBe('Kept');
    expect(shownValue(T.ui.background)).toBe('#101010');
    expect(html.style.getPropertyValue('--surface-1')).toBe('#101010');
    expect(personalThemes.getState()).toEqual([]);
    expect(preferences.getState().palette).toBe('builtin:monokai');
    failThemeWrites = false;
    await click(button(T.save));
    expect(editor()).toBeNull();
    expect(cards()).toEqual(['Kept']);
  });

  it('saving the applied theme keeps it applied with the new colors', async () => {
    const id = stored({ ...monokai, name: 'Mine' }, 'mine');
    chooseAppearance(`custom:${id}`);
    await show();
    await cardAction('Mine', T.edit);
    expect(editor()?.querySelector('h3')?.textContent).toBe(T.editTheme);
    await typeColor(T.ui.background, '#202020');
    await click(button(T.save));
    expect(editor()).toBeNull();
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: 'custom:mine' });
    expect(html.style.getPropertyValue('--surface-1')).toBe('#202020');
    expect(personalThemes.getState()[0]?.palette.ui.background).toBe('#202020');
    // Focus goes back to the card whose menu opened the editor.
    expect(document.activeElement).toBe(card('Mine'));
  });

  it("refuses a name another personal theme has, and keeps the theme's own name", async () => {
    stored({ ...monokai, name: 'Mine' }, 'mine');
    stored({ ...monokai, name: 'Other' }, 'other');
    await show();
    await cardAction('Other', T.edit);
    const name = field(T.name);
    await type(name, ' Mine ');
    await click(button(T.save));
    expect(editor()).not.toBeNull();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(editor()?.textContent).toContain(T.nameTaken);
    expect(document.activeElement).toBe(name);
    expect(personalThemes.getState().map((theme) => theme.palette.name)).toEqual(['Mine', 'Other']);
    // Its own name is not another theme's.
    await type(name, 'Other');
    await typeColor(T.ui.background, '#202020');
    await click(button(T.save));
    expect(editor()).toBeNull();
  });

  it('shows a sample of the draft: a sidebar with its chosen row, text, status marks, code, the sixteen terminal colors and two buttons', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(newTile());
    const sample = must(editor()?.querySelector('[role="img"]'), 'sample');
    expect(sample.getAttribute('aria-label')).toBe(T.sample);
    expect(sample.querySelector('[data-sample-selected]')?.textContent).toBe(T.sampleRows.second);
    expect(sample.textContent).toContain(T.sampleBody);
    expect(sample.textContent).toContain(T.sampleMuted);
    for (const status of [T.ui.success, T.ui.warning, T.ui.error, T.ui.info, T.ui.emphasis])
      expect(sample.textContent).toContain(status);
    expect(sample.querySelector('code')?.textContent).toContain(T.sampleComment);
    expect(sample.querySelectorAll('[data-terminal-color]')).toHaveLength(16);
    expect([...sample.querySelectorAll('button')].map((each) => each.textContent)).toEqual([
      T.samplePrimary,
      T.sampleSecondary,
    ]);
    // A picture, not controls: nothing in it takes focus.
    expect(sample.querySelector('[inert]')).not.toBeNull();
  });
});

describe('export and import', () => {
  it('exports a theme and imports it back as one more theme with a numbered name', async () => {
    const harbor = { ...monokai, name: 'Harbor' };
    stored(harbor, 'harbor');
    chooseAppearance('builtin:dracula');
    await show();
    const before = tokens();
    const files: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      files.push(blob as Blob);
      return 'blob:theme';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    await cardAction('Harbor', T.export);
    expect(names).toEqual(['Harbor.json']);
    const exported = await must(files[0], 'exported file').text();
    expect(exported).toBe(serializeTheme(harbor));
    await chooseFile(exported, 'Harbor.json');
    expect(cards()).toEqual(['Harbor', 'Harbor (2)']);
    const copy = personalThemes.getState()[1];
    expect(copy?.palette).toEqual({ ...harbor, name: 'Harbor (2)' });
    expect(preferences.getState().palette).toBe('builtin:dracula');
    expect(tokens()).toEqual(before);
    expect(checked()).toEqual(['Dracula']);
    // Focus is on the new card.
    expect(document.activeElement).toBe(card('Harbor (2)'));
  });

  const file = (change: (theme: Record<string, unknown>) => void) => {
    const theme = JSON.parse(serializeTheme({ ...monokai, name: 'Evil name' }));
    change(theme);
    return JSON.stringify(theme);
  };
  it.each([
    [
      'a color that is not #rrggbb',
      file((theme) => {
        (theme.ui as Record<string, string>).error = 'red; background: url(https://x.test/a)';
      }),
      T.importError.color.replace('{format}', '#rrggbb'),
    ],
    [
      'an extra field',
      file((theme) => {
        theme.evil = 'payload';
      }),
      T.importError.fields,
    ],
    [
      'fifteen terminal colors',
      file((theme) => {
        (theme.terminal as string[]).pop();
      }),
      T.importError.terminal.replace('{count}', '16'),
    ],
    ['a file over 64 KB', ' '.repeat(64 * 1024 + 1), T.importError['too-large']],
    ['a file that is not JSON', '{ "corralTheme": 1, evil', T.importError['not-theme']],
  ])(
    'rejects %s, adds nothing and names the problem without echoing the file',
    async (_, contents, reason) => {
      await show();
      await chooseFile(contents);
      expect(personalThemes.getState()).toEqual([]);
      expect(values.has(PERSONAL_THEMES_KEY)).toBe(false);
      expect(cards()).toEqual([]);
      const shown = importReason();
      expect(shown).toBe(reason);
      for (const echoed of ['Evil', 'evil', 'url(', 'payload']) expect(shown).not.toContain(echoed);
    },
  );
});

describe('the cap of twenty', () => {
  it('disables the New theme tile and Import with the reason reachable', async () => {
    for (let index = 0; index < PERSONAL_THEME_LIMIT; index++)
      stored({ ...monokai, name: `Theme ${index}` }, `theme-${index}`);
    await show();
    const reason = T.limit.replace('{limit}', '20');
    const file = must(
      document.querySelector<HTMLInputElement>('[data-personal-themes] input[type="file"]'),
      'file input',
    );
    const opened = vi.spyOn(file, 'click');
    for (const name of [T.newTheme, T.import]) {
      const control = must(button(name), name);
      expect(control.getAttribute('aria-disabled')).toBe('true');
      // Still in the tab order, so the reason can be reached.
      expect(control.disabled).toBe(false);
      expect(described(control)).toContain(reason);
      await click(control);
    }
    expect(editor()).toBeNull();
    expect(opened).not.toHaveBeenCalled();
    expect(document.querySelector('[data-personal-themes]')?.textContent).toContain(reason);
  });
});

describe('deleting', () => {
  it('confirms first; the applied theme goes back to the light or dark of its base', async () => {
    const id = stored({ ...latte, name: 'Dawn' }, 'dawn');
    chooseAppearance(`custom:${id}`);
    await show();
    await cardAction('Dawn', T.delete);
    const dialog = must(document.querySelector('[role="dialog"]'), 'confirmation');
    expect(dialog.textContent).toContain(T.deleteTitle.replace('{name}', 'Dawn'));
    await click(button(T.cancel));
    expect(cards()).toEqual(['Dawn']);
    await cardAction('Dawn', T.delete);
    await click(button(T.delete));
    expect(cards()).toEqual([]);
    expect(preferences.getState()).toMatchObject({ theme: 'light', palette: null });
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null).palette).toBeNull();
    expect(Object.values(tokens()).filter(Boolean)).toEqual([]);
    expect(html.classList.contains('light')).toBe(true);
    expect(checked()).toEqual([messages.Desktop.light]);
    // The last personal theme is gone: focus goes to the New theme tile.
    expect(document.activeElement).toBe(newTile());
  });

  it('a dark-based theme goes back to dark, and focus moves to the next card', async () => {
    stored({ ...monokai, name: 'Harbor' }, 'harbor');
    const id = stored({ ...monokai, name: 'Ember' }, 'ember');
    stored({ ...latte, name: 'Dawn' }, 'dawn');
    chooseAppearance(`custom:${id}`);
    await show();
    await cardAction('Ember', T.delete);
    await click(button(T.delete));
    expect(cards()).toEqual(['Harbor', 'Dawn']);
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: null });
    expect(html.classList.contains('dark')).toBe(true);
    expect(document.activeElement).toBe(card('Dawn'));
  });
});
