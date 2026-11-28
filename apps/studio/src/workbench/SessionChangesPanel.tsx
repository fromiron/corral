import type { PaddockSetup, ParentMerge } from '@corral/client';
import type { PullRequestView, TextAttachment } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import {
  Badge,
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
  Tooltip,
} from '@corral/react/design-kit';
import { Ellipsis, GitBranch } from '@corral/react/icons';
import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Checks, ReviewContent } from '../pages/changes/ReviewPage.tsx';
import { useBinding, WorkingCopyPanel } from '../pages/FilesViews.tsx';
import { useServices } from '../services.tsx';
import { CheckpointPanel } from './CheckpointPanel.tsx';
import type { AttachmentCapture } from './context/bridge.ts';
import { GitPanel } from './GitPanel.tsx';
import { PaddockSetupStatus, setupWord } from './PaddockSetupStatus.tsx';
import { PullRequestRow } from './PullRequestRow.tsx';
import type { ReviewSearch } from './panels/routes.ts';
import { readWorkspaceAgain, WORKSPACE_CHANGED } from './workspaceEvents.ts';

/** The Changes tab's sub-views. Review and Checks have addresses; Git and Checkpoints do not. */
export type ChangesView = 'review' | 'git' | 'checkpoints' | 'checks';

interface CopyState {
  /** `unknown` until the first read; `none` when the session has no working copy. */
  state: 'unknown' | 'none' | 'ready' | 'failed';
  failure?: string;
  /** The copy's current branch; null while unknown, detached or without a copy. */
  branch: string | null;
  merge: ParentMerge | null;
  pr: PullRequestView | null;
  setup: PaddockSetup | null;
}

/** Whether the session has a working copy, the branch it is on, and its merge into a parent. */
function useCopy(
  sessionId: string,
  parentSessionId: string | null,
  copyChanged: string | undefined,
  visible: boolean,
): CopyState & { reread: (remote?: boolean) => void } {
  const { workspaces } = useServices();
  const [read, setRead] = useState<({ sessionId: string } & CopyState) | null>(null);
  const [tick, setTick] = useState(0);
  const [remoteTick, setRemoteTick] = useState(0);
  const remoteSeen = useRef<string | null>(null);
  const settingUp = useRef(false);
  useEffect(() => {
    const changed = () => setTick((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    const poll = window.setInterval(() => {
      if (settingUp.current) changed();
    }, 2000);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED, changed);
      window.clearInterval(poll);
    };
  }, []);
  useEffect(() => {
    void tick;
    if (!workspaces || !visible) {
      remoteSeen.current = null;
      return;
    }
    const remoteKey = `${sessionId}|${copyChanged}|${remoteTick}`;
    const remote = remoteSeen.current !== remoteKey;
    remoteSeen.current = remoteKey;
    let live = true;
    let answered = false;
    void (async (): Promise<CopyState> => {
      let copy: Awaited<ReturnType<typeof workspaces.worktree>>;
      try {
        copy = await workspaces.worktree(sessionId);
      } catch (cause) {
        return {
          state: 'failed',
          failure: cause instanceof Error ? cause.message : String(cause),
          branch: null,
          merge: null,
          pr: null,
          setup: null,
        };
      }
      if (!copy || copy.missing)
        return { state: 'none', branch: null, merge: null, pr: null, setup: null };
      const [status, merge, pr] = await Promise.all([
        workspaces.gitStatus({ kind: 'session', id: sessionId }).catch(() => null),
        parentSessionId ? workspaces.parentMerge(sessionId).catch(() => null) : null,
        (async () => workspaces.pullRequest(sessionId, remote))().catch(
          (): PullRequestView => ({ kind: 'read_failed' }),
        ),
      ]);
      return {
        state: 'ready',
        branch:
          status?.target.kind === 'session' && status.target.copyGeneration === copy.copyGeneration
            ? status.head.branch
            : null,
        merge,
        pr,
        setup: copy.setup,
      };
    })().then((copy) => {
      if (!live) return;
      answered = true;
      settingUp.current = copy.setup?.state === 'running';
      setRead({ sessionId, ...copy });
    });
    return () => {
      live = false;
      if (remote && !answered) remoteSeen.current = null;
    };
  }, [workspaces, sessionId, parentSessionId, tick, remoteTick, copyChanged, visible]);
  // Without a workspace service there is nothing to prepare; the sub-views say so themselves.
  const reread = (remote = false) =>
    remote ? setRemoteTick((value) => value + 1) : setTick((value) => value + 1);
  if (!workspaces)
    return { state: 'ready', branch: null, merge: null, pr: null, setup: null, reread };
  return read?.sessionId === sessionId
    ? {
        state: read.state,
        ...(read.failure === undefined ? {} : { failure: read.failure }),
        branch: read.branch,
        merge: read.merge,
        pr: read.pr,
        setup: read.setup,
        reread,
      }
    : { state: 'unknown', branch: null, merge: null, pr: null, setup: null, reread };
}

