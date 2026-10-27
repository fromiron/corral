// @vitest-environment jsdom
import type { HarnessApi } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HarnessDefaultsPage } from './HarnessDefaultsPage.tsx';

const fixture = vi.hoisted(() => ({ api: {} as HarnessApi, text: (key: string) => key }));
vi.mock('use-intl', () => ({ useTranslations: () => fixture.text }));
vi.mock('../services.tsx', () => ({ useServices: () => ({ harnesses: fixture.api }) }));
vi.mock('../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ projectId: 'project', link: () => ({}) }),
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => async (task: () => Promise<unknown>) => task(),
}));
vi.mock('../workbench/ScopeLadder.tsx', () => ({ ScopeLadder: () => null }));
vi.mock('./SettingsPage.tsx', () => ({
  SettingsLayout: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('@corral/react/design-kit', () => ({
  Button: ({
    children,
    render: _render,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { render?: unknown }) => (
    <button {...props}>{children}</button>
  ),
  Select: ({
    options,
    value,
    onValueChange,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

it.each([1, 2])(
  'keeps the name and selection of pinned r%s after the next revision is saved and reloaded',
  async (revision) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const binding = { profileId: 'harness_named', revision };
    const profile = vi.fn(async () => ({ ...binding, name: `Original ${revision}` }));
    const setDefault = vi.fn();
    fixture.api = {
      default: async () => ({ scope: 'project', scopeId: 'project', revision: 4, binding }),
      profileManagement: async () => [
        { ...binding, revision: revision + 1, name: 'Latest', archivedAt: null },
      ],
      profile,
      setDefault,
    } as unknown as HarnessApi;
    for (let reload = 0; reload < 2; reload++) {
      const container = document.createElement('div');
      const root = createRoot(container);
      await act(async () => root.render(<HarnessDefaultsPage scope="project" />));
      const select = container.querySelector('select')!;
      expect(select.value).toBe(`harness_named:${revision}`);
      expect(select.selectedOptions[0]?.textContent).toBe(`Original ${revision} · r${revision}`);
      await act(async () => root.unmount());
    }
    expect(profile).toHaveBeenCalledWith(binding);
    expect(setDefault).not.toHaveBeenCalled();
  },
);
