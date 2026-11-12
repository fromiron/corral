// @vitest-environment jsdom
import type { InboxItemView } from '@corral/client';
import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { DesignKitProvider, SidebarProvider } from '@corral/react/design-kit';
import { act, type ComponentProps, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { shortcutLabel } from '../shortcuts.ts';
import { Sidebar, sidebarRowHeights } from './Sidebar.tsx';
import { forgetSharedPresenceHolds } from './useSettledPresence.ts';

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
  useSettingsNavigation: () => ({
    link: (section: string) => ({ to: '/', search: { settings: section } }),
  }),
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
    return useMemo(() => {
      // The real cache includes scrollMargin in `start`. Tests keep it at 0, so
      // a running sum matches what the sidebar subtracts back out.
      const sizeAt = (index: number) => current.current.options.estimateSize(index);
      return {
        getTotalSize: () =>
          Array.from({ length: current.current.options.count }, (_, index) => sizeAt(index)).reduce(
            (total, size) => total + size,
            0,
          ),
        get measurementsCache() {
          const { options: next } = current.current;
          let top = 0;
          return Array.from({ length: next.count }, (_, index) => {
            const size = sizeAt(index);
            const item = {
              index,
              key: next.getItemKey?.(index) ?? index,
              start: top,
              size,
              end: top + size,
              lane: 0,
            };
            top += size;
            return item;
          });
        },
        getVirtualItems: () => {
          const { options: next, start: first } = current.current;
          const offset = Math.min(first, Math.max(0, next.count - 8));
          let top = Array.from({ length: offset }, (_, index) => sizeAt(index)).reduce(
            (total, size) => total + size,
            0,
          );
          return Array.from({ length: Math.min(8, next.count - offset) }, (_, relative) => {
            const index = offset + relative;
            const size = sizeAt(index);
            const item = { index, key: next.getItemKey?.(index) ?? index, start: top, size };
            top += size;
            return item;
          });
        },
        measure: () => {},
        scrollToIndex: (index: number) => {
          fixture.scrollToIndex(index);
          setStart(Math.max(0, index - 3));
        },
      };
    }, []);
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
  autoStart: true,
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
  // Run ids repeat across cases; the views' shared memory of ended runs must not.
  forgetSharedPresenceHolds();
});

async function mount(overrides: Partial<Model> = {}, density: 'default' | 'compact' = 'default') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const draw = (next: Partial<Model>) =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <DesignKitProvider size={density}>
          <SidebarProvider persist={false} shortcut={null} mobileBreakpoint={0}>
            <Sidebar model={{ ...model, ...next }} />
          </SidebarProvider>
        </DesignKitProvider>
      </IntlProvider>,
    );
  await act(async () => draw(overrides));
  lastDraw = draw;
  return container;
}
let lastDraw: ((next: Partial<Model>) => void) | null = null;
/** Draws the last mounted sidebar again with a new model, as the run list poll does. */
async function redraw(overrides: Partial<Model>) {
  await act(async () => lastDraw?.(overrides));
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

/** Hovers `element` long enough for a tooltip to open; returns what the page then reads. */
async function hover(element: Element) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseenter'));
    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1200)));
  return document.body.textContent ?? '';
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

