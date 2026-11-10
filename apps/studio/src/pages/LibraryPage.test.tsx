// @vitest-environment jsdom
import type { HarnessEntryView, PackageView, ProjectToolConfigRevision } from '@corral/contracts';
import { type CorralRepository, createKeyValueCorralRepository } from '@corral/core';
import { emptyDraft } from '@corral/react';
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
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { setCurrentProject } from '../projects.ts';
import { SettingsNavigationContext } from '../workbench/navigation.ts';
import {
  LIBRARY_VIEWS,
  LibraryPage,
  type LibraryView,
  validateLibrarySearch,
} from './LibraryPage.tsx';
import { ResourceTable } from './LibraryResources.tsx';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function memoryRepository(): CorralRepository {
  const values = new Map<string, string>();
  let id = 0;
  let project = 0;
  let session = 0;
  return createKeyValueCorralRepository(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    },
    {
      clock: { nowIso: () => '2026-11-10T00:00:00.000Z', monotonicMs: () => 0 },
      newCorralId: () => `corral_${++id}`,
      newProjectId: () => `project_${++project}`,
      newSessionId: () => `session_${++session}`,
    },
  );
}

async function team(repository: CorralRepository, name: string, projectId: string) {
  const draft = emptyDraft('untitled', name);
  const result = await repository.save({
    definition: draft.definition,
    expectedDefinitionRevision: null,
    projectId,
  });
  if (!result.ok) throw new Error(result.message);
  return result.record.corralId;
}

