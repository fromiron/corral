// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { type PreviewTabs, PreviewTabsContext } from './browser/previewTabs.tsx';
import { ServicePreview } from './ServicePreview.tsx';

// The session preview pane links to the browser QA feature preview and draws no sample content
// itself (docs/specs/features/feature-preview.md).

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  tabs: null as PreviewTabs | null,
  hide: () => {},
  desktop: null as { openPreview: (...args: unknown[]) => Promise<void> } | null,
  workspaces: {
    commands: vi.fn(async () => [] as unknown[]),
    tasks: vi.fn(async () => ({ tasks: [] as unknown[] })),
    startPreview: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    stopPreview: vi.fn(async () => {}),
  },
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../desktop.tsx', () => ({
  get previewDesktop() {
    return fixture.desktop;
  },
}));

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
  fixture.desktop = null;
  fixture.tabs = null;
  fixture.workspaces.stopPreview.mockClear();
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

/** The pane, which `fixture.hide()` takes away as closing the 작업 tab does. */
function Host() {
  const [shown, setShown] = useState(true);
  fixture.hide = () => setShown(false);
  return (
    <PreviewTabsContext.Provider value={fixture.tabs}>
      {shown ? <ServicePreview sessionId="session_a" projectId="project_a" /> : null}
    </PreviewTabsContext.Provider>
  );
}

async function render(url: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const session = createRoute({
    getParentRoute: () => root,
    path: '/sessions/$sessionId',
    component: Host,
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
  await flush();
  return { container, router };
}
async function flush() {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
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
    const { container } = await render('/sessions/session_a?panel=files');
    const href = qaLink(container);
    expect(href.pathname).toBe('/preview/browser-qa');
    expect(href.searchParams.get('returnTo')).toBe('/sessions/session_a?panel=files');
    // A link only: the real pane shows no sample page, snapshot or screenshot.
    expect(container.textContent).not.toMatch(/sample data|Simulated|example-shop/i);
  },
);

// Where the desktop's browser tab is (features/browser-tab.md 여는 곳, 닫기와 떠나기).
const SERVICE = {
  leaseId: 'lease_svc',
  sessionId: 'session_a',
  runId: 'run_dev',
  operationId: 'cmd_1',
  kind: 'service',
  url: 'http://127.0.0.2:4100/lease_svc/',
  origin: 'http://127.0.0.2:4100',
  path: '/',
  state: 'ready',
  createdAt: '2026-11-18T00:00:00Z',
};
async function startService(container: HTMLElement) {
  const start = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === messages.Preview.openInteractive,
  );
  if (!start) throw new Error('no Open interactive preview');
  await act(async () => start.click());
  await flush();
}
function withCommand() {
  fixture.workspaces.commands.mockResolvedValue([
    { id: 'cmd_1', state: 'running', command: 'pnpm dev', shellId: 'sh', cwd: '.' },
  ]);
  fixture.workspaces.startPreview.mockResolvedValue({ ...SERVICE });
  fixture.services = { mode: 'server', workspaceId: 'local', workspaces: fixture.workspaces };
}

it('브라우저 탭이 있으면 시작한 서비스 미리보기를 미리보기 탭으로 열고(작업 탭이 시작한 것으로), 따로 뜨는 창과 요소 캡처는 없으며, 이 칸이 사라져도 멈추지 않는다', async () => {
  withCommand();
  const open = vi.fn(() => true);
  fixture.tabs = { open };
  fixture.desktop = { openPreview: vi.fn(async () => {}) };
  const { container } = await render('/sessions/session_a?panel=preview');
  await startService(container);

  expect(open.mock.calls).toEqual([['lease_svc', { started: true }]]);
  expect(fixture.desktop.openPreview).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain(messages.PreviewFeedback.capture);

  await act(async () => fixture.hide());
  await flush();
  expect(container.textContent).not.toContain(messages.Preview.service);
  expect(fixture.workspaces.stopPreview).not.toHaveBeenCalled();
});

it('미리보기 탭이 열리지 않았다(false) → 시작한 lease를 멈춘다', async () => {
  withCommand();
  fixture.tabs = { open: vi.fn(() => false) };
  const { container } = await render('/sessions/session_a?panel=preview');
  await startService(container);

  expect(fixture.workspaces.stopPreview).toHaveBeenCalledWith('session_a', 'lease_svc');
});

it('브라우저 탭이 없는 데스크톱(원격 호스트의 창)에서는 따로 뜨는 창으로 열고, 이 칸이 사라지면 지금처럼 멈춘다 (반례)', async () => {
  withCommand();
  fixture.desktop = { openPreview: vi.fn(async () => {}) };
  const { container } = await render('/sessions/session_a?panel=preview');
  await startService(container);
  expect(fixture.desktop.openPreview).toHaveBeenCalledWith('session_a', 'lease_svc');

  await act(async () => fixture.hide());
  await flush();
  expect(fixture.workspaces.stopPreview).toHaveBeenCalledWith('session_a', 'lease_svc');
});

// workbench.md: a failed read shows its cause and a way to try again, never an empty list.
it('tells a failed service list apart from no service, and reads it again on Try again', async () => {
  fixture.workspaces.commands.mockRejectedValue(new Error('offline'));
  fixture.services = { mode: 'server', workspaceId: 'local', workspaces: fixture.workspaces };
  const { container } = await render('/sessions/session_a?panel=files');
  expect(container.textContent).not.toContain('No service is running');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline');
  fixture.workspaces.commands.mockResolvedValue([]);
  const again = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Try again',
  );
  if (!again) throw new Error('Missing Try again');
  await act(async () => again.click());
  await flush();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('No service is running');
});
