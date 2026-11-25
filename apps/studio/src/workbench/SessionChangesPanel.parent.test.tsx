// @vitest-environment jsdom
import type { ParentMerge } from '@corral/client';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionChangesPanel } from './SessionChangesPanel.tsx';

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

it('reads the merge again when the tab comes on screen, not while it is hidden', async () => {
  const hidden = await render(sub, { ...ready, commits: 1 }, false);
  expect(hidden.parentMerge).not.toHaveBeenCalled();
  await hidden.show();
  expect(hidden.parentMerge).toHaveBeenCalledTimes(1);
});