function ChecksView({
  session,
  onAttach,
  copy,
}: {
  session: WorkSession;
  onAttach?: ((attachment: TextAttachment, capture: AttachmentCapture) => void) | undefined;
  copy: CopyState['state'];
}) {
  const { binding, failed } = useBinding(session.projectId);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const changed = () => setVersion((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  return (
    <Checks
      sessionId={session.sessionId}
      projectId={session.projectId}
      binding={binding}
      folderFailed={failed}
      readFailureSaid={copy === 'failed' || (copy === 'none' && Boolean(failed))}
      changed={version}
      titled={false}
      {...(onAttach ? { onAttach } : {})}
    />
  );
}

/**
 * The Changes tab. One header row: the sub-views, the review's compare range, the copy's branch
 * and a menu with the PR review preview and "mark all read". It opens on Review (files, changes
 * and the decision area); Git, Checkpoints and Checks are the other sub-views. Each stays
 * mounted once opened, so moving between them keeps drafts, selections and reads. A session
 * without a working copy shows the copy's setup once, above whichever sub-view is open.
 */
export function SessionChangesPanel({
  session,
  reviewSearch,
  requestedView,
  onReviewChange,
  onViewChange,
  onSessionChange,
  onAttach,
  visible = true,
  copyChanged,
  mergeBranch,
}: {
  session: WorkSession;
  mergeBranch?: string | undefined;
  /** False while the host keeps the tab mounted behind another one. */
  visible?: boolean;
  /** Changes whenever a run of the session starts or ends, which may change the copy. */
  copyChanged?: string | undefined;
  /** The review's address; present while the address names the Review sub-view. */
  reviewSearch?: ReviewSearch | undefined;
  /** A sub-view the address names other than Review (Checks). */
  requestedView?: ChangesView | undefined;
  onReviewChange(search: ReviewSearch | undefined): void;
  /** Moves the address to another sub-view; without it, leaving Review clears the review. */
  onViewChange?: ((view: Exclude<ChangesView, 'review'>) => void) | undefined;
  onSessionChange?: () => void | Promise<void>;
  /** Puts a captured text (check output, fix request) into the session composer. */
  onAttach?: ((attachment: TextAttachment, capture: AttachmentCapture) => void) | undefined;
}) {
  const tr = useTranslations('Review');
  const tg = useTranslations('Git');
  const tp = useTranslations('Checkpoints');
  const tk = useTranslations('Checks');
  const tf = useTranslations('Files');
  const { workspaces } = useServices();
  const href = useRouterState({ select: (state) => state.location.href });
  const copy = useCopy(session.sessionId, session.parentSessionId ?? null, copyChanged, visible);
  const reviewing = reviewSearch !== undefined;
  const [remembered, setRemembered] = useState<ReviewSearch | undefined>(reviewSearch);
  if (reviewSearch && reviewSearch !== remembered) setRemembered(reviewSearch);
  const search = reviewSearch ?? remembered ?? {};
  // The address picks Review, Git or Checks. Without one the view opens on Review, and leaving
  // the sub-view the address picked returns there, while a sub-view chosen here in the meantime
  // stays.
  const entry: ChangesView | null = reviewing
    ? 'review'
    : requestedView === 'checks' || requestedView === 'git'
      ? requestedView
      : null;
  const [view, setView] = useState<ChangesView>(entry ?? 'review');
  const [seen, setSeen] = useState(entry);
  let shown = view;
  if (entry !== seen) {
    shown = entry ?? (view === seen ? 'review' : view);
    setSeen(entry);
    setView(shown);
  }
  const [visited, setVisited] = useState<ReadonlySet<ChangesView>>(() => new Set([shown]));
  if (!visited.has(shown)) setVisited(new Set([...visited, shown]));
  const [rangeSlot, setRangeSlot] = useState<HTMLDivElement | null>(null);
  const choose = (next: ChangesView) => {
    setView(next);
    if (next === 'review') onReviewChange(search);
    else if (onViewChange) onViewChange(next);
    else if (reviewing) onReviewChange(undefined);
  };
  const ready = copy.state === 'ready';
  const missing = copy.state === 'none';
  const failed = copy.state === 'failed';
  return (
    <Tabs
      value={shown}
      onValueChange={(value) => choose(value as ChangesView)}
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2">
        <TabsList aria-label={tr('changesViews')}>
          <TabItem value="review" label={tr('tabReview')} />
          <TabItem value="git" label={tg('title')} />
          <TabItem value="checkpoints" label={tp('tab')} />
          <TabItem value="checks" label={tk('title')} />
        </TabsList>
        <div
          ref={setRangeSlot}
          hidden={shown !== 'review' || !ready}
          className="flex min-w-0 items-center"
        />
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {copy.branch ? (
            <span
              className="inline-flex min-w-0 items-center gap-1 text-caption text-muted-foreground"
              title={tf('branch', { branch: copy.branch })}
            >
              <GitBranch size={12} aria-hidden className="shrink-0" />
              <span className="sr-only">{tf('branch', { branch: copy.branch })}</span>
              <span aria-hidden className="truncate font-mono">
                {copy.branch}
              </span>
            </span>
          ) : null}
          {copy.merge?.branch && copy.merge.parentPaddock && copy.merge.commits ? (
            <Button
              variant="secondary"
              render={
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: copy.merge.parentSessionId }}
                  search={{ panel: 'git', merge: copy.merge.branch }}
                />
              }
            >
              {tg('mergeIntoParent')}
            </Button>
          ) : null}
          <Menu>
            <Tooltip content={tr('more')}>
              <MenuTrigger render={<Button variant="ghost" size="icon" aria-label={tr('more')} />}>
                <Ellipsis aria-hidden />
              </MenuTrigger>
            </Tooltip>
            <MenuPopup align="end" className="min-w-56">
              <MenuItem
                label={tr('prPreview')}
                render={
                  <Link
                    to="/preview/$feature"
                    params={{ feature: 'pr-review' }}
                    search={{ returnTo: href }}
                  />
                }
              >
                <span className="flex w-full items-center justify-between gap-3">
                  {tr('prPreview')}
                  <Badge size="sm" variant="secondary">
                    {tr('previewBadge')}
                  </Badge>
                </span>
              </MenuItem>
              {/* The baseline always covers the whole current copy (#78 IA-07); the item names
                  it, and the longer note is its tooltip. */}
              <MenuItem
                disabled={!ready || !workspaces}
                title={tf('reviewedNote')}
                onClick={() =>
                  void workspaces
                    ?.markReviewed(session.sessionId)
                    .then(() => window.dispatchEvent(new Event(WORKSPACE_CHANGED)))
                }
              >
                {tf('markReviewed')}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {setupWord(copy.setup) ? (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <PaddockSetupStatus
            sessionId={session.sessionId}
            setup={copy.setup}
            onChanged={() => copy.reread()}
          />
        </div>
      ) : null}
      <PullRequestRow
        sessionId={session.sessionId}
        view={copy.pr}
        onSync={() => choose('git')}
        onChanged={() => copy.reread(true)}
      />
      {failed ? (
        <div className="flex shrink-0 flex-col items-start gap-2 p-3">
          <p role="alert" className="m-0 text-body text-destructive">
            {tf('copyReadFailed', { message: copy.failure ?? '' })}
          </p>
          <Button variant="tertiary" onClick={readWorkspaceAgain}>
            {tf('retry')}
          </Button>
        </div>
      ) : null}
      {missing ? (
        // The copy's setup: the shared empty view, laid out as the sub-views lay out theirs.
        <div className="shrink-0 p-3">
          <WorkingCopyPanel sessionId={session.sessionId} projectId={session.projectId} />
        </div>
      ) : null}
      <TabPanel value="review" keepMounted className="min-h-0 flex-1">
        {visited.has('review') && ready ? (
          <ReviewContent
            session={session}
            search={search}
            onSearch={(patch) => onReviewChange({ ...search, ...patch })}
            rangeSlot={rangeSlot}
            onPrepareCopy={() => choose('git')}
            onSessionChange={onSessionChange}
            shown={visible && shown === 'review'}
            copyChanged={copyChanged}
            onAttach={onAttach}
          />
        ) : null}
      </TabPanel>
      <TabPanel value="git" keepMounted className="min-h-0 flex-1 overflow-auto">
        {visited.has('git') ? (
          <div className="flex flex-col gap-4 p-3">
            {missing || failed ? null : (
              <WorkingCopyPanel sessionId={session.sessionId} projectId={session.projectId} />
            )}
            <GitPanel
              sessionId={session.sessionId}
              projectId={session.projectId}
              onRefresh={() => copy.reread(true)}
              {...(mergeBranch ? { mergeBranch } : {})}
            />
          </div>
        ) : null}
      </TabPanel>
      <TabPanel value="checkpoints" keepMounted className="min-h-0 flex-1 overflow-auto p-3">
        {visited.has('checkpoints') && !missing ? (
          <CheckpointPanel key={session.sessionId} sessionId={session.sessionId} />
        ) : null}
      </TabPanel>
      <TabPanel value="checks" keepMounted className="min-h-0 flex-1 overflow-auto p-3">
        {visited.has('checks') ? (
          <ChecksView session={session} onAttach={onAttach} copy={copy.state} />
        ) : null}
      </TabPanel>
    </Tabs>
  );
}
