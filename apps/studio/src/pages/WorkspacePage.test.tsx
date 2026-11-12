// @vitest-environment jsdom
import type {
  InboxItemView,
  SessionEvidenceView,
  WorkspaceBindingView,
  WorktreeView,
} from '@corral/client';
import type { NewSession, ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { SettingsNavigationContext } from '../workbench/navigation.ts';
import { WorkspacePage } from './WorkspacePage.tsx';

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  data: {} as Record<string, unknown>,
  /** Views reading the loader data, told when a test loads new data. */
  readers: new Set<() => void>(),
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', async () => {
  const { useSyncExternalStore } = await import('react');
  const listen = (change: () => void) => {
    fixture.readers.add(change);
    return () => fixture.readers.delete(change);
  };
  return {
    workspaceRoute: {
      useLoaderData: () => useSyncExternalStore(listen, () => fixture.data),
      useSearch: () => ({}),
    },
  };
});
vi.mock('../workbench/ProjectMaterials.tsx', () => ({
  ProjectMaterials: () => <p>Project materials</p>,
}));
vi.mock('../workbench/useModels.ts', () => ({ useModelProfiles: () => [] }));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const project: ProjectSummary = {
  projectId: 'alpha',
  name: 'Alpha',
  description: '',
  revision: 1,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  archivedAt: null,
};
const session = (sessionId: string, title: string): WorkSession => ({
  sessionId,
  projectId: 'alpha',
  corralId: null,
  auto: null,
  title,
  objective: '',
  pinned: false,
  revision: 1,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  archivedAt: null,
  entries: [],
});
const pending = (sessionId: string): InboxItemView => ({
  kind: 'queued',
  sessionId,
  sessionTitle: 'Fix the build',
  runId: null,
  detail: 'Private request body',
});
const binding: WorkspaceBindingView = {
  bindingId: 'binding_1',
  projectId: 'alpha',
  path: '/work/alpha',
  isGit: true,
  trusted: true,
  verifyCommands: [],
  status: { branch: 'main', head: 'abc1234', changed: 2 },
  missing: false,
};
const copy: WorktreeView = {
  sessionId: 'session_1',
  bindingId: 'binding_1',
  copyGeneration: 1,
  baseCommit: 'abc1234abc1234',
  createdAt: '2026-11-10T00:00:00.000Z',
  removedAt: null,
  reviewed: false,
  missing: false,
};

beforeEach(() => {
  fixture.data = {
    project,
    projects: [project],
    corrals: [],
    runs: [],
    sessions: [session('session_1', 'Fix the build'), session('session_2', 'Plan the release')],
    totals: { corrals: 0, runs: 0 },
  };
  fixture.services = {
    mode: 'server',
    live: false,
    models: null,
    persistent: true,
    repository: { listSessions: vi.fn(async () => []) },
    workspaces: {
      inbox: vi.fn(async () => [pending('session_1'), pending('session_2')]),
      sessionEvidence: vi.fn(async (): Promise<SessionEvidenceView[]> => []),
      binding: vi.fn(async () => binding),
      worktree: vi.fn(async (sessionId: string) => (sessionId === 'session_1' ? copy : null)),
      gitStatus: vi.fn(async () => {
        throw new Error('Git inspection requires the local server.');
      }),
    },
  };
});

function SettingsBridge({ children }: { children: ReactNode }) {
  const location = useRouterState({ select: (state) => state.location });
  return (
    <SettingsNavigationContext.Provider
      value={{
        projects: [project],
        returnTo: location.href,
        search: {},
        link: (section, projectId) => ({
          to: location.pathname,
          search: { ...location.search, settings: section, settingsProject: projectId },
          resetScroll: false,
        }),
      }}
    >
      {children}
    </SettingsNavigationContext.Provider>
  );
}

async function settle() {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function render() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRootRoute({
    component: () => (
      <SettingsBridge>
        <Outlet />
      </SettingsBridge>
    ),
  });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>{path}</p> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/projects/$projectId',
        component: WorkspacePage,
      }),
      stub('/inbox'),
      stub('/library/teams'),
      stub('/preview/$feature'),
      stub('/sessions/$sessionId'),
    ]),
    history: createMemoryHistory({ initialEntries: ['/projects/alpha'] }),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  disposals.push(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
  });
  await act(async () => {
    reactRoot.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>,
    );
    await router.load();
  });
  await settle();
  return { container, router };
}

const tabs = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]'),
];
const tabName = (tab: HTMLElement) =>
  (tab.querySelector('span > span:last-child')?.textContent ?? tab.textContent ?? '').trim();

it('has Sessions, Runs, Environment and Instructions & memory tabs, and no Teams tab', async () => {
  const { container } = await render();
  expect(tabs(container).map(tabName)).toEqual([
    'Sessions 2',
    'Runs',
    'Environment',
    'Instructions & memory',
  ]);
  expect(tabs(container).some((tab) => /^Teams/.test(tabName(tab)))).toBe(false);
  // The tabs are named for what they switch, not after the project they belong to.
  expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
    messages.Projects.tabsLabel,
  );
  expect(messages.Projects.tabsLabel).not.toBe(messages.Projects.label);
  expect(
    [...container.querySelectorAll('button')].some((button) => button.textContent === 'New team'),
  ).toBe(false);
});

it('heads the project with its folder state, pending count and actions', async () => {
  const { container } = await render();
  // The path bar names the project; the page keeps the name for the outline only.
  expect(container.querySelector('h1')?.textContent).toBe('Alpha');
  expect(container.querySelector('h1')?.className).toContain('sr-only');
  const count = [...container.querySelectorAll('a')].find(
    (link) => link.textContent === '2 pending',
  );
  // Every inbox item of the project, leading to Needs you and back here.
  const inbox = new URL(count?.getAttribute('href') ?? '', 'http://x');
  expect(inbox.pathname).toBe('/inbox');
  expect(inbox.searchParams.get('returnTo')).toBe('/projects/alpha');
  expect(container.textContent).not.toContain('Private request body');
  expect(container.textContent).toContain('Folder linked');
  const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent);
  expect(buttons).toContain('New conversation');
  expect(buttons.some((text) => text?.includes('New meeting'))).toBe(true);
  expect(
    container.querySelector('button[aria-label="More ways to start a conversation"]'),
  ).toBeTruthy();
  // The sample-data preview is not a header action of its own.
  expect(
    [...container.querySelectorAll('a')].some((link) => link.textContent === 'Task board preview'),
  ).toBe(false);
});

