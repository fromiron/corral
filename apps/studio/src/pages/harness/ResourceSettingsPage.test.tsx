// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider, useTranslations } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { HookSettingsPage } from './ResourceSettingsPage.tsx';

const api = {
  entries: vi.fn(async (): Promise<unknown[]> => []),
  readEntry: vi.fn(() => new Promise(() => {})),
  resource: vi.fn(() => new Promise(() => {})),
  trust: vi.fn(async () => {}),
};
const navigation = vi.hoisted(() => ({ item: undefined as string | undefined }));
vi.mock('../../services.tsx', () => ({ useServices: () => ({ harnesses: api }) }));
vi.mock('../SettingsPage.tsx', () => ({
  SettingsLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('../../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ item: navigation.item, link: () => ({ to: '/' }) }),
}));
vi.mock('../../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsTask: () => (action: () => Promise<unknown>) => action(),
}));
vi.mock('../../workbench/harness/ConfirmAction.tsx', () => ({
  useManagementConfirmation: () => ({ request: () => {}, dialog: null }),
}));
vi.mock('../../workbench/harness/ResourceEditor.tsx', () => ({ ResourceEditor: () => null }));
vi.mock('../../workbench/harness/SkillQualityPanel.tsx', () => ({ SkillQualityPanel: () => null }));
// The package manager's own section starts with its heading, as the real one does.
vi.mock('../../workbench/harness/PackageManager.tsx', () => ({
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
  navigation.item = undefined;
  api.entries.mockImplementation(async () => []);
});

async function show(locale: 'en' | 'ko' = 'en') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  const page = () => (
    <IntlProvider locale={locale} messages={locale === 'ko' ? ko : messages} timeZone="UTC">
      <HookSettingsPage />
    </IntlProvider>
  );
  await act(async () => root.render(page()));
  rerender = () => act(async () => root.render(page()));
  return container;
}
let rerender = async () => {};

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

const second = { ...hook, resourceHash: 'hash_2', name: 'Notify on finish' };
const archivedHook = {
  ...hook,
  resourceHash: 'hash_3',
  name: 'Old formatter',
  archivedAt: '2026-11-01T00:00:00.000Z',
};
const NAMES = ['Format on save', 'Notify on finish', 'Old formatter'];
const nameOf = (button: Element) => NAMES.find((name) => button.textContent?.includes(name));
const pressed = (container: HTMLElement) =>
  [...container.querySelectorAll('button[aria-pressed="true"]')].map(nameOf);
const details = (container: HTMLElement) =>
  container.querySelector(`section[aria-label="${messages.Resources.details}"] h3`)?.textContent;
// The page's one switch: Show archived items.
const archivedSwitch = (container: HTMLElement) => container.querySelector('[role="switch"]');

// features/library.md: Manage opens the section with the resource it came from chosen.
it('chooses the resource Manage carried once the library has loaded', async () => {
  navigation.item = 'hash_2:extensions/hook.ts';
  api.entries.mockResolvedValue([hook, second]);
  const container = await show();
  expect(pressed(container)).toEqual(['Notify on finish']);
  expect(details(container)).toBe('Notify on finish');
});

it('shows archived items to choose an archived resource Manage carried', async () => {
  navigation.item = 'hash_3:extensions/hook.ts';
  api.entries.mockResolvedValue([hook, archivedHook]);
  const container = await show();
  expect(archivedSwitch(container)?.getAttribute('aria-checked')).toBe('true');
  expect(pressed(container)).toEqual(['Old formatter']);
  expect(details(container)).toBe('Old formatter');
});

it('opens only the section when the carried resource is gone or is a package', async () => {
  for (const item of ['hash_9:extensions/hook.ts', 'hash_1']) {
    navigation.item = item;
    api.entries.mockResolvedValue([hook, second]);
    const container = await show();
    expect(pressed(container)).toEqual([]);
    expect(details(container)).toBeUndefined();
    expect(archivedSwitch(container)?.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    for (const dispose of cleanup.splice(0)) act(dispose);
  }
});

it('follows the person’s own choice after a re-render or a refetch', async () => {
  navigation.item = 'hash_2:extensions/hook.ts';
  api.entries.mockResolvedValue([hook, second]);
  const container = await show();
  const first = [...container.querySelectorAll('button[aria-pressed]')].find(
    (button) => nameOf(button) === 'Format on save',
  );
  await act(async () => (first as HTMLButtonElement | undefined)?.click());
  expect(pressed(container)).toEqual(['Format on save']);
  await rerender();
  expect(pressed(container)).toEqual(['Format on save']);
  const trust = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === messages.Harness.trust,
  );
  await act(async () => trust?.click());
  expect(api.trust).toHaveBeenCalled();
  expect(api.entries.mock.calls.length).toBeGreaterThan(1);
  expect(pressed(container)).toEqual(['Format on save']);
});
