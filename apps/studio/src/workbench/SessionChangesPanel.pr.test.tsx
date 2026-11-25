// @vitest-environment jsdom
import type { PullRequestView } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionChangesPanel } from './SessionChangesPanel.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

// docs/specs/features/pull-requests.md: the PR row under the Changes head, when it reads GitHub,
// and the dialog that pushes and opens.

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
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};

async function render(view: PullRequestView, extra: Record<string, unknown> = {}) {
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
  const pullRequest = vi.fn(async (_sessionId: string, _remote: boolean) => view);
  fixture.services = {
    mode: 'server',
    workspaces: {
      worktree: vi.fn(async () => ({ copyGeneration: 1, missing: false })),
      gitStatus: vi.fn(async () => ({
        target: { kind: 'session', hostId: 'h', sessionId: 's1', copyGeneration: 1 },
        head: { branch: 'corral/fix-abc123', oid: 'a'.repeat(40) },
        indexHash: 'b'.repeat(64),
      })),
      parentMerge: vi.fn(async () => null),
      pullRequest,
      ...extra,
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const onViewChange = vi.fn();
  await act(async () =>
    root.render(
      <SessionChangesPanel
        session={{ sessionId: 's1', projectId: 'project' } as WorkSession}
        onReviewChange={() => {}}
        onViewChange={onViewChange}
      />,
    ),
  );
  await settle();
  const row = () => container.querySelector<HTMLElement>('[data-pull-request-row]');
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === label,
    );
  const show = async (visible: boolean) => {
    await act(async () =>
      root.render(
        <SessionChangesPanel
          session={{ sessionId: 's1', projectId: 'project' } as WorkSession}
          visible={visible}
          onReviewChange={() => {}}
          onViewChange={onViewChange}
        />,
      ),
    );
    await settle();
  };
  return { container, pullRequest, onViewChange, row, button, show };
}

const open: PullRequestView = {
  kind: 'open',
  branch: 'corral/fix-abc123',
  base: 'main',
  push: false,
  pr: {
    number: 12,
    url: 'https://github.com/acme/widgets/pull/12',
    title: 'Fix',
    state: 'open',
    isDraft: false,
    checks: { passed: 3, failed: 1, pending: 0 },
    review: 'changes_requested',
    conflicting: false,
  },
};

it('shows an open PR with its checks, review and a link that opens GitHub in a new window', async () => {
  const f = await render(open);
  expect(f.row()?.textContent).toContain('PullRequests.number(12)');
  expect(f.row()?.textContent).toContain('PullRequests.state.open');
  expect(f.row()?.textContent).toContain('PullRequests.checksFailed(1)');
  expect(f.row()?.textContent).toContain('PullRequests.review.changes_requested');
  const link = f.row()?.querySelector('a[target="_blank"]');
  expect(link?.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/12');
  expect(link?.getAttribute('rel')).toContain('noopener');
});

it('has no row when there is nothing to show, and names a missing gh once', async () => {
  expect((await render({ kind: 'hidden', reason: 'nothing_to_open' })).row()).toBeNull();
  expect((await render({ kind: 'gh_missing' })).row()?.textContent).toBe('PullRequests.ghMissing');
});

it('reads GitHub when the tab shows and only the copy after a Git change', async () => {
  const f = await render(open);
  expect(f.pullRequest.mock.calls.map((call) => call[1])).toEqual([true]);
  await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
  await settle();
  expect(f.pullRequest.mock.calls.map((call) => call[1])).toEqual([true, false]);
});

it('sends the person to the Git view when the remote branch differs', async () => {
  const f = await render({
    kind: 'none',
    branch: 'corral/fix-abc123',
    base: 'main',
    action: 'sync',
    previous: null,
  });
  await act(async () => f.button('PullRequests.sync')?.click());
  expect(f.onViewChange).toHaveBeenCalledWith('git');
});

it('drafts, pushes with the Git command and opens the PR at the drafted head', async () => {
  const head = { branch: 'corral/fix-abc123', commit: 'a'.repeat(40) };
  const signals: AbortSignal[] = [];
  const pullRequestDraft = vi.fn(async (_s: string, _r: unknown, signal: AbortSignal) => {
    signals.push(signal);
    return {
      title: 'Fix the login check',
      body: '## Summary',
      head,
      base: 'main',
      source: 'model',
    };
  });
  const gitChange = vi.fn(async (_s: string, command: { operationId: string }) => ({
    operationId: command.operationId,
    state: 'succeeded',
    result: { kind: 'applied' },
  }));
  const openPullRequest = vi.fn(async () => ({ pr: open.kind === 'open' ? open.pr : null }));
  const f = await render(
    { kind: 'none', branch: head.branch, base: 'main', action: 'push_and_open', previous: null },
    { pullRequestDraft, gitChange, openPullRequest },
  );
  await act(async () => f.button('PullRequests.pushAndOpen')?.click());
  await settle();
  const title = document.querySelector<HTMLInputElement>('input[name="pull-request-title"]');
  expect(title?.value).toBe('Fix the login check');
  await act(async () => f.button('PullRequests.dialog.pushAndOpen')?.click());
  await settle();
  expect(gitChange).toHaveBeenCalledWith(
    's1',
    expect.objectContaining({ kind: 'push', remote: 'origin', branch: head.branch }),
  );
  expect(openPullRequest).toHaveBeenCalledWith(
    's1',
    expect.objectContaining({ title: 'Fix the login check', body: '## Summary', head }),
  );
  expect(f.pullRequest.mock.calls.at(-1)?.[1]).toBe(true);
  expect(signals[0]?.aborted).toBe(false);
});

it('stops the draft when the dialog closes before it arrives', async () => {
  const signals: AbortSignal[] = [];
  const pullRequestDraft = vi.fn(
    (_s: string, _r: unknown, signal: AbortSignal) =>
      new Promise(() => {
        signals.push(signal);
      }),
  );
  const f = await render(
    {
      kind: 'none',
      branch: 'corral/fix-abc123',
      base: 'main',
      action: 'open',
      previous: null,
    },
    { pullRequestDraft },
  );
  await act(async () => f.button('PullRequests.open')?.click());
  await settle();
  await act(async () => f.button('PullRequests.dialog.cancel')?.click());
  expect(signals[0]?.aborted).toBe(true);
});

it('reads GitHub again when the tab comes back on screen', async () => {
  const f = await render(open);
  await f.show(false);
  await f.show(true);
  expect(f.pullRequest.mock.calls.map((call) => call[1])).toEqual([true, true]);
});

it('after a lost push response, reads that push back by its ID instead of pushing again', async () => {
  const head = { branch: 'corral/fix-abc123', commit: 'a'.repeat(40) };
  const pullRequestDraft = vi.fn(async () => ({
    title: 'Fix',
    body: '',
    head,
    base: 'main',
    source: 'commits',
  }));
  const ids: string[] = [];
  const gitChange = vi.fn(async (_s: string, command: { operationId: string }) => {
    ids.push(command.operationId);
    throw new TypeError('Failed to fetch');
  });
  const gitOperation = vi.fn(async (_s: string, operationId: string) => ({
    operationId,
    state: 'succeeded',
    result: { kind: 'applied' },
  }));
  const openPullRequest = vi.fn(async () => ({ pr: open.kind === 'open' ? open.pr : null }));
  const f = await render(
    { kind: 'none', branch: head.branch, base: 'main', action: 'push_and_open', previous: null },
    { pullRequestDraft, gitChange, gitOperation, openPullRequest },
  );
  gitOperation.mockRejectedValueOnce(
    Object.assign(new Error('missing'), { code: 'TARGET_NOT_FOUND' }),
  );
  await act(async () => f.button('PullRequests.pushAndOpen')?.click());
  await settle();
  await act(async () => f.button('PullRequests.dialog.pushAndOpen')?.click());
  await settle();
  expect(openPullRequest).not.toHaveBeenCalled();
  await act(async () => f.button('PullRequests.dialog.pushAndOpen')?.click());
  await settle();
  expect(gitChange).toHaveBeenCalledTimes(1);
  expect(gitOperation.mock.calls.map((call) => call[1])).toEqual([ids[0], ids[0]]);
  expect(openPullRequest).toHaveBeenCalledTimes(1);
});