it('keeps rename, archive and all projects in one more menu', async () => {
  const { container } = await render();
  const more = container.querySelector<HTMLButtonElement>('button[aria-label="Actions for Alpha"]');
  expect(more).toBeTruthy();
  // The menu follows the start actions at the row's end, after New meeting.
  const order = [...container.querySelectorAll('button')].map(
    (button) => button.getAttribute('aria-label') ?? button.textContent,
  );
  expect(order.indexOf('Actions for Alpha')).toBeGreaterThan(
    order.findIndex((text) => text?.includes('New meeting')),
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  await act(async () => more?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  expect(menu).toBeTruthy();
  const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  // The kit item repeats its label for layout; each row is read by what it starts with.
  const expected = ['Rename', 'Archive', 'All projects…'];
  expect(items).toHaveLength(expected.length);
  for (const [index, item] of items.entries())
    expect(item.textContent).toMatch(new RegExp(`^${expected[index]}`));
  // The task board preview is gone: nothing in the menu leads to a sample screen.
  expect(menu?.querySelector('a[href^="/preview"]')).toBeNull();
  expect(menu?.textContent).not.toMatch(/Task board|Preview/);
});

it('shows saved new-conversation details on the menu item that opens them', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  fixture.data = {
    ...fixture.data,
    corrals: [{ corralId: 'team_1', name: 'Release crew', projectId: 'alpha' }],
  };
  const item = async (draft: { title: string; objective: string; corralId: string } | null) => {
    for (const dispose of disposals.splice(0)) await dispose();
    localStorage.clear();
    if (draft) localStorage.setItem('corral:new-session:v1:alpha', JSON.stringify(draft));
    const { container } = await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="More ways to start a conversation"]')
        ?.click(),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const row = document.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]');
    return {
      hint: row?.querySelector('[data-testid="new-conversation-draft"]')?.textContent ?? null,
      name: row?.getAttribute('aria-label') ?? row?.textContent ?? '',
    };
  };
  // Nothing saved: the item is its action alone.
  expect(await item(null)).toMatchObject({ hint: null });
  // The saved name, else the purpose's first line, else the team.
  const named = await item({ title: 'Visible name', objective: 'A purpose', corralId: '' });
  expect(named.hint).toBe('Visible name');
  expect(named.name).toContain('Visible name');
  expect(
    (await item({ title: '', objective: 'Objective-only summary\nmore lines', corralId: '' })).hint,
  ).toBe('Objective-only summary');
  expect((await item({ title: '', objective: '', corralId: 'team_1' })).hint).toBe('Release crew');
});

it('says the pending count once, in the header', async () => {
  const { container } = await render();
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]');
  expect(panel?.textContent).not.toMatch(/need(s)? you/);
  expect(container.textContent?.match(/2 pending/g)).toHaveLength(1);
});

it('shows one empty state when the project has no sessions; the header alone starts one', async () => {
  fixture.data = { ...fixture.data, sessions: [] };
  const createSession = vi.fn(async () => ({ ok: true, session: session('session_9', 'New') }));
  fixture.services = {
    ...fixture.services,
    repository: { listSessions: vi.fn(async () => []), createSession },
    workspaces: { ...(fixture.services.workspaces as object), inbox: vi.fn(async () => []) },
  };
  const { container, router } = await render();
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
  expect(panel.querySelectorAll('.border-dashed')).toHaveLength(1);
  expect(panel.textContent).toContain(messages.Sessions.emptyTitle);
  // The old getting-started card and its separate sentence are gone.
  expect(container.textContent).not.toContain('Getting started');
  expect(panel.querySelectorAll('p').length).toBeLessThanOrEqual(1);
  // One primary start on the page: the header's, not a second one under the empty state.
  expect(panel.querySelectorAll('button')).toHaveLength(0);
  const starts = [...container.querySelectorAll('button')].filter(
    (button) => button.textContent === 'New conversation',
  );
  expect(starts).toHaveLength(1);
  // It starts one session, then the conversation opens.
  await act(async () => starts[0]?.click());
  await settle();
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(router.state.location.pathname).toBe('/sessions/session_9');
});

it('lets the group name a session without a run; its row says neither that nor "no runs"', async () => {
  fixture.services = {
    ...fixture.services,
    workspaces: { ...(fixture.services.workspaces as object), inbox: vi.fn(async () => []) },
  };
  const { container } = await render();
  const rows = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"] li')];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.closest('details')?.querySelector('summary')?.textContent).toBe(
      `${messages.Sessions.listState.empty}2`,
    );
    expect(row.textContent).not.toContain(messages.Sessions.listState.empty);
    expect(row.textContent).not.toMatch(/no runs/);
  }
});

it('shows the source folder and each working copy, saying where nothing is known', async () => {
  const { container } = await render();
  const environment = tabs(container).find((tab) => tabName(tab) === 'Environment');
  await act(async () => environment?.click());
  await settle();
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
  expect(panel.textContent).toContain('Source folder');
  expect(panel.textContent).toContain('main');
  const settings = [...panel.querySelectorAll('a')].find(
    (link) => link.textContent === 'Open Folders & tools',
  );
  const href = new URL(settings?.getAttribute('href') ?? '', 'http://x');
  expect(href.searchParams.get('settings')).toBe('workspace');
  expect(href.searchParams.get('settingsProject')).toBe('alpha');
  const row = [...panel.querySelectorAll('tr')].find((tr) =>
    tr.textContent?.includes('Fix the build'),
  );
  expect(row).toBeTruthy();
  // Path, branch and changes are not reported for this copy: none of them reads as "none".
  expect(row?.textContent?.match(/No information/g)?.length).toBe(3);
  expect(panel.textContent).not.toContain('Plan the release');
  // The folder's state is said once, in the header above the tabs.
  expect(
    container.textContent?.match(new RegExp(messages.Workspace.folder.ready, 'g')),
  ).toHaveLength(1);
  expect(panel.textContent).not.toContain(messages.Workspace.folder.ready);
});

