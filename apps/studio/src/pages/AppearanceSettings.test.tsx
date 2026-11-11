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
// acceptance scenarios): the list under Appearance, the editor with its live preview and
// contrast marks, export, import, delete and the cap.

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
// The kit select's options as a native list, each group under its label.
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
const rows = () => all('[data-personal-themes] li').map((row) => row.textContent?.trim());
const appearance = () => must(field(messages.Desktop.appearance), 'appearance select');
const personalGroup = () =>
  [
    ...(appearance().querySelector(`optgroup[label="${messages.Desktop.personalThemes}"]`)
      ?.children ?? []),
  ].map((option) => option.textContent);
const tokens = () =>
  Object.fromEntries(PALETTE_TOKENS.map((name) => [name, html.style.getPropertyValue(name)]));

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

describe('the personal theme list', () => {
  it('is only its head while there are no personal themes', async () => {
    await show();
    const section = must(document.querySelector('[data-personal-themes]'), 'list');
    expect(section.querySelector('h3')?.textContent).toBe(messages.Desktop.personalThemes);
    expect(button(T.newTheme)).not.toBeNull();
    expect(button(T.import)).not.toBeNull();
    expect(section.querySelector('ul, li, p')).toBeNull();
    expect(personalGroup()).toEqual([]);
  });

  it('shows each theme with edit, export and delete, and lists them in the picker', async () => {
    stored({ ...monokai, name: 'Harbor' }, 'harbor');
    stored({ ...latte, name: 'Dawn' }, 'dawn');
    stored({ ...monokai, name: 'Ember' }, 'ember');
    await show();
    expect(rows()).toEqual(['Harbor', 'Dawn', 'Ember']);
    for (const name of ['Harbor', 'Dawn', 'Ember'])
      for (const action of [T.editNamed, T.exportNamed, T.deleteNamed])
        expect(button(action.replace('{name}', name))).not.toBeNull();
    expect(personalGroup()).toEqual(['Harbor', 'Dawn', 'Ember']);
  });
});

