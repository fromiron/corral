// @vitest-environment jsdom
import type { InboxItemView, WorkspaceBindingView, WorktreeView } from '@corral/client';
import type { ProjectSummary, WorkSession } from '@corral/core';
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
  detail: null,
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
  expect(count?.getAttribute('href')).toBe('/inbox');
  expect(container.textContent).toContain('Folder linked');
  const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent);
  expect(buttons).toContain('New conversation');
  expect(buttons.some((text) => text?.includes('New meeting'))).toBe(true);
  expect(
    container.querySelector('button[aria-label="More ways to start a conversation"]'),
  ).toBeTruthy();
  const preview = [...container.querySelectorAll('a')].find(
    (link) => link.textContent === 'Task board preview',
  );
  const href = new URL(preview?.getAttribute('href') ?? '', 'http://x');
  expect(href.pathname).toBe('/preview/task-board');
  expect(href.searchParams.get('returnTo')).toBe('/projects/alpha');
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
    (link) => link.textContent === 'Folder settings',
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
});
