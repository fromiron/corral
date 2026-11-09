// @vitest-environment jsdom
import type { InboxItemView } from '@corral/client';
import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
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
  navigate: vi.fn(),
  services: { repository: {}, mode: 'demo', live: false } as Record<string, unknown>,
  profiles: [] as { available: boolean }[] | null,
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
  useNavigate: () => fixture.navigate,
  useRouter: () => ({ invalidate: vi.fn(async () => {}) }),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string; href: string } }) => unknown;
  }) => select({ location: { pathname: fixture.pathname, href: fixture.pathname } }),
}));
vi.mock('../services.tsx', () => ({
  useServices: () => fixture.services,
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
vi.mock('./useModels.ts', () => ({ useModelProfiles: () => fixture.profiles }));

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
type Model = ComponentProps<typeof Sidebar>['model'];
const model: Model = {
  projects: [project('alpha', 'Alpha'), project('beta', 'Beta')],
  sessions,
  corrals: [],
  runs: [],
  inbox: 0,
  terminalAttention: [],
  error: null,
  current: 'alpha',
  scheduledResults: [],
  dismissScheduled: () => {},
};

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  fixture.collapsed = {};
  fixture.pathname = '/projects/alpha';
  fixture.navigate.mockClear();
  fixture.services = { repository: {}, mode: 'demo', live: false };
  fixture.profiles = [];
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

async function mount(overrides: Partial<Model> = {}) {
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
          <Sidebar model={{ ...model, ...overrides }} />
        </SidebarProvider>
      </IntlProvider>,
    );
  });
  return container;
}

function conversationLinks(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLAnchorElement>('a[href^="/sessions/"]')];
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

const run = (sessionId: string, status: RunSummary['status'], startedAt: string): RunSummary => ({
  runId: `${sessionId}:${startedAt}`,
  sessionId,
  projectId: 'alpha',
  corralId: 'team',
  status,
  startedAt,
});
const attention = (kind: InboxItemView['kind'], sessionId: string): InboxItemView => ({
  kind,
  sessionId,
  sessionTitle: sessionId,
  runId: null,
  detail: null,
  ...(kind === 'uncertain_terminal' ? { terminalId: `${sessionId}_pty` } : {}),
});

/** Text a person reads: the kit draws each label twice, once hidden to reserve its bold width. */
function visibleText(element: Element | null | undefined) {
  if (!element) return undefined;
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent?.trim();
}

function primaryMenu(container: HTMLElement) {
  const menus = [...container.querySelectorAll<HTMLElement>('[data-sidebar="content"] ul')];
  const primary = menus.find((menu) => menu.querySelector('a[href="/inbox"]'));
  if (!primary) throw new Error('Missing primary menu');
  return primary;
}

