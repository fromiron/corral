// @vitest-environment jsdom
import type { InboxItemView, WorkspaceBindingView, WorktreeView } from '@corral/client';
import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SettingsNavigationContext } from '../workbench/navigation.ts';
import { WorkspacePage } from './WorkspacePage.tsx';

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  data: {} as Record<string, unknown>,
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({
  workspaceRoute: { useLoaderData: () => fixture.data, useSearch: () => ({}) },
}));
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

it('heads the project with its name, folder state, pending count and actions', async () => {
  const { container } = await render();
  expect(container.querySelector('h1')?.textContent).toBe('Alpha');
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

it('keeps rename, archive, all projects and the task board preview in one more menu', async () => {
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
  const expected = ['Rename', 'Archive', 'All projects…', 'Task board preview'];
  expect(items).toHaveLength(expected.length);
  for (const [index, item] of items.entries())
    expect(item.textContent).toMatch(new RegExp(`^${expected[index]}`));
  // The preview says it shows sample data.
  expect(items.at(-1)?.textContent).toContain('Preview');
  const preview = items.at(-1)?.closest('a') ?? items.at(-1);
  const href = new URL(preview?.getAttribute('href') ?? '', 'http://x');
  expect(href.pathname).toBe('/preview/task-board');
  expect(href.searchParams.get('returnTo')).toBe('/projects/alpha');
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

it('lists a session without a run by its state once, not also as "no runs"', async () => {
  fixture.services = {
    ...fixture.services,
    workspaces: { ...(fixture.services.workspaces as object), inbox: vi.fn(async () => []) },
  };
  const { container } = await render();
  const rows = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"] li')];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.textContent).toContain(messages.Sessions.listState.empty);
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
  // The header is the group's name and its number of sessions, as Needs you heads its groups.
  for (const group of groups(container)) {
    const heading = group.details.querySelector('summary h2');
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
  const failure = messages.Inbox.loadFailed.replace('{project}', 'Alpha');
  expect(panel.textContent?.split(failure)).toHaveLength(2);
  // A failed read is not "nothing to review".
  expect(container.textContent).not.toContain(messages.Inbox.empty);
  expect(container.textContent).not.toMatch(/nothing (to review|needs you)/i);
  const retry = [...panel.querySelectorAll('button')].filter(
    (button) => button.textContent === messages.Inbox.retry,
  );
  expect(retry).toHaveLength(1);
  fail = false;
  await act(async () => retry[0]?.click());
  await settle();
  expect(read).toHaveBeenCalledTimes(2);
  expect(panel.textContent).not.toContain(failure);
  expect(groups(container).find((group) => group.name === 'Review')?.rows).toEqual(['B']);
});
