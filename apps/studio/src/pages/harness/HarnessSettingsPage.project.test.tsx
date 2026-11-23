// @vitest-environment jsdom
import type { HarnessApi } from '@corral/client';
import type { ProjectSummary } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SettingsNavigationContext } from '../../workbench/navigation.ts';
import { HarnessSettingsPage } from './HarnessSettingsPage.tsx';

const fixture = vi.hoisted(() => ({ api: {} as HarnessApi }));
vi.mock('../../services.tsx', () => ({ useServices: () => ({ harnesses: fixture.api }) }));
vi.mock('../../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsCommand: () => ({ current: null }),
  useSettingsForm: () => async () => true,
  useSettingsTask: () => async (task: () => Promise<unknown>) => task(),
}));
vi.mock('../SettingsPage.tsx', () => ({
  // The frame's description line, as SettingsLayout draws it under the section title.
  SettingsLayout: ({
    children,
    description,
    descriptionId,
  }: {
    children: ReactNode;
    description?: ReactNode;
    descriptionId?: string;
  }) => (
    <>
      {description ? (
        <p data-description="" data-testid={descriptionId}>
          {description}
        </p>
      ) : null}
      {children}
    </>
  ),
}));
vi.mock('./HarnessMcpTools.tsx', () => ({ HarnessMcpTools: () => null }));
vi.mock('../../workbench/harness/PermissionPolicyEditor.tsx', () => ({
  PermissionPolicyEditor: () => null,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

const project = (projectId: string, name: string) => ({ projectId, name }) as ProjectSummary;

it('Work styles has no project picker of its own and follows the settings target project', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const projectTools = vi.fn(async (_projectId: string) => null);
  fixture.api = {
    resources: async () => [],
    profileManagement: async () => [],
    projectTools,
    entries: async () => [],
  } as unknown as HarnessApi;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (projectId: string) =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <SettingsNavigationContext.Provider
          value={{
            projects: [project('a', 'Alpha'), project('b', 'Beta')],
            projectId,
            returnTo: '/projects',
            search: {},
            overlay: true,
            link: (section) => ({ to: `/settings/${section}`, search: {}, resetScroll: false }),
            selectProject: vi.fn(),
          }}
        >
          <HarnessSettingsPage />
        </SettingsNavigationContext.Provider>
      </IntlProvider>,
    );
  try {
    await act(async () => render('a'));
    expect(projectTools).toHaveBeenLastCalledWith('a');
    // The single picker lives in the settings navigation; the page itself names no project.
    expect(container.querySelector('#project-context')).toBeNull();
    for (const label of ['Project tools and defaults', 'Applies to project', 'Settings for'])
      expect(container.querySelector(`[aria-label="${label}"]`)).toBeNull();
    expect(container.textContent).not.toContain('Alpha');
    await act(async () => render('b'));
    expect(projectTools).toHaveBeenLastCalledWith('b');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('says once that a work style is shared, as the section description', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  fixture.api = {
    resources: async () => [],
    profileManagement: async () => [],
    projectTools: async () => null,
    entries: async () => [],
  } as unknown as HarnessApi;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <SettingsNavigationContext.Provider
            value={{
              projects: [project('a', 'Alpha')],
              projectId: 'a',
              returnTo: '/projects',
              search: {},
              overlay: true,
              link: (section) => ({ to: `/settings/${section}`, search: {}, resetScroll: false }),
              selectProject: vi.fn(),
            }}
          >
            <HarnessSettingsPage />
          </SettingsNavigationContext.Provider>
        </IntlProvider>,
      ),
    );
    const description = container.querySelector('[data-description]');
    expect(description?.textContent).toBe(messages.Harness.sharedScope);
    expect(description?.getAttribute('data-testid')).toBe('shared-scope');
    // No grey notice restating it, and no second line saying a save makes a revision.
    expect(container.textContent?.split('Shared Harness')).toHaveLength(2);
    expect(container.textContent).not.toContain('Each save makes a new revision');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('opens the exact policy revision carried by a skill usage link', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const profile = {
    profileId: 'p',
    revision: 2,
    name: 'Previous policy',
    resources: [],
    allowedTools: [],
    startupCommands: [],
    policy: 'strict',
  };
  const lookup = vi.fn(async () => profile);
  fixture.api = {
    resources: async () => [],
    profileManagement: async () => [{ ...profile, revision: 3, name: 'Latest policy', usages: [] }],
    projectTools: async () => null,
    entries: async () => [],
    profile: lookup,
  } as unknown as HarnessApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <SettingsNavigationContext.Provider
            value={{
              projects: [],
              search: {},
              returnTo: '/library/skills',
              item: 'p:2',
              link: () => ({ to: '/', search: {}, resetScroll: false }),
            }}
          >
            <HarnessSettingsPage />
          </SettingsNavigationContext.Provider>
        </IntlProvider>,
      ),
    );
    expect(lookup).toHaveBeenCalledWith({ profileId: 'p', revision: 2 });
    expect(Array.from(host.querySelectorAll('input'), (input) => input.value)).toContain(
      'Previous policy',
    );
    expect(host.querySelector('button[aria-pressed="true"]')).toBeNull();
    expect(host.textContent).toContain('Previous policy · r2');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
