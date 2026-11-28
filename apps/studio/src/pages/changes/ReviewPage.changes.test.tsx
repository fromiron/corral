// @vitest-environment jsdom
import type { ReviewCommentView } from '@corral/client';
import type { TextAttachment } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { forgetKeptInputs } from '@corral/react';
import { Button } from '@corral/react/design-kit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { AttachmentCapture } from '../../workbench/context/bridge.ts';
import type { ReviewSearch } from '../../workbench/panels/routes.ts';
import { parseCommentBody } from '../../workbench/reviewComments.ts';
import { CommentsPanel, ReviewContent } from './ReviewPage.tsx';

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  navigations: [] as unknown[],
  folder: { binding: null } as Record<string, unknown>,
}));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../FilesViews.tsx', () => ({ useBinding: () => fixture.folder }));
vi.mock('./LspProposals.tsx', () => ({ LspProposals: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => async (options: unknown) => {
    fixture.navigations.push(options);
  },
}));
vi.mock('../../workbench/useModels.ts', () => ({ useModelProfiles: () => null }));
// The diff renderer needs real workers. This one reports line picks the way the renderer does
// (a finished range on the "after" side) and shows which range it is asked to highlight; the
// comment form the pick opens is the real one.
type Picked = { start: number; end: number; side: 'additions' | 'deletions' };
vi.mock('../../workbench/PierreCode.tsx', () => ({
  DiffCode: ({
    selection,
    onPick,
  }: {
    selection?: Picked | null;
    onPick?: (range: Picked) => void;
  }) => (
    <div
      data-testid="diff"
      data-selection={selection ? `${selection.side}:${selection.start}-${selection.end}` : ''}
    >
      {onPick ? (
        <>
          <button type="button" onClick={() => onPick({ start: 1, end: 1, side: 'additions' })}>
            pick line 1
          </button>
          <button type="button" onClick={() => onPick({ start: 3, end: 2, side: 'additions' })}>
            pick lines 2-3
          </button>
        </>
      ) : null}
    </div>
  ),
}));
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
  forgetKeptInputs();
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
  autoStart: true,
  entries: [],
};
const file = (path: string, provenance = 'managed_agent') => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
  provenance,
});

