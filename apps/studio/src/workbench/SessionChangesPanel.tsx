import type { TextAttachment } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { Button, TabItem, TabPanel, Tabs, TabsList } from '@corral/react/design-kit';
import { GitBranch } from '@corral/react/icons';
import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useBinding, WorkingCopyPanel } from '../pages/FilesViews.tsx';
import { Checks, ReviewContent } from '../pages/ReviewPage.tsx';
import { useServices } from '../services.tsx';
import { CheckpointPanel } from './CheckpointPanel.tsx';
import type { AttachmentCapture } from './context/bridge.ts';
import { GitPanel } from './GitPanel.tsx';
import type { ReviewSearch } from './panels/routes.ts';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

/** The Changes tab's sub-views. Review and Checks have addresses; Git and Checkpoints do not. */
export type ChangesView = 'review' | 'git' | 'checkpoints' | 'checks';

/** The session copy's current branch, or null while unknown, detached or without a copy. */
function useCopyBranch(sessionId: string) {
  const { workspaces } = useServices();
  const [read, setRead] = useState<{ sessionId: string; branch: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const changed = () => setTick((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  useEffect(() => {
    void tick;
    if (!workspaces) return;
    let live = true;
    void (async () => {
      const copy = await workspaces.worktree(sessionId);
      if (!copy || copy.missing) return null;
      const status = await workspaces.gitStatus({ kind: 'session', id: sessionId });
      return status.target.kind === 'session' &&
        status.target.copyGeneration === copy.copyGeneration
        ? status.head.branch
        : null;
    })().then(
      (branch) => live && setRead({ sessionId, branch }),
      () => live && setRead({ sessionId, branch: null }),
    );
    return () => {
      live = false;
    };
  }, [workspaces, sessionId, tick]);
  return read?.sessionId === sessionId ? read.branch : null;
}

function ChecksView({
  session,
  onAttach,
}: {
  session: WorkSession;
  onAttach?: ((attachment: TextAttachment, capture: AttachmentCapture) => void) | undefined;
}) {
  const { binding } = useBinding(session.projectId);
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
      binding={binding ?? null}
      changed={version}
      {...(onAttach ? { onAttach } : {})}
    />
  );
}

/**
 * The Changes tab: a header with the sub-views, the review's compare range, the copy's branch
 * and the PR review preview link; then Review (diff, comments, decision), Git (copy preparation
 * and Git state), Checkpoints and Checks. Each sub-view stays mounted once opened, so moving
 * between them keeps drafts, selections and reads.
 */
export function SessionChangesPanel({
  session,
  reviewSearch,
  requestedView,
  onReviewChange,
  onViewChange,
  onSessionChange,
  onAttach,
}: {
  session: WorkSession;
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
  const href = useRouterState({ select: (state) => state.location.href });
  const branch = useCopyBranch(session.sessionId);
  const reviewing = reviewSearch !== undefined;
  const [remembered, setRemembered] = useState<ReviewSearch | undefined>(reviewSearch);
  if (reviewSearch && reviewSearch !== remembered) setRemembered(reviewSearch);
  const search = reviewSearch ?? remembered ?? {};
  // The address picks Review or Checks; leaving the sub-view it picked returns to Git, while a
  // sub-view chosen here in the meantime stays.
  const entry: ChangesView | null = reviewing
    ? 'review'
    : requestedView === 'checks'
      ? 'checks'
      : null;
  const [view, setView] = useState<ChangesView>(entry ?? 'git');
  const [seen, setSeen] = useState(entry);
  let shown = view;
  if (entry !== seen) {
    shown = entry ?? (view === seen ? 'git' : view);
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
  return (
    <Tabs
      size="compact"
      value={shown}
      onValueChange={(value) => choose(value as ChangesView)}
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2">
        <TabsList aria-label={tr('changesViews')}>
          <TabItem value="review" label={tr('tabReview')} />
          <TabItem value="git" label={tg('title')} />
          <TabItem value="checkpoints" label={tp('tab')} />
          <TabItem value="checks" label={tk('title')} />
        </TabsList>
        <div
          ref={setRangeSlot}
          hidden={shown !== 'review'}
          className="flex min-w-0 flex-wrap items-center gap-2"
        />
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
          {branch ? (
            <span
              className="inline-flex min-w-0 items-center gap-1"
              title={tf('branch', { branch })}
            >
              <GitBranch size={12} aria-hidden className="shrink-0" />
              <span className="sr-only">{tf('branch', { branch })}</span>
              <span aria-hidden className="truncate font-mono">
                {branch}
              </span>
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="compact"
            render={
              <Link
                to="/preview/$feature"
                params={{ feature: 'pr-review' }}
                search={{ returnTo: href }}
              />
            }
          >
            {tr('prPreview')}
          </Button>
        </div>
      </div>
      <TabPanel value="review" keepMounted className="min-h-0 flex-1">
        {visited.has('review') ? (
          <ReviewContent
            session={session}
            search={search}
            onSearch={(patch) => onReviewChange({ ...search, ...patch })}
            embedded
            rangeSlot={rangeSlot}
            showChecks={false}
            onPrepareCopy={() => choose('git')}
            onSessionChange={onSessionChange}
          />
        ) : null}
      </TabPanel>
      <TabPanel value="git" keepMounted className="min-h-0 flex-1 overflow-auto">
        {visited.has('git') ? (
          <div className="flex flex-col gap-4 p-3">
            <WorkingCopyPanel sessionId={session.sessionId} projectId={session.projectId} />
            <GitPanel sessionId={session.sessionId} projectId={session.projectId} />
          </div>
        ) : null}
      </TabPanel>
      <TabPanel value="checkpoints" keepMounted className="min-h-0 flex-1 overflow-auto p-3">
        {visited.has('checkpoints') ? (
          <CheckpointPanel key={session.sessionId} sessionId={session.sessionId} />
        ) : null}
      </TabPanel>
      <TabPanel value="checks" keepMounted className="min-h-0 flex-1 overflow-auto p-3">
        {visited.has('checks') ? <ChecksView session={session} onAttach={onAttach} /> : null}
      </TabPanel>
    </Tabs>
  );
}