describe('a new theme', () => {
  it('copies the applied built-in theme; saving with only the name changed keeps every token', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    const before = tokens();
    await click(button(T.newTheme));
    expect(editor()).not.toBeNull();
    const name = field(T.name);
    expect(name.value).toBe('Monokai (2)');
    expect(document.activeElement).toBe(name);
    expect(field(T.ui.background).value).toBe(monokai.ui.background);
    expect(tokens()).toEqual(before);
    await type(name, 'Harbor');
    await click(button(T.save));
    expect(editor()).toBeNull();
    expect(rows()).toEqual(['Harbor']);
    const [saved] = personalThemes.getState();
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: `custom:${saved?.id}` });
    expect(tokens()).toEqual(before);
    expect(appearance().value).toBe(`custom:${saved?.id}`);
    expect(personalGroup()).toEqual(['Harbor']);
    // Focus goes back to the control that opened the editor.
    expect(document.activeElement).toBe(button(T.newTheme));
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
    await click(button(T.newTheme));
    expect(field(T.name).value).toBe('Dark (2)');
    expect(field(T.base).value).toBe('dark');
    expect(field(T.ui.background).value).toBe('#171717');
    expect(field(T.ui.muted).value).toBe('#b8b8b8');
    expect(field(T.syntax.comment).value).toBe('#b8b8b8');
    expect(field(T.terminal.red).value).toBe('#cc0000');
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
    await click(button(T.newTheme));
    // About 3:1 on Nord's background.
    await type(field(T.ui.muted), '#7e7e7e');
    expect(html.style.getPropertyValue('--muted-foreground')).toBe('#7e7e7e');
    await click(button(T.cancel));
    expect(prompt()).not.toBeNull();
    expect(editor()).not.toBeNull();
    await click(button(messages.SettingsDialog.discard));
    expect(editor()).toBeNull();
    expect(tokens()).toEqual(before);
    expect(preferences.getState().palette).toBe('builtin:nord');
    expect(values.has(PERSONAL_THEMES_KEY)).toBe(false);
    expect(rows()).toEqual([]);
    expect(document.activeElement).toBe(button(T.newTheme));
  });

  it('Escape asks the same, and keep editing leaves the draft on screen', async () => {
    chooseAppearance('builtin:nord');
    await show();
    const before = tokens();
    await click(button(T.newTheme));
    const muted = field(T.ui.muted);
    await type(muted, '#7e7e7e');
    await pressEscape(muted);
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
    await click(button(T.newTheme));
    await click(button(T.cancel));
    expect(prompt()).toBeNull();
    expect(editor()).toBeNull();
    await click(button(T.newTheme));
    await pressEscape(field(T.name));
    expect(prompt()).toBeNull();
    expect(editor()).toBeNull();
  });

  it('guards closing settings while it has changes, and a discard leaves no draft applied', async () => {
    chooseAppearance('builtin:monokai');
    const { router } = await show();
    const before = tokens();
    await click(button(T.newTheme));
    await type(field(T.ui.background), '#101010');
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

  it('marks #12345 and red as invalid and does not apply them; upper case applies and is stored lower case', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(button(T.newTheme));
    const info = field(T.ui.info);
    for (const bad of ['#12345', 'red']) {
      await type(info, bad);
      await blur(info);
      expect(info.getAttribute('aria-invalid')).toBe('true');
      expect(html.style.getPropertyValue('--info')).toBe(monokai.ui.info);
    }
    // Saving with an invalid color saves nothing and goes to the field.
    await click(button(T.save));
    expect(editor()).not.toBeNull();
    expect(personalThemes.getState()).toEqual([]);
    expect(document.activeElement).toBe(info);
    await type(info, '#ABCDEF');
    await blur(info);
    expect(info.hasAttribute('aria-invalid')).toBe(false);
    expect(html.style.getPropertyValue('--info')).toBe('#abcdef');
    await click(button(T.save));
    expect(personalThemes.getState()[0]?.palette.ui.info).toBe('#abcdef');
    expect(values.get(PERSONAL_THEMES_KEY)).not.toMatch(/#ABCDEF/);
  });

  it('keeps the picker and the hex field in step', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(button(T.newTheme));
    const picker = field(T.pick.replace('{name}', T.syntax.keyword));
    expect(picker.type).toBe('color');
    expect(picker.value).toBe(monokai.syntax.keyword);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(picker, '#123abc');
      picker.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(field(T.syntax.keyword).value).toBe('#123abc');
    expect(html.style.getPropertyValue('--syntax-keyword')).toBe('#123abc');
    await type(field(T.syntax.keyword), '#00ff00');
    expect(picker.value).toBe('#00ff00');
  });

  it('shows the contrast of a text color and marks it under 4.5:1 in words; saving is never blocked', async () => {
    chooseAppearance('builtin:nord');
    await show();
    await click(button(T.newTheme));
    const muted = field(T.ui.muted);
    const contrast = () =>
      (muted.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    await type(muted, '#7e7e7e');
    expect(contrast()).toContain('3.0:1');
    expect(contrast()).toContain(T.low);
    await type(muted, '#9e9e9e');
    expect(contrast()).toContain('4.6:1');
    expect(contrast()).not.toContain(T.low);
    // Background and selection are not text colors.
    expect(field(T.ui.background).getAttribute('aria-describedby')).toBeNull();
    await type(muted, '#7e7e7e');
    await click(button(T.save));
    expect(editor()).toBeNull();
    expect(personalThemes.getState()[0]?.palette.ui.muted).toBe('#7e7e7e');
  });

  it('says so when storage refuses the save, and keeps the editor and the changes', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(button(T.newTheme));
    await type(field(T.ui.background), '#101010');
    await type(field(T.name), 'Kept');
    failThemeWrites = true;
    await click(button(T.save));
    expect(editor()?.querySelector('[role="alert"]')?.textContent).toBe(T.saveFailed);
    expect(field(T.name).value).toBe('Kept');
    expect(field(T.ui.background).value).toBe('#101010');
    expect(html.style.getPropertyValue('--surface-1')).toBe('#101010');
    expect(personalThemes.getState()).toEqual([]);
    expect(preferences.getState().palette).toBe('builtin:monokai');
    failThemeWrites = false;
    await click(button(T.save));
    expect(editor()).toBeNull();
    expect(rows()).toEqual(['Kept']);
  });

  it('saving the applied theme keeps it applied with the new colors', async () => {
    const id = stored({ ...monokai, name: 'Mine' }, 'mine');
    chooseAppearance(`custom:${id}`);
    await show();
    await click(button(T.editNamed.replace('{name}', 'Mine')));
    expect(editor()?.querySelector('h3')?.textContent).toBe(T.editTheme);
    await type(field(T.ui.background), '#202020');
    await click(button(T.save));
    expect(editor()).toBeNull();
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: 'custom:mine' });
    expect(html.style.getPropertyValue('--surface-1')).toBe('#202020');
    expect(personalThemes.getState()[0]?.palette.ui.background).toBe('#202020');
    expect(document.activeElement).toBe(button(T.editNamed.replace('{name}', 'Mine')));
  });

  it('shows a sample of the draft: text, status marks, code and the sixteen terminal colors', async () => {
    chooseAppearance('builtin:monokai');
    await show();
    await click(button(T.newTheme));
    const sample = must(editor()?.querySelector('[role="img"]'), 'sample');
    expect(sample.getAttribute('aria-label')).toBe(T.sample);
    expect(sample.textContent).toContain(T.sampleBody);
    expect(sample.textContent).toContain(T.sampleMuted);
    expect(sample.querySelectorAll('[data-terminal-color]')).toHaveLength(16);
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
    await click(button(T.exportNamed.replace('{name}', 'Harbor')));
    expect(names).toEqual(['Harbor.json']);
    const exported = await must(files[0], 'exported file').text();
    expect(exported).toBe(serializeTheme(harbor));
    await chooseFile(exported, 'Harbor.json');
    expect(rows()).toEqual(['Harbor', 'Harbor (2)']);
    const copy = personalThemes.getState()[1];
    expect(copy?.palette).toEqual({ ...harbor, name: 'Harbor (2)' });
    expect(preferences.getState().palette).toBe('builtin:dracula');
    expect(tokens()).toEqual(before);
    expect(personalGroup()).toEqual(['Harbor', 'Harbor (2)']);
    // Focus is on the new row.
    expect(document.activeElement?.closest('li')?.textContent).toContain('Harbor (2)');
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
      expect(rows()).toEqual([]);
      const shown = importReason();
      expect(shown).toBe(reason);
      for (const echoed of ['Evil', 'evil', 'url(', 'payload']) expect(shown).not.toContain(echoed);
    },
  );
});

