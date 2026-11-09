// @vitest-environment jsdom
import type { ReviewCommentView } from '@corral/client';
import type { RunSummary, WorkSession } from '@corral/core';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReviewSearch } from '../workbench/panels/routes.ts';
import { parseCommentBody } from '../workbench/reviewComments.ts';
import { CommentsPanel, ReviewContent } from './ReviewPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ reviewRoute: {} }));
vi.mock('./FilesViews.tsx', () => ({ useBinding: () => ({ binding: null }) }));
vi.mock('./LspProposals.tsx', () => ({ LspProposals: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => () => {},
}));
vi.mock('../workbench/useModels.ts', () => ({ useModelProfiles: () => null }));
// The diff renderer needs real workers; the comment form inside it is the real one, open on
// README.md as if its first line had been chosen.
vi.mock('../workbench/PierreCode.tsx', async () => {
  const { ReviewCommentForm } = await import('../workbench/ReviewCommentForm.tsx');
  return {
    DiffCode: ({
      diff,
      after,
      onComment,
    }: {
      diff: { name: string };
      after: string;
      onComment?: (comment: Record<string, unknown>) => Promise<void>;
    }) =>
      onComment && diff.name === 'README.md' ? (
        <ReviewCommentForm
          anchor={{ side: 'after', startLine: 1, endLine: 1, quote: after.split('\n')[0] ?? '' }}
          onSubmit={onComment}
          onCancel={() => {}}
        />
      ) : null,
  };
});
vi.mock('@corral/react/design-kit', async (original) => ({
  ...(await original<typeof import('@corral/react/design-kit')>()),
  Select: ({
    value,
    label,
    options,
    onValueChange,
  }: {
    value: string;
    label: string;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('use-intl', async (original) => {
  const actual = await original<typeof import('use-intl')>();
  return {
    ...actual,
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
    useFormatter: () => actual.createFormatter({ locale: 'en', timeZone: 'UTC' }),
  };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const from = 'f'.repeat(40),
  to = 'e'.repeat(40),
  date = '2026-11-10T00:00:00Z';
const session: WorkSession = {
  sessionId: 'session_changes',
  projectId: 'project',
  corralId: null,
  auto: null,
  title: 'Changes',
  objective: '',
  pinned: false,
  revision: 1,
  createdAt: date,
  updatedAt: date,
  archivedAt: null,
  entries: [],
};
const file = (path: string) => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
  provenance: 'managed_agent',
});
const run = (runId: string, startedAt: string): RunSummary => ({
  runId,
  status: 'succeeded',
  corralId: 'team',
  projectId: 'project',
  sessionId: session.sessionId,
  startedAt,
});

/** The diff worker answers at once with a diff that has no hunks. */
class ImmediateWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(message: { path: string }) {
    queueMicrotask(() =>
      this.onmessage?.({ data: { diff: { name: message.path, hunks: [] } } } as MessageEvent),
    );
  }
  terminate() {}
}

function setValue(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount({
  search: initial = {},
  files = ['README.md'],
  reviewed = false,
  runs = [] as RunSummary[],
} = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Worker', ImmediateWorker);
  const writes = {
    integrate: vi.fn(),
    integrationPlan: vi.fn(),
    decide: vi.fn(),
    revert: vi.fn(),
    restoreCheckpoint: vi.fn(),
    planHunks: vi.fn(),
    planCheckpointRestore: vi.fn(),
    recordFeedback: vi.fn(),
    feedbackText: vi.fn(),
  };
  let comments: ReviewCommentView[] = [];
  const addComment = vi.fn(async (_id: string, comment: Omit<ReviewCommentView, 'commentId'>) => {
    const added = {
      ...comment,
      commentId: `comment_${comments.length + 1}`,
      state: 'draft' as const,
      batchId: null,
      createdAt: date,
    };
    comments = [...comments, added];
    return added;
  });
  const startAuto = vi.fn();
  fixture.services = {
    mode: 'server',
    live: false,
    workspaceId: 'host',
    startAuto,
    transport: { listRuns: async () => runs },
    repository: { getSession: async () => session },
    workspaces: {
      ...writes,
      addComment,
      worktree: async () => ({ missing: false, reviewed }),
      comments: async () => comments,
      changes: vi.fn(async () => ({ from, to, unavailable: null, files: files.map(file) })),
      fileVersions: vi.fn(async (_s: string, _f: string, _t: string, path: string) => ({
        path,
        before: { kind: 'text', text: 'old line\n' },
        after: { kind: 'text', text: 'new line\n' },
      })),
      verifications: async () => [],
      fileOperations: async () => [],
      decisions: async () => [],
      integrations: async () => [],
    },
  };
  const searches: Partial<ReviewSearch>[] = [];
  function Embedded() {
    const [search, setSearch] = useState<ReviewSearch>(initial);
    return (
      <ReviewContent
        session={session}
        search={search}
        onSearch={(patch) => {
          searches.push(patch);
          setSearch((previous) => ({ ...previous, ...patch }));
        }}
        embedded
      />
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<Embedded />));
  await act(async () => {});
  const fileButton = (path: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('nav button')].find((button) =>
      button.textContent?.includes(path),
    );
  const scope = () =>
    container.querySelector<HTMLSelectElement>('select[aria-label="Files.scope"]');
  return { container, writes, addComment, startAuto, searches, fileButton, scope };
}

it('a replacement suggestion is only a comment: it never writes a file or applies anything', async () => {
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const kind = [...view.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Review.kindReplace',
  );
  expect(kind).toBeDefined();
  await act(async () => kind?.click());
  expect(kind?.getAttribute('aria-pressed')).toBe('true');
  const replacement = view.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Review.replaceWith"]',
  );
  expect(replacement?.value).toBe('new line');
  await act(async () => {
    if (replacement) setValue(replacement, 'newer line');
  });
  const add = [...view.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Review.addComment',
  );
  await act(async () => add?.click());

  expect(view.addComment).toHaveBeenCalledTimes(1);
  const comment = view.addComment.mock.calls[0]?.[1];
  expect(comment).toMatchObject({ path: 'README.md', from, to, quote: 'new line', side: 'after' });
  expect(parseCommentBody(comment?.body ?? '')).toEqual({
    kind: 'replace',
    original: 'new line',
    replacement: 'newer line',
    note: '',
  });
  for (const write of Object.values(view.writes)) expect(write).not.toHaveBeenCalled();
  expect(view.startAuto).not.toHaveBeenCalled();
  // The new draft reads back as a suggestion, not as raw markers.
  expect(view.container.textContent).toContain('Review.kinds.replace');
  expect(view.container.textContent).not.toContain('Suggested replacement:');
});

it('an existing review address keeps its run and file, and names the run by number', async () => {
  const view = await mount({
    search: { scope: 'run', runId: 'run_b', file: 'b.ts' },
    files: ['a.ts', 'b.ts'],
    runs: [run('run_b', '2026-11-10T02:00:00Z'), run('run_a', '2026-11-10T01:00:00Z')],
  });
  expect(view.scope()?.value).toBe('run:run_b');
  const labels = [...(view.scope()?.options ?? [])].map((option) => option.textContent);
  expect(labels).toEqual([
    'Files.scopes.session',
    'Workbench.runNumber:{"number":2}',
    'Workbench.runNumber:{"number":1}',
  ]);
  expect(labels.join()).not.toContain('run_b');
  expect(view.fileButton('b.ts')?.getAttribute('aria-current')).toBe('true');
  expect(view.fileButton('a.ts')?.getAttribute('aria-current')).toBeNull();
});

it('offers "since last read" only once the copy has been marked read', async () => {
  const unread = await mount({ search: { scope: 'session' } });
  expect([...(unread.scope()?.options ?? [])].map((option) => option.value)).toEqual(['session']);
  for (const cleanup of cleanups.splice(0)) await cleanup();
  const read = await mount({ search: { scope: 'session' }, reviewed: true });
  expect([...(read.scope()?.options ?? [])].map((option) => option.value)).toEqual([
    'session',
    'review',
  ]);
});

it('moves between files with the visible buttons and the brace keys, stopping at the ends', async () => {
  const view = await mount({ search: { scope: 'session' }, files: ['a.ts', 'b.ts', 'c.ts'] });
  const press = async (key: string, target: Element) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true }));
    });
  const first = view.fileButton('a.ts');
  if (!first) throw new Error('Missing file row');
  await press('}', first);
  expect(view.searches.at(-1)).toEqual({ file: 'a.ts' });
  expect(document.activeElement).toBe(view.fileButton('a.ts'));
  await press('}', document.activeElement as Element);
  expect(view.searches.at(-1)).toEqual({ file: 'b.ts' });
  expect(document.activeElement).toBe(view.fileButton('b.ts'));
  const next = [...view.container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === 'Review.nextFile',
  );
  expect(next?.getAttribute('aria-keyshortcuts')).toBe('Shift+]');
  await act(async () => next?.click());
  expect(view.searches.at(-1)).toEqual({ file: 'c.ts' });
  expect(next?.disabled).toBe(true);
  const count = view.searches.length;
  await press('}', document.activeElement as Element);
  expect(view.searches).toHaveLength(count);
  // A text field keeps its keys.
  const filter = view.container.querySelector('input[type="search"]');
  if (!filter) throw new Error('Missing file filter');
  await press('{', filter);
  expect(view.searches).toHaveLength(count);
  await press('{', document.activeElement as Element);
  expect(view.searches.at(-1)).toEqual({ file: 'b.ts' });
});

