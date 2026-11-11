// @vitest-environment jsdom
import type { ProjectSummary } from '@corral/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SettingsNavigationContext, type SettingsSection } from '../workbench/navigation.ts';
import { SettingsContent } from '../workbench/SettingsContent.tsx';

// The settings dialog's content frame owns the one section heading (docs/specs/workbench.md#문맥형-설정).

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

const project = { projectId: 'alpha', name: 'Alpha' } as ProjectSummary;

async function render(content: ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const root = createRootRoute({
    component: () => (
      <SettingsNavigationContext.Provider
        value={{
          projects: [project],
          projectId: 'alpha',
          returnTo: '/projects/alpha',
          search: {},
          overlay: true,
          link: (section) => ({
            to: '/projects/alpha',
            search: { settings: section },
            resetScroll: false,
          }),
        }}
      >
        {content}
      </SettingsNavigationContext.Provider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/projects/$projectId' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/projects/alpha?settings=general'] }),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  cleanups.push(async () => {
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
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return container;
}

const browserDemo = {
  mode: 'browser',
  live: false,
  models: null,
  harnesses: null,
  vault: null,
  workspaces: null,
  repository: { listProjects: async () => [project] },
  serverVersion: null,
};

const LABELS: Partial<Record<SettingsSection, string>> = {
  general: messages.Desktop.general,
  shortcuts: messages.Desktop.shortcuts,
  about: messages.Desktop.about,
  models: messages.Desktop.models,
  harness: messages.Harness.heading,
  defaults: messages.Navigation.personalDefaults,
  'project-defaults': messages.Navigation.projectDefaults,
  skills: messages.Resources.skills,
  hooks: messages.Resources.hooks,
  mcp: messages.Resources.mcp,
  vault: messages.Vault.heading,
};

it.each(Object.entries(LABELS))(
  'the frame alone heads the %s section with its name',
  async (section, label) => {
    fixture.services = browserDemo;
    const container = await render(<SettingsContent section={section} />);
    const headings = [...container.querySelectorAll('h1, h2')];
    expect(headings.map((heading) => heading.textContent)).toEqual([label]);
    expect(headings[0]?.closest('[data-settings-header]')).toBeTruthy();
    expect(container.querySelector('main h1, main h2')).toBeNull();
  },
);

const emptyHarness = {
  entries: vi.fn(async () => []),
  packages: vi.fn(async () => []),
  projectTools: vi.fn(async () => ({
    projectId: 'alpha',
    revision: 1,
    hash: 'h',
    checks: [],
    lspServers: [],
    mcpServers: [],
  })),
  mcpHistory: vi.fn(async () => []),
  mcpUsages: vi.fn(async () => []),
  profileManagement: vi.fn(async () => []),
};

// A heading names its section; no line under it introduces or explains the section
// (docs/specs/workbench.md: 제목 아래 소개 문장을 두지 않는다).
it.each([
  ['general', browserDemo],
  ['shortcuts', browserDemo],
  ['defaults', browserDemo],
  ['project-defaults', browserDemo],
  ['skills', { ...browserDemo, mode: 'server', harnesses: emptyHarness }],
  ['hooks', { ...browserDemo, mode: 'server', harnesses: emptyHarness }],
  ['mcp', { ...browserDemo, mode: 'server', harnesses: emptyHarness }],
] as const)('puts no intro line under the %s heading', async (section, services) => {
  fixture.services = services;
  const container = await render(<SettingsContent section={section} />);
  const header = container.querySelector('[data-settings-header]');
  expect(header?.querySelector('h2')).toBeTruthy();
  expect(header?.querySelector('p')).toBeNull();
});

it.each([
  ['skills', messages.Resources.emptySkills],
  ['mcp', messages.Resources.emptyMcp],
] as const)('shows one empty state and one Add for an empty %s list', async (section, title) => {
  fixture.services = { ...browserDemo, mode: 'server', harnesses: emptyHarness };
  const container = await render(<SettingsContent section={section} />);
  const main = container.querySelector('main') as HTMLElement;
  expect(main.querySelectorAll('.border-dashed')).toHaveLength(1);
  expect(main.textContent).toContain(title);
  const adds = [...main.querySelectorAll('button')].filter(
    (button) => button.textContent === messages.Resources.add,
  );
  expect(adds).toHaveLength(1);
  // No row whose label repeats its own button.
  expect([...main.querySelectorAll('h3')].map((heading) => heading.textContent)).not.toContain(
    messages.Resources.add,
  );
  expect(main.textContent).not.toContain('Select an item');
});