it.each([
  ['a demo', { mode: 'browser', live: false }, [], 'Demo · simulated', 'Demo'],
  [
    'a simulated local server',
    { mode: 'server', live: false },
    [],
    'Local · simulated',
    'Simulated',
  ],
] as const)(
  'names the connection state of %s once, as the header’s word',
  async (_name, services, profiles, state, word) => {
    fixture.services = { repository: {}, ...services };
    fixture.profiles = [...profiles];
    const container = await mount();
    const menu = corralMenu(container);
    // The row reads Corral and one whole word; the full state is only the button's name.
    expect(visibleText(menu)).toBe(`Corral${word}`);
    const mark = menu.querySelector('[data-testid="sidebar-connection"]');
    expect(mark?.textContent).toBe(word);
    // The word keeps its width; the name before it gives way first.
    expect(mark?.className).toContain('shrink-0');
    expect(menu.getAttribute('aria-label')).toContain(state);
    // No card, tooltip, menu line or second mark on the tile says it again.
    expect(container.querySelector('[data-testid="sidebar-status"]')).toBeNull();
    expect(menu.querySelector('.rounded-full')).toBeNull();
    const read = await hover(menu);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(occurrences(read, word)).toBe(1);
    // The full state is longer than the word, and only the button's name holds it.
    expect(read).not.toContain(state);
    await act(async () => menu.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const popup = document.querySelector('[role="menu"]');
    expect(popup?.querySelector('[data-slot="menu-label"]')).toBeNull();
    expect(
      [...(popup?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) => visibleText(item)),
    ).toEqual([messages.Shell.allProjects, messages.Shell.newProject]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
  },
);

// workbench.md: the sidebar does not keep a badge for a normal model connection; the header's
// word is only for no model, the demo and simulation.
it('shows no state word or mark for a live server with a model', async () => {
  fixture.services = { repository: {}, mode: 'server', live: true };
  fixture.profiles = [{ available: true }];
  const container = await mount();
  const menu = corralMenu(container);
  expect(visibleText(menu)).toBe('Corral');
  expect(container.querySelector('[data-testid="sidebar-connection"]')).toBeNull();
  expect(menu.querySelector('.rounded-full')).toBeNull();
  expect(document.body.textContent).not.toContain(messages.Shell.connected);
  // The menu's name keeps the state for screen readers, as it does for the other states.
  expect(menu.getAttribute('aria-label')).toBe(
    messages.Shell.workspaceMenuState.replace('{state}', messages.Shell.connected),
  );
  const read = await hover(menu);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(read).not.toContain(messages.Shell.connected);
});

// The logo is the symbol and the wordmark drawn as vectors in the text color; the name stays as
// text for screen readers and is not read twice.
it('shows the Corral symbol and wordmark in the header, with the name as text once', async () => {
  fixture.services = { repository: {}, mode: 'server', live: true };
  fixture.profiles = [{ available: true }];
  const container = await mount();
  const header = container.querySelector<HTMLElement>('[data-sidebar="header"]');
  const symbol = header?.querySelector('svg[data-brand="symbol"]');
  const wordmark = header?.querySelector('svg[data-brand="wordmark"]');
  expect(symbol?.getAttribute('fill')).toBe('currentColor');
  expect(wordmark?.getAttribute('fill')).toBe('currentColor');
  for (const mark of [symbol, wordmark])
    expect(mark?.closest('[aria-hidden="true"]')).not.toBeNull();
  const menu = corralMenu(container);
  expect(menu.contains(wordmark ?? null)).toBe(true);
  expect(occurrences(menu.textContent ?? '', 'Corral')).toBe(1);
  expect(visibleText(menu)).toBe('Corral');
  // The letter tile the symbol replaced is gone.
  expect(header?.querySelector('.bg-foreground')).toBeNull();
});

it('without a model, the header word is the one control that opens model settings', async () => {
  fixture.services = { repository: {}, mode: 'server', live: true };
  fixture.profiles = [];
  const container = await mount();
  const word = container.querySelector<HTMLElement>('[data-testid="sidebar-connection"]');
  expect(word?.tagName).toBe('BUTTON');
  expect(visibleText(word)).toBe(messages.Shell.stateNoModel);
  // Its name says where it leads and keeps the word it shows.
  expect(word?.getAttribute('aria-label')).toBe(messages.Shell.openModelSettings);
  expect(messages.Shell.openModelSettings).toContain(messages.Shell.stateNoModel);
  // Beside the Corral menu, not a button inside its button.
  expect(corralMenu(container).contains(word)).toBe(false);
  expect(visibleText(corralMenu(container))).toBe('Corral');
  expect(container.querySelector('[data-testid="sidebar-status"]')).toBeNull();
  const read = await hover(corralMenu(container));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(occurrences(read, messages.Shell.stateNoModel)).toBe(1);
  expect(read).not.toContain(messages.Shell.noModel);
  await act(async () => word?.click());
  expect(fixture.navigate).toHaveBeenLastCalledWith({ to: '/', search: { settings: 'models' } });
});

it('names New conversation once: its tooltip holds only the shortcut', async () => {
  const container = await mount();
  const link = [...primaryMenu(container).querySelectorAll('a')].find(
    (item) => visibleText(item) === messages.Shell.newConversation,
  );
  if (!link) throw new Error('Missing New conversation');
  // The kit draws a row's label twice (once hidden, to reserve its bold width).
  const before = occurrences(document.body.textContent ?? '', messages.Shell.newConversation);
  const read = await hover(link);
  const tip = document.querySelector('[role="tooltip"]');
  expect(tip?.textContent).toBe(shortcutLabel('session.new'));
  expect(occurrences(read, messages.Shell.newConversation)).toBe(before);
});

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

it.each([
  ['default', { project: 32, session: 44, empty: 28 }],
  ['compact', { project: 28, session: 36, empty: 24 }],
] as const)(
  'lays the virtual list out at the %s density’s row heights, two full lines per session',
  async (density, heights) => {
    expect(sidebarRowHeights(density === 'compact')).toEqual(heights);
    const container = await mount(
      { projects: [project('alpha', 'Alpha'), project('beta', 'Beta'), project('empty', 'Empty')] },
      density,
    );
    const row = container.querySelector<HTMLElement>('a[href="/sessions/session_0"]');
    const item = row?.closest<HTMLElement>('[data-sidebar-index]');
    expect(item?.style.height).toBe(`${heights.session}px`);
    // The row is drawn at the height the list positions it by.
    expect(row?.className).toContain(density === 'compact' ? 'h-9' : 'h-11');
    const rows = [...container.querySelectorAll<HTMLElement>('[data-sidebar="menu-sub-item"]')];
    const tops = rows.map((entry) => Number.parseFloat(entry.style.top));
    expect(tops.slice(1).map((top, index) => top - (tops[index] ?? 0))).toEqual(
      rows.slice(1).map(() => heights.session),
    );
    // The list's whole height: three projects, 500 sessions, one empty project's line.
    const list = container.querySelector<HTMLElement>('[data-sidebar-index]')?.parentElement;
    expect(list?.style.height).toBe(
      `${3 * heights.project + 500 * heights.session + heights.empty}px`,
    );
  },
);

it('puts a session’s title and its state line on full lines of their own, the state led by its mark', async () => {
  const container = await mount({
    runs: [run('session_0', 'awaiting_user', '2026-11-01T00:00:00Z')],
  });
  const waiting = container.querySelector('a[href="/sessions/session_0"]');
  const lines = [...(waiting?.querySelectorAll('[data-session-line]') ?? [])];
  expect(lines).toHaveLength(2);
  expect(lines[0]?.textContent).toBe('Conversation 0');
  // The state is the kit mark and its name, not words: the line's text is the time alone.
  expect(lines[1]?.textContent).not.toContain(messages.Presence.state.awaiting_user);
  const mark = lines[1]?.querySelector('[role="img"][data-presence="awaiting_user"]');
  expect(mark?.getAttribute('aria-label')).toBe(messages.Presence.state.awaiting_user);
  expect(mark?.querySelector('svg')).not.toBeNull();
  // Neither line borrows a tighter line height than its type role's.
  for (const line of lines) expect(line?.className).not.toMatch(/leading-\d/);
  // The row carries no separate badge: the state is said once.
  expect(
    waiting
      ?.closest('[data-sidebar="menu-sub-item"]')
      ?.querySelector('[data-sidebar="menu-badge"]'),
  ).toBeNull();
  const idle = container.querySelector('a[href="/sessions/session_1"]');
  expect(idle?.querySelector('[role="img"][data-presence]')).toBeNull();
});

// docs/specs/features/presence.md: the exit grace, and one state name per screen.
describe('session row presence', () => {
  const T0 = Date.parse('2026-11-13T00:00:00Z');
  const first = '2026-11-13T00:00:00Z';
  const next = '2026-11-13T00:00:05Z';
  const row = (container: HTMLElement, id = 'session_0') =>
    container.querySelector<HTMLElement>(`[data-session-row="${id}"]`);
  const group = (container: HTMLElement, id = 'session_0') =>
    row(container, id)?.dataset.sessionGroup;
  /** The state a row says: its mark's name, the only place it says it. */
  const label = (container: HTMLElement, id = 'session_0') => {
    const item = row(container, id);
    // No state words and no state label on a sidebar row.
    expect(item?.querySelector('[data-presence-label]')).toBeNull();
    return [...(item?.querySelectorAll('[role="img"][data-presence]') ?? [])].map((mark) =>
      mark.getAttribute('aria-label'),
    );
  };
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a row in progress when the next run starts within two seconds of the end', async () => {
    const container = await mount({ runs: [run('session_0', 'running', first)] });
    expect(group(container)).toBe('running');
    expect(label(container)).toEqual([messages.Presence.state.working]);
    await redraw({ runs: [run('session_0', 'succeeded', first)] });
    expect(group(container)).toBe('running');
    expect(label(container)).toEqual([messages.Presence.state.working]);
    await advance(1000);
    await redraw({
      runs: [run('session_0', 'succeeded', first), run('session_0', 'created', next)],
    });
    expect(group(container)).toBe('running');
    expect(label(container)).toEqual([messages.Presence.state.starting]);
    await advance(3000);
    expect(group(container)).toBe('running');
    expect(label(container)).toEqual([messages.Presence.state.starting]);
  });

  it('moves an ended run to Completed two seconds after the end was first seen, on one timer', async () => {
    const container = await mount({ runs: [run('session_0', 'running', first)] });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await redraw({ runs: [run('session_0', 'succeeded', first)] });
    await advance(1500);
    // The next poll judges again; the end of the hold does not move.
    await redraw({ runs: [run('session_0', 'succeeded', first)] });
    expect(group(container)).toBe('running');
    await advance(499);
    expect(group(container)).toBe('running');
    await advance(1);
    expect(group(container)).toBe('completed');
    expect(label(container)).toEqual([messages.Presence.state.succeeded]);
    const holds = timers.mock.calls.filter(([, delay]) => (delay ?? 0) > 0 && (delay ?? 0) <= 2000);
    expect(holds).toHaveLength(1);
    timers.mockRestore();
  });

  it('shows a run that waits for the person, fails or is paused at once, and counts it at once', async () => {
    for (const [index, status] of (
      ['awaiting_user', 'failed', 'interrupted', 'paused'] as const
    ).entries()) {
      // A run of its own each time: one seen ended never shows running again.
      const startedAt = `2026-11-13T00:00:0${index}Z`;
      const container = await mount({ runs: [run('session_0', 'running', startedAt)] });
      await redraw({ runs: [run('session_0', status, startedAt)] });
      expect([status, group(container)]).toEqual([status, 'attention']);
      // These four Run states share their presence kind's name.
      expect(label(container)).toEqual([messages.Presence.state[status]]);
      const badge = container
        .querySelector('a[href="/inbox"]')
        ?.closest('[data-sidebar="menu-item"]')
        ?.querySelector('[data-sidebar="menu-badge"]');
      expect([status, badge?.textContent ?? null]).toEqual([
        status,
        status === 'awaiting_user' ? '1' : null,
      ]);
      for (const dispose of disposals.splice(0)) await dispose();
    }
  });

  it('shows a pause or stop the person pressed at once', async () => {
    const container = await mount({ runs: [run('session_0', 'running', first)] });
    await redraw({ runs: [run('session_0', 'pausing', first)] });
    expect(label(container)).toEqual([messages.Presence.state.pausing]);
    await redraw({ runs: [run('session_0', 'cancelling', first)] });
    expect(label(container)).toEqual([messages.Presence.state.stopping]);
    await redraw({ runs: [run('session_0', 'cancelled', first)] });
    // Only an end from starting or working is held.
    expect(group(container)).toBe('cancelled');
    expect(label(container)).toEqual([messages.Presence.state.cancelled]);
  });

  it('shows a run that ended long before the sidebar opened as Completed at once', async () => {
    const container = await mount({ runs: [run('session_0', 'succeeded', first)] });
    expect(group(container)).toBe('completed');
  });

  it('keeps every row the same height and structure whatever its state', async () => {
    const states = ['running', 'awaiting_user', 'succeeded', 'failed', 'paused'] as const;
    const container = await mount({
      runs: states.map((status, index) => run(`session_${index}`, status, first)),
      terminalAttention: [attention('uncertain_terminal', 'session_5')],
    });
    const shapes = [0, 1, 2, 3, 4, 5].map((index) => {
      const item = row(container, `session_${index}`);
      const button = item?.querySelector('[data-sidebar="menu-sub-button"]');
      return {
        item: item?.getAttribute('style'),
        button: button?.className,
        lines: [...(button?.querySelectorAll('[data-session-line]') ?? [])].map(
          (line) => `${line.getAttribute('data-session-line')}:${line.className}`,
        ),
      };
    });
    const top = (style: string | null | undefined) => style?.replace(/top: [^;]+;/, '');
    for (const shape of shapes) {
      expect(top(shape.item)).toBe(top(shapes[0]?.item));
      expect(shape.button).toBe(shapes[0]?.button);
      expect(shape.lines).toEqual(shapes[0]?.lines);
    }
  });

  it('never writes a session’s state name in the sidebar; its link still names it', async () => {
    const container = await mount({
      runs: [run('session_0', 'awaiting_user', first)],
      terminalAttention: [attention('uncertain_terminal', 'session_1')],
    });
    const sidebar = container.querySelector('[data-testid="app-sidebar"]') ?? container;
    const name = messages.Presence.state.awaiting_user;
    expect(label(container)).toEqual([name]);
    expect(visibleText(sidebar)).not.toContain(name);
    expect(sidebar.querySelector('[data-presence-label]')).toBeNull();
    const link = row(container)?.querySelector('a');
    expect(link?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(name);
    // A terminal to check keeps its words, which are not a run's state; no run, no mark.
    const terminal = row(container, 'session_1');
    expect(visibleText(terminal)).toContain(messages.Sessions.terminalNeedsAttention);
    expect(terminal?.querySelector('[role="img"][data-presence]')).toBeNull();
  });

  it('colours the mark by the tone and draws the kit glyph in that colour', async () => {
    const container = await mount({
      runs: [
        run('session_0', 'paused', first),
        run('session_1', 'created', first),
        run('session_2', 'failed', first),
        run('session_3', 'cancelled', first),
      ],
    });
    const mark = (id: string) => row(container, id)?.querySelector('[role="img"][data-presence]');
    expect(mark('session_0')?.className).toContain('text-warning');
    expect(mark('session_1')?.className).toContain('text-primary');
    expect(mark('session_2')?.className).toContain('text-danger');
    // Neutral is the dot's own grey (bg-muted-foreground/60), not a darker one.
    expect(mark('session_3')?.className).toContain('text-muted-foreground/60');
    expect(mark('session_3')?.getAttribute('title')).toBe(messages.Presence.state.cancelled);
    // The glyph takes the tone's colour, not the kit's own colour for the state.
    for (const id of ['session_0', 'session_1', 'session_2'])
      expect(mark(id)?.querySelector('svg')?.getAttribute('style') ?? '').not.toContain('color');
  });

  // The grace delays only what shows: archiving reads the live run.
  it('lets a session whose run just ended be archived during the hold, and not a running one', async () => {
    const archive = async (container: HTMLElement, id: string) => {
      const trigger = row(container, id)?.querySelector<HTMLButtonElement>('[data-session-menu]');
      await act(async () => {
        trigger?.focus();
        trigger?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
        );
        await vi.advanceTimersByTimeAsync(20);
      });
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => visibleText(element) === messages.Sessions.archive,
      );
      if (!item)
        throw new Error(
          `no Archive item in ${document.querySelector('[role="menu"]')?.textContent}`,
        );
      const disabled =
        item?.getAttribute('aria-disabled') === 'true' || item?.hasAttribute('data-disabled');
      await act(async () => {
        item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await vi.advanceTimersByTimeAsync(20);
      });
      return disabled;
    };
    const container = await mount({ runs: [run('session_0', 'running', first)] });
    expect(await archive(container, 'session_0')).toBe(true);
    await redraw({ runs: [run('session_0', 'succeeded', first)] });
    expect(group(container)).toBe('running');
    expect(await archive(container, 'session_0')).toBe(false);
  });
});