/** Reports this review width to whatever the view observes. */
function reviewWidth(width: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly report: ResizeObserverCallback;
      constructor(report: ResizeObserverCallback) {
        this.report = report;
      }
      observe(target: Element) {
        this.report(
          [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
}
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

function setValue(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount({
  search: initial = {},
  files = ['README.md'],
  provenance = {} as Record<string, string>,
  reviewed = false,
  runs = [] as RunSummary[],
  groups = undefined as Record<string, { runs?: string[]; outside?: boolean }> | undefined,
  statuses = {} as Record<string, string>,
  runOrder = [] as string[],
  head = to,
  attach = undefined as
    | ((attachment: TextAttachment, capture: AttachmentCapture) => void | Promise<void>)
    | undefined,
} = {}) {
  fixture.navigations = [];
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
  // What the copy holds now; a test changes it as a run would.
  const copy = { files, to: head, groups, runOrder };
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
      changes: vi.fn(async (_session: string, _scope: unknown, group?: 'run') => ({
        from,
        to: copy.to,
        unavailable: null,
        files: copy.files.map((path) => ({
          ...file(path, provenance[path]),
          ...(statuses[path] ? { status: statuses[path] } : {}),
          ...(group && copy.groups
            ? {
                runs: copy.groups[path]?.runs ?? [],
                outsideRuns: copy.groups[path]?.outside ?? false,
              }
            : {}),
        })),
        ...(group && copy.groups ? { runs: copy.runOrder } : {}),
      })),
      fileVersions: vi.fn(async (_s: string, _f: string, _t: string, path: string) => ({
        path,
        before: { kind: 'text', text: 'old line\n' },
        after: { kind: 'text', text: 'new line\nsecond line\nthird line\n' },
      })),
      hunks: async () => ({
        from,
        to: copy.to,
        path: copy.files[0],
        patchHash: 'c'.repeat(64),
        hunks: [{ id: 'd'.repeat(64), patch: '@@ -1 +1,3 @@\n-old line\n+new line' }],
      }),
      verifications: async () => [],
      fileOperations: async () => [],
      decisions: async () => [],
      integrations: async () => [],
    },
  };
  const searches: Partial<ReviewSearch>[] = [];
  type Host = { shown: boolean; copyChanged?: string };
  let setHost: (host: Host) => void = () => {};
  function Embedded() {
    const [search, setSearch] = useState<ReviewSearch>(initial);
    const [host, setHostState] = useState<Host>({ shown: true });
    setHost = setHostState;
    return (
      <ReviewContent
        session={session}
        search={search}
        onSearch={(patch) => {
          searches.push(patch);
          setSearch((previous) => ({ ...previous, ...patch }));
        }}
        shown={host.shown}
        copyChanged={host.copyChanged}
        {...(attach ? { onAttach: attach } : {})}
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
  const button = (text: string, within: ParentNode = container) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === text,
    );
  const click = async (text: string, within?: ParentNode) => {
    const target = button(text, within);
    if (!target) throw new Error(`Missing button ${text}`);
    await act(async () => target.click());
  };
  const host = async (next: Host) => {
    await act(async () => setHost(next));
    await act(async () => {});
  };
  return {
    container,
    writes,
    addComment,
    startAuto,
    searches,
    fileButton,
    scope,
    button,
    click,
    copy,
    host,
    changes: fixture.services.workspaces as { changes: ReturnType<typeof vi.fn> },
  };
}

it('attaching parts of the change from the embedded review hands them to the host and goes nowhere (features/session-panel.md)', async () => {
  // Selection attach ends in the conversation, and a panel beside it stays as it is: the
  // session screen that hosts the review brings the conversation forward, not the review.
  const attach = vi.fn();
  const view = await mount({ search: { scope: 'session', file: 'README.md' }, attach });
  await view.click('Hunks.heading');
  const part = view.container.querySelector<HTMLElement>('[role=checkbox]');
  if (!part) throw new Error('Missing the part to pick');
  await act(async () => part.click());
  await view.click('Hunks.attachSelected');
  expect(attach).toHaveBeenCalledTimes(1);
  expect(attach.mock.calls[0]?.[0]).toMatchObject({
    provenance: { kind: 'hunk', path: 'README.md' },
  });
  expect(fixture.navigations).toEqual([]);
});

it('picking lines in the changes opens the comment form on that range and saves a draft for it', async () => {
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const area = view.container.querySelector('aside');
  if (!area) throw new Error('Missing the decision area');
  const field = (label: string) =>
    area.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  // Nothing is highlighted and no form is open until lines are picked.
  expect(area.querySelector('form')).toBeNull();
  expect(view.container.querySelector('[data-testid="diff"]')?.getAttribute('data-selection')).toBe(
    '',
  );

  await view.click('pick lines 2-3');
  // The form is in the decision area, with the picked side and lines filled in.
  expect(area.querySelector('form')).not.toBeNull();
  expect(
    area.querySelector<HTMLSelectElement>('select[aria-label="Desktop.commentSide"]')?.value,
  ).toBe('after');
  expect([field('Desktop.fromLine')?.value, field('Desktop.toLine')?.value]).toEqual(['3', '2']);
  expect(view.container.querySelector('[data-testid="diff"]')?.getAttribute('data-selection')).toBe(
    'additions:3-2',
  );
  const note = area.querySelector<HTMLTextAreaElement>('form textarea');
  if (!note) throw new Error('Missing the comment field');
  await act(async () => setValue(note, 'Join these two lines.'));
  await view.click('Review.addComment', area);
  expect(view.addComment).toHaveBeenCalledTimes(1);
  expect(view.addComment.mock.calls[0]?.[1]).toMatchObject({
    path: 'README.md',
    from,
    to,
    side: 'after',
    startLine: 2,
    endLine: 3,
    quote: 'second line\nthird line',
    body: 'Join these two lines.',
  });
  // Saved as a draft in the same area; the form closes and the highlight goes with it.
  expect(area.querySelector('form')).toBeNull();
  expect(area.textContent).toContain('README.md:2–3');
  expect(view.container.querySelector('[data-testid="diff"]')?.getAttribute('data-selection')).toBe(
    '',
  );

  // Typing the lines is the other way in: the same form, opened without a pick.
  await view.click('Review.addComment', area);
  const first = field('Desktop.fromLine');
  const last = field('Desktop.toLine');
  if (!first || !last) throw new Error('Missing the line fields');
  await act(async () => setValue(first, '1'));
  await act(async () => setValue(last, '1'));
  const again = area.querySelector<HTMLTextAreaElement>('form textarea');
  if (!again) throw new Error('Missing the comment field');
  await act(async () => setValue(again, 'Start with a title.'));
  await view.click('Review.addComment', area);
  expect(view.addComment.mock.calls[1]?.[1]).toMatchObject({
    startLine: 1,
    endLine: 1,
    quote: 'new line',
    body: 'Start with a title.',
  });
  for (const write of Object.values(view.writes)) expect(write).not.toHaveBeenCalled();
});

it('a form opened at another range and moved onto lines with a kept comment shows that comment, and it stays kept (features/session-panel.md)', async () => {
  const first = await mount({ search: { scope: 'session', file: 'README.md' } });
  const areaOf = (view: typeof first) => {
    const area = view.container.querySelector('aside');
    if (!area) throw new Error('Missing the decision area');
    return area;
  };
  const noteOf = (view: typeof first) =>
    areaOf(view).querySelector<HTMLTextAreaElement>('form textarea');
  await first.click('pick lines 2-3');
  const note = noteOf(first);
  if (!note) throw new Error('Missing the comment field');
  await act(async () => setValue(note, 'Join these two lines.'));
  for (const cleanup of cleanups.splice(0)) await cleanup();

  // The form opens at its own range (line 1), then the person selects lines 2-3.
  const again = await mount({ search: { scope: 'session', file: 'README.md' } });
  await again.click('Review.addComment', areaOf(again));
  expect(noteOf(again)?.value).toBe('');
  await again.click('pick lines 2-3');
  expect(noteOf(again)?.value).toBe('Join these two lines.');
  for (const cleanup of cleanups.splice(0)) await cleanup();

  const later = await mount({ search: { scope: 'session', file: 'README.md' } });
  await later.click('pick lines 2-3');
  expect(noteOf(later)?.value).toBe('Join these two lines.');
});

it('a form holding text moved onto lines with a kept comment keeps its own text, and that is what is kept there (features/session-panel.md)', async () => {
  const first = await mount({ search: { scope: 'session', file: 'README.md' } });
  const noteOf = (view: typeof first) =>
    view.container.querySelector<HTMLTextAreaElement>('aside form textarea');
  await first.click('pick lines 2-3');
  const kept = noteOf(first);
  if (!kept) throw new Error('Missing the comment field');
  await act(async () => setValue(kept, 'Join these two lines.'));
  for (const cleanup of cleanups.splice(0)) await cleanup();

  const again = await mount({ search: { scope: 'session', file: 'README.md' } });
  await again.click('pick line 1');
  const writing = noteOf(again);
  if (!writing) throw new Error('Missing the comment field');
  await act(async () => setValue(writing, 'Start with a title.'));
  await again.click('pick lines 2-3');
  expect(noteOf(again)?.value).toBe('Start with a title.');
  for (const cleanup of cleanups.splice(0)) await cleanup();

  const later = await mount({ search: { scope: 'session', file: 'README.md' } });
  await later.click('pick lines 2-3');
  expect(noteOf(later)?.value).toBe('Start with a title.');
});

it('keeps a comment not added yet after the review goes, for the same file and lines, until it is added (features/session-panel.md)', async () => {
  const first = await mount({ search: { scope: 'session', file: 'README.md' } });
  const areaOf = (view: typeof first) => {
    const area = view.container.querySelector('aside');
    if (!area) throw new Error('Missing the decision area');
    return area;
  };
  const noteOf = (view: typeof first) =>
    areaOf(view).querySelector<HTMLTextAreaElement>('form textarea');
  await first.click('pick lines 2-3');
  const note = noteOf(first);
  if (!note) throw new Error('Missing the comment field');
  await act(async () => setValue(note, 'Join these two lines.'));
  // The 변경 tab closes: the review goes.
  for (const cleanup of cleanups.splice(0)) await cleanup();

  const again = await mount({ search: { scope: 'session', file: 'README.md' } });
  await again.click('pick lines 2-3');
  expect(noteOf(again)?.value).toBe('Join these two lines.');
  await again.click('Review.addComment', areaOf(again));
  expect(again.addComment).toHaveBeenCalledTimes(1);
  for (const cleanup of cleanups.splice(0)) await cleanup();

  // Added: it goes.
  const after = await mount({ search: { scope: 'session', file: 'README.md' } });
  await after.click('pick lines 2-3');
  expect(noteOf(after)?.value).toBe('');
});

it('a comment added while its lines are changed is kept neither for the lines it was added on nor for the new ones (features/session-panel.md)', async () => {
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const noteOf = (shown: typeof view) =>
    shown.container.querySelector<HTMLTextAreaElement>('aside form textarea');
  const area = view.container.querySelector('aside');
  if (!area) throw new Error('Missing the decision area');
  await view.click('pick lines 2-3');
  const note = noteOf(view);
  if (!note) throw new Error('Missing the comment field');
  await act(async () => setValue(note, 'Join these two lines.'));
  // The add waits for its answer; meanwhile the person picks other lines.
  const real = view.addComment.getMockImplementation();
  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  view.addComment.mockImplementationOnce(async (...args) => {
    await answered;
    return (real as NonNullable<typeof real>)(...args);
  });
  await view.click('Review.addComment', area);
  await view.click('pick line 1');
  await act(async () => answer());
  expect(view.addComment).toHaveBeenCalledTimes(1);
  for (const cleanup of cleanups.splice(0)) await cleanup();

  const later = await mount({ search: { scope: 'session', file: 'README.md' } });
  await later.click('pick line 1');
  expect(noteOf(later)?.value).toBe('');
  await later.click('pick lines 2-3');
  expect(noteOf(later)?.value).toBe('');
});

it('a comment not added yet is kept for the comparison it was written against, not for the same lines of another (features/session-panel.md)', async () => {
  const first = await mount({ search: { scope: 'session', file: 'README.md' } });
  const noteOf = (view: typeof first) =>
    view.container.querySelector<HTMLTextAreaElement>('aside form textarea');
  await first.click('pick lines 2-3');
  const note = noteOf(first);
  if (!note) throw new Error('Missing the comment field');
  await act(async () => setValue(note, 'Join these two lines.'));
  for (const cleanup of cleanups.splice(0)) await cleanup();

  // A run moved the copy: the same file and lines, in another comparison.
  const moved = await mount({
    search: { scope: 'session', file: 'README.md' },
    head: 'd'.repeat(40),
  });
  await moved.click('pick lines 2-3');
  expect(noteOf(moved)?.value).toBe('');
  for (const cleanup of cleanups.splice(0)) await cleanup();

  // Back on the comparison it was written against, it is there.
  const back = await mount({ search: { scope: 'session', file: 'README.md' } });
  await back.click('pick lines 2-3');
  expect(noteOf(back)?.value).toBe('Join these two lines.');
});

it('keeps the decision in the decision area, recorded on the exact comparison', async () => {
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const area = view.container.querySelector('aside');
  if (!area) throw new Error('Missing the decision area');
  expect(area.querySelector('[data-testid="review-comments"]')).not.toBeNull();
  await view.click('Review.approve', area);
  expect(view.writes.decide).toHaveBeenLastCalledWith(session.sessionId, {
    from,
    to,
    decision: 'approved',
    note: '',
  });
  await view.click('Review.requestChanges', area);
  expect(view.writes.decide).toHaveBeenLastCalledWith(session.sessionId, {
    from,
    to,
    decision: 'changes_requested',
    note: '',
  });
  // Deciding is neither applying nor sending.
  expect(view.writes.integrate).not.toHaveBeenCalled();
  expect(view.writes.recordFeedback).not.toHaveBeenCalled();
  expect(view.startAuto).not.toHaveBeenCalled();
});

it('says in the decision area that the folder link could not be read, once approved', async () => {
  fixture.folder = { binding: undefined, failed: 'offline' };
  cleanups.push(async () => {
    fixture.folder = { binding: null };
  });
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const area = view.container.querySelector('aside');
  if (!area) throw new Error('Missing the decision area');
  expect(area.textContent).not.toContain('Files.folderReadFailed');
  view.writes.decide.mockImplementation(async () => {
    Object.assign(fixture.services.workspaces as object, {
      decisions: async () => [
        {
          decisionId: 'decision_1',
          from,
          to,
          decision: 'approved',
          note: '',
          createdAt: date,
          stale: false,
        },
      ],
    });
  });
  await view.click('Review.approve', area);
  await act(async () => {});
  expect(area.textContent).toContain('Files.folderReadFailed');
  expect(area.textContent).not.toContain('Review.integrateHeading');
});

it('heads the comments only once there are comments to head', async () => {
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const area = view.container.querySelector('aside');
  if (!area) throw new Error('Missing the decision area');
  const heads = () =>
    [...area.querySelectorAll('h3')].filter((h) =>
      h.textContent?.startsWith('Review.commentsHeading'),
    );
  // One control, no heading over it: Add comment names itself; the part keeps its name.
  expect(heads()).toHaveLength(0);
  expect(area.querySelector('[data-testid="review-comments"]')?.getAttribute('aria-label')).toBe(
    'Review.commentsHeading',
  );
  await view.click('pick line 1');
  const note = area.querySelector<HTMLTextAreaElement>('form textarea');
  if (!note) throw new Error('Missing the comment field');
  await act(async () => setValue(note, 'Name the run.'));
  await view.click('Review.addComment', area);
  expect(heads()).toHaveLength(1);
});

it('puts no heading over the two decision buttons and keeps the scope note beside them', async () => {
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const area = view.container.querySelector('aside');
  if (!area) throw new Error('Missing the decision area');
  const decision = area.querySelector<HTMLElement>('[data-testid="review-decision"]');
  if (!decision) throw new Error('Missing the decision');
  expect(decision.getAttribute('aria-label')).toBe('Review.decisionHeading');
  expect(decision.querySelector('h3')).toBeNull();
  const approve = view.button('Review.approve', decision);
  const info = decision.querySelector('[aria-label="Review.decisionScope"]');
  expect(approve).toBeDefined();
  expect(info).not.toBeNull();
  // The note sits in the buttons' row.
  expect(approve?.parentElement?.contains(info)).toBe(true);
});

it('leads the decision area with the decision, so opening a comment never moves it', async () => {
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const area = view.container.querySelector('aside');
  if (!area) throw new Error('Missing the decision area');
  const decision = area.querySelector('[data-testid="review-decision"]');
  const comments = area.querySelector('[data-testid="review-comments"]');
  if (!decision || !comments) throw new Error('Missing a part');
  // The decision comes first and holds the top of the area; the comments follow it.
  expect(area.firstElementChild?.contains(decision)).toBe(true);
  expect(decision.compareDocumentPosition(comments) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const approve = view.button('Review.approve', area);
  expect(approve).toBeDefined();
  await view.click('pick line 1');
  const form = area.querySelector('form');
  expect(form).not.toBeNull();
  expect(approve?.compareDocumentPosition(form as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(area.firstElementChild?.contains(approve as Node)).toBe(true);
  // A long path keeps its file name: the form cuts it at the start.
  expect(form?.querySelector('[dir="rtl"]')?.textContent).toBe('README.md');
  // Three columns: nothing is pinned under the review.
  expect(view.container.querySelector('[data-testid="review-actions"]')).toBeNull();
});

it.each([
  [700, 'below three columns'],
  [1200, 'in three columns'],
])('at %ipx (%s) the decision and sending stay in reach', async (width) => {
  reviewWidth(width);
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const area = view.container.querySelector('aside');
  if (!area) throw new Error('Missing the decision area');
  await view.click('pick line 1');
  const note = area.querySelector<HTMLTextAreaElement>('form textarea');
  if (!note) throw new Error('Missing the comment field');
  await act(async () => setValue(note, 'Name the run.'));
  await view.click('Review.addComment', area);
  const pinned = view.container.querySelector<HTMLElement>('[data-testid="review-actions"]');
  const actions = ['Review.approve', 'Review.requestChanges', 'Review.sendReview'];
  if (width < 880) {
    // Under the changes, the primary actions sit in a row at the bottom of the review.
    if (!pinned) throw new Error('Missing the pinned actions');
    expect(area.contains(pinned)).toBe(false);
    for (const label of actions) {
      expect(view.button(label, pinned)).toBeDefined();
      expect(view.button(label, area)).toBeUndefined();
    }
  } else {
    expect(pinned).toBeNull();
    for (const label of actions) expect(view.button(label, area)).toBeDefined();
  }
  // Each action exists once.
  for (const label of actions)
    expect(
      [...view.container.querySelectorAll('button')].filter((item) => item.textContent === label),
    ).toHaveLength(1);
});

/** Whether a button draws as the kit's primary, told by the classes primary adds over tertiary. */
function isPrimary(button: HTMLButtonElement | undefined) {
  const classes = (variant: 'primary' | 'tertiary') => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <Button size="compact" variant={variant}>
        label
      </Button>,
    );
    return new Set(host.querySelector('button')?.classList);
  };
  const tertiary = classes('tertiary');
  const marks = [...classes('primary')].filter((name) => !tertiary.has(name));
  if (!button) throw new Error('Missing the button');
  return marks.every((name) => button.classList.contains(name));
}

it('while a comment is being written, adding it is the one primary action', async () => {
  reviewWidth(1200);
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const area = view.container.querySelector('aside');
  if (!area) throw new Error('Missing the decision area');
  const primaries = () =>
    [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => isPrimary(button))
      .map((button) => button.textContent);
  expect(primaries()).toEqual(['Review.approve']);

  await view.click('pick line 1');
  expect(primaries()).toEqual(['Review.addComment']);
  expect(isPrimary(view.button('Review.approve', area))).toBe(false);
  // Closing the form gives the decision its emphasis back.
  await view.click('Review.cancel', area);
  expect(primaries()).toEqual(['Review.approve']);

  // With a draft waiting, sending it leads; a second comment being written leads over both.
  await view.click('Review.addComment', area);
  const note = area.querySelector<HTMLTextAreaElement>('form textarea');
  if (!note) throw new Error('Missing the comment field');
  await act(async () => setValue(note, 'Name the run.'));
  await view.click('Review.addComment', area);
  expect(primaries()).toEqual(['Review.sendReview']);
  await view.click('Review.addComment', area);
  expect(primaries()).toEqual(['Review.addComment']);
  await view.click('Review.cancel', area);
  expect(primaries()).toEqual(['Review.sendReview']);
});

it('marks only files not left as Corral wrote them, each source in its own words, with a tooltip that names it', async () => {
  const view = await mount({
    search: { scope: 'session' },
    files: ['corral.ts', 'outside.ts', 'mixed.ts'],
    provenance: { 'outside.ts': 'external_observed', 'mixed.ts': 'mixed' },
  });
  const badge = (path: string) =>
    [...(view.fileButton(path)?.querySelectorAll<HTMLElement>('[title]') ?? [])].find((node) =>
      node.textContent?.startsWith('Files.provenanceMark.'),
    );
  expect(badge('corral.ts')).toBeUndefined();
  expect(badge('outside.ts')?.textContent).toBe('Files.provenanceMark.external_observed');
  expect(badge('mixed.ts')?.textContent).toBe('Files.provenanceMark.mixed');
  expect(badge('outside.ts')?.textContent).not.toBe(badge('mixed.ts')?.textContent);
  expect(badge('outside.ts')?.getAttribute('title')).toBe('Files.provenance.external_observed');
  expect(badge('mixed.ts')?.getAttribute('title')).toBe('Files.provenance.mixed');
  // The badge sits under the name instead of taking the name's width beside the counts.
  const counts = [...(view.fileButton('outside.ts')?.querySelectorAll('span') ?? [])].find(
    (node) => node.textContent === '+1',
  );
  expect(counts?.parentElement?.contains(badge('outside.ts') ?? null)).toBe(false);
  // No icon stands for where a change came from.
  for (const path of ['corral.ts', 'outside.ts', 'mixed.ts'])
    expect(view.fileButton(path)?.querySelector('svg')).toBeNull();
  // Screen readers still hear every file's source.
  expect(view.fileButton('corral.ts')?.textContent).toContain('Files.provenance.managed_agent');
});

it('puts the shown file’s source mark after the path in the comparison head only while the file list is folded away', async () => {
  const headMark = (container: HTMLElement) => {
    const path = container.querySelector('[data-testid="file-diff"] h3');
    const next = path?.nextElementSibling;
    return next?.textContent?.startsWith('Files.provenanceMark.') ? next : null;
  };
  const marks = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="file-diff"] *')].filter((node) =>
      node.textContent?.startsWith('Files.provenanceMark.'),
    );
  const files = ['outside.ts', 'mixed.ts', 'corral.ts'];
  const provenance = { 'outside.ts': 'external_observed', 'mixed.ts': 'mixed' };

  reviewWidth(700);
  const narrow = await mount({
    search: { scope: 'session', file: 'outside.ts' },
    files,
    provenance,
  });
  const toggle = narrow.container.querySelector<HTMLButtonElement>('nav button[aria-expanded]');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  const mark = headMark(narrow.container);
  expect(mark?.textContent).toBe('Files.provenanceMark.external_observed');
  expect(mark?.getAttribute('title')).toBe('Files.provenance.external_observed');
  // Unfolded, the list says it, so the head does not say it again.
  await act(async () => toggle?.click());
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  expect(marks(narrow.container)).toEqual([]);
  // Folded again on another file, the head names that file's source.
  await act(async () => narrow.fileButton('mixed.ts')?.click());
  expect(headMark(narrow.container)?.textContent).toBe('Files.provenanceMark.mixed');
  // A file as Corral wrote it carries no mark anywhere.
  await act(async () => narrow.fileButton('corral.ts')?.click());
  expect(marks(narrow.container)).toEqual([]);
  for (const cleanup of cleanups.splice(0)) await cleanup();

  reviewWidth(1200);
  const wide = await mount({ search: { scope: 'session', file: 'outside.ts' }, files, provenance });
  expect(wide.container.querySelector('[data-testid="file-diff"] h3')).not.toBeNull();
  expect(marks(wide.container)).toEqual([]);
});

it('shows the shared empty view where there is no diff to read', async () => {
  const none = await mount({ search: { scope: 'session' }, files: [] });
  const empty = none.container.querySelector('[data-testid="no-changes"]');
  expect(empty?.getAttribute('data-slot')).toBe('empty-view');
  expect(empty?.textContent).toContain('Files.nothingChanged');
  expect(none.container.textContent).not.toContain('Files.chooseFile');
});

it('opens with the first changed file of the list, or the file the address names', async () => {
  // Build output is folded below the other files, so the first file shown is `b.ts`.
  const opened = await mount({
    search: { scope: 'session' },
    files: ['dist/out.js', 'b.ts', 'c.ts'],
  });
  const shown = () => opened.container.querySelector('section[aria-label]');
  expect(shown()?.getAttribute('aria-label')).toBe('b.ts');
  expect(shown()?.querySelector('[data-testid="diff"]')).not.toBeNull();
  expect(opened.fileButton('b.ts')?.getAttribute('aria-current')).toBe('true');
  expect(opened.container.textContent).not.toContain('Files.chooseFile');
  // Opening it is not a choice the address records.
  expect(opened.searches).toEqual([]);
  for (const cleanup of cleanups.splice(0)) await cleanup();
  const named = await mount({
    search: { scope: 'session', file: 'c.ts' },
    files: ['dist/out.js', 'b.ts', 'c.ts'],
  });
  expect(named.container.querySelector('section[aria-label]')?.getAttribute('aria-label')).toBe(
    'c.ts',
  );
  expect(named.fileButton('c.ts')?.getAttribute('aria-current')).toBe('true');
});

it('offers no decision on a comparison with no changed files', async () => {
  for (const width of [1200, 600]) {
    reviewWidth(width);
    const view = await mount({ search: { scope: 'session' }, files: [] });
    expect(view.container.querySelector('[data-testid="review-decision"]')).toBeNull();
    expect(view.button('Review.approve')).toBeUndefined();
    expect(view.button('Review.requestChanges')).toBeUndefined();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  }
  // With a change to judge, both decisions are there.
  const changed = await mount({ search: { scope: 'session' }, files: ['a.ts'] });
  expect(changed.button('Review.approve')).toBeDefined();
  expect(changed.button('Review.requestChanges')).toBeDefined();
});

it('reads the changes again when shown again or when a run moves, keeping the place when nothing changed', async () => {
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  const reads = () => view.changes.changes.mock.calls.length;
  // A comment being written on the selected file, and the file's row as it is now.
  await view.click('pick line 1');
  const note = view.container.querySelector<HTMLTextAreaElement>('form textarea');
  if (!note) throw new Error('Missing the comment field');
  await act(async () => setValue(note, 'Keep this draft.'));
  const row = view.fileButton('README.md');

  // Hidden and shown again with nothing changed: read again, and nothing moves.
  const before = reads();
  await view.host({ shown: false });
  expect(reads()).toBe(before);
  await view.host({ shown: true });
  expect(reads()).toBe(before + 1);
  expect(view.fileButton('README.md')).toBe(row);
  expect(view.container.querySelector<HTMLTextAreaElement>('form textarea')?.value).toBe(
    'Keep this draft.',
  );
  // Any other refresh (a working copy event) keeps the draft too.
  await act(async () => window.dispatchEvent(new Event('corral:workspace-changed')));
  await act(async () => {});
  expect(view.container.querySelector<HTMLTextAreaElement>('form textarea')?.value).toBe(
    'Keep this draft.',
  );

  // A run of the session changes the copy while the view is open: the list follows.
  view.copy.files = ['README.md', 'notes.md'];
  view.copy.to = 'd'.repeat(40);
  await view.host({ shown: true, copyChanged: 'run_1:succeeded' });
  expect(view.fileButton('notes.md')).toBeDefined();

  // Changed while hidden: showing the view again lists it.
  await view.host({ shown: false, copyChanged: 'run_1:succeeded' });
  view.copy.files = ['README.md', 'notes.md', 'later.md'];
  view.copy.to = 'c'.repeat(40);
  await view.host({ shown: true, copyChanged: 'run_1:succeeded' });
  expect(view.fileButton('later.md')).toBeDefined();
});

it('a replacement suggestion is only a comment: it never writes a file or applies anything', async () => {
  const view = await mount({ search: { scope: 'session', file: 'README.md' } });
  await view.click('pick line 1');
  // The kind is chosen in the form: comment, suggested deletion or suggested replacement.
  const kind = view.container.querySelector<HTMLSelectElement>(
    'form select[aria-label="Review.kindLabel"]',
  );
  expect([...(kind?.options ?? [])].map((option) => option.textContent)).toEqual([
    'Review.kindComment',
    'Review.kindDelete',
    'Review.kindReplace',
  ]);
  await act(async () => {
    if (!kind) throw new Error('Missing the comment kind');
    kind.value = 'replace';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(kind?.value).toBe('replace');
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
  // Only the chosen run is a range to pick; the others are reached from their groups or the
  // conversation (features/review-run-groups.md).
  const labels = [...(view.scope()?.options ?? [])].map((option) => option.textContent);
  expect(labels).toEqual(['Files.scopes.session', 'Workbench.runNumber:{"number":2}']);
  expect(labels.join()).not.toContain('run_b');
  expect(view.fileButton('b.ts')?.getAttribute('aria-current')).toBe('true');
  expect(view.fileButton('a.ts')?.getAttribute('aria-current')).toBeNull();
});

it('offers no run as a range while the whole conversation is compared', async () => {
  const view = await mount({
    search: { scope: 'session' },
    runs: [run('run_b', '2026-11-10T02:00:00Z'), run('run_a', '2026-11-10T01:00:00Z')],
  });
  expect([...(view.scope()?.options ?? [])].map((option) => option.value)).toEqual(['session']);
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

it('moves between files with the list and the brace keys, stopping at the ends', async () => {
  const view = await mount({ search: { scope: 'session' }, files: ['a.ts', 'b.ts', 'c.ts'] });
  // The list is the way between files; its head has no previous/next file arrows of its own.
  const arrows = [...view.container.querySelectorAll('nav button')].filter((button) =>
    ['Review.nextFile', 'Review.previousFile'].includes(button.getAttribute('aria-label') ?? ''),
  );
  expect(arrows).toHaveLength(0);
  const press = async (key: string, target: Element) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true }));
    });
  // The review opens on the first file, so the next one is the second.
  const first = view.fileButton('a.ts');
  if (!first) throw new Error('Missing file row');
  expect(first.getAttribute('aria-current')).toBe('true');
  await press('}', first);
  expect(view.searches.at(-1)).toEqual({ file: 'b.ts' });
  expect(document.activeElement).toBe(view.fileButton('b.ts'));
  await press('}', document.activeElement as Element);
  expect(view.searches.at(-1)).toEqual({ file: 'c.ts' });
  expect(document.activeElement).toBe(view.fileButton('c.ts'));
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

// features/review-run-groups.md: the whole-conversation list grouped by the run a file changed
// during.
const twoRuns = {
  files: ['a.ts', 'b.ts', 'c.ts'],
  runs: [run('run_b', '2026-11-10T02:00:00Z'), run('run_a', '2026-11-10T01:00:00Z')],
  runOrder: ['run_a', 'run_b'],
  groups: {
    'a.ts': { runs: ['run_a'] },
    'b.ts': { runs: ['run_a', 'run_b'] },
    'c.ts': { outside: true },
  },
};
const groupsShown = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('nav [data-review-group]')].map((group) => [
    group.querySelector('h4')?.textContent,
    [...group.querySelectorAll<HTMLElement>('[data-review-file]')].map(
      (row) => row.dataset.reviewFile,
    ),
  ]);
const rowsOf = (container: HTMLElement, path: string) => [
  ...container.querySelectorAll<HTMLButtonElement>(`nav button[data-review-file="${path}"]`),
];

it('groups the whole conversation by run, newest first, with what changed outside any run last', async () => {
  const view = await mount({ search: { scope: 'session' }, ...twoRuns });
  expect(view.changes.changes).toHaveBeenLastCalledWith(
    session.sessionId,
    { kind: 'session' },
    'run',
  );
  expect(groupsShown(view.container)).toEqual([
    ['Workbench.runNumber:{"number":2}1Files.files:{"count":1}', ['b.ts']],
    ['Workbench.runNumber:{"number":1}2Files.files:{"count":2}', ['a.ts', 'b.ts']],
    ['Files.outsideRuns1Files.files:{"count":1}', ['c.ts']],
  ]);
  // The head counts files, not rows: b.ts is one file in two groups.
  expect(view.container.querySelector('nav h3')?.textContent).toBe('Files.files:{"count":3}');
});

it('opens on the first row as shown, and a file in two groups is one file whichever row is picked', async () => {
  const view = await mount({ search: { scope: 'session' }, ...twoRuns });
  const rows = rowsOf(view.container, 'b.ts');
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual(['true', 'true']);
  expect(rowsOf(view.container, 'a.ts')[0]?.getAttribute('aria-current')).toBeNull();
  await act(async () => rowsOf(view.container, 'a.ts')[0]?.click());
  await act(async () => rows[1]?.click());
  expect(view.searches.at(-1)).toEqual({ file: 'b.ts' });
  expect(view.searches.every((patch) => !('scope' in patch))).toBe(true);
});

it('the brace keys pass each file once in the order shown, although a file has two rows', async () => {
  const view = await mount({ search: { scope: 'session' }, ...twoRuns });
  const press = async (key: string) =>
    act(async () => {
      (document.activeElement ?? view.container).dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true }),
      );
    });
  rowsOf(view.container, 'b.ts')[0]?.focus();
  await press('}');
  expect(view.searches.at(-1)).toEqual({ file: 'a.ts' });
  await press('}');
  expect(view.searches.at(-1)).toEqual({ file: 'c.ts' });
  const count = view.searches.length;
  await press('}');
  expect(view.searches).toHaveLength(count);
  await press('{');
  await press('{');
  expect(view.searches.at(-1)).toEqual({ file: 'b.ts' });
  expect(document.activeElement).toBe(rowsOf(view.container, 'b.ts')[0]);
});

