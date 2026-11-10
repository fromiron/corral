import type {
  ChangeScopeQuery,
  ChangeSetView,
  FileChangeView,
  FileOperationView,
  FileSideView,
  IntegrationPlanFile,
  IntegrationResultView,
  ReviewCommentView,
  ReviewDecisionView,
} from '@corral/client';
import { TERMINAL_RUN_STATUSES, type TextAttachment } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { EmptyView } from '@corral/react';
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  fontWeights,
  Input,
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  Tooltip,
} from '@corral/react/design-kit';
import { Check, ChevronDown, Eye, Info, ListFilter, Plus, Trash2 } from '@corral/react/icons';
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useFormatter, useTranslations } from 'use-intl';
import { createPendingSessionCommands } from '../pendingCommands.ts';
import { reviewRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { conversationRequest, newCommandId, steer, steerTargets } from '../sessionActions.ts';
import {
  autoChoiceFor,
  autoNotReady,
  autoReasoningUnsupported,
  sessionRunMode,
} from '../workbench/autoChoice.ts';
import { Checks } from '../workbench/ChecksView.tsx';
import { type AttachmentCapture, appendComposerAttachment } from '../workbench/context/bridge.ts';
import {
  integrationDisplayState,
  uniqueFileOperations,
} from '../workbench/fileReviewPresentation.ts';
import { HunkActions } from '../workbench/HunkActions.tsx';
import { type HunkNavigation, HunkNavigator, hunkLabel } from '../workbench/HunkNavigator.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import type { DiffHandle } from '../workbench/PierreCode.tsx';
import { panelKey } from '../workbench/panels/registry.ts';
import type { ReviewSearch } from '../workbench/panels/routes.ts';
import { CommentBody, ReviewCommentForm } from '../workbench/ReviewCommentForm.tsx';
import { rangeChanged, sideText } from '../workbench/reviewComments.ts';
import { type ReviewMarks, useReviewMarks } from '../workbench/reviewMarks.ts';
import { reveal, reviewMoveFor, stepIndex } from '../workbench/reviewNavigation.ts';
import { reviewSelection } from '../workbench/reviewSelection.ts';
import { useModelProfiles } from '../workbench/useModels.ts';
import { WORKSPACE_CHANGED } from '../workbench/workspaceEvents.ts';
import { useBinding } from './FilesViews.tsx';
import { LspProposals } from './LspProposals.tsx';
import { useRemembered, WorkbenchLayout } from './Workbench.tsx';

// Reviewing a session's file changes: a fixed comparison range, then three columns. The files
// the range changed (with where each change came from), the selected file's changes, and the
// decision area: the decision at its top, then comments and applying. Below the three-column
// width the file list folds into its head, the decision area follows the changes, and its
// primary actions (the decision, and sending drafts) stay in a row at the bottom of the review.

const DiffCode = lazy(() =>
  import('../workbench/PierreCode.tsx').then((module) => ({ default: module.DiffCode })),
);

const semibold = { fontVariationSettings: fontWeights.semibold };
// The three columns sit side by side from an 880px review width (`@min-[880px]/review`).
const THREE_COLUMNS = 880;

/**
 * Whether the review is wide enough for three columns, measured as its container query
 * measures it. Without a way to measure (no ResizeObserver) the review counts as wide.
 */
function useThreeColumns(element: HTMLElement | null) {
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWide(entry.contentRect.width >= THREE_COLUMNS);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return wide;
}

// Git state has one home, the Git pane; an old `scope=git` address is redirected there (#91).
type ReviewScope = ChangeScopeQuery;

const scopeFromSearch = (search: { scope?: string; runId?: string }): ReviewScope =>
  search.scope === 'run' && search.runId
    ? { kind: 'run', runId: search.runId }
    : search.scope === 'review'
      ? { kind: 'review' }
      : { kind: 'session' };

export function ReviewPage() {
  const { session } = reviewRoute.useLoaderData();
  const search = reviewRoute.useSearch();
  const navigate = useNavigate({ from: '/sessions/$sessionId/review' });
  return (
    <ReviewContent
      session={session}
      search={search}
      onSearch={(patch) => void navigate({ search: (current) => ({ ...current, ...patch }) })}
    />
  );
}

export function ReviewContent({
  session,
  search,
  onSearch,
  embedded = false,
  onPrepareCopy,
  onSessionChange,
  rangeSlot,
  showChecks = true,
}: {
  session: WorkSession;
  search: ReviewSearch;
  onSearch: (patch: Partial<ReviewSearch>) => void;
  embedded?: boolean;
  onPrepareCopy?: () => void;
  onSessionChange?: () => void | Promise<void>;
  /**
   * Where the host's header shows the compare range. A host that gives one owns the view's
   * header (and its "mark all read" action); without one this view heads itself.
   */
  rangeSlot?: HTMLElement | null;
  /** False where checks have their own view beside this one. */
  showChecks?: boolean;
}) {
  const t = useTranslations('Files');
  const tr = useTranslations('Review');
  const tw = useTranslations('Workbench');
  const ts = useTranslations('Sessions');
  const tc = useTranslations('Context');
  const reviewedHint = useId();
  const navigate = useNavigate();
  const services = useServices();
  const { workspaces, transport, mode } = services;
  const mounted = useRef(false);
  const current = useRef({ services, session });
  current.current = { services, session };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onAttach = async (attachment: TextAttachment, capture: AttachmentCapture) => {
    const isCurrent = () =>
      mounted.current &&
      current.current.services === services &&
      current.current.session.sessionId === session.sessionId &&
      current.current.session.projectId === session.projectId;
    if (
      !isCurrent() ||
      capture.target.hostId !== services.workspaceId ||
      capture.target.projectId !== session.projectId ||
      capture.target.sessionId !== session.sessionId
    )
      throw new Error(tc('attachFailed'));
    const result = appendComposerAttachment(capture, attachment);
    if (!result.ok) throw new Error(tc('attachFailed'));
    if (isCurrent())
      await navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: session.sessionId },
        search: { compose: true },
      });
  };
  const scope = scopeFromSearch(search);
  const scopeKey = scope.kind === 'run' ? `run:${scope.runId}` : scope.kind;
  const [changes, setChanges] = useState<ChangeSetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // UX-05: a session without a working copy has nothing to compare; that is not a failure.
  const [noCopy, setNoCopy] = useState(false);
  // "Since last read" exists once the copy has been marked read.
  const [copyRead, setCopyRead] = useState<{ sessionId: string; read: boolean } | null>(null);
  // Runs and comments are held with the session they were read for: a late answer for the
  // session just left never lands here, and its drafts or active run never drive this one.
  const [loadedRuns, setRuns] = useState<{ sessionId: string; runs: RunSummary[] }>({
    sessionId: '',
    runs: [],
  });
  const runs = loadedRuns.sessionId === session.sessionId ? loadedRuns.runs : [];
  const [runTick, setRunTick] = useState(0);
  const [runsLost, setRunsLost] = useState(false);
  const refreshRuns = useCallback(() => setRunTick((tick) => tick + 1), []);
  const runActive = runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const changed = () => setVersion((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  const { binding } = useBinding(session.projectId);
  const [loadedComments, setComments] = useState<{
    sessionId: string;
    comments: ReviewCommentView[];
  }>({ sessionId: session.sessionId, comments: [] });
  const comments = loadedComments.sessionId === session.sessionId ? loadedComments.comments : [];
  const reviewed = useReviewMarks(services.workspaceId ?? mode, session.sessionId);
  const reloadComments = useCallback(async () => {
    if (!workspaces) return;
    const sessionId = session.sessionId;
    const value = await workspaces.comments(sessionId).catch(() => []);
    if (current.current.services.workspaces === workspaces)
      setComments((shown) =>
        current.current.session.sessionId === sessionId ? { sessionId, comments: value } : shown,
      );
  }, [workspaces, session.sessionId]);
  useEffect(() => {
    void reloadComments();
  }, [reloadComments]);

  useEffect(() => {
    void runTick;
    let live = true;
    const sessionId = session.sessionId;
    void transport.listRuns().then(
      (all) => {
        if (!live) return;
        setRuns({ sessionId, runs: all.filter((r) => r.sessionId === sessionId) });
        setRunsLost(false);
      },
      () => live && setRunsLost(true),
    );
    return () => {
      live = false;
    };
  }, [transport, session.sessionId, runTick]);
  useEffect(() => {
    if (!runActive && !runsLost) return;
    const timer = setInterval(refreshRuns, 1500);
    return () => clearInterval(timer);
  }, [runActive, runsLost, refreshRuns]);
  useEffect(() => {
    void version;
    if (!workspaces) return;
    let live = true;
    setChanges(null);
    setError(null);
    setNoCopy(false);
    const chosen = scopeFromSearch({
      scope: scopeKey.split(':')[0],
      runId: scopeKey.split(':')[1],
    });
    const sessionId = session.sessionId;
    void (async () => {
      const copy = await workspaces.worktree(sessionId).catch(() => null);
      if (live) setCopyRead({ sessionId, read: Boolean(copy?.reviewed) });
      if (!copy || copy.missing) return live && setNoCopy(true);
      const result = await workspaces.changes(session.sessionId, chosen);
      if (live) setChanges(result);
    })().catch(
      (failure: unknown) =>
        live && setError(failure instanceof Error ? failure.message : String(failure)),
    );
    return () => {
      live = false;
    };
  }, [workspaces, session.sessionId, scopeKey, version]);

  const selected = search.file ?? null;
  const choose = (file: string) => onSearch({ file });
  const setScope = (value: string) => {
    const [kind, runId] = value.split(':');
    onSearch({
      scope: kind as 'session' | 'review' | 'run',
      runId,
      file: undefined,
    });
  };
  // Run #N counts this session's runs in start order, as the run controls do.
  const numbered = runs.toReversed().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const runNumber = (runId: string) => numbered.findIndex((run) => run.runId === runId) + 1;
  const sinceRead = copyRead?.sessionId === session.sessionId && copyRead.read;
  // The chosen range's detail is the exact pair of trees it compares.
  const trees =
    changes?.from && changes.to
      ? t('compareRange', { from: changes.from.slice(0, 8), to: changes.to.slice(0, 8) })
      : undefined;
  const ranges = [
    { value: 'session', label: t('scopes.session') },
    ...(sinceRead || scope.kind === 'review'
      ? [{ value: 'review', label: t('scopes.review') }]
      : []),
    // A run from the address that the list has not shown yet stays chosen, without its raw id.
    ...(scope.kind === 'run' && !runNumber(scope.runId)
      ? [{ value: scopeKey, label: tr('selectedRun') }]
      : []),
    ...numbered.toReversed().map((r) => ({
      value: `run:${r.runId}`,
      label: tw('runNumber', { number: runNumber(r.runId) }),
    })),
  ].map((option) =>
    option.value === scopeKey && trees
      ? { ...option, hint: <span className="font-mono">{trees}</span> }
      : option,
  );
  // The options name what they compare; the label stays for assistive technology.
  const range = (
    <Select
      variant="chip"
      label={t('scope')}
      value={scopeKey}
      onValueChange={setScope}
      options={ranges}
    />
  );

  // The brace keys move to the next/previous file of the list as shown (its filters and folded
  // group) from anywhere in this view, and the bracket keys move between changes.
  const fileNav = useRef<HTMLElement>(null);
  const hunkNav = useRef<HunkNavigation | null>(null);
  const moveFile = (direction: 1 | -1) => {
    const rows = [
      ...(fileNav.current?.querySelectorAll<HTMLButtonElement>('button[data-review-file]') ?? []),
    ].filter((row) => !row.closest('details:not([open])'));
    const paths = rows.map((row) => row.dataset.reviewFile ?? '');
    const at = selected ? paths.indexOf(selected) : -1;
    const next = stepIndex(at < 0 ? null : at, paths.length, direction);
    if (next === null) return false;
    choose(paths[next] as string);
    rows[next]?.focus();
    reveal(rows[next]);
    return true;
  };
  const moves = useRef(moveFile);
  moves.current = moveFile;
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      const move = reviewMoveFor(event);
      if (!move) return;
      const done =
        move === 'nextChange' || move === 'previousChange'
          ? (hunkNav.current?.move(move === 'nextChange' ? 1 : -1) ?? false)
          : moves.current(move === 'nextFile' ? 1 : -1);
      if (done) event.preventDefault();
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [root]);
  // The comment form is opened from the diff and shown in the decision area.
  const [commentSlot, setCommentSlot] = useState<HTMLElement | null>(null);
  // Below three columns the decision and the send button move to the row pinned under the
  // review; in three columns they stay in the decision area (`undefined`).
  const wide = useThreeColumns(root);
  const [decisionSlot, setDecisionSlot] = useState<HTMLElement | null>(null);
  const [sendSlot, setSendSlot] = useState<HTMLElement | null>(null);
  const active = runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  const drafts = comments.filter((comment) => comment.state === 'draft').length;
  // While a comment is being written, adding it is the review's one primary action.
  const [composing, setComposing] = useState(false);
  // The empty view where the changes would be, whenever there is no diff to show.
  const noFiles = Boolean(changes) && (Boolean(changes?.unavailable) || !changes?.files.length);
  const idle = !changes
    ? null
    : changes.unavailable
      ? t('noBaseline')
      : changes.files.length === 0
        ? scope.kind === 'run'
          ? t('runChangedNothing')
          : t('nothingChanged')
        : t('chooseFile');
  const Container = embedded ? 'div' : 'main';

  return (
    <WorkbenchLayout
      key={panelKey(services, {
        kind: 'review',
        projectId: session.projectId,
        sessionId: session.sessionId,
      })}
      main={
        <Container
          ref={setRoot}
          className="@container/review flex h-full min-h-0 min-w-0 flex-1 flex-col"
        >
          {rangeSlot ? createPortal(range, rangeSlot) : null}
          {!embedded || rangeSlot === undefined ? (
            <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-3 py-2">
              {!embedded ? (
                <>
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: session.sessionId }}
                    className="text-caption underline"
                  >
                    ← {session.title}
                  </Link>
                  <h2 className="text-title" style={semibold}>
                    {t('reviewHeading')}
                  </h2>
                </>
              ) : null}
              {rangeSlot === undefined ? range : null}
              {!embedded ? (
                <>
                  <Button
                    variant="tertiary"
                    size="compact"
                    onClick={() =>
                      void workspaces
                        ?.markReviewed(session.sessionId)
                        .then(() => setVersion((n) => n + 1))
                    }
                    title={t('reviewedNote')}
                    aria-describedby={reviewedHint}
                    className="ml-auto"
                  >
                    {t('markReviewed')}
                  </Button>
                  {/* The baseline always covers the whole current copy (#78 IA-07); the button
                      names it, so the longer note is its description and tooltip only. */}
                  <span id={reviewedHint} className="sr-only">
                    {t('reviewedNote')}
                  </span>
                </>
              ) : null}
            </header>
          ) : null}
          {runsLost ? (
            <p role="alert" className="m-0 p-3 text-body text-destructive">
              {ts('connectionLost')}
            </p>
          ) : null}
          {noCopy ? (
            <section
              data-testid="review-empty"
              className="mx-auto flex max-w-lg flex-col items-start gap-3 p-8"
            >
              <h3 className="text-subtitle" style={semibold}>
                {t('noCopyTitle')}
              </h3>
              <p className="m-0 text-body text-muted-foreground">{t('noCopyBody')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="compact"
                  render={
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: session.sessionId }}
                      search={{ panel: 'artifacts' }}
                    />
                  }
                >
                  {t('openResults')}
                </Button>
                <Button
                  variant="tertiary"
                  size="compact"
                  onClick={onPrepareCopy}
                  render={
                    onPrepareCopy ? undefined : (
                      <Link
                        to="/sessions/$sessionId"
                        params={{ sessionId: session.sessionId }}
                        search={{ panel: 'changes' }}
                      />
                    )
                  }
                >
                  {t('makeCopyThere')}
                </Button>
              </div>
            </section>
          ) : error ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 p-3 text-body text-destructive"
            >
              {t('failed', { message: error })}
              <Button variant="tertiary" size="compact" onClick={() => setVersion((n) => n + 1)}>
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div
            className={cn(
              noCopy || error ? 'hidden' : 'grid',
              // Stacked, each part keeps its own height and the view scrolls as one.
              'min-h-0 flex-1 auto-rows-max grid-cols-1 content-start overflow-auto',
              '@min-[880px]/review:grid-cols-[13rem_minmax(0,1fr)_17.5rem]',
              '@min-[880px]/review:grid-rows-[minmax(0,1fr)] @min-[880px]/review:content-stretch @min-[880px]/review:overflow-hidden',
            )}
          >
            <nav
              ref={fileNav}
              aria-label={t('reviewHeading')}
              className={cn(
                'flex min-h-0 min-w-0 flex-col border-b border-border',
                '@min-[880px]/review:border-r @min-[880px]/review:border-b-0',
              )}
            >
              <FileList
                changes={changes}
                selected={selected}
                reviewed={reviewed}
                onChoose={choose}
                sinceRead={scope.kind === 'review'}
              />
            </nav>
            <section
              aria-label={selected ?? t('chooseFile')}
              className={cn('flex min-h-0 min-w-0 flex-col', '@min-[880px]/review:overflow-hidden')}
            >
              {selected && changes?.from && changes.to ? (
                <FileDiff
                  fill
                  path={selected}
                  loadKey={`${session.sessionId}:${scopeKey}:${changes.from}:${changes.to}:${selected}`}
                  load={() =>
                    (workspaces as NonNullable<typeof workspaces>).fileVersions(
                      session.sessionId,
                      changes.from as string,
                      changes.to as string,
                      selected,
                    )
                  }
                  mark={changeMark(
                    reviewed,
                    changes.files.find((f) => f.path === selected),
                  )}
                  navigation={hunkNav}
                  comments={comments.filter(
                    (c) => c.from === changes.from && c.to === changes.to && c.path === selected,
                  )}
                  commentSlot={commentSlot}
                  onComposing={setComposing}
                  onComment={async (comment: NewComment) => {
                    await workspaces?.addComment(session.sessionId, {
                      ...comment,
                      from: changes.from as string,
                      to: changes.to as string,
                      path: selected,
                    });
                    await reloadComments();
                  }}
                />
              ) : idle ? (
                <EmptyView
                  {...(noFiles ? { 'data-testid': 'no-changes' } : {})}
                  title={idle}
                  className="m-3"
                />
              ) : (
                <p className="m-auto px-6 py-10 text-center text-caption text-muted-foreground">
                  {t('preparing')}
                </p>
              )}
            </section>
            <aside
              aria-label={tr('decisionArea')}
              // Beside the changes it is one column led by the decision, which holds the top
              // while the rest scrolls. Under the changes the decision is in the pinned row, and
              // the comments sit beside the other parts once there is room for both.
              className={cn(
                'flex min-w-0 flex-col gap-3 border-t border-border p-3',
                '@min-[640px]/review:grid @min-[640px]/review:grid-cols-2 @min-[640px]/review:items-start @min-[640px]/review:gap-x-6',
                '@min-[880px]/review:flex @min-[880px]/review:items-stretch @min-[880px]/review:overflow-auto @min-[880px]/review:border-t-0 @min-[880px]/review:border-l',
              )}
            >
              {scope.kind === 'session' && changes?.from && changes.to ? (
                <DecisionPanel
                  key={`decision:${session.sessionId}`}
                  sessionId={session.sessionId}
                  from={changes.from}
                  to={changes.to}
                  changed={version}
                  linked={Boolean(binding)}
                  active={active}
                  // Draft comments make sending them the next step; approving waits its turn.
                  primary={drafts === 0 && !composing}
                  barSlot={wide ? undefined : decisionSlot}
                  detailsClassName="@min-[640px]/review:col-start-2"
                />
              ) : null}
              <CommentsPanel
                key={`comments:${session.sessionId}`}
                session={session}
                runs={runs}
                runsReady={loadedRuns.sessionId === session.sessionId && !runsLost}
                comments={comments}
                current={changes}
                composer={<div ref={setCommentSlot} className="empty:hidden" />}
                stepBack={composing}
                sendSlot={wide ? undefined : sendSlot}
                className="@min-[640px]/review:col-start-1 @min-[640px]/review:row-span-2 @min-[640px]/review:row-start-1"
                onChange={async () => {
                  refreshRuns();
                  await reloadComments();
                  await onSessionChange?.();
                }}
              />
              {/* Each part below rules itself off from the one above; the first one is not ruled
                  off while it heads its own column beside the comments. */}
              <div
                className={cn(
                  'flex min-w-0 flex-col gap-3 empty:hidden @min-[640px]/review:col-start-2',
                  '@min-[640px]/review:[&>*:first-child]:border-t-0 @min-[640px]/review:[&>*:first-child]:pt-0',
                  '@min-[880px]/review:[&>*:first-child]:border-t @min-[880px]/review:[&>*:first-child]:pt-3',
                )}
              >
                {selected && changes?.from && changes.to ? (
                  <HunkActions
                    key={`${session.sessionId}:${selected}:${changes.from}:${changes.to}`}
                    sessionId={session.sessionId}
                    projectId={session.projectId}
                    from={changes.from}
                    to={changes.to}
                    path={selected}
                    active={active}
                    onApplied={() => setVersion((value) => value + 1)}
                    onAttach={onAttach}
                  />
                ) : null}
                {workspaces && mode === 'server' ? (
                  <LspProposals
                    key={`lsp:${session.sessionId}`}
                    api={workspaces}
                    sessionId={session.sessionId}
                    version={version}
                    onApplied={() => setVersion((current) => current + 1)}
                    renderFile={(proposal, file) => (
                      <FileDiff
                        path={file.path}
                        loadKey={`${proposal.hash}:${file.path}`}
                        load={async () => ({
                          before: { kind: 'text', text: file.before },
                          after: { kind: 'text', text: file.after },
                        })}
                        mark={{
                          pressed: reviewed.has(`proposal:${proposal.hash}:${file.path}`),
                          toggle: () => reviewed.toggle(`proposal:${proposal.hash}:${file.path}`),
                        }}
                        comments={[]}
                      />
                    )}
                  />
                ) : null}
                {showChecks ? (
                  <div className="border-t border-border pt-3">
                    <Checks
                      sessionId={session.sessionId}
                      projectId={session.projectId}
                      binding={binding ?? null}
                      changed={version}
                      onAttach={onAttach}
                    />
                  </div>
                ) : null}
                <Operations sessionId={session.sessionId} />
              </div>
            </aside>
          </div>
          {/* Below three columns the decision area sits under the changes, so its primary
              actions stay here, under the scrolling review, always in view. */}
          {!wide && !noCopy && !error ? (
            <div
              data-testid="review-actions"
              className="hidden shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-background px-3 py-2 has-[button]:flex"
            >
              <div ref={setDecisionSlot} className="contents" />
              <div ref={setSendSlot} className="contents" />
            </div>
          ) : null}
        </Container>
      }
    />
  );
}

