// @vitest-environment jsdom
import type { ProjectSummary, WorkSession } from '@corral/core';
import { SidebarProvider } from '@corral/react/design-kit';
import { act, type ComponentProps, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { Sidebar } from './Sidebar.tsx';

const fixture = vi.hoisted(() => ({
  collapsed: {} as Record<string, boolean>,
  pathname: '/projects/alpha',
  scrollToIndex: vi.fn<(index: number) => void>(),
  virtualCount: 0,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    search: _search,
    ...props
  }: ComponentProps<'a'> & {
    to: string;
    params?: Record<string, string>;
    search?: unknown;
  }) => (
    <a {...props} href={to.replace(/\$(\w+)/g, (_match, key: string) => params?.[key] ?? key)} />
  ),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ invalidate: vi.fn(async () => {}) }),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string; href: string } }) => unknown;
  }) => select({ location: { pathname: fixture.pathname, href: fixture.pathname } }),
}));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ repository: {}, mode: 'demo', live: false }),
}));
vi.mock('../desktop.tsx', () => ({ desktop: null }));
vi.mock('../shortcutBindings.ts', async (original) => ({
  ...(await original<typeof import('../shortcutBindings.ts')>()),
  useShortcutBindings() {},
}));
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: () => useState(fixture.collapsed),
}));
vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('./useModels.ts', () => ({ useModelProfiles: () => [] }));

interface VirtualOptions {
  count: number;
  estimateSize(index: number): number;
  getItemKey?(index: number): string | number;
}

// jsdom has no viewport layout. Keep an eight-row window while rendering the real
// Sidebar and kit hierarchy; moving to an unmounted row must change that window.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: VirtualOptions) => {
    const [start, setStart] = useState(0);
    const current = useRef({ options, start });
    current.current = { options, start };
    fixture.virtualCount = options.count;
    return useMemo(
      () => ({
        getTotalSize: () =>
          Array.from({ length: current.current.options.count }, (_, index) =>
            current.current.options.estimateSize(index),
          ).reduce((total, size) => total + size, 0),
        getVirtualItems: () => {
          const { options: next, start: first } = current.current;
          const offset = Math.min(first, Math.max(0, next.count - 8));
          let top = Array.from({ length: offset }, (_, index) => next.estimateSize(index)).reduce(
            (total, size) => total + size,
            0,
          );
          return Array.from({ length: Math.min(8, next.count - offset) }, (_, relative) => {
            const index = offset + relative;
            const size = next.estimateSize(index);
            const item = { index, key: next.getItemKey?.(index) ?? index, start: top, size };
            top += size;
            return item;
          });
        },
        scrollToIndex: (index: number) => {
          fixture.scrollToIndex(index);
          setStart(Math.max(0, index - 3));
        },
      }),
      [],
    );
  },
}));

const createdAt = '2026-11-01T00:00:00.000Z';
const project = (projectId: string, name: string): ProjectSummary => ({
  projectId,
  name,
  description: '',
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
});
const sessions: WorkSession[] = Array.from({ length: 500 }, (_, index) => ({
  sessionId: `session_${index}`,
  projectId: index === 499 ? 'beta' : 'alpha',
  corralId: null,
  auto: null,
  title: index === 123 ? 'Pinned conversation' : `Conversation ${index}`,
  objective: index === 250 ? 'Objective needle' : '',
  pinned: index === 123,
  revision: 1,
  createdAt,
  updatedAt: new Date(Date.parse(createdAt) - index * 1000).toISOString(),
  archivedAt: null,
  entries: [],
}));
const model: ComponentProps<typeof Sidebar>['model'] = {
  projects: [project('alpha', 'Alpha'), project('beta', 'Beta')],
  sessions,
  corrals: [],
  runs: [],
  inbox: 0,
  error: null,
  current: 'alpha',
};

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  fixture.collapsed = {};
  fixture.pathname = '/projects/alpha';
  fixture.virtualCount = 0;
  fixture.scrollToIndex.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Element.prototype.getAnimations ??= () => [];
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <SidebarProvider persist={false} shortcut={null} mobileBreakpoint={0}>
          <Sidebar model={model} />
        </SidebarProvider>
      </IntlProvider>,
    );
  });
  return container;
}

function conversationLinks(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLAnchorElement>('a[href^="/sessions/"]')];
}

async function filter(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error('Missing conversation filter');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('keeps 500 conversations virtualized under their project and puts pinned conversations first', async () => {
  const container = await mount();
  const links = conversationLinks(container);
  expect(links.length).toBeGreaterThan(0);
  expect(links.length).toBeLessThan(30);
  expect(links[0]?.getAttribute('href')).toBe('/sessions/session_123');
  expect(links[1]?.getAttribute('href')).toBe('/sessions/session_0');
  const submenu = links[0]?.closest('[data-sidebar="menu-sub"]');
  expect(submenu?.tagName).toBe('UL');
  expect(
    submenu
      ?.closest('[data-sidebar="menu-item"]')
      ?.querySelector('a[href="/projects/alpha"]')
      ?.getAttribute('href'),
  ).toBe('/projects/alpha');
});

it('moves End to an unmounted conversation in the last project and Home back to the first', async () => {
  const container = await mount();
  const first = container.querySelector<HTMLAnchorElement>(
    '[data-sidebar-index] a[href="/projects/alpha"]',
  );
  if (!first) throw new Error('Missing first project link');
  expect(container.querySelector('a[href="/sessions/session_499"]')).toBeNull();
  await act(async () => {
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(fixture.scrollToIndex).toHaveBeenLastCalledWith(fixture.virtualCount - 1);
  expect(document.activeElement?.getAttribute('href')).toBe('/sessions/session_499');
  expect(conversationLinks(container).length).toBeLessThan(30);
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(document.activeElement?.getAttribute('href')).toBe('/projects/alpha');
});

it('keeps list navigation away from conversation actions and opens their menu with ArrowDown', async () => {
  const container = await mount();
  const actions = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Actions for Pinned conversation"]',
  );
  if (!actions) throw new Error('Missing pinned conversation actions');
  const end = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
  await act(async () => {
    actions.focus();
    actions.dispatchEvent(end);
  });
  expect(end.defaultPrevented).toBe(true);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(fixture.scrollToIndex).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(actions);
  await act(async () => {
    actions.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(fixture.scrollToIndex).not.toHaveBeenCalled();
  expect(document.activeElement?.getAttribute('href')).not.toBe('/sessions/session_0');
});

it('temporarily reveals a collapsed project for an objective match and restores its collapse on clear', async () => {
  fixture.collapsed = { alpha: true };
  const container = await mount();
  expect(container.querySelector('a[href="/sessions/session_250"]')).toBeNull();
  const toggle = () => container.querySelector('[aria-label="Toggle Alpha sessions"]');
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  await filter(container, 'Objective needle');
  expect(container.querySelector('a[href="/sessions/session_250"]')).not.toBeNull();
  expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('a[href="/projects/beta"]')).toBeNull();
  await filter(container, '');
  expect(container.querySelector('a[href="/sessions/session_250"]')).toBeNull();
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('a[href="/projects/beta"]')).not.toBeNull();
});
