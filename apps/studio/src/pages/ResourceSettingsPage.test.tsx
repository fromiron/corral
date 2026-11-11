// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider, useTranslations } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { HookSettingsPage } from './ResourceSettingsPage.tsx';

const api = { entries: vi.fn(async (): Promise<unknown[]> => []) };
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

async function show(locale: 'en' | 'ko' = 'en') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale={locale} messages={locale === 'ko' ? ko : messages} timeZone="UTC">
        <HookSettingsPage />
      </IntlProvider>,
    ),
  );
  return container;
}

const hook = {
  kind: 'extension',
  resourceHash: 'hash_1',
  entry: 'extensions/hook.ts',
  name: 'Format on save',
  description: '',
  archivedAt: null,
  successor: null,
  profiles: [],
  managementRevision: 1,
  resource: { name: 'format-pack', trustedAt: null, sourceKind: 'local', version: '1.0.0' },
};

// workbench.md: a name shows once per screen. With an empty hook library the packages section
// sits right below, named by its own heading, so no row of links above the page names it again.
it('names the hook page’s packages once, by their heading, while the library is empty', async () => {
  const container = await show();
  expect(container.querySelector('h3')?.textContent).toBe(messages.Packages.title);
  expect(container.querySelector('nav')).toBeNull();
  expect(container.textContent?.split(messages.Packages.title)).toHaveLength(2);
  expect(container.textContent).not.toContain('On this page');
});

// #82 (SET-S04): with hooks listed, package management sits below a long library, so the top of
// the page says it is there and lets a keyboard user jump to it.
it('heads a page with hooks with an On this page row that jumps to the library and the packages', async () => {
  api.entries.mockResolvedValueOnce([hook]);
  const container = await show();
  const index = container.querySelector('nav');
  expect(index?.getAttribute('aria-label')).toBe(messages.Navigation.onThisPage);
  const jumps = [...(index?.querySelectorAll('button') ?? [])];
  expect(jumps.map((button) => button.textContent)).toEqual([
    messages.Resources.library,
    messages.Packages.title,
  ]);
  Element.prototype.scrollIntoView ??= () => {};
  await act(async () => jumps[1]?.click());
  const packages = document.activeElement;
  expect(packages?.id).toBe('resources-packages');
  expect(packages?.querySelector('h3')?.textContent).toBe(messages.Packages.title);
  await act(async () => jumps[0]?.click());
  expect(document.activeElement?.id).toBe('resources-library');
  expect(document.activeElement?.getAttribute('aria-label')).toBe(messages.Resources.library);
});

// The row names each section as a place, in Korean as in English ("Library", not "View library").
it('names the Korean row’s sections as places', async () => {
  api.entries.mockResolvedValueOnce([hook]);
  const container = await show('ko');
  const jumps = [...(container.querySelector('nav')?.querySelectorAll('button') ?? [])];
  expect(jumps.map((button) => button.textContent)).toEqual(['라이브러리', '패키지']);
});