describe('the cap of twenty', () => {
  it('disables New theme and Import with the reason reachable', async () => {
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
      const describedBy = control.getAttribute('aria-describedby') ?? '';
      expect(
        describedBy
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent)
          .join(' '),
      ).toContain(reason);
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
    await click(button(T.deleteNamed.replace('{name}', 'Dawn')));
    const dialog = must(document.querySelector('[role="dialog"]'), 'confirmation');
    expect(dialog.textContent).toContain(T.deleteTitle.replace('{name}', 'Dawn'));
    await click(button(T.cancel));
    expect(rows()).toEqual(['Dawn']);
    await click(button(T.deleteNamed.replace('{name}', 'Dawn')));
    await click(button(T.delete));
    expect(rows()).toEqual([]);
    expect(preferences.getState()).toMatchObject({ theme: 'light', palette: null });
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null).palette).toBeNull();
    expect(Object.values(tokens()).filter(Boolean)).toEqual([]);
    expect(html.classList.contains('light')).toBe(true);
    expect(document.activeElement).toBe(button(T.newTheme));
  });

  it('a dark-based theme goes back to dark, and focus moves to the next row', async () => {
    stored({ ...monokai, name: 'Harbor' }, 'harbor');
    const id = stored({ ...monokai, name: 'Ember' }, 'ember');
    stored({ ...latte, name: 'Dawn' }, 'dawn');
    chooseAppearance(`custom:${id}`);
    await show();
    await click(button(T.deleteNamed.replace('{name}', 'Ember')));
    await click(button(T.delete));
    expect(rows()).toEqual(['Harbor', 'Dawn']);
    expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: null });
    expect(html.classList.contains('dark')).toBe(true);
    expect(document.activeElement).toBe(button(T.editNamed.replace('{name}', 'Dawn')));
  });
});