it('shows exactly the four primary entries without a group name, and drops the old rows', async () => {
  const container = await mount();
  const primary = primaryMenu(container);
  const rows = [...primary.querySelectorAll<HTMLElement>(':scope > [data-sidebar="menu-item"]')];
  expect(rows.map((row) => visibleText(row.querySelector('a')))).toEqual([
    'New conversation',
    'Needs you',
    'Library',
    'Automation',
  ]);
  expect(rows.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual([
    '/projects/alpha',
    '/inbox',
    '/library/teams',
    '/schedules',
  ]);
  expect(
    primary.closest('[data-sidebar="group"]')?.querySelector('[data-sidebar="group-label"]'),
  ).toBeNull();
  const sidebar = container.querySelector('[data-testid="app-sidebar"]');
  for (const removed of ['Pending actions', 'Schedules', 'All projects', 'New project'])
    expect(sidebar?.textContent).not.toContain(removed);
});

it('counts a waiting run and a terminal to check in the Needs you badge, not queued or unreviewed items', async () => {
  const container = await mount({
    runs: [
      run('session_0', 'awaiting_user', '2026-11-01T00:00:00Z'),
      run('session_1', 'running', '2026-11-01T00:00:00Z'),
    ],
    terminalAttention: [
      attention('uncertain_terminal', 'session_499'),
      attention('queued', 'session_2'),
      attention('unreviewed', 'session_3'),
    ],
    // The current project's inbox also holds a queued request and an unreviewed file.
    inbox: 4,
  });
  const needsYou = container.querySelector<HTMLAnchorElement>('a[href="/inbox"]');
  expect(visibleText(needsYou)).toBe('Needs you');
  const badge = needsYou
    ?.closest('[data-sidebar="menu-item"]')
    ?.querySelector('[data-sidebar="menu-badge"]');
  expect(badge?.textContent).toBe('2');
});

it('keeps Needs you without a number when nothing waits', async () => {
  const container = await mount({ inbox: 3 });
  const needsYou = container.querySelector<HTMLAnchorElement>('a[href="/inbox"]');
  expect(needsYou).not.toBeNull();
  expect(
    needsYou?.closest('[data-sidebar="menu-item"]')?.querySelector('[data-sidebar="menu-badge"]'),
  ).toBeNull();
});

it('marks the primary entry for the path active', async () => {
  fixture.pathname = '/library/resources';
  const container = await mount();
  expect(container.querySelector('a[href="/library/teams"]')?.getAttribute('aria-current')).toBe(
    'page',
  );
  expect(container.querySelector('a[href="/inbox"]')?.getAttribute('aria-current')).toBeNull();
});

it('opens the palette in session search from the read-only field, carrying the typed character', async () => {
  const container = await mount();
  const requests: unknown[] = [];
  const listen = (event: Event) => requests.push((event as CustomEvent).detail);
  window.addEventListener('corral:open-palette', listen);
  try {
    const field = container.querySelector<HTMLInputElement>(
      '[data-testid="session-search-field"] input',
    );
    if (!field) throw new Error('Missing search field');
    expect(field.readOnly).toBe(true);
    await act(async () => field.click());
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(requests).toEqual([
      { mode: 'sessions', query: '' },
      { mode: 'sessions', query: 'm' },
      { mode: 'sessions', query: '' },
    ]);
  } finally {
    window.removeEventListener('corral:open-palette', listen);
  }
});

it('marks a meeting with its own icon and keeps the active row menu visible', async () => {
  fixture.pathname = '/sessions/session_0';
  const meeting = {
    ...(sessions[1] as WorkSession),
    meeting: { config: { version: 1, participants: [], secretary: { modelProfile: 'm' } } },
  } as unknown as WorkSession;
  const container = await mount({
    sessions: sessions.map((session) => (session.sessionId === 'session_1' ? meeting : session)),
  });
  const icon = (id: string) =>
    container.querySelector(`a[href="/sessions/${id}"] svg`)?.getAttribute('class') ?? '';
  expect(icon('session_1')).not.toBe(icon('session_0'));
  const action = (title: string) =>
    container.querySelector(`button[aria-label="Actions for ${title}"]`);
  expect(action('Conversation 0')?.hasAttribute('data-show-on-hover')).toBe(false);
  expect(action('Pinned conversation')?.hasAttribute('data-show-on-hover')).toBe(true);
});

it('starts a meeting in a project from its row menu', async () => {
  const container = await mount();
  const requests: unknown[] = [];
  const listen = (event: Event) => requests.push((event as CustomEvent).detail);
  window.addEventListener('corral:new-meeting', listen);
  try {
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Alpha project menu"]',
    );
    if (!trigger) throw new Error('Missing project actions');
    await act(async () => trigger.click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (row) => visibleText(row) === 'New meeting',
    );
    if (!item) throw new Error('Missing New meeting');
    await act(async () => item.click());
    expect(requests).toEqual(['alpha']);
  } finally {
    window.removeEventListener('corral:new-meeting', listen);
  }
});

/** The header's Corral menu button. */
function corralMenu(container: HTMLElement) {
  const button = container.querySelector<HTMLElement>(
    '[data-sidebar="header"] [data-sidebar="menu-button"]',
  );
  if (!button) throw new Error('Missing the Corral menu');
  return button;
}

it.each([
  ['a demo', { mode: 'browser', live: false }, [], 'Demo · simulated'],
  ['a simulated local server', { mode: 'server', live: false }, [], 'Local · simulated'],
  ['a live server without a model', { mode: 'server', live: true }, [], 'No model connected'],
  [
    'a live server with a model',
    { mode: 'server', live: true },
    [{ available: true }],
    'Connected',
  ],
] as const)(
  'names the connection state of %s in the header',
  async (_name, services, profiles, state) => {
    fixture.services = { repository: {}, ...services };
    fixture.profiles = [...profiles];
    const container = await mount();
    const menu = corralMenu(container);
    expect(menu.textContent).toContain('Corral');
    expect(menu.textContent).toContain(state);
    expect(menu.getAttribute('aria-label')).toContain(state);
    // The footer card stays for every state that cannot reach a model.
    const card = container.querySelector('[data-testid="sidebar-status"]');
    if (state === 'Connected') expect(card).toBeNull();
    else expect(card).not.toBeNull();
  },
);

it('opens the projects page at its new-project form from the Corral menu', async () => {
  const container = await mount();
  await act(async () => corralMenu(container).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const create = items.find((item) => item.textContent?.includes(messages.Shell.newProject));
  const all = items.find((item) => item.textContent?.includes(messages.Shell.allProjects));
  expect(create).toBeDefined();
  await act(async () => create?.click());
  expect(fixture.navigate).toHaveBeenLastCalledWith({ to: '/projects', hash: 'new-project' });
  await act(async () => corralMenu(container).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes(messages.Shell.allProjects))
      ?.click(),
  );
  expect(all).toBeDefined();
  expect(fixture.navigate).toHaveBeenLastCalledWith({ to: '/projects' });
});