it('stops reading working copies once the Environment tab is left', async () => {
  const ids = Array.from({ length: 8 }, (_, index) => `session_${index + 1}`);
  fixture.data = { ...fixture.data, sessions: ids.map((id) => session(id, `Session ${id}`)) };
  const reads: (() => void)[] = [];
  const workspaces = fixture.services.workspaces as Record<string, ReturnType<typeof vi.fn>>;
  workspaces.worktree = vi.fn(
    (sessionId: string) =>
      new Promise<WorktreeView>((resolve) => {
        reads.push(() => resolve({ ...copy, sessionId }));
      }),
  );
  workspaces.gitStatus = vi.fn(async () => ({ head: { branch: 'main' }, entries: [] }));
  const { container } = await render();
  const environment = tabs(container).find((tab) => tabName(tab) === 'Environment');
  await act(async () => environment?.click());
  await settle();
  // A few at a time: the first batch is in flight.
  expect(workspaces.worktree).toHaveBeenCalledTimes(4);
  const sessionsTab = tabs(container).find((tab) => tabName(tab).startsWith('Sessions'));
  await act(async () => sessionsTab?.click());
  await settle();
  for (const read of reads.splice(0)) await act(async () => read());
  await settle();
  expect(workspaces.worktree).toHaveBeenCalledTimes(4);
  expect(workspaces.gitStatus).not.toHaveBeenCalled();
});

// The Sessions tab groups sessions by state (docs/specs/workbench.md#세션-목록의-상태와-처리할-항목).
const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const ran = (sessionId: string, status: RunSummary['status']): RunSummary => ({
  runId: `run_${sessionId}`,
  sessionId,
  projectId: 'alpha',
  corralId: 'team',
  status,
  startedAt: at(9),
});
const inboxItem = (
  kind: InboxItemView['kind'],
  sessionId: string,
  detail: string | null = null,
): InboxItemView => ({ kind, sessionId, sessionTitle: sessionId, runId: null, detail });

/**
 * A waits for the person, B finished with writes to review, C runs, D has only a purpose, E
 * finished, X was cancelled and Y is empty.
 */
function stateFixture(inbox: () => Promise<InboxItemView[]>) {
  fixture.data = {
    ...fixture.data,
    sessions: [
      { ...session('A', 'Answer the question'), updatedAt: at(5) },
      { ...session('B', 'Build the report'), updatedAt: at(4) },
      { ...session('C', 'Crunch the numbers'), updatedAt: at(3) },
      { ...session('D', 'Draft the plan'), objective: 'Plan the release', updatedAt: at(2) },
      { ...session('E', 'Edit the notes'), updatedAt: at(1) },
      { ...session('X', 'Cancelled export'), updatedAt: at(6) },
      { ...session('Y', 'Blank page'), updatedAt: at(7) },
    ],
    runs: [
      ran('A', 'awaiting_user'),
      ran('B', 'succeeded'),
      ran('C', 'running'),
      ran('E', 'succeeded'),
      ran('X', 'cancelled'),
    ],
  };
  const read = vi.fn(inbox);
  fixture.services = {
    ...fixture.services,
    workspaces: { ...(fixture.services.workspaces as object), inbox: read },
  };
  return read;
}
const reviewItems = () => [
  inboxItem('unreviewed', 'B', '3'),
  inboxItem('check_failed', 'B', 'unit tests'),
  inboxItem('queued', 'D', 'Private request body'),
];

/** Each group as shown: its disclosure, its list's name and the sessions listed in it. */
function groups(container: HTMLElement) {
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
  return [...panel.querySelectorAll<HTMLDetailsElement>('details')].map((details) => {
    const list = details.querySelector<HTMLElement>('ul');
    const label = list?.getAttribute('aria-labelledby');
    return {
      details,
      name: label ? document.getElementById(label)?.textContent : null,
      rows: [...details.querySelectorAll<HTMLAnchorElement>('li a[href^="/sessions/"]')].map(
        (link) => new URL(link.href, 'http://x').pathname.split('/')[2],
      ),
    };
  });
}