// jsdom has no layout. Until the last row is mounted the guide is the submenu's
// left border: its length is the ul height, clipped by the wrapper's animated
// height. Once that row is mounted, the border stops and a stem of the same
// colour ends at the guide line's middle, with one elbow into that row only.
// A row's box is the absolute top/height the virtual list writes. Guide-line
// offsets are that row's own layout (title padding and leading, or the centered
// empty line), which the test supplies through offset* and the guide must read.
const TITLE_PAD = 4;

function px(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function guideLayout(compact: boolean) {
  const titleLeading = compact ? 18 : 20;
  return {
    titlePad: TITLE_PAD,
    titleLeading,
    /** Vertical middle of a session title line, measured from the row's top. */
    sessionMiddle: TITLE_PAD + titleLeading / 2,
    projectRowHeight: sidebarRowHeights(compact).project + 8,
  };
}

function projectRow(container: HTMLElement, projectId: string) {
  const row = container
    .querySelector<HTMLElement>(`[data-sidebar-index] a[href="/projects/${projectId}"]`)
    ?.closest<HTMLElement>('[data-sidebar="menu-item"]');
  if (!row) throw new Error(`Missing ${projectId} project row`);
  return row;
}

/** The readings a real layout would give the guide line and its row. */
function installGuideLayout(compact: boolean) {
  const layout = guideLayout(compact);
  const captionLeading = compact ? 14 : 16;
  const proto = HTMLElement.prototype;
  const previous = {
    offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
    offsetTop: Object.getOwnPropertyDescriptor(proto, 'offsetTop'),
    offsetLeft: Object.getOwnPropertyDescriptor(proto, 'offsetLeft'),
    offsetParent: Object.getOwnPropertyDescriptor(proto, 'offsetParent'),
  };
  const isProjectButton = (element: HTMLElement) =>
    element.dataset.sidebar === 'menu-button' &&
    Boolean(element.parentElement?.querySelector('[data-sidebar="menu-sub"]'));
  const isSubmenuRow = (element: HTMLElement) =>
    element.dataset.sidebar === 'menu-sub-item' ||
    (element.tagName === 'LI' &&
      element.dataset.sidebar !== 'menu-guide' &&
      element.parentElement?.dataset.sidebar === 'menu-sub');
  const guideParent = (element: HTMLElement): HTMLElement | null => {
    if (element.dataset.sidebarGuideLine !== undefined) {
      return (
        element.closest<HTMLElement>('[data-sidebar="menu-sub-button"]') ?? element.parentElement
      );
    }
    if (element.dataset.sidebar === 'menu-sub-button') {
      return element.closest<HTMLElement>('[data-sidebar="menu-sub-item"]');
    }
    if (isSubmenuRow(element)) return element.closest<HTMLElement>('[data-sidebar="menu-sub"]');
    return null;
  };

  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get() {
      const element = this as HTMLElement;
      if (isProjectButton(element)) return layout.projectRowHeight;
      if (element.dataset.sidebar === 'menu-sub') return px(element.style.height);
      if (element.dataset.sidebarGuideLine !== undefined) {
        return element.closest('[data-sidebar="menu-sub-button"]')
          ? layout.titleLeading
          : captionLeading;
      }
      if (isSubmenuRow(element)) return px(element.style.height);
      return 0;
    },
  });
  Object.defineProperty(proto, 'offsetTop', {
    configurable: true,
    get() {
      const element = this as HTMLElement;
      if (element.dataset.sidebarGuideLine !== undefined) {
        if (element.closest('[data-sidebar="menu-sub-button"]')) return layout.titlePad;
        const rowHeight = px(element.parentElement?.style.height ?? '');
        return (rowHeight - captionLeading) / 2;
      }
      if (element.dataset.sidebar === 'menu-sub-button') return 0;
      if (isSubmenuRow(element)) return px(element.style.top);
      return 0;
    },
  });
  Object.defineProperty(proto, 'offsetLeft', {
    configurable: true,
    get() {
      const element = this as HTMLElement;
      const left = element.style.left;
      if (left.endsWith('rem')) return Number.parseFloat(left) * 16;
      if (left.endsWith('px')) return px(left);
      return 0;
    },
  });
  Object.defineProperty(proto, 'offsetParent', {
    configurable: true,
    get() {
      return guideParent(this as HTMLElement);
    },
  });

  return {
    layout,
    restore() {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else Reflect.deleteProperty(proto, key);
      }
    },
  };
}

