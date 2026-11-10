// @vitest-environment jsdom
import type { ProjectSummary } from '@corral/core';
import { Dialog, DialogPopup, SidebarProvider } from '@corral/react/design-kit';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SettingsNavigationContext } from './navigation.ts';
import { SettingsNavigation } from './SettingsNavigation.tsx';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search: _search,
    activeOptions: _activeOptions,
    activeProps: _activeProps,
    inactiveProps: _inactiveProps,
    resetScroll: _resetScroll,
    replace: _replace,
    state: _state,
    hash: _hash,
    params: _params,
    ...props
  }: ComponentProps<'a'> & Record<string, unknown> & { to: string }) => <a {...props} href={to} />,
  useNavigate: () => vi.fn(),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string; search: object } }) => unknown;
  }) => select({ location: { pathname: '/projects/b', search: {} } }),
}));

afterEach(() => vi.unstubAllGlobals());

const project = (projectId: string, name: string) => ({ projectId, name }) as ProjectSummary;

async function render(overlay: boolean, projectId?: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const navigation = (
    <SidebarProvider persist={false} shortcut={null}>
      <SettingsNavigation inbox={0} currentProject="b" />
    </SidebarProvider>
  );
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <SettingsNavigationContext.Provider
          value={{
            projects: [project('a', 'Alpha'), project('b', 'Beta')],
            ...(projectId ? { projectId } : {}),
            returnTo: '/projects/b',
            search: {},
            overlay,
            section: 'general',
            link: (section) => ({ to: `/settings/${section}`, search: {}, resetScroll: false }),
            selectProject: vi.fn(),
          }}
        >
          {overlay ? (
            <Dialog open>
              <DialogPopup>{navigation}</DialogPopup>
            </Dialog>
          ) : (
            navigation
          )}
        </SettingsNavigationContext.Provider>
      </IntlProvider>,
    ),
  );
  return {
    container: document.body,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it('heads the project group with the one settings target picker', async () => {
  const { container, cleanup } = await render(true, 'b');
  try {
    const nav = container.querySelector<HTMLElement>('[data-testid="settings-sidebar"]');
    const group = nav?.querySelector<HTMLElement>('[aria-label="Project"]');
    // The group label names the picker on screen; "Settings for" is its accessible name only.
    expect(group?.textContent).not.toContain('Settings for');
    const pickers = container.querySelectorAll('[aria-label="Settings for"]');
    expect(pickers).toHaveLength(1);
    expect(group?.contains(pickers[0] ?? null)).toBe(true);
    expect(pickers[0]?.textContent).toContain('Beta');
    // The app group carries Diagnostics.
    const app = nav?.querySelector<HTMLElement>('[aria-label="App"]');
    expect(
      [...(app?.querySelectorAll('a') ?? [])].map((link) => link.getAttribute('href')),
    ).toContain('/settings/diagnostics');
  } finally {
    await cleanup();
  }
});

it('asks for a project when the settings have no target yet', async () => {
  const { container, cleanup } = await render(true);
  try {
    expect(container.querySelector('[aria-label="Settings for"]')?.textContent).toContain(
      'Choose a project',
    );
  } finally {
    await cleanup();
  }
});

it('keeps no standalone return link or collapse control', async () => {
  const { container, cleanup } = await render(false, 'b');
  try {
    expect(container.textContent).not.toContain('Back to work');
    expect(container.querySelector('[aria-label="Hide the sidebar"]')).toBeNull();
  } finally {
    await cleanup();
  }
});