async function search(container: HTMLElement, value: string) {
  const field = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!field) throw new Error('no search field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

// docs/specs/features/presence.md "벗어날 때의 유예": the grace on the Sessions tab's groups.
describe('the exit grace on the session groups', () => {
  const later = (sessionId: string, status: RunSummary['status']): RunSummary => ({
    ...ran(sessionId, status),
    runId: `run_${sessionId}_next`,
    startedAt: at(10),
  });
  const where = (container: HTMLElement, id: string) =>
    groups(container).find((group) => group.rows.includes(id))?.name;
  /** Every heading's count is the number of rows its group shows. */
  const countsMatch = (container: HTMLElement) => {
    for (const group of groups(container))
      expect(group.details.querySelector('summary h3')?.textContent).toBe(
        `${group.name}${group.rows.length}`,
      );
  };
  /** The run list poll: new runs, drawn again. */
  async function poll(runs: RunSummary[]) {
    await act(async () => {
      fixture.data = { ...fixture.data, runs };
      for (const reader of fixture.readers) reader();
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const base = () =>
    (fixture.data as { runs: RunSummary[] }).runs.filter((r) => r.sessionId !== 'C');

  let container: HTMLElement;
  beforeEach(async () => {
    stateFixture(async () => []);
    ({ container } = await render());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a row in progress when its next run starts within two seconds of the end', async () => {
    expect(where(container, 'C')).toBe('In progress');
    await poll([...base(), ran('C', 'succeeded')]);
    expect(where(container, 'C')).toBe('In progress');
    countsMatch(container);
    await advance(1000);
    await poll([...base(), ran('C', 'succeeded'), later('C', 'created')]);
    await advance(3000);
    expect(where(container, 'C')).toBe('In progress');
    countsMatch(container);
  });

  it('moves a row to Completed two seconds after the end, without a next run', async () => {
    await poll([...base(), ran('C', 'succeeded')]);
    await advance(1500);
    await poll([...base(), ran('C', 'succeeded')]);
    expect(where(container, 'C')).toBe('In progress');
    await advance(500);
    expect(where(container, 'C')).toBe('Completed');
    countsMatch(container);
  });

  it('moves a row that waits for the person or failed to Needs attention at once', async () => {
    await poll([...base(), ran('C', 'awaiting_user')]);
    expect(where(container, 'C')).toBe('Needs attention');
    countsMatch(container);
    await poll([...base(), later('C', 'running')]);
    expect(where(container, 'C')).toBe('In progress');
    await poll([...base(), later('C', 'failed')]);
    expect(where(container, 'C')).toBe('Needs attention');
    countsMatch(container);
    // Needs attention does not name the state: the row does, once.
    const row = container.querySelector(`[role="tabpanel"] [data-session-row="C"]`);
    expect(
      [...(row?.querySelectorAll('[data-presence-label]') ?? [])].map((el) => el.textContent),
    ).toEqual([`${messages.Presence.state.failed} ·`]);
  });
});

it('groups the sessions by state, in order, each headed by its name and count', async () => {
  stateFixture(async () => reviewItems());
  const { container } = await render();
  expect(groups(container).map(({ name, rows }) => [name, rows])).toEqual([
    ['Needs attention', ['A']],
    ['Review', ['B']],
    ['In progress', ['C']],
    ['No run yet', ['D']],
    ['Completed', ['E']],
    ['Cancelled', ['X']],
    ['Empty session', ['Y']],
  ]);
  // The header is the group's name and its number of sessions, as Needs you heads its groups,
  // one level under the tab's own Sessions heading.
  const tabHeadings = container.querySelectorAll('[role="tabpanel"] h2');
  expect([...tabHeadings].map((heading) => heading.textContent)).toEqual([
    messages.Sessions.heading,
  ]);
  for (const group of groups(container)) {
    const heading = group.details.querySelector('summary h3');
    expect(heading?.textContent).toBe(`${group.name}${group.rows.length}`);
  }
  // No status filter: the groups are the states.
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
  expect(panel.querySelector('[role="combobox"]')).toBeNull();
  expect(panel.textContent).not.toMatch(/All statuses|Session status/);
  expect(panel.querySelector('[aria-label="Session status"]')).toBeNull();
});

it('names the review kinds on a reviewed row, never their counts or a request body', async () => {
  stateFixture(async () => reviewItems());
  const { container } = await render();
  const review = groups(container).find((group) => group.name === 'Review');
  const row = review?.details.querySelector('li');
  expect(row?.textContent).toContain(messages.Inbox.kind.unreviewed);
  expect(row?.textContent).toContain(messages.Inbox.kind.check_failed);
  expect(row?.textContent).not.toMatch(/3 unreviewed|unit tests/);
  // Other groups do not name review kinds, and no row shows a queued request's body.
  for (const group of groups(container).filter((group) => group.name !== 'Review'))
    expect(group.details.textContent).not.toContain(messages.Inbox.kind.unreviewed);
  expect(container.textContent).not.toContain('Private request body');
});

it('starts Cancelled and Empty session collapsed and every other group open', async () => {
  stateFixture(async () => reviewItems());
  const { container } = await render();
  expect(groups(container).map(({ name, details }) => [name, details.open])).toEqual([
    ['Needs attention', true],
    ['Review', true],
    ['In progress', true],
    ['No run yet', true],
    ['Completed', true],
    ['Cancelled', false],
    ['Empty session', false],
  ]);
  // A collapsed group opens from its header, and stays open through the next render.
  const empty = groups(container).find((group) => group.name === 'Empty session');
  const summary = empty?.details.querySelector<HTMLElement>('summary');
  expect(summary?.textContent).toBe('Empty session1');
  await act(async () => summary?.click());
  await settle();
  await search(container, 'x');
  await search(container, '');
  expect(groups(container).find((group) => group.name === 'Empty session')?.details.open).toBe(
    true,
  );
  expect(
    empty?.details.querySelector('button[aria-label="Archive empty session: Blank page"]'),
  ).toBeTruthy();
});

it('keeps only matching rows while searching, with every group open', async () => {
  stateFixture(async () => reviewItems());
  const { container } = await render();
  // Titles and purposes match: A, D (by its purpose too), X and Y.
  await search(container, 'an');
  expect(groups(container).map(({ name, rows, details }) => [name, rows, details.open])).toEqual([
    ['Needs attention', ['A'], true],
    ['No run yet', ['D'], true],
    ['Cancelled', ['X'], true],
    ['Empty session', ['Y'], true],
  ]);
  // Without a query the groups are as they started.
  await search(container, '');
  expect(groups(container)).toHaveLength(7);
  expect(groups(container).find((group) => group.name === 'Cancelled')?.details.open).toBe(false);
  await search(container, 'nothing like this');
  expect(groups(container)).toEqual([]);
  expect(container.textContent).toContain(messages.Sessions.noMatches);
});

it('groups by run state alone when the first inbox read fails, says so once and retries', async () => {
  let fail = true;
  const read = stateFixture(async () => {
    if (fail) throw new Error('inbox unavailable');
    return reviewItems();
  });
  const { container } = await render();
  expect(read).toHaveBeenCalledTimes(1);
  expect(groups(container).map(({ name, rows }) => [name, rows])).toEqual([
    ['Needs attention', ['A']],
    ['In progress', ['C']],
    ['No run yet', ['D']],
    ['Completed', ['B', 'E']],
    ['Cancelled', ['X']],
    ['Empty session', ['Y']],
  ]);
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
  // Its own words: not the Needs you line, which here would read as the project failing.
  const failure = messages.Sessions.reviewLoadFailed;
  expect(failure).toBe("Couldn't load items to review.");
  expect(panel.textContent?.split(failure)).toHaveLength(2);
  expect(panel.textContent).not.toContain(messages.Inbox.loadFailed.replace('{project}', 'Alpha'));
  // A failed read is not "nothing to review".
  expect(container.textContent).not.toContain(messages.Inbox.empty);
  expect(container.textContent).not.toMatch(/nothing (to review|needs you)/i);
  const retry = [...panel.querySelectorAll('button')].filter(
    (button) => button.textContent === messages.Sessions.retry,
  );
  expect(retry).toHaveLength(1);
  fail = false;
  await act(async () => retry[0]?.click());
  await settle();
  expect(read).toHaveBeenCalledTimes(2);
  expect(panel.textContent).not.toContain(failure);
  expect(groups(container).find((group) => group.name === 'Review')?.rows).toEqual(['B']);
});

it('keeps the last items and says so when a later inbox read fails', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    let fail = false;
    const read = stateFixture(async () => {
      if (fail) throw new Error('inbox unavailable');
      return reviewItems();
    });
    const { container } = await render();
    expect(groups(container).find((group) => group.name === 'Review')?.rows).toEqual(['B']);
    fail = true;
    await act(async () => vi.advanceTimersByTime(5000));
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
    expect(panel.textContent?.split(messages.Sessions.reviewLoadFailed)).toHaveLength(2);
    expect(groups(container).find((group) => group.name === 'Review')?.rows).toEqual(['B']);
  } finally {
    vi.useRealTimers();
  }
});

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * A row's text: its title, then its facts joined by " · ", ending with when it last changed,
 * worded as the sidebar words it: the time alone, never "Saved …".
 */
function rowText(title: string, ...facts: string[]) {
  const saved = escaped(messages.Workspace.updated.replace('{time}', ''));
  const shown = facts.map((fact) => `${escaped(fact)} · `).join('');
  return new RegExp(`^${escaped(title)}${shown}(?!${saved})[^·]+$`);
}

it('says on each row only what its group does not', async () => {
  stateFixture(async () => [...reviewItems(), inboxItem('uncertain_write', 'F')]);
  const data = fixture.data as { sessions: WorkSession[] };
  data.sessions = [
    ...data.sessions.map((item) => (item.sessionId === 'E' ? { ...item, pinned: true } : item)),
    { ...session('F', 'Fix the upload'), updatedAt: at(8) },
  ];
  const { container } = await render();
  const row = (id: string) =>
    container.querySelector<HTMLAnchorElement>(`[role="tabpanel"] a[href^="/sessions/${id}?"]`);
  const oneRun = '1 run';
  // Needs attention: why it is there. A session without a run never says it is empty.
  expect(row('A')?.textContent).toMatch(
    rowText('Answer the question', messages.Status.awaiting_user, oneRun),
  );
  expect(row('F')?.textContent).toMatch(
    rowText('Fix the upload', messages.Inbox.kind.uncertain_write),
  );
  // Review: the kinds only, not the run's "Succeeded".
  expect(row('B')?.textContent).toMatch(
    rowText(
      'Build the report',
      messages.Inbox.kind.unreviewed,
      messages.Inbox.kind.check_failed,
      oneRun,
    ),
  );
  // Every other group: no state word.
  expect(row('C')?.textContent).toMatch(rowText('Crunch the numbers', oneRun));
  expect(row('D')?.textContent).toMatch(rowText('Draft the plan'));
  expect(row('E')?.textContent).toMatch(rowText('Edit the notes', oneRun));
  expect(row('X')?.textContent).toMatch(rowText('Cancelled export', oneRun));
  expect(row('Y')?.textContent).toMatch(rowText('Blank page'));
  // Pinned is the sidebar's pin icon with its name, not a word.
  const pin = row('E')?.querySelector('svg[role="img"]');
  expect(pin?.getAttribute('aria-label')).toBe(messages.Sessions.pinned);
  expect(row('C')?.querySelector('svg[role="img"]')).toBeNull();
  expect(container.querySelector('[role="tabpanel"]')?.textContent).not.toContain(
    messages.Sessions.pinned,
  );
});

it('gives a row the time as the sidebar does, without "Saved"', async () => {
  fixture.data = {
    ...fixture.data,
    sessions: [{ ...session('session_1', 'Fix the build'), updatedAt: new Date().toISOString() }],
  };
  const workspaces = fixture.services.workspaces as Record<string, unknown>;
  fixture.services = { ...fixture.services, workspaces: { ...workspaces, inbox: async () => [] } };
  const { container } = await render();
  const row = container.querySelector('[role="tabpanel"] a[href^="/sessions/session_1"]');
  expect(row?.textContent).toBe(`Fix the build${messages.Sessions.justNow}`);
  expect(container.querySelector('[role="tabpanel"]')?.textContent).not.toContain(
    messages.Workspace.updated.replace(' {time}', ''),
  );
});

// What a row says of its recorded check, decision and applying
// (docs/specs/features/session-evidence.md).
const fact = messages.Sessions.fact;
const evidence = (
  sessionId: string,
  change: Partial<SessionEvidenceView> = {},
): SessionEvidenceView => ({
  sessionId,
  check: null,
  decision: null,
  integration: null,
  ...change,
});
const checked = (
  verdict: NonNullable<SessionEvidenceView['check']>['verdict'],
  writesSince = false,
) => ({ name: 'Unit tests', verdict, writesSince });
const approved = (writesSince = false) => ({ decision: 'approved' as const, writesSince });
function evidenceFixture(read: () => Promise<SessionEvidenceView[]>) {
  const spy = vi.fn(read);
  const workspaces = fixture.services.workspaces as Record<string, unknown>;
  fixture.services = { ...fixture.services, workspaces: { ...workspaces, sessionEvidence: spy } };
  return spy;
}
const rowOf = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLAnchorElement>(`[role="tabpanel"] a[href^="/sessions/${id}?"]`);
const panelOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
const retries = (container: HTMLElement) =>
  [...panelOf(container).querySelectorAll('button')].filter(
    (button) => button.textContent === messages.Sessions.retry,
  );

it('says Checks passed first on a row whose latest check passed with nothing written since', async () => {
  stateFixture(async () => reviewItems());
  const read = evidenceFixture(async () => [
    evidence('E', { check: checked('pass') }),
    evidence('A', { check: checked('pass') }),
  ]);
  const { container } = await render();
  expect(read).toHaveBeenCalledWith('alpha');
  expect(rowOf(container, 'E')?.textContent).toMatch(
    rowText('Edit the notes', fact.checks_passed, '1 run'),
  );
  // Ahead of what the group puts on the row.
  expect(rowOf(container, 'A')?.textContent).toMatch(
    rowText('Answer the question', fact.checks_passed, messages.Status.awaiting_user, '1 run'),
  );
});

it('says Changed after checks once Corral wrote after the check, and Checks passed nowhere', async () => {
  stateFixture(async () => reviewItems());
  evidenceFixture(async () => [evidence('E', { check: checked('pass', true) })]);
  const { container } = await render();
  expect(rowOf(container, 'E')?.textContent).toMatch(
    rowText('Edit the notes', fact.changed_after_checks, '1 run'),
  );
  expect(container.textContent).not.toContain(fact.checks_passed);
});

it('shows no check fact for a check that was cancelled, failed or could not decide', async () => {
  stateFixture(async () => reviewItems());
  evidenceFixture(async () => [
    // A cancelled or still running check has not completed: the server sends none.
    evidence('E', { check: null }),
    evidence('X', { check: checked('inconclusive') }),
    evidence('C', { check: checked('not_evaluated') }),
    evidence('B', { check: checked('fail') }),
  ]);
  const { container } = await render();
  expect(rowOf(container, 'E')?.textContent).toMatch(rowText('Edit the notes', '1 run'));
  expect(rowOf(container, 'X')?.textContent).toMatch(rowText('Cancelled export', '1 run'));
  expect(rowOf(container, 'C')?.textContent).toMatch(rowText('Crunch the numbers', '1 run'));
  // A failed check is the Review group's to say, once.
  expect(rowOf(container, 'B')?.textContent).toMatch(
    rowText(
      'Build the report',
      messages.Inbox.kind.unreviewed,
      messages.Inbox.kind.check_failed,
      '1 run',
    ),
  );
  expect(container.textContent).not.toContain(fact.checks_passed);
  expect(container.textContent).not.toContain(fact.changed_after_checks);
});

it('says Approved · Applied in that order, after the check', async () => {
  stateFixture(async () => reviewItems());
  evidenceFixture(async () => [
    evidence('C', { integration: 'applied', decision: approved() }),
    evidence('E', { integration: 'applied', decision: approved(), check: checked('pass') }),
    evidence('D', { decision: { decision: 'changes_requested', writesSince: false } }),
    // Applying that did not finish cleanly is the Review group's; it never reads as applied.
    evidence('X', { integration: 'partial', decision: approved() }),
  ]);
  const { container } = await render();
  expect(rowOf(container, 'C')?.textContent).toMatch(
    rowText('Crunch the numbers', fact.approved, fact.applied, '1 run'),
  );
  expect(rowOf(container, 'E')?.textContent).toMatch(
    rowText('Edit the notes', fact.checks_passed, fact.approved, fact.applied, '1 run'),
  );
  expect(rowOf(container, 'D')?.textContent).toMatch(
    rowText('Draft the plan', fact.changes_requested),
  );
  expect(rowOf(container, 'X')?.textContent).toMatch(
    rowText('Cancelled export', fact.approved, '1 run'),
  );
});

it('drops Approved once Corral wrote after it; the Review group names the unreviewed writes', async () => {
  stateFixture(async () => reviewItems());
  evidenceFixture(async () => [evidence('B', { decision: approved(true) })]);
  const { container } = await render();
  expect(groups(container).find((group) => group.name === 'Review')?.rows).toEqual(['B']);
  expect(rowOf(container, 'B')?.textContent).toMatch(
    rowText(
      'Build the report',
      messages.Inbox.kind.unreviewed,
      messages.Inbox.kind.check_failed,
      '1 run',
    ),
  );
  expect(container.textContent).not.toContain(fact.approved);
});

it('never moves a session to another group for its facts', async () => {
  stateFixture(async () => reviewItems());
  evidenceFixture(async () =>
    ['A', 'B', 'C', 'D', 'E', 'X', 'Y'].map((id) =>
      evidence(id, { check: checked('pass'), decision: approved(), integration: 'applied' }),
    ),
  );
  const { container } = await render();
  expect(rowOf(container, 'Y')?.textContent).toContain(fact.applied);
  expect(groups(container).map(({ name, rows }) => [name, rows])).toEqual([
    ['Needs attention', ['A']],
    ['Review', ['B']],
    ['In progress', ['C']],
    ['No run yet', ['D']],
    ['Completed', ['E']],
    ['Cancelled', ['X']],
    ['Empty session', ['Y']],
  ]);
});

it('drops every fact and says so in one line with a retry when a later evidence read fails', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    let fail = false;
    const inbox = stateFixture(async () => reviewItems());
    const read = evidenceFixture(async () => {
      if (fail) throw new Error('evidence unavailable');
      return [evidence('E', { check: checked('pass') })];
    });
    const { container } = await render();
    expect(rowOf(container, 'E')?.textContent).toContain(fact.checks_passed);
    fail = true;
    // Read on the inbox's schedule.
    await act(async () => vi.advanceTimersByTime(5000));
    await settle();
    expect(inbox).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    // The last values are gone: no row says what can no longer be read.
    expect(container.textContent).not.toContain(fact.checks_passed);
    const panel = panelOf(container);
    expect(panel.textContent?.split(messages.Sessions.evidenceLoadFailed)).toHaveLength(2);
    expect(panel.textContent).not.toContain(messages.Sessions.reviewLoadFailed);
    // A failed read is not "no record".
    expect(container.textContent).not.toContain(messages.Sessions.notChecked);
    expect(container.textContent).not.toMatch(/no (record|check|decision)/i);
    // The inbox still groups the sessions.
    expect(groups(container).find((group) => group.name === 'Review')?.rows).toEqual(['B']);
    expect(retries(container)).toHaveLength(1);
    fail = false;
    await act(async () => retries(container)[0]?.click());
    await settle();
    expect(panel.textContent).not.toContain(messages.Sessions.evidenceLoadFailed);
    expect(rowOf(container, 'E')?.textContent).toContain(fact.checks_passed);
  } finally {
    vi.useRealTimers();
  }
});