function submenuRows(submenu: HTMLElement) {
  return [...submenu.querySelectorAll<HTMLElement>(':scope > li')].filter(
    (row) => row.dataset.sidebar !== 'menu-guide',
  );
}

function readGuide(row: HTMLElement) {
  const button = row.querySelector<HTMLElement>(':scope > [data-sidebar="menu-button"]');
  const submenu = row.querySelector<HTMLElement>('[data-sidebar="menu-sub"]');
  if (!button || !submenu) throw new Error('Missing project guide');
  const origin = px(row.style.top) + button.offsetHeight;
  const stem = submenu.querySelector<HTMLElement>('[data-sidebar="menu-guide-stem"]');
  const elbow = submenu.querySelector<HTMLElement>('[data-sidebar="menu-guide-elbow"]');
  const ulHeight = px(submenu.style.height);
  const drawn = stem ? px(stem.style.top) + px(stem.style.height) : ulHeight;
  const clip = submenu.parentElement?.style.height ?? '';
  const wrapperHeight = clip.endsWith('px') ? px(clip) : drawn;
  const rows = submenuRows(submenu);
  let lastBottom = origin;
  for (const item of rows) {
    lastBottom = Math.max(lastBottom, origin + px(item.style.top) + px(item.style.height));
  }
  return {
    origin,
    submenu,
    stem,
    elbow,
    rows,
    last: rows.at(-1) ?? null,
    drawn,
    guideBottom: origin + Math.min(drawn, wrapperHeight),
    lastBottom,
    ulHeight,
  };
}