const compareButton = (container: HTMLElement, runId: string) =>
  container.querySelector<HTMLButtonElement>(
    `nav [data-review-group="${runId}"] button[aria-label^="Files.compareRun"]`,
  );

it("a run group's compare button opens that run's comparison, and that range is not grouped", async () => {
  const view = await mount({ search: { scope: 'session' }, ...twoRuns });
  const compare = compareButton(view.container, 'run_a');
  expect(compare?.getAttribute('aria-label')).toBe(
    'Files.compareRunNamed:{"run":"Workbench.runNumber:{\\"number\\":1}"}',
  );
  // The head is a label: nothing in it is pressed, and what changed outside runs has no button.
  expect(view.container.querySelector('nav h4 button')).toBeNull();
  expect(compare?.closest('h4')).toBeNull();
  expect(compareButton(view.container, 'outside')).toBeNull();
  await act(async () => compare?.click());
  await act(async () => {});
  expect(view.searches.at(-1)).toEqual({ scope: 'run', runId: 'run_a', file: undefined });
  expect(view.changes.changes).toHaveBeenLastCalledWith(session.sessionId, {
    kind: 'run',
    runId: 'run_a',
  });
  expect(groupsShown(view.container)).toEqual([]);
  expect(view.scope()?.value).toBe('run:run_a');
});