it('says one line with one retry when both reads fail, and the retry reads both', async () => {
  const inbox = stateFixture(async () => {
    throw new Error('inbox unavailable');
  });
  const read = evidenceFixture(async () => {
    throw new Error('evidence unavailable');
  });
  const { container } = await render();
  const panel = panelOf(container);
  const line = messages.Sessions.reviewAndEvidenceLoadFailed;
  expect(panel.textContent?.split(line)).toHaveLength(2);
  expect(panel.textContent).not.toContain(messages.Sessions.reviewLoadFailed);
  expect(panel.textContent).not.toContain(messages.Sessions.evidenceLoadFailed);
  expect(retries(container)).toHaveLength(1);
  await act(async () => retries(container)[0]?.click());
  await settle();
  expect(inbox).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(2);
  expect(panel.textContent?.split(line)).toHaveLength(2);
});

it('never lets an older evidence answer replace a newer one', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    stateFixture(async () => reviewItems());
    const answers: { resolve(list: SessionEvidenceView[]): void; reject(error: Error): void }[] =
      [];
    evidenceFixture(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
    const { container } = await render();
    await act(async () => vi.advanceTimersByTime(5000));
    await act(async () => vi.advanceTimersByTime(5000));
    await settle();
    expect(answers).toHaveLength(3);
    // The newest read answers first; the older ones arrive late, one with values, one failed.
    await act(async () => answers[2]?.resolve([evidence('E', { check: checked('pass', true) })]));
    await settle();
    await act(async () => answers[0]?.resolve([evidence('E', { check: checked('pass') })]));
    await act(async () => answers[1]?.reject(new Error('late failure')));
    await settle();
    expect(rowOf(container, 'E')?.textContent).toContain(fact.changed_after_checks);
    expect(container.textContent).not.toContain(fact.checks_passed);
    expect(container.textContent).not.toContain(messages.Sessions.evidenceLoadFailed);
  } finally {
    vi.useRealTimers();
  }
});

