// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider, useTranslations } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { HookSettingsPage } from './ResourceSettingsPage.tsx';

const api = { entries: vi.fn(async () => []) };
vi.mock('../services.tsx', () => ({ useServices: () => ({ harnesses: api }) }));
vi.mock('./SettingsPage.tsx', () => ({
  SettingsLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsTask: () => (action: () => Promise<unknown>) => action(),
}));
vi.mock('../workbench/harness/ConfirmAction.tsx', () => ({
  useManagementConfirmation: () => ({ request: () => {}, dialog: null }),
}));
vi.mock('../workbench/harness/ResourceEditor.tsx', () => ({ ResourceEditor: () => null }));
vi.mock('../workbench/harness/SkillQualityPanel.tsx', () => ({ SkillQualityPanel: () => null }));
// The package manager's own section starts with its heading, as the real one does.
vi.mock('../workbench/harness/PackageManager.tsx', () => ({
  PackageManager: function Packages() {
    const t = useTranslations('Packages');
    return (
      <section aria-label={t('title')}>
        <h3>{t('title')}</h3>
      </section>
    );
  },
}));

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

// workbench.md: a name shows once per screen. The packages section is named by its own heading,
// so no row of links above the page names it again.
it('names the hook page’s packages once, by their heading', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <HookSettingsPage />
      </IntlProvider>,
    ),
  );
  expect(container.querySelector('h3')?.textContent).toBe(messages.Packages.title);
  expect(container.querySelector('nav')).toBeNull();
  expect(container.textContent?.split(messages.Packages.title)).toHaveLength(2);
  expect(container.textContent).not.toContain('On this page');
});