const rowName = (row: HTMLElement | undefined) => row?.querySelector('.sr-only')?.textContent;

it('a file in more than one group shows no status or line counts on its rows; one in a single group does', async () => {
  const view = await mount({
    search: { scope: 'session' },
    ...twoRuns,
    statuses: { 'a.ts': 'added', 'b.ts': 'added' },
  });
  const [inSecond, inFirst] = rowsOf(view.container, 'b.ts');
  for (const row of [inSecond, inFirst]) {
    expect(rowName(row)).toBe('b.ts \u00b7 Files.provenance.managed_agent');
    expect(row?.querySelector('[title="Files.status.added"]')).toBeNull();
    expect(row?.textContent).not.toContain('+1');
  }
  const single = rowsOf(view.container, 'a.ts')[0];
  expect(rowName(single)).toBe(
    'a.ts \u00b7 Files.status.added \u00b7 +1 \u22121 \u00b7 Files.provenance.managed_agent',
  );
  expect(single?.querySelector('[title="Files.status.added"]')?.textContent).toBe('A');
  // Counted from the answer, not from the groups left on screen by a filter.
  const filter = view.container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!filter) throw new Error('Missing file filter');
  await act(async () => setValue(filter, 'b.ts'));
  expect(rowsOf(view.container, 'b.ts').map(rowName)).toEqual([
    'b.ts \u00b7 Files.provenance.managed_agent',
    'b.ts \u00b7 Files.provenance.managed_agent',
  ]);
});