/** Root layout's overlay link: the same work address with the settings dialog search added. */
function SettingsBridge({ children }: { children: ReactNode }) {
  const location = useRouterState({ select: (state) => state.location });
  return (
    <SettingsNavigationContext.Provider
      value={{
        projects: [],
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

async function render(url: string, children?: ReactNode, locale: 'en' | 'ko' = 'en') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRootRoute({
    component: () => (
      <SettingsBridge>
        <Outlet />
      </SettingsBridge>
    ),
  });
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p data-testid="elsewhere">{path}</p>,
    });
  const views = LIBRARY_VIEWS.map((view: LibraryView) =>
    createRoute({
      getParentRoute: () => root,
      path: `/library/${view}`,
      component: () => children ?? <LibraryPage view={view} />,
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren([
      ...views,
      stub('/corrals/$corralId/edit'),
      stub('/sessions/$sessionId'),
      stub('/projects/$projectId'),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
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
      <IntlProvider locale={locale} messages={locale === 'ko' ? ko : messages} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>,
    );
    await router.load();
  });
  await settle();
  return { container, router };
}

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

const byText = (container: HTMLElement, selector: string, text: string | RegExp) =>
  [...container.querySelectorAll<HTMLElement>(selector)].find((element) =>
    typeof text === 'string'
      ? element.textContent?.trim() === text
      : text.test(element.textContent ?? ''),
  );

const groupOf = (container: HTMLElement, group: string) =>
  container.querySelector<HTMLElement>(`[data-resource-group="${group}"]`);

const resource = {
  license: null,
  packagePath: null,
  extensions: [] as string[],
  skills: [] as { name: string; description: string; entry: string }[],
  createdAt: '2026-11-10T00:00:00.000Z',
  trustedAt: '2026-11-10T00:00:00.000Z',
};
const hash = (n: number) => `sha256:${String(n).repeat(64)}`;

function entry(
  kind: 'skill' | 'extension',
  name: string,
  sourceLabel: string,
  n: number,
): HarnessEntryView {
  return {
    resourceHash: hash(n),
    entry: kind === 'skill' ? 'skills/SKILL.md' : 'extensions/hook.ts',
    kind,
    name,
    description: '',
    managementRevision: 1,
    archivedAt: null,
    successor: null,
    profiles: [],
    resource: {
      ...resource,
      hash: hash(n),
      name: 'corral-managed-resource',
      version: '1.0.0',
      sourceKind: 'local',
      sourceLabel,
      fileCount: 2,
    },
  };
}

function packageView(
  name: string,
  n: number,
  change: Partial<PackageView['resource']> = {},
): PackageView {
  return {
    managementRevision: 1,
    status: 'enabled',
    updatedAt: null,
    manifest: null,
    profiles: [],
    resource: {
      ...resource,
      hash: hash(n),
      name,
      version: '1.2.3',
      sourceKind: 'npm',
      sourceLabel: `npm:${name}@1.2.3`,
      files: [],
      ...change,
    },
  };
}

const mcp: ProjectToolConfigRevision = {
  projectId: 'alpha',
  revision: 3,
  hash: hash(9),
  checks: [],
  lspServers: [],
  mcpServers: [
    {
      id: 'mcp_local',
      name: 'Local tools',
      transport: 'stdio',
      argv: ['/usr/local/bin/tool-server', '--token=abc123'],
    },
    {
      id: 'mcp_remote',
      name: 'Remote search',
      transport: 'http',
      url: 'https://search.example/mcp?token=abc123',
      enabled: false,
    },
  ],
} as unknown as ProjectToolConfigRevision;

function harnesses(overrides: Record<string, unknown> = {}) {
  return {
    entries: vi.fn(async () => [
      entry('skill', 'Code review', 'Created in Corral', 1),
      entry('extension', 'Notify on finish', 'Created in Corral', 2),
      entry('extension', 'lint-hook.ts', '/home/me/private/lint-pack', 3),
    ]),
    packages: vi.fn(async () => [
      packageView('lint-pack', 3, {
        sourceLabel: '/home/me/private/lint-pack',
        sourceKind: 'local',
      }),
      packageView('writing-skill', 4, {
        skills: [{ name: 'writing', description: '', entry: 'SKILL.md' }],
      }),
    ]),
    projectTools: vi.fn(async () => mcp),
    ...overrides,
  };
}

let repository: CorralRepository;
beforeEach(async () => {
  repository = memoryRepository();
  await repository.createProject({ name: 'Alpha' });
  await repository.createProject({ name: 'Beta' });
  fixture.services = {
    mode: 'server',
    persistent: true,
    repository,
    harnesses: harnesses(),
    workspaces: null,
  };
});

it('keeps a project filter, a draft request and an in-app return address', () => {
  expect(
    validateLibrarySearch({ project: 'project_a', returnTo: '/sessions/session_a#draft' }),
  ).toEqual({ project: 'project_a', returnTo: '/sessions/session_a#draft' });
  expect(validateLibrarySearch({ project: 'project_a', draft: '1' })).toEqual({
    project: 'project_a',
    draft: true,
  });
  for (const search of [
    { project: '' },
    { project: 'x'.repeat(257) },
    { project: ['project_a'] },
    { returnTo: 'https://example.org' },
    { returnTo: '//example.org' },
    { returnTo: '/settings/skills' },
    { draft: 'yes' },
  ])
    expect(validateLibrarySearch(search)).toEqual({});
});

it.each(LIBRARY_VIEWS)('frames the %s view with the library title and its tab', async (view) => {
  const { container } = await render(`/library/${view}?project=project_1`);
  expect(container.querySelector('h1')?.textContent).toBe('Library');
  expect(container.querySelector('[data-library-view]')?.getAttribute('data-library-view')).toBe(
    view,
  );
  const tabs = [...container.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
  const name = (tab: HTMLElement) => tab.querySelector('span > span:last-child')?.textContent;
  expect(tabs.map(name)).toEqual(['Teams', 'Templates', 'Resources']);
  expect(
    name(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') as HTMLElement),
  ).toBe(view[0]?.toUpperCase() + view.slice(1));
});

it("lists the filtered project's teams and makes a new team in it with the existing editor flow", async () => {
  await team(repository, 'Alpha reviewers', 'project_1');
  await team(repository, 'Beta writers', 'project_2');
  const { container, router } = await render('/library/teams?project=project_1');
  expect(container.textContent).toContain('Alpha reviewers');
  expect(container.textContent).not.toContain('Beta writers');
  const create = byText(container, 'button', 'New team');
  expect(create).toBeTruthy();
  await act(async () => create?.click());
  await settle();
  expect(router.state.location.pathname).toMatch(/^\/corrals\/corral_\d+\/edit$/);
  const made = (await repository.list()).find((item) => item.corralId === 'corral_3');
  expect(made?.projectId).toBe('project_1');
});

it('uses the last opened project without a filter and offers a project filter', async () => {
  await team(repository, 'Alpha reviewers', 'project_1');
  await team(repository, 'Beta writers', 'project_2');
  setCurrentProject('project_2');
  const { container } = await render('/library/teams');
  expect(container.textContent).toContain('Beta writers');
  expect(container.textContent).not.toContain('Alpha reviewers');
  expect(
    container.querySelector('[role="combobox"][aria-label="Project"], [aria-label="Project"]'),
  ).toBeTruthy();
});

it('opens a team detail with a conversation, the editor and a duplicate', async () => {
  const id = await team(repository, 'Alpha reviewers', 'project_1');
  const { container, router } = await render('/library/teams?project=project_1');
  const name = byText(container, 'button', 'Alpha reviewers');
  await act(async () => name?.click());
  const detail = container.querySelector<HTMLElement>('[aria-label="Team details"]');
  expect(detail).toBeTruthy();
  expect(detail?.querySelector(`a[href="/corrals/${id}/edit"]`)?.textContent).toBe('Edit');
  const duplicate = byText(detail as HTMLElement, 'button', 'Duplicate');
  await act(async () => duplicate?.click());
  await settle();
  expect((await repository.list()).map((item) => item.name)).toContain('Alpha reviewers copy');
  // The copy is shown next; the original is one click away.
  expect(container.querySelector('[aria-label="Team details"] h2')?.textContent).toContain(
    'Alpha reviewers copy',
  );
  await act(async () => byText(container, 'button', 'Alpha reviewers')?.click());
  const start = byText(container, 'button', 'New conversation with this team');
  await act(async () => start?.click());
  await settle();
  expect(router.state.location.pathname).toMatch(/^\/sessions\/session_1$/);
  expect((await repository.getSession('session_1'))?.corralId).toBe(id);
});

it('moves a team from its Move to… button and menu of projects, beside Edit and Duplicate', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.getAnimations ??= () => [];
  const id = await team(repository, 'Alpha reviewers', 'project_1');
  const { container } = await render('/library/teams?project=project_1');
  const detail = container.querySelector<HTMLElement>('[aria-label="Team details"]');
  // A button like Edit and Duplicate, never a select showing its placeholder.
  expect(detail?.querySelector('[data-slot="select-trigger"]')).toBeNull();
  expect(detail?.textContent).not.toContain('Select…');
  const move = byText(detail as HTMLElement, 'button', messages.Projects.moveChoose);
  expect(move).toBeTruthy();
  await act(async () => {
    move?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    move?.click();
  });
  await settle();
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  // Other active projects only; the team's own project is not a destination.
  expect(items.map((item) => item.getAttribute('aria-label') ?? item.textContent)).toEqual([
    'My project',
    'Beta',
  ]);
  await act(async () => items[1]?.click());
  await settle();
  expect((await repository.list()).find((item) => item.corralId === id)?.projectId).toBe(
    'project_2',
  );
});

it('adds the settings dialog to the current library address from Manage', async () => {
  const { container, router } = await render(
    '/library/resources?project=project_1&returnTo=%2Fsessions%2Fsession_a',
  );
  const manage = container.querySelector<HTMLAnchorElement>('a[aria-label="Manage Local tools"]');
  expect(manage).toBeTruthy();
  await act(async () => manage?.click());
  await settle();
  expect(router.state.location.pathname).toBe('/library/resources');
  expect(router.state.location.search).toMatchObject({
    project: 'project_1',
    returnTo: '/sessions/session_a',
    settings: 'mcp',
    settingsProject: 'project_1',
  });
  const skill = container.querySelector<HTMLAnchorElement>('a[aria-label="Manage Code review"]');
  expect(new URL(skill?.href ?? '', 'http://x').searchParams.get('settings')).toBe('skills');
  const hook = container.querySelector<HTMLAnchorElement>(
    'a[aria-label="Manage Notify on finish"]',
  );
  expect(new URL(hook?.href ?? '', 'http://x').searchParams.get('settings')).toBe('hooks');
});

it('shows a failed group with its failure and a retry while the other groups stay', async () => {
  const packages = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([packageView('lint-pack', 3)]);
  fixture.services = { ...fixture.services, harnesses: harnesses({ packages }) };
  const { container } = await render('/library/resources?project=project_1');
  const group = groupOf(container, 'packages') as HTMLElement;
  expect(group.textContent).toContain('Could not load Packages.');
  expect(group.textContent).not.toContain('None');
  expect(group.querySelector('[role="alert"]')).toBeTruthy();
  expect(groupOf(container, 'skills')?.textContent).toContain('Code review');
  expect(groupOf(container, 'mcp')?.textContent).toContain('Local tools');
  const retry = byText(group, 'button', 'Try again');
  await act(async () => retry?.click());
  await settle();
  expect(packages).toHaveBeenCalledTimes(2);
  expect(groupOf(container, 'packages')?.textContent).toContain('lint-pack');
  expect(groupOf(container, 'packages')?.textContent).not.toContain('Could not load');
});

it('shows a refused package with its limit reason and the next step', async () => {
  const { container } = await render(
    '/library/resources',
    <ResourceTable
      group="packages"
      projectId="project_1"
      rows={[
        {
          key: 'refused',
          name: 'huge-pack',
          scope: 'personal',
          state: 'refused',
          issue: 'package_limit',
        },
      ]}
    />,
  );
  expect(container.textContent).toContain('Not installed');
  expect(container.textContent).toContain(
    'Install refused: the package is over the size or file-count limit.',
  );
  expect(container.textContent).toContain(
    'Leave out files it does not need or split the package, then review it again.',
  );
});

it('says when a package with a root SKILL.md was read as one Skill', async () => {
  const { container } = await render('/library/resources?project=project_1');
  const packages = groupOf(container, 'packages') as HTMLElement;
  const row = [...packages.querySelectorAll('tr')].find((tr) =>
    tr.textContent?.includes('writing-skill'),
  );
  expect(row?.textContent).toContain('read as one Skill');
  expect(row?.textContent).toContain('move SKILL.md into a skills folder');
});

it('shows the browser demo one empty state that says resources need the local server', async () => {
  fixture.services = { ...fixture.services, mode: 'browser', harnesses: null };
  const { container } = await render('/library/resources');
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
  expect(panel.querySelectorAll('.border-dashed')).toHaveLength(1);
  expect(panel.textContent?.match(/Available with the local server/g)).toHaveLength(1);
  for (const group of ['skills', 'hooks', 'extensions', 'packages', 'mcp'])
    expect(groupOf(container, group)).toBeNull();
  expect(panel.textContent).not.toContain('None');
  expect(panel.querySelector('[role="alert"]')).toBeNull();
});

it('shows one empty state with a way to add each kind when nothing is installed', async () => {
  fixture.services = {
    ...fixture.services,
    harnesses: harnesses({
      entries: vi.fn(async () => []),
      packages: vi.fn(async () => []),
      projectTools: vi.fn(async () => ({ ...mcp, mcpServers: [] })),
    }),
  };
  const { container } = await render('/library/resources?project=project_1');
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
  expect(panel.querySelectorAll('.border-dashed')).toHaveLength(1);
  expect(panel.textContent).not.toContain('None');
  for (const group of ['skills', 'hooks', 'extensions', 'packages', 'mcp'])
    expect(groupOf(container, group)).toBeNull();
  const sections = [...panel.querySelectorAll<HTMLAnchorElement>('a[aria-label^="Manage "]')].map(
    (link) => new URL(link.href, 'http://x').searchParams.get('settings'),
  );
  expect(new Set(sections)).toEqual(new Set(['skills', 'hooks', 'mcp']));
});

it('lists only the groups that have items or failed, and keeps the others one click away', async () => {
  const packages = vi.fn().mockRejectedValue(new Error('offline'));
  fixture.services = {
    ...fixture.services,
    harnesses: harnesses({
      entries: vi.fn(async () => [entry('skill', 'Code review', 'Created in Corral', 1)]),
      packages,
      projectTools: vi.fn(async () => ({ ...mcp, mcpServers: [] })),
    }),
  };
  const { container } = await render('/library/resources?project=project_1');
  expect(groupOf(container, 'skills')?.textContent).toContain('Code review');
  expect(groupOf(container, 'packages')?.textContent).toContain('Could not load Packages.');
  for (const group of ['hooks', 'extensions', 'mcp']) expect(groupOf(container, group)).toBeNull();
  expect(container.textContent).not.toContain('None');
  const mcpManage = container.querySelector<HTMLAnchorElement>(
    'a[aria-label="Manage MCP servers"]',
  );
  expect(new URL(mcpManage?.href ?? '', 'http://x').searchParams.get('settings')).toBe('mcp');
  const hooksManage = container.querySelector<HTMLAnchorElement>('a[aria-label="Manage Hooks"]');
  expect(new URL(hooksManage?.href ?? '', 'http://x').searchParams.get('settings')).toBe('hooks');
});

it('offers New team and Browse templates when the project has no teams', async () => {
  const { container, router } = await render('/library/teams?project=project_1');
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
  expect(panel.querySelectorAll('.border-dashed')).toHaveLength(1);
  // No pointer to templates "below": they are on their own tab.
  expect(panel.textContent).not.toMatch(/below/i);
  expect(byText(panel, 'button', 'New team')).toBeTruthy();
  // The storage note is not a sentence under the list.
  expect(panel.textContent).not.toContain('saved in this app data folder');
  await act(async () => byText(panel, 'button', 'Browse templates')?.click());
  await settle();
  expect(router.state.location.pathname).toBe('/library/templates');
  expect(router.state.location.search).toMatchObject({ project: 'project_1' });
});

it('shows the eight templates in order with their roles, and marks the ones that change nothing', async () => {
  const { container } = await render('/library/templates?project=project_1');
  const cards = [...container.querySelectorAll<HTMLElement>('[data-library-view] article')];
  const title = (card: HTMLElement) =>
    card.querySelector('h3 [data-slot="card-title"] > span:last-child')?.textContent;
  expect(cards.map(title)).toEqual([
    'Single agent',
    'Implement and review',
    'Plan, implement and review',
    'Bug fix',
    'Parallel code review',
    'Technical decision',
    'Research team',
    'Empty',
  ]);
  const roles = (card: HTMLElement) =>
    [...card.querySelectorAll('ol[aria-label="Roles"] > li')].map((step) => step.textContent);
  expect(cards.map(roles)).toEqual([
    ['Agent 1'],
    ['Implementation', 'Review'],
    ['Plan', 'Implementation', 'Review'],
    ['Cause investigation', 'Fix', 'Review'],
    ['Scope', 'Correctness review and Security review', 'Synthesis'],
    ['Framing', 'Option A research and Option B research', 'Comparison'],
    ['Researcher', 'Writer', 'Reviewer'],
    [],
  ]);
  const readOnly = (card: HTMLElement) =>
    [...card.querySelectorAll('[data-slot="card-action"]')].some(
      (mark) => mark.textContent === 'Read-only',
    );
  expect(cards.map(readOnly)).toEqual([true, false, false, false, true, true, true, false]);
  // The name and the role flow only: no sentence retelling the flow.
  const ids = [
    'starter',
    'implement-review',
    'plan-implement-review',
    'bug-fix',
    'parallel-review',
    'tech-decision',
    'research-team',
    'blank',
  ] as const;
  for (const [index, card] of cards.entries()) {
    expect(card.querySelector('[data-slot="card-description"]')).toBeNull();
    const id = ids[index] as (typeof ids)[number];
    expect(card.textContent).not.toContain(messages.Workspace.template[id].body);
  }
  // Two quiet actions named for their template; the empty canvas has no conversation to start.
  const actions = (card: HTMLElement) =>
    [...card.querySelectorAll('button')].map((button) => [
      button.textContent,
      button.getAttribute('aria-label'),
    ]);
  expect(cards.map(actions)).toEqual(
    cards.map((card, index) => {
      const name = title(card);
      const edit = ['Edit a copy', `Edit a copy of ${name}`];
      return index === 7 ? [edit] : [['New conversation', `New conversation with ${name}`], edit];
    }),
  );
  // Neither is the screen's primary button: tertiary, then ghost.
  for (const card of cards) {
    const buttons = [...card.querySelectorAll('button')];
    expect(buttons.filter((button) => button.className.includes('text-background'))).toEqual([]);
    expect(buttons.at(-1)?.className).toContain('text-muted-foreground');
  }
  expect(cards[0]?.querySelector('button')?.className).not.toContain('text-muted-foreground');
  // No label over the grid: the tab already names it.
  expect(container.textContent).not.toContain('Start from a template');
  expect(container.querySelector('[role="tabpanel"] section[aria-label]')).toBeNull();
});

it('starts a new conversation in the project with the template chosen', async () => {
  const { container, router } = await render('/library/templates?project=project_1');
  const start = container.querySelector<HTMLElement>(
    'button[aria-label="New conversation with Bug fix"]',
  );
  await act(async () => start?.click());
  await settle();
  expect(router.state.location.pathname).toBe('/projects/project_1');
  expect(router.state.location.search).toMatchObject({ newSession: true });
  expect(JSON.parse(localStorage.getItem('corral:new-session:v1:project_1') ?? '{}').corralId).toBe(
    'template:bug-fix',
  );
});

it('drafts a team from a goal from the toolbar beside the tabs', async () => {
  // The draft dialog follows the person's reduced-motion setting.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  const { container, router } = await render('/library/templates?project=project_1');
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;
  expect(byText(panel, 'button', 'Draft from a goal')).toBeUndefined();
  await act(async () => byText(container, 'button', 'Draft from a goal')?.click());
  await settle();
  expect(router.state.location.search).toMatchObject({ project: 'project_1', draft: true });
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  // The other views have nothing to draft.
  const teams = await render('/library/teams?project=project_1');
  expect(byText(teams.container, 'button', 'Draft from a goal')).toBeUndefined();
});

it('names every template’s roles in Korean on a Korean screen', async () => {
  const { container } = await render('/library/templates?project=project_1', undefined, 'ko');
  const cards = [...container.querySelectorAll<HTMLElement>('[data-library-view] article')];
  const roles = (card: HTMLElement) =>
    [...card.querySelectorAll('ol[aria-label="역할"] > li')].map((step) => step.textContent);
  expect(roles(cards[0] as HTMLElement)).toEqual(['에이전트 1']);
  expect(roles(cards[6] as HTMLElement)).toEqual(['조사자', '작성자', '검토자']);
  for (const card of cards)
    for (const step of roles(card))
      expect([step, /[A-Za-z]{2,}/.test(step ?? '')]).toEqual([step, false]);
  const labels = [...(cards[0] as HTMLElement).querySelectorAll('button')].map((button) => [
    button.textContent,
    button.getAttribute('aria-label'),
  ]);
  expect(labels).toEqual([
    ['새 대화', '단일 에이전트 템플릿으로 새 대화'],
    ['사본 편집', '단일 에이전트 사본 편집'],
  ]);
});

it('saves a copy of a new template as a separate team and opens it in the editor', async () => {
  // The copy dialog follows the person's reduced-motion setting.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  const { container, router } = await render('/library/templates?project=project_1');
  for (const expected of ['Parallel code review', 'Parallel code review (2)']) {
    const card = [...container.querySelectorAll<HTMLElement>('[data-library-view] article')].find(
      (article) => article.textContent?.includes('Parallel code review'),
    ) as HTMLElement;
    await act(async () => byText(card, 'button', 'Edit a copy')?.click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    await act(async () => byText(dialog, 'button', 'Save copy and edit')?.click());
    await settle();
    expect(router.state.location.pathname).toMatch(/^\/corrals\/corral_\d+\/edit$/);
    const corralId = router.state.location.pathname.split('/')[2] as string;
    const saved = await repository.get(corralId);
    expect(saved?.name).toBe(expected);
    expect(saved?.projectId).toBe('project_1');
    await act(async () => router.history.back());
    await settle();
  }
});

it('selects a team by its whole row', async () => {
  await team(repository, 'Alpha reviewers', 'project_1');
  await team(repository, 'Alpha writers', 'project_1');
  const { container } = await render('/library/teams?project=project_1');
  const rows = [...container.querySelectorAll<HTMLTableRowElement>('tbody tr')];
  expect(rows.map((row) => row.dataset.selected)).toEqual(['true', 'false']);
  await act(async () => byText(container, 'button', 'Alpha writers')?.click());
  expect(rows.map((row) => row.dataset.selected)).toEqual(['false', 'true']);
});

it('never shows local paths or tokens in resource rows', async () => {
  const { container } = await render('/library/resources?project=project_1');
  const text = container.textContent ?? '';
  expect(text).toContain('lint-pack');
  expect(text).toContain('Remote search');
  expect(text).not.toMatch(/\/home\/|\/usr\/|token|abc123|npm:/);
});
