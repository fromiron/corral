// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { PREFERENCES_KEY, parsePreferences, preferences } from '../workbench/preferences.ts';
import { applyAppearance } from '../workbench/themes/appearance.ts';
import { BUILTIN_THEMES } from '../workbench/themes/builtin.ts';
import { addPersonalTheme, loadPersonalThemes } from '../workbench/themes/storage.ts';
import { SettingsPage } from './SettingsPage.tsx';

vi.mock('../services.tsx', () => ({ useServices: () => ({ mode: 'browser' }) }));
vi.mock('../CommandPalette.tsx', () => ({ ShortcutTable: () => null }));
vi.mock('./FilesViews.tsx', () => ({ WorkFolderSection: () => null }));
vi.mock('./ProjectToolSettings.tsx', () => ({ WorkspaceToolSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
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
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Appearance"]');
  if (!select) throw new Error('No appearance select');
  const groups = () =>
    [...select.querySelectorAll('optgroup')].map((group) => ({
      label: group.label,
      options: [...group.querySelectorAll('option')].map((option) => option.textContent),
    }));
  const choose = (value: string) =>
    act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  return {
    select,
    groups,
    choose,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it('lists system, light and dark, then the built-in themes, with no personal group while none exist', async () => {
  const view = await show();
  try {
    expect(view.groups()).toEqual([
      { label: '', options: ['System', 'Light', 'Dark'] },
      { label: 'Built-in themes', options: BUILTIN_THEMES.map((theme) => theme.palette.name) },
    ]);
    expect(view.select.value).toBe('system');
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
    expect(view.groups().at(-1)).toEqual({ label: 'Personal themes', options: ['My harbor'] });
  } finally {
    await view.close();
  }
});

it('applies and saves a chosen theme at once, and choosing light afterwards clears it', async () => {
  const view = await show();
  try {
    await view.choose('builtin:nord');
    expect(document.documentElement.style.getPropertyValue('--surface-1')).toBe('#2e3440');
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null)).toMatchObject({
      theme: 'dark',
      palette: 'builtin:nord',
    });
    expect(view.select.value).toBe('builtin:nord');
    await view.choose('light');
    expect(document.documentElement.style.getPropertyValue('--surface-1')).toBe('');
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null)).toMatchObject({
      theme: 'light',
      palette: null,
    });
    expect(view.select.value).toBe('light');
  } finally {
    await view.close();
  }
});
