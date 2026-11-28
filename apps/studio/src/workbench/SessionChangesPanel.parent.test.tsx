// @vitest-environment jsdom
import type { ParentMerge } from '@corral/client';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionChangesPanel } from './SessionChangesPanel.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

// docs/specs/features/sub-sessions.md 부모에 합치기: the Changes header of a sub-session leads
// to its parent's Git view with the branch picked; it reads nothing for a main session.

Element.prototype.getAnimations ??= () => [];
const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ reviewRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    search,
    children,
    ...rest
  }: {
    params?: Record<string, string>;
    search?: Record<string, string>;
    children?: React.ReactNode;
  }) => (
    <a {...rest} data-params={JSON.stringify(params)} data-search={JSON.stringify(search)}>
      {children}
    </a>
  ),
  useNavigate: () => () => {},
  useRouterState: ({ select }: { select: (state: { location: { href: string } }) => string }) =>
    select({ location: { href: '/sessions/sub' } }),
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

async function render(session: Partial<WorkSession>, merge: ParentMerge | null, visible = true) {
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
  const parentMerge = vi.fn(async () => merge);
  fixture.services = {
    mode: 'server',
    workspaces: {
      worktree: vi.fn(async () => ({ copyGeneration: 1, missing: false })),
      gitStatus: vi.fn(async () => ({
        target: { kind: 'session', copyGeneration: 1 },
        head: { branch: merge?.branch ?? 'corral/main-abc123' },
      })),
      parentMerge,
    },
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
        session={{ projectId: 'project', ...session } as WorkSession}
        visible={visible}
        onReviewChange={() => {}}
      />,
    ),
  );
  for (let i = 0; i < 3; i++) await act(async () => {});
  const show = async () => {
    await act(async () =>
      root.render(
        <SessionChangesPanel
          session={{ projectId: 'project', ...session } as WorkSession}
          visible
          onReviewChange={() => {}}
        />,
      ),
    );
    for (let i = 0; i < 3; i++) await act(async () => {});
  };
  const merger = [...container.querySelectorAll<HTMLElement>('a, button')].find(
    (item) => item.textContent === 'Git.mergeIntoParent',
  );
  return { container, parentMerge, merger, show };
}

const sub = { sessionId: 'sub', parentSessionId: 'parent' };
const ready = { parentSessionId: 'parent', branch: 'corral/x-abc123', parentPaddock: true };

it('opens the parent’s Git view with the sub-session branch picked', async () => {
  const { merger } = await render(sub, { ...ready, commits: 2 });
  expect(merger?.tagName).toBe('A');
  expect(JSON.parse(merger?.dataset.params ?? '{}')).toEqual({ sessionId: 'parent' });
  expect(JSON.parse(merger?.dataset.search ?? '{}')).toEqual({
    panel: 'git',
    merge: 'corral/x-abc123',
  });
});

it('is absent while there is nothing to merge or the parent has no Paddock', async () => {
  const none = await render(sub, { ...ready, commits: 0 });
  expect(none.merger).toBeUndefined();
  const noPaddock = await render(sub, { ...ready, commits: null, parentPaddock: false });
  expect(noPaddock.merger).toBeUndefined();
});

it('has no merge for a copy without a branch, and reads nothing for a main session', async () => {
  const detached = await render(sub, { ...ready, branch: null, commits: null });
  expect(detached.merger).toBeUndefined();
  const main = await render({ sessionId: 'main', parentSessionId: null }, null);
  expect(main.parentMerge).not.toHaveBeenCalled();
  expect(main.merger).toBeUndefined();
});

const readAgain = async () => {
  await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
  for (let i = 0; i < 3; i++) await act(async () => {});
};
const reads = () =>
  fixture.services.workspaces as Record<'gitStatus' | 'parentMerge', ReturnType<typeof vi.fn>>;
const retries = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].filter((item) => item.textContent === 'Files.retry');
const merging = (container: HTMLElement) =>
  [...container.querySelectorAll('a, button')].some(
    (item) => item.textContent === 'Git.mergeIntoParent',
  );

it('says a failed Git state read with Try again instead of dropping the branch read before', async () => {
  const view = await render(sub, { ...ready, commits: 2 });
  expect(view.container.textContent).toContain('corral/x-abc123');
  reads().gitStatus.mockRejectedValue(new Error('git offline'));
  await readAgain();
  const alerts = view.container.querySelectorAll('[role="alert"]');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toContain('Files.gitReadFailed');
  expect(retries(view.container)).toHaveLength(1);
  expect(view.container.textContent).toContain('corral/x-abc123');
  expect(merging(view.container)).toBe(true);
});

it('says a failed merge read with Try again instead of dropping the merge read before', async () => {
  const view = await render(sub, { ...ready, commits: 2 });
  reads().parentMerge.mockRejectedValue(new Error('parent offline'));
  await readAgain();
  const alerts = view.container.querySelectorAll('[role="alert"]');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toContain('Files.mergeReadFailed');
  expect(merging(view.container)).toBe(true);
});

it('says both failed reads in one place with one Try again that reads both again', async () => {
  const view = await render(sub, { ...ready, commits: 2 });
  const { gitStatus, parentMerge } = reads();
  const answered = {
    git: gitStatus.getMockImplementation(),
    merge: parentMerge.getMockImplementation(),
  };
  gitStatus.mockRejectedValue(new Error('git offline'));
  parentMerge.mockRejectedValue(new Error('parent offline'));
  await readAgain();
  const alerts = view.container.querySelectorAll('[role="alert"]');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toContain('Files.gitReadFailed');
  expect(alerts[0]?.textContent).toContain('Files.mergeReadFailed');
  const again = retries(view.container);
  expect(again).toHaveLength(1);
  if (answered.git) gitStatus.mockImplementation(answered.git);
  if (answered.merge) parentMerge.mockImplementation(answered.merge);
  const before = { git: gitStatus.mock.calls.length, merge: parentMerge.mock.calls.length };
  await act(async () => again[0]?.click());
  for (let i = 0; i < 3; i++) await act(async () => {});
  expect(gitStatus.mock.calls.length).toBe(before.git + 1);
  expect(parentMerge.mock.calls.length).toBe(before.merge + 1);
  expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(retries(view.container)).toHaveLength(0);
  expect(view.container.textContent).toContain('corral/x-abc123');
});

it('reads the merge again when the tab comes on screen, not while it is hidden', async () => {
  const hidden = await render(sub, { ...ready, commits: 1 }, false);
  expect(hidden.parentMerge).not.toHaveBeenCalled();
  await hidden.show();
  expect(hidden.parentMerge).toHaveBeenCalledTimes(1);
});
