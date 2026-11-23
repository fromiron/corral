// @vitest-environment jsdom
import type { GitStatus } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionChangesPanel } from './SessionChangesPanel.tsx';

// The changes tab's Git view with the real Git panel (workbench.md 읽기 전용 Git 관찰, and a
// changes screen without a Paddock showing its title and one next action).

Element.prototype.getAnimations ??= () => [];
const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ reviewRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: () => null,
  useNavigate: () => () => {},
  useRouterState: ({ select }: { select: (state: { location: { href: string } }) => string }) =>
    select({ location: { href: '/sessions/session?panel=git' } }),
}));
vi.mock('./documents/store.ts', () => ({
  documentStore: () => ({ getState: () => ({ documents: {} }) }),
}));
// The shared copy setup: the one place that says there is no copy.
vi.mock('../pages/FilesViews.tsx', () => ({
  WorkingCopyPanel: () => <p>no copy yet</p>,
  useBinding: () => ({ binding: null }),
}));
vi.mock('./CheckpointPanel.tsx', () => ({ CheckpointPanel: () => null }));
vi.mock('../pages/changes/ReviewPage.tsx', () => ({
  ReviewContent: () => null,
  Checks: () => null,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

const project: GitStatus = {
  target: { kind: 'project', hostId: 'host', projectId: 'project', bindingId: 'binding' },
  head: {
    oid: null,
    branch: 'main',
    detached: false,
    unborn: true,
    shallow: false,
    upstream: null,
  },
  indexHash: 'b'.repeat(64),
  filtersDisabled: true,
  truncated: false,
  entries: [],
};

it('without a copy, says so once, shows the project’s Git first, and still offers Paddock', async () => {
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
  const gitStatus = vi.fn(async (scope: { kind: string }) => {
    if (scope.kind === 'session') throw new Error('no working copy');
    return project;
  });
  const createWorktree = vi.fn();
  fixture.services = {
    mode: 'server',
    workspaceId: 'host',
    workspaces: { worktree: vi.fn(async () => null), gitStatus, createWorktree },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <SessionChangesPanel
        session={{ sessionId: 'session', projectId: 'project' } as WorkSession}
        requestedView="git"
        onReviewChange={() => {}}
      />,
    ),
  );
  for (let i = 0; i < 3; i++) await act(async () => {});
  const text = () => container.textContent ?? '';
  expect(text().split('no copy yet')).toHaveLength(2);
  expect(text()).not.toContain('Git.noSessionCopy');
  // The original's Git first (workbench.md): read without choosing, and no copy is made.
  expect(gitStatus.mock.calls.map((call) => call[0])).toEqual([{ kind: 'project', id: 'project' }]);
  expect(text()).toContain('Git.unborn');

  // The source picker stays: Paddock is one choice away, and nothing of it is read without a copy.
  const picker = container.querySelector<HTMLButtonElement>('[role=combobox]');
  expect(picker).not.toBeNull();
  await act(async () => picker?.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role=option]')].find(
    (item) => item.textContent === 'Git.sessionSource',
  );
  await act(async () => option?.focus());
  await act(async () =>
    option?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  for (let i = 0; i < 3; i++) await act(async () => {});
  expect(gitStatus).toHaveBeenCalledTimes(1);
  expect(text()).not.toContain('Git.unborn');
  expect(text().split('no copy yet')).toHaveLength(2);
  expect(createWorktree).not.toHaveBeenCalled();
});