it('reads no evidence without a server workspace, as in the browser demo', async () => {
  stateFixture(async () => reviewItems());
  const read = evidenceFixture(async () => [evidence('E', { check: checked('pass') })]);
  fixture.services = { ...fixture.services, mode: 'browser' };
  const { container } = await render();
  expect(read).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain(fact.checks_passed);
  expect(container.textContent).not.toContain(messages.Sessions.evidenceLoadFailed);
});

it('reads neither list and shows no facts or failure without any workspace client', async () => {
  stateFixture(async () => reviewItems());
  fixture.services = { ...fixture.services, workspaces: null };
  const { container } = await render();
  expect(rowOf(container, 'E')?.textContent).toMatch(rowText('Edit the notes', '1 run'));
  expect(retries(container)).toHaveLength(0);
});

it('never calls a fact or the criteria verified, confirmed or met, in either language', () => {
  for (const catalog of [messages, ko]) {
    const { fact, evidenceLoadFailed, reviewAndEvidenceLoadFailed, criteria } = catalog.Sessions;
    const words = JSON.stringify({
      fact,
      evidenceLoadFailed,
      reviewAndEvidenceLoadFailed,
      criteria,
    });
    expect(words).not.toMatch(/verified|confirmed|criteria met|검증됨|완료 확인|기준 충족/i);
  }
});