/** The open guide ends on `kind`'s line and turns only into that last row. */
function expectElbow(row: HTMLElement, compact: boolean, kind: 'session' | 'empty') {
  const guide = readGuide(row);
  const layout = guideLayout(compact);
  const last = guide.last;
  if (!last || !guide.elbow || !guide.stem) throw new Error(`Missing ${kind} guide elbow`);
  const middleInRow = kind === 'session' ? layout.sessionMiddle : px(last.style.height) / 2;
  const titleMiddle = guide.origin + px(last.style.top) + middleInRow;
  // The stem's own length, not the submenu box: the line stops at the title
  // middle even while a collapse tween is still clipping it.
  expect(guide.origin + guide.drawn).toBe(titleMiddle);
  expect(titleMiddle).not.toBe(guide.lastBottom);
  if (kind === 'session') {
    expect(titleMiddle).not.toBe(guide.origin + px(last.style.top) + px(last.style.height) / 2);
  }
  expect(guide.submenu.className).toContain('border-transparent');
  expect(guide.submenu.className).not.toContain('border-border');
  expect(guide.stem.className).toContain('bg-border');
  expect(guide.stem.style.width).toBe('1px');
  expect(guide.elbow.className).toContain('bg-border');
  expect(guide.elbow.style.height).toBe('1px');
  expect(guide.elbow.style.transform).toContain('translateY(-50%)');
  expect(guide.origin + px(guide.elbow.style.top)).toBe(titleMiddle);
  // The stroke meets the stem and stops at the row edge, short of the icon
  // or the empty line (another 0.5rem of padding inside the row). The active
  // and hover fills are the button box, which starts at that edge.
  const elbowEnd = px(guide.elbow.style.left) + px(guide.elbow.style.width);
  expect(elbowEnd).toBe(last.offsetLeft);
  expect(px(guide.elbow.style.width)).toBeGreaterThan(1);
  expect(elbowEnd).toBeLessThan(last.offsetLeft + 8);
  const content = last.querySelector<HTMLElement>('[data-sidebar="menu-sub-button"]') ?? last;
  expect(content.className).toContain(content === last ? 'px-2' : 'pl-2');
  expect(guide.rows.filter((item) => item.hasAttribute('data-sidebar-guide-end'))).toEqual([last]);
  expect(guide.submenu.querySelectorAll('[data-sidebar="menu-guide-elbow"]')).toHaveLength(1);
  for (const earlier of guide.rows.slice(0, -1)) {
    expect(earlier.querySelector('[data-sidebar="menu-guide-elbow"]')).toBeNull();
    expect(earlier.hasAttribute('data-sidebar-guide-end')).toBe(false);
    const earlierMiddle =
      guide.origin +
      px(earlier.style.top) +
      (earlier.querySelector('[data-sidebar="menu-sub-button"]')
        ? layout.sessionMiddle
        : px(earlier.style.height) / 2);
    expect(guide.origin + px(guide.elbow.style.top)).not.toBe(earlierMiddle);
  }
  const clip = guide.submenu.parentElement?.style.height ?? '';
  if (clip.endsWith('px') && Math.abs(px(clip) - guide.ulHeight) < 0.01) {
    expect(guide.guideBottom).toBe(titleMiddle);
  }
  if (kind === 'empty') expect(last.textContent).toContain('No sessions yet.');
}