it('the kind filter goes by the whole-conversation status, shown on the row or not', async () => {
  const view = await mount({
    search: { scope: 'session' },
    ...twoRuns,
    statuses: { 'b.ts': 'added' },
  });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const trigger = view.container.querySelector<HTMLButtonElement>(
    'nav button[aria-label="Files.filterFiles"]',
  );
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    trigger?.click();
  });
  let added: HTMLElement | undefined;
  await vi.waitFor(() => {
    added = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      (item.getAttribute('aria-label') ?? item.textContent ?? '').includes('Files.status.added'),
    );
    expect(added).toBeDefined();
  });
  await act(async () => added?.click());
  expect(groupsShown(view.container).map(([, rows]) => rows)).toEqual([['b.ts'], ['b.ts']]);
});

it('a generated file listed once in its folded group keeps its status and line counts', async () => {
  const view = await mount({
    search: { scope: 'session' },
    ...twoRuns,
    files: [...twoRuns.files, 'pnpm-lock.yaml'],
    groups: { ...twoRuns.groups, 'pnpm-lock.yaml': { runs: ['run_a', 'run_b'] } },
  });
  expect(rowName(rowsOf(view.container, 'pnpm-lock.yaml')[0])).toBe(
    'pnpm-lock.yaml \u00b7 Files.status.modified \u00b7 +1 \u22121 \u00b7 Files.provenance.managed_agent',
  );
});