// Completion criteria on a new conversation (docs/specs/workbench.md#세션-완료-기준).
async function type(field: HTMLTextAreaElement | HTMLInputElement | null, value: string) {
  if (!field) throw new Error('no field');
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function stubMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}
/** Opens the New conversation menu's "name, purpose and team first" form. */
async function openDetails(container: HTMLElement) {
  stubMedia();
  const more = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${messages.Workspace.newConversationMenu}"]`,
  );
  await act(async () => more?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    row.textContent?.startsWith(messages.Workspace.detailsFirst),
  );
  expect(item).toBeTruthy();
  await act(async () => item?.click());
  await settle();
  return document.querySelector<HTMLFormElement>(`form[aria-label="${messages.Sessions.new}"]`);
}
const criteriaField = () =>
  document.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${messages.Sessions.criteria.label}"]`,
  );
const startChat = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === messages.Workspace.startChat,
  );
const describedError = (field: HTMLElement | null) => {
  const id = field?.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent : undefined;
};
function creating(result?: () => Promise<unknown>) {
  const createSession = vi.fn(
    result ?? (async (_input: NewSession) => ({ ok: true, session: session('session_9', 'New') })),
  );
  fixture.services = {
    ...fixture.services,
    repository: { listSessions: vi.fn(async () => []), createSession },
  };
  return createSession;
}

it('starts a conversation with its completion criteria, trimmed and without blank lines', async () => {
  const createSession = creating();
  const { container, router } = await render();
  const form = await openDetails(container);
  const field = criteriaField();
  expect(field).toBeTruthy();
  // The limits are not a standing hint.
  expect(form?.textContent).not.toMatch(/\b20\b|\b200\b/);
  expect(field?.getAttribute('aria-invalid')).toBeNull();
  await type(field, '  The build passes  \n\n   \nDocs mention the new flag\n');
  await act(async () => startChat()?.click());
  await settle();
  expect(createSession).toHaveBeenCalledOnce();
  expect(createSession.mock.calls[0]?.[0]).toMatchObject({
    criteria: ['The build passes', 'Docs mention the new flag'],
  });
  expect(router.state.location.pathname).toBe('/sessions/session_9');
  // The sent draft is cleared.
  expect(
    JSON.parse(localStorage.getItem('corral:new-session:v1:alpha') ?? '{}').criteria ?? '',
  ).toBe('');
});

it('sends no criteria when none were written', async () => {
  const createSession = creating();
  const { container } = await render();
  await openDetails(container);
  await type(criteriaField(), '  \n ');
  await act(async () => startChat()?.click());
  await settle();
  expect(createSession).toHaveBeenCalledOnce();
  expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty('criteria');
});

it('keeps the criteria in the remembered draft through closing and opening the form', async () => {
  const createSession = creating();
  const { container } = await render();
  await openDetails(container);
  await type(criteriaField(), 'The build passes\n');
  const close = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Close',
  );
  await act(async () => close?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
  await settle();
  expect(criteriaField()).toBeNull();
  expect(JSON.parse(localStorage.getItem('corral:new-session:v1:alpha') ?? '{}')).toMatchObject({
    criteria: 'The build passes\n',
  });
  // Saved criteria are never sent silently: New conversation shows them first.
  const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === messages.Workspace.newConversation,
  );
  await act(async () => start?.click());
  await settle();
  expect(createSession).not.toHaveBeenCalled();
  expect(criteriaField()?.value).toBe('The build passes\n');
});

