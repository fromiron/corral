// @vitest-environment jsdom
import type { WorkSession } from '@corral/core';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionChangesPanel } from './SessionChangesPanel.tsx';

// docs/specs/features/paddock-setup.md 화면: the setup's state under the Changes head while it is
// not a success.

Element.prototype.getAnimations ??= () => [];
const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join(',')})` : `${namespace}.${key}`,
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ reviewRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => () => {},
  useRouterState: ({ select }: { select: (state: { location: { href: string } }) => string }) =>
    select({ location: { href: '/sessions/s1' } }),
}));
vi.mock('./documents/store.ts', () => ({
  documentStore: () => ({ getState: () => ({ documents: {} }) }),
}));
vi.mock('../pages/FilesViews.tsx', () => ({
  WorkingCopyPanel: () => null,
  useBinding: () => ({ binding: null }),
}));
vi.mock('./CheckpointPanel.tsx', () => ({ CheckpointPanel: () => null }));
vi.mock('./GitPanel.tsx', () => ({ GitPanel: () => null }));
vi.mock('../pages/changes/ReviewPage.tsx', () => ({
  ReviewContent: () => null,
  Checks: () => null,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function render(
  state: 'running' | 'succeeded' | 'failed',
  worktree?: () => Promise<unknown>,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
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
  fixture.services = {
    mode: 'server',
    workspaces: {
      worktree: vi.fn(async () => ({
        copyGeneration: 1,
        missing: false,
        setup: {
          operationId: 'setup_1',
          state,
          reason: state === 'failed' ? 'command_failed' : null,
          exitCode: state === 'running' ? null : state === 'failed' ? 1 : 0,
          startedAt: 'x',
          endedAt: state === 'running' ? null : 'y',
        },
      })),
      gitStatus: vi.fn(async () => null),
      parentMerge: vi.fn(async () => null),
      pullRequest: vi.fn(async () => ({ kind: 'read_failed' })),
    },
  };
  if (worktree) (fixture.services.workspaces as Record<string, unknown>).worktree = vi.fn(worktree);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <StrictMode>
        <SessionChangesPanel
          session={{ sessionId: 's1', projectId: 'project' } as WorkSession}
          onReviewChange={() => {}}
          onViewChange={() => {}}
        />
      </StrictMode>,
    ),
  );
  for (let i = 0; i < 4; i++) await act(async () => {});
  return container;
}
const statusText = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent);

it('a running setup shows under the Changes head with its stop', async () => {
  const container = await render('running');
  expect(statusText(container)).toContain('Files.setupRunning');
  expect([...container.querySelectorAll('button')].map((node) => node.textContent)).toContain(
    'Files.setupStop',
  );
});

it('a failed setup shows with Run again; a succeeded one shows nothing', async () => {
  expect(statusText(await render('failed'))).toContain('Files.setupFailed');
  const quiet = await render('succeeded');
  expect(statusText(quiet)).not.toContain('Files.setupRunning');
  expect(statusText(quiet)).not.toContain('Files.setupFailed');
});

it('a Paddock that cannot be read says why with Try again, and offers no new Paddock', async () => {
  let offline = true;
  const container = await render('succeeded', async () => {
    if (offline) throw new Error('offline');
    return null;
  });
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('Files.copyReadFailed(offline)');
  offline = false;
  const retry = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === 'Files.retry',
  );
  await act(async () => retry?.click());
  for (let i = 0; i < 4; i++) await act(async () => {});
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
