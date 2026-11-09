// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { parsePreferences, preferences } from '../workbench/preferences.ts';
import { SettingsPage } from './SettingsPage.tsx';

vi.mock('../services.tsx', () => ({ useServices: () => ({ mode: 'browser' }) }));
vi.mock('../CommandPalette.tsx', () => ({ ShortcutTable: () => null }));
vi.mock('./FilesViews.tsx', () => ({ WorkFolderSection: () => null }));
vi.mock('./ProjectToolSettings.tsx', () => ({ WorkspaceToolSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@corral/react/design-kit', async (original) => ({
  ...(await original<typeof import('@corral/react/design-kit')>()),
  Select: ({
    label,
    options,
    value,
    onValueChange,
  }: {
    label: string;
    options: { value: string; label: string }[];
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  preferences.setState(parsePreferences(null));
});

it('General offers the interface density and saves the choice', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <SettingsPage section="general" />
        </IntlProvider>,
      ),
    );
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Interface density"]',
    );
    expect(select).not.toBeNull();
    expect([...(select?.options ?? [])].map((option) => option.textContent)).toEqual([
      'Default',
      'Compact',
    ]);
    expect(select?.value).toBe('default');
    await act(async () => {
      if (!select) return;
      select.value = 'compact';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(preferences.getState().density).toBe('compact');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