it('says on the field when there are more than 20 criteria or a line over 200 characters, and sends nothing', async () => {
  const createSession = creating();
  const { container } = await render();
  await openDetails(container);
  const field = criteriaField();
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => `Criterion ${index + 1}`);
  // Twenty, with blank lines between them, is within the limit.
  await type(field, lines(20).join('\n\n'));
  expect(field?.getAttribute('aria-invalid')).toBeNull();
  expect(describedError(field)).toBeUndefined();
  await type(field, lines(21).join('\n'));
  expect(field?.getAttribute('aria-invalid')).toBe('true');
  expect(describedError(field)).toBe(messages.Sessions.criteria.tooMany.replace('{max}', '20'));
  await act(async () => startChat()?.click());
  await settle();
  expect(createSession).not.toHaveBeenCalled();
  await type(field, `Short\n\n${'x'.repeat(201)}`);
  expect(field?.getAttribute('aria-invalid')).toBe('true');
  expect(describedError(field)).toBe(
    messages.Sessions.criteria.tooLong.replace('{line}', '3').replace('{max}', '200'),
  );
  await act(async () => startChat()?.click());
  await settle();
  expect(createSession).not.toHaveBeenCalled();
  // Within the limits again, the error goes and the form starts the conversation.
  await type(field, `Short\n${'x'.repeat(200)}`);
  expect(field?.getAttribute('aria-invalid')).toBeNull();
  await act(async () => startChat()?.click());
  await settle();
  expect(createSession.mock.calls[0]?.[0]).toMatchObject({ criteria: ['Short', 'x'.repeat(200)] });
});

it('adds a line on Enter in the criteria field, also while composing, and never submits', async () => {
  const createSession = creating();
  const { container } = await render();
  await openDetails(container);
  const field = criteriaField();
  for (const isComposing of [false, true]) {
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing,
    });
    await act(async () => field?.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(false);
  }
  await settle();
  expect(createSession).not.toHaveBeenCalled();
  expect(criteriaField()).toBe(field);
});

it('heads the form with its title only and lets the placeholders tell a note from criteria', async () => {
  const { container } = await render();
  await openDetails(container);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
  // The title says a conversation is being named: the field is just Name.
  const name = dialog.querySelector('input#new-session-title-alpha');
  expect(name).toBeTruthy();
  // The kit keeps a hidden bold copy of the label to reserve its width; read what is shown.
  const label = dialog.querySelector('label[for="new-session-title-alpha"]')?.cloneNode(true);
  expect(label).toBeTruthy();
  for (const copy of (label as Element).querySelectorAll('[aria-hidden="true"]')) copy.remove();
  expect(label?.textContent).toBe(messages.Sessions.nameLabel);
  expect(messages.Sessions.nameLabel).toBe('Name');
  expect(ko.Sessions.nameLabel).toBe('이름');
  expect(dialog.textContent).not.toMatch(/Session name|never sent automatically/);
  // No sentence under the title, and nothing describes the dialog by an id that is gone.
  const described = dialog.getAttribute('aria-describedby');
  for (const id of described?.split(' ') ?? []) expect(document.getElementById(id)).toBeTruthy();
  expect(dialog.querySelector('[data-slot="dialog-description"]')).toBeNull();
  // The purpose is a note that stays here; the criteria are what the agents work toward.
  expect(
    dialog.querySelector<HTMLTextAreaElement>('textarea#new-session-objective-alpha')?.placeholder,
  ).toBe(messages.Sessions.objectivePlaceholder);
  expect(messages.Sessions.objectivePlaceholder).toBe('A note that is not sent to agents');
  expect(ko.Sessions.objectivePlaceholder).toBe('에이전트에게 보내지 않는 메모');
  expect(criteriaField()?.placeholder).toBe(messages.Sessions.criteria.placeholder);
  for (const catalog of [messages, ko])
    expect(catalog.Sessions.criteria.placeholder).toMatch(/^(Example|예): /);
});

it('shows the default team choice by its own name when no team is chosen', async () => {
  fixture.data = {
    ...fixture.data,
    corrals: [
      {
        corralId: 'corral_review',
        projectId: 'alpha',
        name: 'Review team',
        definitionRevision: 1,
        nodeCount: 2,
        updatedAt: '2026-11-10T00:00:00.000Z',
      },
    ],
  };
  const { container } = await render();
  await openDetails(container);
  const team = () =>
    document.querySelector<HTMLElement>(
      `[role="combobox"][aria-label="${messages.Sessions.teamLabel}"]`,
    );
  expect(team()?.textContent).toContain(messages.Sessions.autoTeam);
  expect(team()?.textContent).not.toContain(messages.Select.placeholder);
  // Choosing a team and then the default again stores no team, as before.
  const choose = async (label: string) => {
    await act(async () => team()?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes(label),
    );
    expect(option, label).toBeTruthy();
    await act(async () => option?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  };
  const stored = () =>
    JSON.parse(localStorage.getItem('corral:new-session:v1:alpha') ?? '{}').corralId;
  await choose('Review team');
  expect(stored()).toBe('corral_review');
  expect(team()?.textContent).toContain('Review team');
  await choose(messages.Sessions.autoTeam);
  expect(stored()).toBe('');
  expect(team()?.textContent).toContain(messages.Sessions.autoTeam);
});

it('keeps the typed criteria when the conversation could not be created', async () => {
  const message = 'Completion criteria have up to 20 lines of 1 to 200 characters.';
  const createSession = creating(async () => ({ ok: false, error: 'invalid', message }));
  const { container } = await render();
  await openDetails(container);
  await type(criteriaField(), 'The build passes');
  await act(async () => startChat()?.click());
  await settle();
  expect(createSession).toHaveBeenCalledOnce();
  expect(criteriaField()?.value).toBe('The build passes');
  expect(document.body.textContent).toContain(message);
});
