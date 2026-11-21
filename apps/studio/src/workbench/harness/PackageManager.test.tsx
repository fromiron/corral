// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { PackageManager } from './PackageManager.tsx';

const navigation = vi.hoisted(() => ({ item: undefined as string | undefined }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('../navigation.ts', () => ({
  useSettingsNavigation: () => ({ item: navigation.item, link: () => ({ to: '/' }) }),
}));
vi.mock('../SettingsLifecycle.tsx', () => ({
  useSettingsCommand: () => ({ current: null }),
  useSettingsForm: () => {},
  useSettingsTask: () => (action: () => Promise<unknown>) => action(),
}));
vi.mock('./ConfirmAction.tsx', () => ({
  useManagementConfirmation: () => ({ request: () => {}, dialog: null }),
}));

const view = (name: string, hash: string) => ({
  managementRevision: 1,
  status: 'enabled',
  updatedAt: null,
  manifest: null,
  profiles: [],
  resource: {
    hash,
    name,
    version: '1.0.0',
    trustedAt: null,
    license: null,
    skills: [],
    extensions: [],
    sourceKind: 'npm',
    sourceLabel: `npm:${name}@1.0.0`,
    files: [],
  },
});
const api = {
  packages: vi.fn(async () => [view('lint-pack', 'hash_1'), view('writing-skill', 'hash_2')]),
  cancelReview: vi.fn(async () => {}),
};

const cleanup: (() => void)[] = [];
const scrolled: Element[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
  navigation.item = undefined;
  scrolled.length = 0;
});

async function show() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  const page = () => (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <PackageManager api={api as never} onChanged={() => {}} />
    </IntlProvider>
  );
  await act(async () => root.render(page()));
  return { container, rerender: () => act(async () => root.render(page())) };
}
const itemOf = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('li')].find((li) => li.textContent?.startsWith(name));

// features/library.md: a package has no list to choose from, so Manage goes to its line and
// puts focus there.
it('scrolls to the package Manage carried and puts focus on it once the list has loaded', async () => {
  navigation.item = 'hash_2';
  const { container, rerender } = await show();
  const target = itemOf(container, 'writing-skill');
  expect(target).toBeTruthy();
  expect(scrolled).toEqual([target]);
  expect(document.activeElement).toBe(target);
  // Once only: a later render does not pull focus back.
  (container.querySelector('input') as HTMLInputElement | null)?.focus();
  await rerender();
  expect(scrolled).toHaveLength(1);
  expect(document.activeElement).not.toBe(target);
});

it('leaves focus and scroll alone when the carried key names no installed package', async () => {
  // A hook row's key starts with its package's hash; it is not that package.
  for (const item of ['hash_9', 'hash_1:extensions/hook.ts', undefined]) {
    navigation.item = item;
    const { container } = await show();
    expect(scrolled).toEqual([]);
    expect(container.contains(document.activeElement)).toBe(false);
    expect(container.querySelector('li[tabindex]')).toBeNull();
    for (const dispose of cleanup.splice(0)) act(dispose);
  }
});
