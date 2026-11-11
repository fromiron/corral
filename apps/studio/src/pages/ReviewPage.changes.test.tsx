// @vitest-environment jsdom
import type { ReviewCommentView } from '@corral/client';
import type { RunSummary, WorkSession } from '@corral/core';
import { Button } from '@corral/react/design-kit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
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
// The diff renderer needs real workers. This one reports line picks the way the renderer does
// (a finished range on the "after" side) and shows which range it is asked to highlight; the
// comment form the pick opens is the real one.
type Picked = { start: number; end: number; side: 'additions' | 'deletions' };
vi.mock('../workbench/PierreCode.tsx', () => ({
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
  // What the copy holds now; a test changes it as a run would.
  const copy = { files, to };
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
      changes: vi.fn(async () => ({
        from,
        to: copy.to,
        unavailable: null,
        files: copy.files.map((path) => file(path, provenance[path])),
      })),
      fileVersions: vi.fn(async (_s: string, _f: string, _t: string, path: string) => ({
        path,
        before: { kind: 'text', text: 'old line\n' },
        after: { kind: 'text', text: 'new line\nsecond line\nthird line\n' },
      })),
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
        embedded
        shown={host.shown}
        copyChanged={host.copyChanged}
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

it('marks only files written outside Corral, with a badge whose tooltip names the source', async () => {
  const view = await mount({
    search: { scope: 'session' },
    files: ['corral.ts', 'outside.ts', 'mixed.ts'],
    provenance: { 'outside.ts': 'external_observed', 'mixed.ts': 'mixed' },
  });
  const badge = (path: string) =>
    [...(view.fileButton(path)?.querySelectorAll<HTMLElement>('[title]') ?? [])].find(
      (node) => node.textContent === 'Files.externalBadge',
    );
  expect(badge('corral.ts')).toBeUndefined();
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

it('shows the shared empty view where there is no diff to read', async () => {
  const chosen = await mount({ search: { scope: 'session' }, files: ['a.ts'] });
  const choose = chosen.container.querySelector('[data-slot="empty-view"]');
  expect(choose?.textContent).toContain('Files.chooseFile');
  expect(choose?.closest('section')?.getAttribute('aria-label')).toBe('Files.chooseFile');
  for (const cleanup of cleanups.splice(0)) await cleanup();
  const none = await mount({ search: { scope: 'session' }, files: [] });
  const empty = none.container.querySelector('[data-testid="no-changes"]');
  expect(empty?.getAttribute('data-slot')).toBe('empty-view');
  expect(empty?.textContent).toContain('Files.nothingChanged');
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
  const first = view.fileButton('a.ts');
  if (!first) throw new Error('Missing file row');
  await press('}', first);
  expect(view.searches.at(-1)).toEqual({ file: 'a.ts' });
  expect(document.activeElement).toBe(view.fileButton('a.ts'));
  await press('}', document.activeElement as Element);
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