it('keeps a list whose files all changed during one run flat', async () => {
  const view = await mount({
    search: { scope: 'session' },
    files: ['a.ts', 'b.ts'],
    runs: [run('run_a', '2026-11-10T01:00:00Z')],
    runOrder: ['run_a'],
    groups: { 'a.ts': { runs: ['run_a'] }, 'b.ts': { runs: ['run_a'] } },
  });
  expect(groupsShown(view.container)).toEqual([]);
  expect(view.fileButton('a.ts')?.getAttribute('aria-current')).toBe('true');
  expect(view.fileButton('b.ts')).toBeDefined();
});

it('filters rows inside the groups and hides a group left without rows', async () => {
  const view = await mount({ search: { scope: 'session' }, ...twoRuns });
  const filter = view.container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!filter) throw new Error('Missing file filter');
  await act(async () => setValue(filter, 'b.ts'));
  expect(groupsShown(view.container).map(([, rows]) => rows)).toEqual([['b.ts'], ['b.ts']]);
  await act(async () => setValue(filter, 'c.ts'));
  expect(groupsShown(view.container)).toEqual([
    ['Files.outsideRuns1Files.files:{"count":1}', ['c.ts']],
  ]);
});

it('leaves generated and lock files in their one folded group, outside the run groups', async () => {
  const view = await mount({
    search: { scope: 'session' },
    ...twoRuns,
    files: [...twoRuns.files, 'pnpm-lock.yaml'],
    groups: { ...twoRuns.groups, 'pnpm-lock.yaml': { runs: ['run_a', 'run_b'] } },
  });
  expect(groupsShown(view.container).flatMap(([, rows]) => rows)).not.toContain('pnpm-lock.yaml');
  expect(rowsOf(view.container, 'pnpm-lock.yaml')).toHaveLength(1);
  expect(rowsOf(view.container, 'pnpm-lock.yaml')[0]?.closest('details')).not.toBeNull();
});

it('a run not yet in the run list still heads its group, without a number', async () => {
  const view = await mount({ search: { scope: 'session' }, ...twoRuns, runs: [] });
  expect(compareButton(view.container, 'run_a')?.getAttribute('aria-label')).toBe(
    'Files.compareRun',
  );
  expect(groupsShown(view.container).map(([head]) => head)).toEqual([
    'Files.run1Files.files:{"count":1}',
    'Files.run2Files.files:{"count":2}',
    'Files.outsideRuns1Files.files:{"count":1}',
  ]);
});

it('regroups when a new answer moves a file to another group', async () => {
  const view = await mount({ search: { scope: 'session' }, ...twoRuns });
  view.copy.groups = { ...twoRuns.groups, 'c.ts': { runs: ['run_b'] } };
  await view.host({ shown: true, copyChanged: 'run_b:succeeded' });
  expect(groupsShown(view.container).map(([, rows]) => rows)).toEqual([
    ['b.ts', 'c.ts'],
    ['a.ts', 'b.ts'],
  ]);
});