it('marks a sent comment whose quoted range changed in the current comparison', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const earlier = (commentId: string, quote: string): ReviewCommentView => ({
    commentId,
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
    path: 'README.md',
    side: 'after',
    startLine: 1,
    endLine: 1,
    quote,
    body: commentId,
    state: 'submitted',
    batchId: 'batch',
    createdAt: date,
  });
  const fileVersions = vi.fn(async () => ({
    path: 'README.md',
    before: { kind: 'text', text: '' },
    after: { kind: 'text', text: '# Title\nbody' },
  }));
  fixture.services = { mode: 'server', workspaces: { fileVersions } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <CommentsPanel
        session={session}
        runs={[]}
        comments={[earlier('comment_moved', '# Setup'), earlier('comment_same', '# Title')]}
        current={{ from, to, unavailable: null, files: [] }}
        onChange={async () => {}}
      />,
    ),
  );
  await act(async () => {});
  expect(fileVersions).toHaveBeenCalledWith(session.sessionId, from, to, 'README.md');
  const item = (id: string) =>
    [...container.querySelectorAll('li')].find((li) => li.textContent?.includes(id));
  expect(item('comment_moved')?.textContent).toContain('Review.rangeChanged');
  expect(item('comment_same')?.textContent).not.toContain('Review.rangeChanged');
  // The pinned quote and the existing state stay.
  expect(item('comment_moved')?.querySelector('blockquote')?.textContent).toBe('# Setup');
  expect(item('comment_moved')?.textContent).toContain('Review.commentState.submitted');
});