it.each(['default', 'compact'] as const)(
  'ends a project guide on the last row’s title line at %s density',
  async (density) => {
    const compact = density === 'compact';
    const sessionCount = 12;
    const layout = installGuideLayout(compact);
    try {
      // The last session starts outside the eight-row window. The project button
      // is taller than its estimate; session rows stay on the estimate.
      const sample = sessions[0];
      if (!sample) throw new Error('Missing a session to copy');
      const guideSessions = Array.from({ length: sessionCount }, (_, index) => ({
        ...sample,
        sessionId: `guide_${index}`,
        projectId: 'alpha',
        pinned: false,
        title: `Guide ${index}`,
        updatedAt: new Date(Date.parse(createdAt) - index * 1000).toISOString(),
      }));
      const container = await mount(
        {
          projects: [project('alpha', 'Alpha'), project('beta', 'Beta')],
          sessions: guideSessions,
        },
        density,
      );
      expect(fixture.virtualCount).toBe(sessionCount + 3);
      expect(conversationLinks(container).length).toBeLessThan(sessionCount);
      expect(container.querySelector('a[href="/sessions/guide_11"]')).toBeNull();
      // The end row is not mounted, so the border still runs the submenu and
      // no elbow is drawn on a row that only happens to be last on screen.
      const early = readGuide(projectRow(container, 'alpha'));
      expect(early.elbow).toBeNull();
      expect(early.submenu.className).toContain('border-border');
      expect(early.submenu.className).not.toContain('border-transparent');

      const jumpToEnd = async () => {
        const first = container.querySelector<HTMLAnchorElement>(
          '[data-sidebar-index] a[href="/projects/alpha"]',
        );
        await act(async () => {
          first?.focus();
          first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        });
      };
      const expectGuides = () => {
        const alpha = readGuide(projectRow(container, 'alpha'));
        const nextTop = px(projectRow(container, 'beta').style.top);
        expectElbow(projectRow(container, 'alpha'), compact, 'session');
        expect(alpha.origin + alpha.drawn).toBeLessThanOrEqual(nextTop);
        // Beta has no sessions: the elbow meets the centered empty line.
        expectElbow(projectRow(container, 'beta'), compact, 'empty');
      };
      // Opening the group tweens the wrapper for 160ms, and that height clips the
      // guide until it lands on the submenu.
      const settleGuide = async (projectId: string) => {
        for (let frame = 0; frame < 20; frame += 1) {
          const submenu = projectRow(container, projectId).querySelector<HTMLElement>(
            '[data-sidebar="menu-sub"]',
          );
          const clip = submenu?.parentElement?.style.height ?? '';
          if (clip.endsWith('px') && Math.abs(px(clip) - px(submenu?.style.height ?? '')) < 0.01) {
            return;
          }
          await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
        }
        throw new Error(`Guide for ${projectId} did not finish opening`);
      };

      await jumpToEnd();
      expect(container.querySelector('a[href="/sessions/guide_11"]')).not.toBeNull();
      expect(conversationLinks(container).length).toBeLessThan(sessionCount);
      expectGuides();

      const toggle = container.querySelector<HTMLButtonElement>(
        `button[aria-label="${messages.Desktop.toggleProject.replace('{name}', 'Alpha')}"]`,
      );
      if (!toggle) throw new Error('Missing project toggle');
      await act(async () => toggle.click());
      expect(container.querySelector('a[href="/sessions/guide_11"]')).toBeNull();
      await act(async () => toggle.click());
      await jumpToEnd();
      expect(container.querySelector('a[href="/sessions/guide_11"]')).not.toBeNull();
      await settleGuide('alpha');
      await settleGuide('beta');
      expectGuides();
    } finally {
      layout.restore();
    }
  },
);

