// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ServicePreview } from './ServicePreview.tsx';

// The session preview pane links to the browser QA feature preview and draws no sample content
// itself (docs/specs/features/feature-preview.md).

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  workspaces: {
    commands: vi.fn(async () => [] as unknown[]),
    tasks: vi.fn(async () => ({ tasks: [] as unknown[] })),
    startPreview: vi.fn(),
    stopPreview: vi.fn(async () => {}),
  },
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../desktop.tsx', () => ({ previewDesktop: null }));

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fixture.workspaces.commands.mockResolvedValue([]);
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function render(url: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const session = createRoute({
    getParentRoute: () => root,
    path: '/sessions/$sessionId',
    component: () => <ServicePreview sessionId="session_a" projectId="project_a" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([session]),
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
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>,
    );
    await router.load();
  });
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return container;
}

function qaLink(container: HTMLElement) {
  const link = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(
    (anchor) => anchor.textContent?.trim() === 'Browser QA preview',
  );
  if (!link) throw new Error('no Browser QA preview link');
  return new URL(link.getAttribute('href') ?? '', 'http://corral.local');
}

it.each([
  ['an idle server pane', 'server', []],
  [
    'a pane with a running command',
    'server',
    [{ id: 'cmd_1', state: 'running', command: 'pnpm dev', shellId: 'sh', cwd: '.' }],
  ],
  ['the browser runtime', 'browser', []],
] as const)(
  'links %s to the browser QA preview and back to this screen',
  async (_name, mode, commands) => {
    fixture.workspaces.commands.mockResolvedValue([...commands]);
    fixture.services = { mode, workspaceId: 'local', workspaces: fixture.workspaces };
    const container = await render('/sessions/session_a?panel=files');
    const href = qaLink(container);
    expect(href.pathname).toBe('/preview/browser-qa');
    expect(href.searchParams.get('returnTo')).toBe('/sessions/session_a?panel=files');
    // A link only: the real pane shows no sample page, snapshot or screenshot.
    expect(container.textContent).not.toMatch(/sample data|Simulated|example-shop/i);
  },
);