type NewComment = Pick<ReviewCommentView, 'side' | 'startLine' | 'endLine' | 'quote' | 'body'>;

/** A change review toggle; absent where there is nothing to review (the Git pane). */
interface ChangeMark {
  pressed: boolean;
  toggle(): void;
}
const changeMark = (marks: ReviewMarks, file: FileChangeView | undefined): ChangeMark | undefined =>
  file && { pressed: marks.changeReviewed(file), toggle: () => marks.toggleChange(file) };

/** The lines being commented on in one loaded comparison of a file. */
interface LinePick {
  key: string;
  range: SelectedLineRange;
  open: boolean;
}

/**
 * One file's changes under a single toolbar: the path, the change position with previous/next,
 * the view mode and, where the change can be reviewed, its review mark. With `onComment`, lines
 * picked in the diff open the comment form with that range; the form's own inputs change it.
 */
export function FileDiff({
  path,
  loadKey,
  load,
  mark,
  comments = [],
  onComment,
  commentSlot,
  onComposing,
  navigation,
  fill = false,
}: {
  path: string;
  /** Changes whenever what to load changes. */
  loadKey: string;
  load: () => Promise<{ before: FileSideView; after: FileSideView }>;
  mark?: ChangeMark | undefined;
  comments?: ReviewCommentView[];
  /** Absent where comments do not apply (the linked folder's Git state). */
  onComment?: (comment: NewComment) => Promise<void>;
  /** Where the comment form shows (the decision area); under the toolbar without one. */
  commentSlot?: HTMLElement | null;
  /** Told whether the comment form is open. */
  onComposing?: ((open: boolean) => void) | undefined;
  /** Takes the shown diff's next/previous change moves (keyboard navigation). */
  navigation?: RefObject<HunkNavigation | null> | undefined;
  /** Fills a review column: a ruled toolbar, and a diff that takes the height left. */
  fill?: boolean;
}) {
  const t = useTranslations('Files');
  const tr = useTranslations('Review');
  const [sides, setSides] = useState<{ before: FileSideView; after: FileSideView } | null>(null);
  const [layout, setLayout] = useState<'unified' | 'split' | 'raw'>('unified');
  const [diff, setDiff] = useState<FileDiffMetadata | 'stopped' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<LinePick | null>(null);
  const viewer = useRef<DiffHandle | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loadKey` names what `load` reads
  useEffect(() => {
    let live = true;
    setSides(null);
    setError(null);
    void load().then(
      (v) => live && setSides(v),
      (failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [loadKey]);
  // The diff runs in a worker and is stopped after 3 s (no endless spinner).
  useEffect(() => {
    setDiff(null);
    if (!sides) return;
    const before = sideText(sides.before);
    const after = sideText(sides.after);
    if (before === null || after === null) return;
    const worker = new Worker(new URL('../diff.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      setDiff('stopped');
    }, 3000);
    worker.onmessage = (event: MessageEvent<{ diff?: FileDiffMetadata; error?: boolean }>) => {
      clearTimeout(timer);
      setDiff(event.data.diff ?? 'stopped');
      worker.terminate();
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      setDiff('stopped');
    };
    worker.postMessage({ path, before, after });
    return () => {
      clearTimeout(timer);
      worker.terminate();
    };
  }, [sides, path]);
  const hunks = useMemo(
    () =>
      diff && diff !== 'stopped' ? diff.hunks.map((hunk) => ({ label: hunkLabel(hunk) })) : [],
    [diff],
  );
  const notText = (side: FileSideView) =>
    side.kind === 'binary' ? t('binary') : side.kind === 'too_large' ? t('tooLarge') : null;
  const before = sides ? sideText(sides.before) : null;
  const after = sides ? sideText(sides.after) : null;
  const source = sides?.after.kind === 'text' ? sides.after.text : (before ?? '');
  const download = () => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = path.split('/').at(-1) ?? 'file.txt';
    link.click();
    URL.revokeObjectURL(url);
  };
  // A pick belongs to the comparison it was made in; another file starts without one.
  const picked = pick?.key === loadKey ? pick : null;
  const range: SelectedLineRange = picked?.range ?? {
    start: 1,
    end: 1,
    side: after ? 'additions' : 'deletions',
  };
  const anchor = sides ? reviewSelection(range, before ?? '', after ?? '') : null;
  const commentable = Boolean(onComment) && before !== null && after !== null;
  const composing = commentable && Boolean(picked?.open);
  useEffect(() => {
    onComposing?.(composing);
  }, [onComposing, composing]);
  useEffect(() => () => onComposing?.(false), [onComposing]);
  const composer =
    onComment && commentable ? (
      picked?.open ? (
        <ReviewCommentForm
          anchor={anchor}
          path={path}
          range={{
            side: range.side === 'deletions' ? 'before' : 'after',
            start: range.start,
            end: range.end,
          }}
          onRange={(next) =>
            setPick({
              key: loadKey,
              open: true,
              range: {
                start: next.start,
                end: next.end,
                side: next.side === 'before' ? 'deletions' : 'additions',
              },
            })
          }
          onSubmit={async (comment) => {
            await onComment(comment);
            setPick((value) => (value?.key === loadKey ? { ...value, open: false } : value));
          }}
          onCancel={() =>
            setPick((value) => (value?.key === loadKey ? { ...value, open: false } : value))
          }
        />
      ) : (
        <Button
          variant="tertiary"
          size="compact"
          className="self-start"
          onClick={() => setPick({ key: loadKey, range, open: true })}
        >
          <Plus aria-hidden />
          {tr('addComment')}
        </Button>
      )
    ) : null;
  const cut = path.lastIndexOf('/') + 1;
  const note = fill ? 'm-0 px-3 py-2 text-caption' : 'm-0 text-caption';
  return (
    <div
      className={cn('flex min-w-0 flex-col', fill ? 'min-h-0 flex-1' : 'gap-2')}
      data-testid="file-diff"
    >
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-2 gap-y-1',
          fill && 'min-h-10 shrink-0 border-b border-border px-3 py-1',
        )}
      >
        {/* A long path keeps its file name: it is cut at the start. */}
        <h3
          dir="rtl"
          title={path}
          className="m-0 min-w-24 flex-1 truncate text-left font-mono text-caption"
        >
          <bdi>
            <span className="text-muted-foreground">{path.slice(0, cut)}</span>
            {path.slice(cut)}
          </bdi>
        </h3>
        {layout !== 'raw' && diff && diff !== 'stopped' ? (
          <HunkNavigator
            key={loadKey}
            hunks={hunks}
            onReveal={(index) => viewer.current?.revealHunk(index)}
            navigation={navigation}
          />
        ) : null}
        <fieldset className="flex shrink-0 gap-0.5">
          <legend className="sr-only">{t('viewMode')}</legend>
          {(['unified', 'split', 'raw'] as const).map((value) => (
            <Button
              key={value}
              variant={layout === value ? 'secondary' : 'ghost'}
              size="compact"
              aria-pressed={layout === value}
              onClick={() => setLayout(value)}
            >
              {t(value)}
            </Button>
          ))}
        </fieldset>
        {mark ? (
          <Tooltip content={t('changeReviewNote')}>
            <Button
              variant={mark.pressed ? 'secondary' : 'tertiary'}
              size="compact"
              aria-pressed={mark.pressed}
              onClick={mark.toggle}
              className="shrink-0"
            >
              {mark.pressed ? (
                <>
                  <Check aria-hidden className="text-success" />
                  {t('reviewedFile')}
                </>
              ) : (
                t('markFileReviewed')
              )}
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {composer && commentSlot === undefined ? (
        <div className="flex flex-col">{composer}</div>
      ) : null}
      {composer && commentSlot ? createPortal(composer, commentSlot) : null}
      {error ? (
        <p role="alert" className={cn(note, 'text-destructive')}>
          {error}
        </p>
      ) : !sides ? (
        <p className={cn(note, 'text-muted-foreground')}>{t('computing')}</p>
      ) : (
        <>
          {diff === 'stopped' && layout !== 'raw' ? (
            <p role="alert" className={cn(note, 'text-warning')}>
              {t('diffStopped')}
            </p>
          ) : null}
          {diff === null && layout !== 'raw' && !notText(sides.before) && !notText(sides.after) ? (
            <p className={cn(note, 'text-muted-foreground')}>{t('computing')}</p>
          ) : null}
          {notText(sides.before) || notText(sides.after) ? (
            <p className={cn(note, 'text-muted-foreground')}>
              {notText(sides.after) ?? notText(sides.before)}
            </p>
          ) : layout === 'raw' ? (
            <div className={cn('flex min-h-0 flex-col gap-2', fill && 'flex-1 p-3')}>
              <Button variant="tertiary" size="compact" onClick={download} className="self-start">
                {t('downloadFile')}
              </Button>
              <pre
                className={cn(
                  'm-0 overflow-auto fill-group p-3 font-mono text-caption break-all whitespace-pre-wrap',
                  fill && 'min-h-0 flex-1',
                )}
              >
                {source}
              </pre>
            </div>
          ) : diff && diff !== 'stopped' ? (
            <Suspense
              fallback={<p className={cn(note, 'text-muted-foreground')}>{t('computing')}</p>}
            >
              <DiffCode
                key={loadKey}
                diff={diff}
                layout={layout}
                comments={comments}
                handle={viewer}
                selection={picked?.open ? picked.range : null}
                className={
                  fill
                    ? 'max-h-[min(70dvh,40rem)] @min-[880px]/review:max-h-none @min-[880px]/review:min-h-0 @min-[880px]/review:flex-1'
                    : 'max-h-[min(65vh,600px)] rounded fill-group'
                }
                {...(commentable
                  ? {
                      // A range across both sides quotes neither, so it is never taken.
                      onSelection: (next: SelectedLineRange) => {
                        if (reviewSelection(next, before ?? '', after ?? ''))
                          setPick((value) => ({
                            key: loadKey,
                            range: next,
                            open: value?.key === loadKey && value.open,
                          }));
                      },
                      onPick: (next: SelectedLineRange) => {
                        if (reviewSelection(next, before ?? '', after ?? ''))
                          setPick({ key: loadKey, range: next, open: true });
                      },
                    }
                  : {})}
              />
            </Suspense>
          ) : null}
        </>
      )}
    </div>
  );
}

export { Checks };

function Operations({ sessionId }: { sessionId: string }) {
  const t = useTranslations('Files');
  const format = useFormatter();
  const { workspaces, repository } = useServices();
  const [ops, setOps] = useState<FileOperationView[]>([]);
  const [requests, setRequests] = useState<Record<string, string>>({});
  useEffect(() => {
    let current = true;
    void workspaces?.fileOperations(sessionId).then(
      (items) => {
        if (current) setOps(uniqueFileOperations(items));
      },
      () => {
        if (current) setOps([]);
      },
    );
    void repository.getSession(sessionId).then(
      (session) => {
        if (current)
          setRequests(
            Object.fromEntries(
              session?.entries.flatMap((entry) =>
                entry.runId && entry.intent !== 'steer' ? [[entry.runId, entry.text]] : [],
              ) ?? [],
            ),
          );
      },
      () => {
        if (current) setRequests({});
      },
    );
    return () => {
      current = false;
    };
  }, [workspaces, repository, sessionId]);
  if (ops.length === 0) return null;
  return (
    <section
      aria-labelledby="ops-heading"
      className="flex flex-col gap-2 border-t border-border pt-3"
    >
      <h3 id="ops-heading" className="m-0 text-body" style={semibold}>
        {t('operations')}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-caption">
        {ops.slice(0, 50).map((op) => (
          <li
            key={op.id}
            className={op.state === 'uncertain' ? 'text-warning' : 'text-muted-foreground'}
          >
            {op.kind}{' '}
            <span className="font-mono">{op.to_path ? `${op.path} → ${op.to_path}` : op.path}</span>{' '}
            · {op.state}
            <p className="m-0 line-clamp-2 wrap-anywhere">
              <time dateTime={op.created_at}>
                {format.dateTime(new Date(op.created_at), {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                })}
              </time>
              {' · '}
              {requests[op.run_id] ?? op.run_id}
            </p>
            <details>
              <summary>{t('operationDetails')}</summary>
              <code className="break-all">
                {op.id} · {op.execution_id ?? op.run_id}
              </code>
            </details>
            {op.state === 'uncertain' ? <span className="block">{t('uncertain')}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const pendingReviewCommands = createPendingSessionCommands(
  typeof window !== 'undefined' && window.corralRemote ? window.localStorage : undefined,
  typeof window !== 'undefined' ? window.corralRemote?.hostId : undefined,
  'review',
);

/** At most this many files are read to compare sent comments with the current comparison. */
const MOVED_RANGE_FILES = 20;
type SideTexts = { before: string | null; after: string | null };

/**
 * Sent comments whose pinned quote no longer matches the same lines in the current comparison.
 * A comment sent on this exact comparison quotes these trees, so only earlier ones are read.
 */
function useMovedRanges(
  sessionId: string,
  current: ChangeSetView | null,
  comments: ReviewCommentView[],
) {
  const { workspaces } = useServices();
  const from = current?.from ?? null;
  const to = current?.to ?? null;
  const sent = comments.filter(
    (c) => c.state === 'submitted' && from && to && (c.from !== from || c.to !== to),
  );
  const paths = [...new Set(sent.map((c) => c.path))].sort().slice(0, MOVED_RANGE_FILES);
  const key = from && to && paths.length ? JSON.stringify([sessionId, from, to, paths]) : '';
  const [read, setRead] = useState<{ key: string; sides: Map<string, SideTexts> }>({
    key: '',
    sides: new Map(),
  });
  useEffect(() => {
    if (!key || !workspaces) return;
    let live = true;
    const [id, base, head, files] = JSON.parse(key) as [string, string, string, string[]];
    void Promise.all(
      files.map((path) =>
        workspaces.fileVersions(id, base, head, path).then(
          (versions) =>
            [path, { before: sideText(versions.before), after: sideText(versions.after) }] as const,
          () => null,
        ),
      ),
    ).then((entries) => {
      if (live) setRead({ key, sides: new Map(entries.filter((entry) => entry !== null)) });
    });
    return () => {
      live = false;
    };
  }, [key, workspaces]);
  const sides = read.key === key ? read.sides : null;
  return new Set(
    sent.flatMap((c) => {
      const text = sides?.get(c.path);
      return text && rangeChanged(c, text) === true ? [c.commentId] : [];
    }),
  );
}

/** Where a comment sits: its file and line range. */
function CommentPlace({ comment }: { comment: ReviewCommentView }) {
  return (
    <span className="font-mono text-muted-foreground">
      {comment.path}:{comment.startLine}
      {comment.endLine > comment.startLine ? `–${comment.endLine}` : ''}
    </span>
  );
}

/**
 * The review's comments: the form for a new one (`composer`), the drafts, sending them together
 * to the running execution or as a new run, and the comments already sent.
 */
export function CommentsPanel({
  session,
  runs,
  runsReady = true,
  comments,
  current,
  composer,
  stepBack = false,
  sendSlot,
  className,
  onChange,
}: {
  session: WorkSession;
  runs: RunSummary[];
  runsReady?: boolean;
  comments: ReviewCommentView[];
  current: ChangeSetView | null;
  /** The new-comment form's place, at the head of the list. */
  composer?: ReactNode;
  /** True while another step leads the review (a comment being written). */
  stepBack?: boolean;
  /** Where the send button shows (the pinned row); under the drafts without one. */
  sendSlot?: HTMLElement | null | undefined;
  className?: string;
  onChange: () => Promise<void>;
}) {
  const t = useTranslations('Review');
  const ts = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  const td = useTranslations('Docking');
  const widgets = useTranslations('Widgets');
  const navigation = useSettingsNavigation();
  const services = useServices();
  const { workspaces } = services;
  const profiles = useModelProfiles();
  const [teamMode] = useRemembered<'none' | 'auto'>(
    `corral:team-mode:${session.sessionId}`,
    'none',
  );
  const [pending, setPending] = useState(
    () => pendingReviewCommands.get(session.sessionId) ?? null,
  );
  const active = runs.find((r) => !TERMINAL_RUN_STATUSES.has(r.status)) ?? null;
  const activeRunId = active?.runId;
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const [target, setTarget] = useState('next');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTargets([]);
    if (!activeRunId) return;
    let live = true;
    let revision = 0;
    const reload = () => {
      const read = ++revision;
      void steerTargets(services, activeRunId).then(
        (targets) => live && read === revision && setTargets(targets),
        () => live && read === revision && setTargets([]),
      );
    };
    reload();
    const timer = setInterval(reload, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [services, activeRunId]);
  const drafts = comments.filter((c) => c.state === 'draft');
  const sentComments = comments.filter((c) => c.state !== 'draft');
  const earlier = sentComments.filter(
    (c) => !current || c.from !== current.from || c.to !== current.to,
  );
  const movedRanges = useMovedRanges(session.sessionId, current, comments);
  // Where the drafts can go: a new run, or a running execution while a run is active. With one
  // destination it is the one sending uses, and there is nothing to choose.
  const steering = Boolean(active) && !pending;
  const destinations = [
    ...(steering ? [] : [{ value: 'next', label: t('sendNext') }]),
    ...targets.map((x) => ({ value: x.id, label: t('sendSteer', { label: x.label }) })),
  ];
  const destination = !steering
    ? 'next'
    : destinations.length === 1
      ? (destinations[0]?.value ?? target)
      : target;
  const steerTo = targets.find((x) => x.id === destination);
  const choice = autoChoiceFor(session.auto, profiles);
  const mode = sessionRunMode(services.mode, services.live);
  const modelBlocked = !pending && !active && autoNotReady(choice, profiles, mode);
  const reasoningBlocked = !pending && !active && autoReasoningUnsupported(choice, profiles, mode);
  const startBlocked = modelBlocked || reasoningBlocked || (!pending && !runsReady);

  const send = async () => {
    if (!workspaces || busy || startBlocked || (!pending && drafts.length === 0)) return;
    setBusy(true);
    setNote(null);
    try {
      const ids = pending ? pending.key.split('\0') : drafts.map((c) => c.commentId);
      const text =
        pending?.autoRequest?.brief ?? (await workspaces.feedbackText(session.sessionId, ids));
      let runId: string | null = null;
      let executionId: string | null = null;
      let sent = false;
      let detail: string | null = null;
      let commandId: string | null = null;
      const next = Boolean(pending) || !active;
      if (next) {
        const command = pending ?? { key: ids.join('\0'), commandId: newCommandId() };
        // A lost answer keeps the original model, team, conversation and comment batch.
        command.autoRequest ??= structuredClone(
          conversationRequest(services, session, {
            commandId: command.commandId,
            brief: text,
            choice,
            team: teamMode,
            throughRunId: runs.find((run) => TERMINAL_RUN_STATUSES.has(run.status))?.runId,
          }),
        );
        pendingReviewCommands.set(session.sessionId, command);
        setPending(command);
        commandId = command.commandId;
        const result = await services.startAuto(command.autoRequest);
        runId = result.runId;
        detail = result.receipt.error?.message ?? null;
        sent = runId !== null;
      } else if (active && steerTo) {
        ({ sent, detail, commandId } = await steer(services, active.runId, steerTo.id, text));
        runId = active.runId;
        executionId = steerTo.id;
      } else {
        detail = 'choose an execution';
      }
      await workspaces.recordFeedback(session.sessionId, {
        commentIds: ids,
        intent: next ? 'next' : 'steer',
        runId,
        executionId,
        text,
        sent,
        detail,
      });
      const recorded = await services.repository.addSessionEntry(session.sessionId, {
        intent: next ? 'next' : 'steer',
        text,
        state: sent ? (next ? 'started' : 'sent') : 'refused',
        runId,
        executionId,
        detail,
        commandId,
      });
      if (!recorded.ok) throw new Error(recorded.message);
      if (pendingReviewCommands.get(session.sessionId)?.commandId === commandId) {
        pendingReviewCommands.delete(session.sessionId);
        setPending(null);
      }
      setNote(sent ? t('sent') : detail);
      await onChange();
    } catch (failure) {
      setNote(
        pendingReviewCommands.get(session.sessionId)
          ? t('sendUnconfirmed')
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
    } finally {
      setBusy(false);
    }
  };

  const sendButton = (
    <Button
      variant={stepBack ? 'tertiary' : 'primary'}
      size="compact"
      type="button"
      disabled={busy || startBlocked || (!pending && Boolean(active) && !steerTo)}
      onClick={() => void send()}
      className={sendSlot === undefined ? 'self-start' : undefined}
    >
      {t(pending ? 'retrySend' : 'sendReview')}
    </Button>
  );

  return (
    <section aria-labelledby="comments-heading" className={cn('flex flex-col gap-2', className)}>
      <h3 id="comments-heading" className="m-0 flex items-center gap-2 text-body" style={semibold}>
        {t('commentsHeading')}
        {drafts.length > 0 ? (
          <span className="text-muted-foreground tabular-nums">{drafts.length}</span>
        ) : null}
      </h3>
      {composer}
      {drafts.length > 0 || pending ? (
        <>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-caption">
            {drafts.map((c) => (
              <li
                key={c.commentId}
                className="flex items-start gap-1 fill-group py-1.5 pr-1 pl-2.5"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5 wrap-anywhere">
                  <CommentPlace comment={c} />
                  <CommentBody body={c.body} />
                </span>
                <Tooltip content={t('deleteDraft')}>
                  <Button
                    variant="ghost"
                    size="icon-compact"
                    aria-label={t('deleteDraft')}
                    disabled={busy || Boolean(pending)}
                    onClick={() =>
                      void workspaces
                        ?.setCommentState(session.sessionId, c.commentId, 'deleted')
                        .then(onChange)
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
          {/* A choice only when there is one to make; it takes the column's width so its
              longest option reads in full, and the send button follows it. */}
          {destinations.length > 1 ? (
            <Select
              label={t('sendTo')}
              size="xs"
              value={destination}
              disabled={busy || Boolean(pending) || !runsReady}
              onValueChange={setTarget}
              options={destinations}
            />
          ) : null}
          {sendSlot === undefined
            ? sendButton
            : sendSlot
              ? createPortal(sendButton, sendSlot)
              : null}
        </>
      ) : null}
      {!runsReady && !pending && drafts.length > 0 ? (
        <p role="status" className="m-0 text-caption text-muted-foreground">
          {widgets('runLoading')}
        </p>
      ) : null}
      {(modelBlocked || reasoningBlocked) && drafts.length > 0 ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-caption">
          <span>
            {modelBlocked
              ? profiles === null
                ? t('modelsUnavailable')
                : ts('autoNotReady', {
                    model:
                      profiles.find((profile) => profile.profileId === choice.modelProfile)
                        ?.label ?? choice.modelProfile,
                  })
              : tc('reasoningUnsupportedHint')}
          </span>
          <Button
            size="compact"
            variant="tertiary"
            render={
              modelBlocked ? (
                <Link {...navigation.link('models')} />
              ) : (
                <Link to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} />
              )
            }
          >
            {modelBlocked ? tc('models.connect') : td('chat')}
          </Button>
        </div>
      ) : null}
      {note ? (
        <p role="status" className="m-0 text-caption">
          {note}
        </p>
      ) : null}
      {sentComments.length > 0 ? (
        <details open={earlier.length > 0} className="text-caption">
          <summary className="cursor-pointer text-muted-foreground">{t('earlier')}</summary>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
            {sentComments.map((c) => (
              <li key={c.commentId} className="flex flex-col gap-1 fill-group px-2.5 py-2">
                <span className="wrap-anywhere">
                  <CommentPlace comment={c} /> · {t(`commentState.${c.state}`)}
                  {movedRanges.has(c.commentId) ? (
                    <span className="text-warning"> · {t('rangeChanged')}</span>
                  ) : null}
                </span>
                <blockquote className="m-0 border-l-2 border-border pl-2 font-mono text-muted-foreground wrap-anywhere">
                  {c.quote}
                </blockquote>
                <p className="m-0 wrap-anywhere">
                  <CommentBody body={c.body} />
                </p>
                {c.state === 'submitted' ? (
                  <div className="-ml-1.5 flex gap-1">
                    {(['addressed', 'obsolete'] as const).map((state) => (
                      <Button
                        key={state}
                        variant="ghost"
                        size="compact"
                        onClick={() =>
                          void workspaces
                            ?.setCommentState(session.sessionId, c.commentId, state)
                            .then(onChange)
                        }
                      >
                        {state === 'addressed' ? t('markAddressed') : t('markObsolete')}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * Approve or ask for changes to exactly these two trees; applying follows an approval. A decision
 * made on another comparison, even one ending in the same tree, is shown as earlier. The decision
 * itself (its state and the two actions) holds the top of the decision area; applying and its
 * results follow it.
 */
export function DecisionPanel({
  sessionId,
  from,
  to,
  changed,
  linked,
  active,
  primary = true,
  barSlot,
  detailsClassName,
}: {
  sessionId: string;
  from: string;
  to: string;
  changed: number;
  linked: boolean;
  active: boolean;
  /** False while another step leads the review (a comment being written, or drafts to send). */
  primary?: boolean;
  /** Where the decision shows (the pinned row); at the top of the area without one. */
  barSlot?: HTMLElement | null | undefined;
  detailsClassName?: string;
}) {
  const t = useTranslations('Review');
  const { workspaces } = useServices();
  const [decisions, setDecisions] = useState<ReviewDecisionView[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationResultView[]>([]);
  const [plan, setPlan] = useState<IntegrationPlanFile[] | null>(null);
  const [revertTarget, setRevertTarget] = useState<{
    sessionId: string;
    integration: IntegrationResultView;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const reload = useCallback(async () => {
    if (!workspaces) return;
    setDecisions(await workspaces.decisions(sessionId).catch(() => []));
    setIntegrations(await workspaces.integrations(sessionId).catch(() => []));
  }, [workspaces, sessionId]);
  useEffect(() => {
    void changed;
    void to;
    void reload();
  }, [reload, changed, to]);
  const latest = decisions[0] ?? null;
  const earlier = latest !== null && (latest.stale || latest.from !== from || latest.to !== to);
  // Applying writes the approved tree; an approval from another starting point is not applied.
  const approved = latest && latest.decision === 'approved' && latest.from === from ? latest : null;
  const settled = Boolean(approved && !earlier);
  const decide = async (decision: 'approved' | 'changes_requested') => {
    await workspaces?.decide(sessionId, { from, to, decision, note: '' });
    setPlan(null);
    await reload();
  };
  const applying = plan?.filter((f) => f.outcome === 'apply').length ?? 0;
  const pinned = barSlot !== undefined;

  // The decision: its state once made, and the actions. Once this comparison is approved the
  // state says so, and approving again is not offered.
  const bar = (
    <section
      aria-labelledby="decision-heading"
      className={
        pinned
          ? 'flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2'
          : // Holds the top of the decision area while the rest scrolls under it.
            'sticky top-0 z-10 -mt-3 flex flex-col gap-2 border-b border-border bg-background pt-3 pb-3'
      }
    >
      <div className="flex min-w-0 items-center gap-1">
        <h3 id="decision-heading" className="m-0 text-body" style={semibold}>
          {t('decisionHeading')}
        </h3>
        <Tooltip content={t('decisionScope')}>
          <Button variant="ghost" size="icon-compact" aria-label={t('decisionScope')}>
            <Info aria-hidden />
          </Button>
        </Tooltip>
        {latest ? (
          <p className={cn('m-0 text-caption', !pinned && 'ml-auto')} data-testid="decision">
            {t(`decisionState.${latest.decision}`)}
            {earlier ? <span className="text-warning"> · {t('staleDecision')}</span> : null}
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="m-0 text-caption text-destructive">
          {error}
        </p>
      ) : null}
      <div className={cn('flex flex-wrap gap-2', pinned && 'ml-auto')}>
        {settled ? null : (
          <Button
            variant={primary ? 'primary' : 'tertiary'}
            size="compact"
            type="button"
            disabled={busy}
            onClick={() => void act(() => decide('approved'))}
          >
            {t('approve')}
          </Button>
        )}
        <Button
          variant="tertiary"
          size="compact"
          disabled={busy}
          onClick={() => void act(() => decide('changes_requested'))}
        >
          {t('requestChanges')}
        </Button>
      </div>
    </section>
  );

  return (
    <>
      {pinned ? (barSlot ? createPortal(bar, barSlot) : null) : bar}
      <div className={cn('flex min-w-0 flex-col gap-2 empty:hidden', detailsClassName)}>
        {approved && linked ? (
          <div className="flex flex-col gap-2 fill-group p-3 text-caption">
            <div className="flex items-center gap-1">
              <h4 className="m-0" style={semibold}>
                {t('integrateHeading')}
              </h4>
              <Tooltip content={t('integrateNote')}>
                <Button variant="ghost" size="icon-compact" aria-label={t('integrateNote')}>
                  <Info aria-hidden />
                </Button>
              </Tooltip>
            </div>
            <Button
              variant={plan ? 'tertiary' : 'secondary'}
              size="compact"
              onClick={() =>
                void act(async () => {
                  if (workspaces)
                    setPlan(await workspaces.integrationPlan(sessionId, approved.decisionId));
                })
              }
              className="self-start"
            >
              {t('plan')}
            </Button>
            {plan ? (
              <>
                <ul
                  data-testid="integration-plan"
                  className="m-0 flex list-none flex-col gap-0.5 p-0"
                >
                  {plan.map((f) => (
                    <li
                      key={f.path}
                      className={cn(
                        'flex min-w-0 gap-1',
                        f.outcome === 'conflict' && 'text-warning',
                      )}
                    >
                      <FilePath path={f.path} />
                      <span className="shrink-0">{` · ${t(`planOutcome.${f.outcome}`)}`}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="primary"
                  size="compact"
                  type="button"
                  disabled={busy || active || applying === 0}
                  onClick={() => {
                    void act(async () => {
                      await workspaces?.integrate(sessionId, approved.decisionId);
                      setPlan(null);
                      await reload();
                    });
                  }}
                  className="self-start"
                >
                  {t('apply', { count: applying })}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {integrations.map((integration) => (
          <div
            key={integration.integrationId}
            data-testid="integration"
            className="flex flex-col gap-1.5 fill-group p-3 text-caption"
          >
            <span style={semibold}>
              {t(`integrationState.${integrationDisplayState(integration)}`)}
            </span>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {integration.files.map((f) => (
                <li key={f.path} className="flex min-w-0 gap-1">
                  <FilePath path={f.path} />
                  <span className="shrink-0">{` · ${t(`fileOutcome.${f.outcome}`)}`}</span>
                </li>
              ))}
            </ul>
            {integration.files.some((f) => f.outcome === 'applied') ? (
              <Tooltip content={t('revertNote')}>
                <Button
                  variant="tertiary"
                  size="compact"
                  disabled={busy || active}
                  onClick={() => setRevertTarget({ sessionId, integration })}
                  className="self-start"
                >
                  {t('revert')}
                </Button>
              </Tooltip>
            ) : null}
          </div>
        ))}
      </div>
      <Dialog
        open={revertTarget?.sessionId === sessionId}
        onOpenChange={(open) => {
          if (!open) setRevertTarget(null);
        }}
      >
        <DialogPopup showCloseButton={false} bottomStickOnMobile={false}>
          <DialogTitle>{t('confirmRevert')}</DialogTitle>
          <DialogDescription>{t('confirmRevertNote')}</DialogDescription>
          <ul className="my-3 max-h-48 list-none overflow-y-auto p-0 font-mono text-caption">
            {revertTarget?.integration.files
              .filter((file) => file.outcome === 'applied')
              .map((file) => (
                <li key={file.path}>{file.path}</li>
              ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setRevertTarget(null)}>
              {t('cancelRevert')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || active}
              onClick={() => {
                if (!revertTarget || revertTarget.sessionId !== sessionId || busy || active) return;
                const integrationId = revertTarget.integration.integrationId;
                void act(async () => {
                  await workspaces?.revert(sessionId, integrationId);
                  setRevertTarget(null);
                  await reload();
                });
              }}
            >
              {t('confirmRevert')}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** A path on one line that keeps its file name: a long one is cut at the start. */
function FilePath({ path }: { path: string }) {
  return (
    <span dir="rtl" title={path} className="min-w-0 truncate text-left font-mono">
      <bdi>{path}</bdi>
    </span>
  );
}

// ── file list helpers ───────────────────────────────────────

/** Lock files and build output: folded by default, but deletions stay in view. */
const GENERATED =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|(^|\/)(dist|build|generated|__generated__)\/|\.min\.(js|css)$/;
const foldedFile = (file: FileChangeView) => GENERATED.test(file.path) && file.status !== 'deleted';

/** Git's one-letter status for what is not a plain modification. */
const STATUS_MARKS: Partial<Record<FileChangeView['status'], { letter: string; tone: string }>> = {
  added: { letter: 'A', tone: 'text-success' },
  deleted: { letter: 'D', tone: 'text-destructive' },
  type_changed: { letter: 'T', tone: 'text-muted-foreground' },
};

/**
 * The files of the range, one line each: its review or read mark, name and folder, what changed
 * and, when it was not Corral's own write, an "External" badge. The head carries the count;
 * below the three-column width it also folds the list away once a file is chosen. Moving
 * between files is the list itself, or Shift+] and Shift+[ from anywhere in the review.
 */
function FileList({
  changes,
  selected,
  reviewed,
  onChoose,
  sinceRead = false,
}: {
  changes: ChangeSetView | null;
  selected: string | null;
  reviewed: ReviewMarks;
  onChoose: (path: string) => void;
  /** The range lists only what changed since the copy was marked read. */
  sinceRead?: boolean;
}) {
  const t = useTranslations('Files');
  const listId = useId();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | FileChangeView['status']>('all');
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  // Below the three-column width the list folds into its head once a file is being read; a
  // fold or unfold made by hand holds for that file.
  const [fold, setFold] = useState<{ file: string | null; collapsed: boolean } | null>(null);
  const files = changes && !changes.unavailable ? changes.files : [];
  const collapsed = fold && fold.file === selected ? fold.collapsed : selected !== null;
  const needle = query.trim().toLowerCase();
  const matches = files.filter(
    (f) =>
      (!needle || f.path.toLowerCase().includes(needle)) &&
      (kind === 'all' || f.status === kind) &&
      (!unreviewedOnly || !reviewed.changeReviewed(f)),
  );
  const generated = matches.filter(foldedFile);
  const main = matches.filter((f) => !generated.includes(f));
  const count = changes
    ? sinceRead
      ? t('newChanges', { count: files.length })
      : t('files', { count: files.length })
    : t('reviewHeading');
  const row = (file: FileChangeView) => {
    const cut = file.path.lastIndexOf('/') + 1;
    const isReviewed = reviewed.changeReviewed(file);
    const isRead = !isReviewed && reviewed.contentRead(file);
    const status = STATUS_MARKS[file.status];
    const counts =
      file.additions !== null ? `+${file.additions} −${file.deletions ?? 0}` : undefined;
    return (
      <li key={file.path}>
        <Button
          variant={selected === file.path ? 'secondary' : 'ghost'}
          size="sm-multiline"
          aria-current={selected === file.path ? 'true' : undefined}
          data-review-file={file.path}
          title={file.path}
          onClick={() => onChoose(file.path)}
          className="w-full justify-start px-2 py-1 text-left"
        >
          <span
            aria-hidden
            className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-0.5"
          >
            <span
              className="grid size-3.5 shrink-0 place-items-center"
              title={isReviewed ? t('reviewedFile') : isRead ? t('readElsewhere') : undefined}
            >
              {isReviewed ? (
                <Check className="text-success" />
              ) : isRead ? (
                <Eye className="text-muted-foreground" />
              ) : null}
            </span>
            <span className="min-w-0 truncate font-mono">
              {file.path.slice(cut)}
              {cut > 0 ? (
                <span className="text-muted-foreground"> {file.path.slice(0, cut - 1)}</span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
              {status ? (
                <span className={status.tone} title={t(`status.${file.status}`)}>
                  {status.letter}
                </span>
              ) : null}
              {file.binary ? <span className="text-muted-foreground">bin</span> : null}
              {file.additions !== null ? (
                <>
                  {file.additions > 0 || !file.deletions ? (
                    <span className="text-success">+{file.additions}</span>
                  ) : null}
                  {file.deletions ? (
                    <span className="text-destructive">−{file.deletions}</span>
                  ) : null}
                </>
              ) : null}
            </span>
            {/* Corral's own writes are the usual case and carry nothing; anything written
                elsewhere says so under the name, so the name keeps the row's width, and
                names where on hover. */}
            {file.provenance !== 'managed_agent' ? (
              <span className="col-start-2 flex">
                <Badge size="sm" variant="secondary" title={t(`provenance.${file.provenance}`)}>
                  {t('externalBadge')}
                </Badge>
              </span>
            ) : null}
          </span>
          {/* Last, so the kit's label rule for a trailing span leaves the row layout alone. */}
          <span className="sr-only">
            {[
              file.path,
              t(`status.${file.status}`),
              counts,
              file.binary ? 'bin' : undefined,
              t(`provenance.${file.provenance}`),
              isReviewed ? t('reviewedFile') : isRead ? t('readElsewhere') : undefined,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </Button>
      </li>
    );
  };
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-0.5 pr-2 pl-3">
        <h3
          className="m-0 hidden text-caption text-muted-foreground @min-[880px]/review:block"
          style={semibold}
        >
          {count}
        </h3>
        <Button
          variant="ghost"
          size="compact"
          aria-expanded={!collapsed}
          aria-controls={listId}
          disabled={files.length === 0}
          onClick={() => setFold({ file: selected, collapsed: !collapsed })}
          className="-ml-2 @min-[880px]/review:hidden"
        >
          {count}
          <ChevronDown
            aria-hidden
            className={cn(
              'transition-transform motion-reduce:transition-none',
              !collapsed && 'rotate-180',
            )}
          />
        </Button>
        {files.length > 0 ? (
          <Tooltip content={t('ignoredNote')}>
            <Button variant="ghost" size="icon-compact" aria-label={t('ignoredNote')}>
              <Info aria-hidden />
            </Button>
          </Tooltip>
        ) : null}
      </div>
      <div
        id={listId}
        className={cn(
          'max-h-64 min-h-0 flex-col gap-2 overflow-auto px-2 pb-2',
          files.length === 0 || collapsed ? 'hidden' : 'flex',
          files.length > 0 && '@min-[880px]/review:flex',
          '@min-[880px]/review:max-h-none @min-[880px]/review:flex-1',
        )}
      >
        <div className="flex items-center gap-1">
          <Input
            type="search"
            size="compact"
            aria-label={t('filterSearch')}
            placeholder={t('filterSearch')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Menu>
            <Tooltip content={t('filterFiles')}>
              <MenuTrigger
                render={
                  <Button
                    variant={kind !== 'all' || unreviewedOnly ? 'secondary' : 'ghost'}
                    size="icon-compact"
                    aria-label={t('filterFiles')}
                  />
                }
              >
                <ListFilter aria-hidden />
              </MenuTrigger>
            </Tooltip>
            <MenuPopup align="end" className="min-w-44">
              <MenuRadioGroup value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
                <MenuRadioItem value="all" closeOnClick>
                  {t('kindAll')}
                </MenuRadioItem>
                {(['added', 'modified', 'deleted', 'type_changed'] as const).map((value) => (
                  <MenuRadioItem key={value} value={value} closeOnClick>
                    {t(`status.${value}`)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuCheckboxItem
                checked={unreviewedOnly}
                onCheckedChange={(checked) => setUnreviewedOnly(checked)}
              >
                {t('unreviewedOnly')}
              </MenuCheckboxItem>
            </MenuPopup>
          </Menu>
        </div>
        {matches.length === 0 ? (
          <p className="m-0 px-2 py-1 text-caption text-muted-foreground">{t('noMatches')}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{main.map(row)}</ul>
        {generated.length > 0 ? (
          <details className="text-caption">
            <summary className="cursor-pointer text-muted-foreground">
              {t('generatedGroup', { count: generated.length })}
            </summary>
            <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">{generated.map(row)}</ul>
          </details>
        ) : null}
      </div>
    </>
  );
}
