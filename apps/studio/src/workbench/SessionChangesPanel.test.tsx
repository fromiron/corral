// @vitest-environment jsdom
import type { WorkSession } from '@corral/core';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReviewSearch } from './panels/routes.ts';
import { type ChangesView, SessionChangesPanel } from './SessionChangesPanel.tsx';

Element.prototype.getAnimations ??= () => [];

const fixture = vi.hoisted(() => ({
  reviewSearches: [] as ReviewSearch[],
  services: {} as Record<string, unknown>,
  href: '/sessions/session?panel=changes&review=true&scope=run&runId=run_2&file=a.ts',
}));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    search,
  }: {
    children?: ReactNode;
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
  }) => (
    <a
      href={`${to.replace('$feature', params?.feature ?? '')}?${new URLSearchParams(search).toString()}`}
    >
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (state: { location: { href: string } }) => string }) =>
    select({ location: { href: fixture.href } }),
}));
vi.mock('../pages/FilesViews.tsx', () => ({
  WorkingCopyPanel: () => <span>copy preparation</span>,
  useBinding: () => ({ binding: null }),
}));
vi.mock('./GitPanel.tsx', () => ({ GitPanel: () => <input aria-label="commit message" /> }));
vi.mock('./CheckpointPanel.tsx', () => ({
  CheckpointPanel: () => <input aria-label="checkpoint name" />,
}));
vi.mock('../pages/ReviewPage.tsx', () => ({
  ReviewContent: ({
    search,
    onPrepareCopy,
  }: {
    search: ReviewSearch;
    onPrepareCopy?: () => void;
  }) => {
    fixture.reviewSearches.push(search);
    return (
      <div>
        <textarea aria-label="review draft" />
        <button type="button" onClick={onPrepareCopy}>
          prepare copy
        </button>
      </div>
    );
  },
  Checks: () => <p>check records</p>,
}));

const cleanups: (() => Promise<void>)[] = [];
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
  fixture.reviewSearches = [];
  fixture.services = {
    mode: 'server',
    workspaces: {
      worktree: vi.fn(async () => ({ missing: false })),
      gitStatus: vi.fn(async () => ({
        target: { kind: 'session' },
        head: { branch: 'corral/session-notes' },
      })),
      binding: vi.fn(async () => null),
    },
  };
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(
  initial: { review?: ReviewSearch; requested?: ChangesView } = {},
  routed = false,
) {
  const views: ChangesView[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  function Fixture() {
    const [search, setSearch] = useState<ReviewSearch | undefined>(initial.review);
    const [requested, setRequested] = useState<ChangesView | undefined>(initial.requested);
    return (
      <SessionChangesPanel
        session={{ sessionId: 'session', projectId: 'project' } as WorkSession}
        reviewSearch={search}
        requestedView={requested}
        onReviewChange={(next) => {
          setSearch(next);
          if (next) setRequested(undefined);
        }}
        onAttach={() => {}}
        {...(routed
          ? {
              onViewChange: (view: Exclude<ChangesView, 'review'>) => {
                views.push(view);
                setSearch(undefined);
                setRequested(view === 'checks' ? 'checks' : undefined);
              },
            }
          : {})}
      />
    );
  }
  await act(async () => root.render(<Fixture />));
  for (let i = 0; i < 3; i++) await act(async () => {});
  const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  const tab = (name: string) => tabs().find((item) => tabName(item) === name);
  const choose = async (name: string) => {
    const item = tab(name);
    if (!item) throw new Error(`Missing tab ${name}`);
    await act(async () => item.click());
  };
  const selected = () => {
    const item = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    return item ? tabName(item) : null;
  };
  return { container, tabs, tab, choose, selected, views };
}

/** The kit draws each label twice: a hidden bold sizer and the visible text. */
const tabName = (item: HTMLElement) =>
  [...item.querySelectorAll('span')].find(
    (span) => span.children.length === 0 && !span.closest('[aria-hidden="true"]'),
  )?.textContent ?? null;

it('keeps commit, review and checkpoint drafts while moving between the sub-views', async () => {
  const view = await mount();
  expect(view.tabs().map(tabName)).toEqual([
    'Review.tabReview',
    'Git.title',
    'Checkpoints.tab',
    'Checks.title',
  ]);
  expect(view.selected()).toBe('Git.title');
  const commit = view.container.querySelector<HTMLInputElement>(
    'input[aria-label="commit message"]',
  );
  if (!commit) throw new Error('Missing commit input');
  commit.value = 'retain my commit message';

  await view.choose('Review.tabReview');
  const draft = view.container.querySelector<HTMLTextAreaElement>('textarea');
  if (!draft) throw new Error('Missing review draft');
  draft.value = 'retain my review';
  await view.choose('Checkpoints.tab');
  const name = view.container.querySelector<HTMLInputElement>(
    'input[aria-label="checkpoint name"]',
  );
  if (!name) throw new Error('Missing checkpoint name');
  name.value = 'retain my checkpoint name';
  await view.choose('Checks.title');
  expect(view.container.textContent).toContain('check records');
  await view.choose('Git.title');
  await view.choose('Review.tabReview');

  expect(view.container.querySelector('textarea')).toBe(draft);
  expect(draft.value).toBe('retain my review');
  expect(view.container.querySelector('input[aria-label="commit message"]')).toBe(commit);
  expect(commit.value).toBe('retain my commit message');
  expect(view.container.querySelector('input[aria-label="checkpoint name"]')).toBe(name);
  expect(name.value).toBe('retain my checkpoint name');

  const prepare = [...view.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'prepare copy',
  );
  await act(async () => prepare?.click());
  expect(view.selected()).toBe('Git.title');
});

it('opens an existing review address on the Review sub-view with its selection', async () => {
  const review: ReviewSearch = { scope: 'run', runId: 'run_2', file: 'a.ts' };
  const view = await mount({ review }, true);
  expect(view.selected()).toBe('Review.tabReview');
  expect(fixture.reviewSearches.at(-1)).toEqual(review);
  await view.choose('Git.title');
  expect(view.views).toEqual(['git']);
  await view.choose('Review.tabReview');
  expect(view.selected()).toBe('Review.tabReview');
  expect(fixture.reviewSearches.at(-1)).toEqual(review);
});

it('opens Checks when the address asks for it and reports each sub-view it moves to', async () => {
  const view = await mount({ requested: 'checks' }, true);
  expect(view.selected()).toBe('Checks.title');
  expect(view.container.textContent).toContain('check records');
  await view.choose('Checkpoints.tab');
  expect(view.selected()).toBe('Checkpoints.tab');
  await view.choose('Git.title');
  await view.choose('Checks.title');
  expect(view.views).toEqual(['checkpoints', 'git', 'checks']);
  expect(view.selected()).toBe('Checks.title');
});

it('heads the view with the copy branch and a PR review preview link back here', async () => {
  const view = await mount({ review: {} });
  expect(view.container.textContent).toContain('corral/session-notes');
  const link = [...view.container.querySelectorAll('a')].find(
    (item) => item.textContent === 'Review.prPreview',
  );
  expect(link).toBeDefined();
  const url = new URL(link?.getAttribute('href') ?? '', 'http://corral.local');
  expect(url.pathname).toBe('/preview/pr-review');
  expect(url.searchParams.get('returnTo')).toBe(fixture.href);
});