it.each(['default', 'compact'] as const)(
  'gives a project that scrolls into view the measured project-button height at %s density',
  async (density) => {
    const compact = density === 'compact';
    const estimated = sidebarRowHeights(compact);
    const alphaCount = 10;
    const betaCount = 2;
    const layout = installGuideLayout(compact);
    try {
      const sample = sessions[0];
      if (!sample) throw new Error('Missing a session to copy');
      const copied = (sessionId: string, projectId: string, title: string, index: number) => ({
        ...sample,
        sessionId,
        projectId,
        pinned: false,
        title,
        updatedAt: new Date(Date.parse(createdAt) - index * 1000).toISOString(),
      });
      const container = await mount(
        {
          projects: [project('alpha', 'Alpha'), project('beta', 'Beta'), project('gamma', 'Gamma')],
          sessions: [
            ...Array.from({ length: alphaCount }, (_, index) =>
              copied(`guide_${index}`, 'alpha', `Guide ${index}`, index),
            ),
            ...Array.from({ length: betaCount }, (_, index) =>
              copied(`beta_${index}`, 'beta', `Beta ${index}`, alphaCount + index),
            ),
          ],
        },
        density,
      );
      // Alpha, its sessions, beta, its sessions, gamma, and gamma's empty line.
      expect(fixture.virtualCount).toBe(alphaCount + betaCount + 4);
      expect(container.querySelector('a[href="/projects/beta"]')).toBeNull();

      const first = container.querySelector<HTMLAnchorElement>(
        '[data-sidebar-index] a[href="/projects/alpha"]',
      );
      await act(async () => {
        first?.focus();
        first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      });

      const betaTop = px(projectRow(container, 'beta').style.top);
      const gammaTop = px(projectRow(container, 'gamma').style.top);
      expect(gammaTop - betaTop).toBe(
        layout.layout.projectRowHeight + betaCount * estimated.session,
      );
      const beta = readGuide(projectRow(container, 'beta'));
      expectElbow(projectRow(container, 'beta'), compact, 'session');
      expect(beta.origin + beta.drawn).toBeLessThanOrEqual(gammaTop);
      expectElbow(projectRow(container, 'gamma'), compact, 'empty');
    } finally {
      layout.restore();
    }
  },
);
