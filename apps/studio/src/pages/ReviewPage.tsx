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
  VerificationResultView,
  WorkspaceBindingView,
} from '@corral/client';
import { TERMINAL_RUN_STATUSES, type TextAttachment } from '@corral/contracts';
import { createTextAttachment, type RunSummary, type WorkSession } from '@corral/core';
import { Button } from '@corral/react/design-kit';
import { Check, Eye } from '@corral/react/icons';
import type { FileDiffMetadata } from '@pierre/diffs';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { reviewRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { latestResult, startFollowUp, steer, steerTargets } from '../sessionActions.ts';
import {
  type AttachmentCapture,
  appendComposerAttachment,
  beginAttachmentCapture,
} from '../workbench/context/bridge.ts';
import { HunkActions } from '../workbench/HunkActions.tsx';
import { panelKey } from '../workbench/panels/registry.ts';
import { type ReviewMarks, useReviewMarks } from '../workbench/reviewMarks.ts';
import { CandidateComparison } from './CandidateComparison.tsx';
import { useBinding } from './FilesViews.tsx';
import { LspProposals } from './LspProposals.tsx';
import { WorkbenchLayout } from './Workbench.tsx';

// Reviewing a session's file changes (CR-012; WBT-15): a fixed comparison range, the files it
// changed with where each change came from, the diff in the middle, and the agreed checks.

const DiffCode = lazy(() =>
  import('../workbench/PierreCode.tsx').then((module) => ({ default: module.DiffCode })),
);

// Git state has one home, the Git pane; an old `scope=git` address is redirected there (#91).
type ReviewScope = ChangeScopeQuery;

const scopeFromSearch = (search: { scope?: string; runId?: string }): ReviewScope =>
  search.scope === 'run' && search.runId
    ? { kind: 'run', runId: search.runId }
    : search.scope === 'review'
      ? { kind: 'review' }
      : { kind: 'session' };

export function ReviewPage() {
  const t = useTranslations('Files');
  const tc = useTranslations('Context');
  const reviewedHint = useId();
  const { session } = reviewRoute.useLoaderData();
  const search = reviewRoute.useSearch();
  const navigate = useNavigate({ from: '/sessions/$sessionId/review' });
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
  // Runs and comments are held with the session they were read for: a late answer for the
  // session just left never lands here, and its drafts or active run never drive this one.
  const [loadedRuns, setRuns] = useState<{ sessionId: string; runs: RunSummary[] }>({
    sessionId: session.sessionId,
    runs: [],
  });
  const runs = loadedRuns.sessionId === session.sessionId ? loadedRuns.runs : [];
  const comparisonRunId = scope.kind === 'run' ? scope.runId : runs[0]?.runId;
  const [version, setVersion] = useState(0);
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
    let live = true;
    const sessionId = session.sessionId;
    void transport.listRuns().then((all) => {
      if (live) setRuns({ sessionId, runs: all.filter((r) => r.sessionId === sessionId) });
    });
    return () => {
      live = false;
    };
  }, [transport, session.sessionId]);
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
    void (async () => {
      const copy = await workspaces.worktree(session.sessionId).catch(() => null);
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
  const choose = (file: string) => void navigate({ search: (s) => ({ ...s, file }) });
  const setScope = (value: string) => {
    const [kind, runId] = value.split(':');
    void navigate({
      search: (s) => ({
        ...s,
        scope: kind as 'session' | 'review' | 'run',
        runId,
        file: undefined,
      }),
    });
  };

  return (
    <WorkbenchLayout
      key={panelKey(services, {
        kind: 'review',
        projectId: session.projectId,
        sessionId: session.sessionId,
      })}
      main={
        <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: session.sessionId }}
              className="text-xs underline"
            >
              ← {session.title}
            </Link>
            <h2 className="text-base font-semibold">{t('reviewHeading')}</h2>
            {/* The options name what they compare; the label stays for assistive technology. */}
            <label className="flex min-w-0 max-w-full items-center gap-1 text-xs">
              <span className="sr-only">{t('scope')}</span>
              <select
                value={scopeKey}
                onChange={(e) => setScope(e.target.value)}
                className="min-w-0 rounded fill-control px-1 py-0.5"
              >
                <option value="session">{t('scopes.session')}</option>
                <option value="review">{t('scopes.review')}</option>
                {[...runs].reverse().map((r) => (
                  <option key={r.runId} value={`run:${r.runId}`}>
                    {t('scopes.run', { runId: r.runId })}
                  </option>
                ))}
              </select>
            </label>
            {changes?.from && changes.to ? (
              <span
                className="font-mono text-xs text-muted-foreground"
                title={`${changes.from} → ${changes.to}`}
              >
                {t('compareRange', { from: changes.from.slice(0, 8), to: changes.to.slice(0, 8) })}
              </span>
            ) : null}
            {changes ? (
              <span className="text-xs text-muted-foreground">
                {scope.kind === 'review'
                  ? t('newChanges', { count: changes.files.length })
                  : t('files', { count: changes.files.length })}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() =>
                void workspaces
                  ?.markReviewed(session.sessionId)
                  .then(() => setVersion((n) => n + 1))
              }
              title={t('reviewedNote')}
              aria-describedby={reviewedHint}
              className="ml-auto rounded fill-control px-2 py-1 text-xs"
            >
              {t('markReviewed')}
            </button>
            {/* The baseline always covers the whole current copy (#78 IA-07); the button names
                it, so the longer note is its description and tooltip only. */}
            <span id={reviewedHint} className="sr-only">
              {t('reviewedNote')}
            </span>
          </header>
          {noCopy ? (
            <section
              data-testid="review-empty"
              className="mx-auto flex max-w-lg flex-col items-start gap-3 p-8 text-sm"
            >
              <h3 className="text-base font-semibold">{t('noCopyTitle')}</h3>
              <p className="text-muted-foreground">{t('noCopyBody')}</p>
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
                  render={
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: session.sessionId }}
                      search={{ panel: 'changes' }}
                    />
                  }
                >
                  {t('makeCopyThere')}
                </Button>
              </div>
            </section>
          ) : error ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 p-3 text-sm text-danger">
              {t('failed', { message: error })}
              <Button variant="tertiary" size="compact" onClick={() => setVersion((n) => n + 1)}>
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={`${noCopy || error ? 'hidden' : 'grid'} review-layout min-h-0 flex-1`}>
            <nav
              aria-label={t('reviewHeading')}
              className="review-files min-w-0 overflow-auto border-line p-2"
            >
              <FileList
                sessionId={session.sessionId}
                changes={changes}
                selected={selected}
                reviewed={reviewed}
                onChoose={choose}
                scopeIsRun={scope.kind === 'run'}
              />
            </nav>
            <section aria-label={selected ?? t('chooseFile')} className="review-diff min-w-0 p-3">
              {selected && changes?.from && changes.to ? (
                <FileDiff
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
                  comments={comments.filter(
                    (c) => c.from === changes.from && c.to === changes.to && c.path === selected,
                  )}
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
              ) : (
                <p className="text-sm text-muted-foreground">{t('chooseFile')}</p>
              )}
              {selected && changes?.from && changes.to ? (
                <HunkActions
                  key={`${session.sessionId}:${selected}:${changes.from}:${changes.to}`}
                  sessionId={session.sessionId}
                  projectId={session.projectId}
                  from={changes.from}
                  to={changes.to}
                  path={selected}
                  active={runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))}
                  onApplied={() => setVersion((value) => value + 1)}
                  onAttach={onAttach}
                />
              ) : null}
            </section>
            <aside className="review-details flex min-w-0 flex-col gap-3 border-line p-3">
              {workspaces && mode === 'server' && comparisonRunId ? (
                <CandidateComparison
                  key={`${session.sessionId}:${comparisonRunId}`}
                  api={workspaces}
                  transport={transport}
                  runId={comparisonRunId}
                  onApplied={() => setVersion((current) => current + 1)}
                  renderFile={(candidate, path) => {
                    const tree = candidate.tree;
                    if (!tree) return null;
                    return (
                      <FileDiff
                        path={path}
                        loadKey={`${comparisonRunId}:${candidate.candidateId}:${tree}:${path}`}
                        load={() =>
                          workspaces.candidateFileVersions(
                            comparisonRunId,
                            candidate.candidateId,
                            tree,
                            path,
                          )
                        }
                      />
                    );
                  }}
                />
              ) : null}
              {workspaces && mode === 'server' ? (
                <LspProposals
                  key={session.sessionId}
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

              <CommentsPanel
                session={session}
                runs={runs}
                comments={comments}
                current={changes}
                onChange={reloadComments}
              />
              {scope.kind === 'session' && changes?.from && changes.to ? (
                <DecisionPanel
                  key={session.sessionId}
                  sessionId={session.sessionId}
                  from={changes.from}
                  to={changes.to}
                  changed={version}
                  linked={Boolean(binding)}
                  active={runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))}
                />
              ) : null}
              <Checks
                sessionId={session.sessionId}
                projectId={session.projectId}
                binding={binding ?? null}
                changed={version}
                onAttach={onAttach}
              />
              <Operations sessionId={session.sessionId} />
            </aside>
          </div>
        </main>
      }
    />
  );
}

const sideText = (side: FileSideView) =>
  side.kind === 'text' ? side.text : side.kind === 'absent' ? '' : null;

type NewComment = Pick<ReviewCommentView, 'side' | 'startLine' | 'endLine' | 'quote' | 'body'>;

/** A change review toggle; absent where there is nothing to review (the Git pane). */
interface ChangeMark {
  pressed: boolean;
  toggle(): void;
}
const changeMark = (marks: ReviewMarks, file: FileChangeView | undefined): ChangeMark | undefined =>
  file && { pressed: marks.changeReviewed(file), toggle: () => marks.toggleChange(file) };

export function FileDiff({
  path,
  loadKey,
  load,
  mark,
  comments = [],
  onComment,
}: {
  path: string;
  /** Changes whenever what to load changes. */
  loadKey: string;
  load: () => Promise<{ before: FileSideView; after: FileSideView }>;
  mark?: ChangeMark | undefined;
  comments?: ReviewCommentView[];
  /** Absent where comments do not apply (the linked folder's Git state). */
  onComment?: (comment: NewComment) => Promise<void>;
}) {
  const t = useTranslations('Files');
  const [sides, setSides] = useState<{ before: FileSideView; after: FileSideView } | null>(null);
  const [layout, setLayout] = useState<'unified' | 'split' | 'raw'>('unified');
  const [diff, setDiff] = useState<FileDiffMetadata | 'stopped' | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  // The diff runs in a worker and is stopped after 3 s (02-UX-Spec §4: no endless spinner).
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
  if (error)
    return (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  if (!sides) return <p className="text-sm text-muted-foreground">…</p>;
  const notText = (side: FileSideView) =>
    side.kind === 'binary' ? t('binary') : side.kind === 'too_large' ? t('tooLarge') : null;
  const before = sideText(sides.before);
  const after = sideText(sides.after);
  const source = sides.after.kind === 'text' ? sides.after.text : (before ?? '');
  const download = () => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = path.split('/').at(-1) ?? 'file.txt';
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-2" data-testid="file-diff">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-all font-mono text-sm">{path}</h3>
        {mark ? (
          <button
            type="button"
            aria-pressed={mark.pressed}
            onClick={mark.toggle}
            title={t('changeReviewNote')}
            className={`rounded px-2 py-0.5 text-xs ${mark.pressed ? 'bg-success/20' : 'fill-control'}`}
          >
            {mark.pressed ? `✓ ${t('reviewedFile')}` : t('markFileReviewed')}
          </button>
        ) : null}
        <fieldset className="ml-auto flex gap-1 text-xs">
          {(['unified', 'split', 'raw'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={layout === value}
              onClick={() => setLayout(value)}
              className={`rounded px-2 py-0.5 ${layout === value ? 'bg-primary text-primary-foreground' : 'fill-control'}`}
            >
              {t(value)}
            </button>
          ))}
        </fieldset>
      </div>
      {diff === 'stopped' && layout !== 'raw' ? (
        <p role="alert" className="text-xs text-warning">
          {t('diffStopped')}
        </p>
      ) : null}
      {diff === null && layout !== 'raw' && !notText(sides.before) && !notText(sides.after) ? (
        <p className="text-xs text-muted-foreground">{t('computing')}</p>
      ) : null}
      {notText(sides.before) || notText(sides.after) ? (
        <p className="text-sm text-muted-foreground">
          {notText(sides.after) ?? notText(sides.before)}
        </p>
      ) : layout === 'raw' ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={download}
            className="self-start rounded fill-control px-2 py-0.5 text-xs"
          >
            {t('downloadFile')}
          </button>
          <pre className="overflow-auto whitespace-pre-wrap break-all rounded fill-group p-2 font-mono text-ui">
            {source}
          </pre>
        </div>
      ) : diff && diff !== 'stopped' ? (
        <Suspense fallback={<p className="text-xs text-muted-foreground">{t('computing')}</p>}>
          <DiffCode
            key={loadKey}
            diff={diff}
            before={before ?? ''}
            after={after ?? ''}
            layout={layout}
            comments={comments}
            {...(onComment ? { onComment } : {})}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export function Checks({
  sessionId,
  projectId,
  binding,
  changed,
  onAttach,
}: {
  sessionId: string;
  projectId?: string;
  binding: WorkspaceBindingView | null;
  changed: number;
  onAttach?(attachment: TextAttachment, capture: AttachmentCapture): void | Promise<void>;
}) {
  const t = useTranslations('Files');
  const tc = useTranslations('Context');
  const { workspaces, mode, workspaceId } = useServices();
  const source = useMemo(
    () => ({ workspaces, workspaceId, projectId, sessionId }),
    [workspaces, workspaceId, projectId, sessionId],
  );
  const currentSource = useRef(source);
  currentSource.current = source;
  const mounted = useRef(false);
  const readRevision = useRef(0);
  const [loaded, setLoaded] = useState<{
    source: typeof source;
    results: VerificationResultView[];
  }>({ source, results: [] });
  const results = loaded.source === source ? loaded.results : [];
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attached, setAttached] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readRevision.current += 1;
    };
  }, []);
  const isCurrent = () => mounted.current && currentSource.current === source;
  const checkAction = async (action: Promise<unknown>) => {
    setError(null);
    try {
      await action;
      if (isCurrent()) await reload();
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : String(error));
    }
  };
  const reload = useCallback(async () => {
    if (!source.workspaces) return;
    const revision = ++readRevision.current;
    const value = await source.workspaces.verifications(source.sessionId).catch(() => []);
    if (mounted.current && currentSource.current === source && readRevision.current === revision)
      setLoaded({ source, results: value });
  }, [source]);
  useEffect(() => {
    void changed;
    void reload();
  }, [reload, changed]);
  const running = results.some((r) => r.state === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 1000);
    return () => clearInterval(timer);
  }, [running, reload]);
  const commands = binding?.verifyCommands ?? [];
  const canAttach = (result: VerificationResultView) =>
    Boolean(
      onAttach &&
        workspaceId &&
        projectId &&
        mode === 'server' &&
        result.output &&
        result.state !== 'running' &&
        (!result.report ||
          (result.report.sessionId === sessionId &&
            result.report.verificationId === result.verificationId &&
            result.report.state !== 'queued' &&
            result.report.state !== 'running')),
    );
  const attach = async (result: VerificationResultView) => {
    if (!canAttach(result) || !workspaceId || !projectId || !onAttach || attaching) return;
    setAttaching(true);
    setAttached(null);
    setError(null);
    try {
      const capture = beginAttachmentCapture({ hostId: workspaceId, projectId, sessionId });
      const report = result.report;
      const attachment = createTextAttachment('check-output.txt', 'text/plain', result.output, {
        kind: 'check',
        hostId: workspaceId,
        projectId,
        sessionId,
        verificationId: result.verificationId,
        commandId: result.commandId,
        tree: result.tree,
        ...(report
          ? {
              fingerprint: report.fingerprint,
              configRevision: report.configRevision,
              outputHash: report.output.hash,
              outputTruncated: report.output.truncated,
            }
          : {}),
      });
      await onAttach(attachment, capture);
      if (isCurrent()) setAttached(result.verificationId);
    } catch {
      if (isCurrent()) setError(tc('attachFailed'));
    } finally {
      if (mounted.current) setAttaching(false);
    }
  };
  return (
    <section aria-labelledby="checks-heading" className="flex flex-col gap-2">
      <h3 id="checks-heading" className="text-sm font-semibold">
        {t('checksHeading')}
      </h3>
      {mode !== 'browser' && commands.length ? (
        <p className="text-xs text-muted-foreground">{t('isolatedChecksNote')}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {commands.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {mode === 'browser' ? t('checksServerOnly') : t('noChecks')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {commands.map((command) => (
          <Button
            variant="tertiary"
            size="compact"
            key={command.id}
            type="button"
            disabled={running}
            onClick={() => workspaces && void checkAction(workspaces.verify(sessionId, command.id))}
            className=""
          >
            {t('runCheck', { name: command.name })}
          </Button>
        ))}
      </div>
      <ul className="flex flex-col gap-1">
        {results.map((r) => (
          <li
            key={r.verificationId}
            className="rounded fill-group p-2 text-xs"
            data-testid="check-result"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.name}</span>
              <span
                className={
                  r.state === 'passed' ? 'text-success' : r.state === 'running' ? '' : 'text-danger'
                }
              >
                {r.report ? t(`checkReportState.${r.report.state}`) : t(`checkState.${r.state}`)}
              </span>
              {r.report ? <span>{t(`checkVerdict.${r.report.verdict}`)}</span> : null}
              {r.state === 'running' && r.report?.owner.kind === 'manual' ? (
                <Button
                  size="compact"
                  variant="tertiary"
                  onClick={() =>
                    workspaces &&
                    void checkAction(workspaces.cancelVerification(sessionId, r.verificationId))
                  }
                >
                  {t('cancelCheck')}
                </Button>
              ) : null}
              {r.endedAt ? (
                <span className="text-muted-foreground">
                  {t('checkMeta', { code: r.exitCode ?? '—', ms: r.durationMs ?? 0 })}
                </span>
              ) : null}
              {r.timedOut ? <span className="text-danger">{t('timedOut')}</span> : null}
              {r.stale ? <span className="text-warning">{t('stale')}</span> : null}
              {r.configChanged && !r.stale ? (
                <span className="text-warning">{t('configChanged')}</span>
              ) : null}
              {onAttach && workspaceId && projectId ? (
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={attaching || !canAttach(r)}
                  onClick={() => void attach(r)}
                >
                  {t('attachCheckOutput')}
                </Button>
              ) : null}
              {attached === r.verificationId ? <span role="status">{tc('attached')}</span> : null}
            </div>
            {r.report ? (
              <details className="text-muted-foreground">
                <summary>{t('checkEvidence')}</summary>
                <p>
                  {t('checkFingerprint', {
                    revision: r.report.configRevision,
                    hash: r.report.fingerprint.slice(0, 12),
                    tree: r.tree.slice(0, 12),
                  })}
                </p>
                <p>{t('checkRetention', { date: r.report.retainUntil })}</p>
                {!r.report.cleanupConfirmed && r.report.endedAt ? (
                  <p className="text-warning">{t('checkCleanupUnknown')}</p>
                ) : null}
                {r.report.targetUnchanged === false ? (
                  <p className="text-warning">{t('checkTargetChanged')}</p>
                ) : null}
              </details>
            ) : null}
            {r.output ? (
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  {r.argv.join(' ')}
                </summary>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                  {r.output}
                </pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Operations({ sessionId }: { sessionId: string }) {
  const t = useTranslations('Files');
  const { workspaces } = useServices();
  const [ops, setOps] = useState<FileOperationView[]>([]);
  useEffect(() => {
    void workspaces?.fileOperations(sessionId).then(setOps, () => setOps([]));
  }, [workspaces, sessionId]);
  if (ops.length === 0) return null;
  return (
    <section aria-labelledby="ops-heading" className="flex flex-col gap-1">
      <h3 id="ops-heading" className="text-sm font-semibold">
        {t('operations')}
      </h3>
      <ul className="flex flex-col gap-1 text-xs">
        {ops.slice(0, 50).map((op) => (
          <li
            key={op.id}
            className={op.state === 'uncertain' ? 'text-warning' : 'text-muted-foreground'}
          >
            {op.kind}{' '}
            <span className="font-mono">{op.to_path ? `${op.path} → ${op.to_path}` : op.path}</span>{' '}
            · {op.state} · {op.run_id}
            {op.state === 'uncertain' ? <span className="block">{t('uncertain')}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Draft comments go out together, to the running execution or as a new run (WB-REV-002). */
function CommentsPanel({
  session,
  runs,
  comments,
  current,
  onChange,
}: {
  session: WorkSession;
  runs: RunSummary[];
  comments: ReviewCommentView[];
  current: ChangeSetView | null;
  onChange: () => Promise<void>;
}) {
  const t = useTranslations('Review');
  const services = useServices();
  const { workspaces } = services;
  const active = runs.find((r) => !TERMINAL_RUN_STATUSES.has(r.status)) ?? null;
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const [target, setTarget] = useState('next');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!active) return setTargets([]);
    void steerTargets(services, active.runId).then(setTargets);
  }, [services, active]);
  const drafts = comments.filter((c) => c.state === 'draft');
  const earlier = comments.filter(
    (c) => c.state !== 'draft' && (!current || c.from !== current.from || c.to !== current.to),
  );
  const steerTo = targets.find((x) => x.id === target);

  const send = async () => {
    if (!workspaces || drafts.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const ids = drafts.map((c) => c.commentId);
      const text = await workspaces.feedbackText(session.sessionId, ids);
      let runId: string | null = null;
      let executionId: string | null = null;
      let sent = false;
      let detail: string | null = null;
      let commandId: string | null = null;
      if (active && steerTo) {
        ({ sent, detail, commandId } = await steer(services, active.runId, steerTo.id, text));
        runId = active.runId;
        executionId = steerTo.id;
      } else if (!active) {
        const latest = await latestResult(services, runs);
        ({ runId, detail } = await startFollowUp(services, session, text, {
          mode: 'mock',
          startFrom: latest ? { runId: latest.runId, artifactVersionId: latest.id } : null,
        }));
        sent = runId !== null;
      } else {
        detail = 'choose an execution';
      }
      await workspaces.recordFeedback(session.sessionId, {
        commentIds: ids,
        intent: steerTo ? 'steer' : 'next',
        runId,
        executionId,
        text,
        sent,
        detail,
      });
      await services.repository.addSessionEntry(session.sessionId, {
        intent: steerTo ? 'steer' : 'next',
        text,
        state: sent ? (steerTo ? 'sent' : 'started') : 'refused',
        runId,
        executionId,
        detail,
        commandId,
      });
      setNote(sent ? t('sent') : detail);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="comments-heading" className="flex flex-col gap-2">
      <h3 id="comments-heading" className="text-sm font-semibold">
        {t('commentsHeading')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('draftCount', { count: drafts.length })}</p>
      {drafts.length > 0 ? (
        <>
          <ul className="flex flex-col gap-1 text-xs">
            {drafts.map((c) => (
              <li key={c.commentId} className="flex items-start justify-between gap-1">
                <span>
                  <span className="font-mono">
                    {c.path}:{c.startLine}
                  </span>{' '}
                  {c.body}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void workspaces
                      ?.setCommentState(session.sessionId, c.commentId, 'deleted')
                      .then(onChange)
                  }
                  className="rounded fill-control px-1"
                >
                  {t('deleteDraft')}
                </button>
              </li>
            ))}
          </ul>
          <label className="flex flex-col gap-1 text-xs">
            {t('sendTo')}
            <select
              value={active ? target : 'next'}
              onChange={(e) => setTarget(e.target.value)}
              className="rounded fill-control px-1 py-0.5"
            >
              {active ? null : <option value="next">{t('sendNext')}</option>}
              {targets.map((x) => (
                <option key={x.id} value={x.id}>
                  {t('sendSteer', { label: x.label })}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="primary"
            size="compact"
            type="button"
            disabled={busy || (Boolean(active) && !steerTo)}
            onClick={() => void send()}
            className="self-start"
          >
            {t('sendReview')}
          </Button>
        </>
      ) : null}
      {note ? (
        <p role="status" className="text-xs">
          {note}
        </p>
      ) : null}
      {comments.filter((c) => c.state !== 'draft').length > 0 ? (
        <details open={earlier.length > 0}>
          <summary className="cursor-pointer text-xs text-muted-foreground">{t('earlier')}</summary>
          <ul className="mt-1 flex flex-col gap-1 text-xs">
            {comments
              .filter((c) => c.state !== 'draft')
              .map((c) => (
                <li key={c.commentId} className="rounded fill-group p-1">
                  <span className="font-mono">
                    {c.path}:{c.startLine}
                  </span>{' '}
                  · {t(`commentState.${c.state}`)}
                  <blockquote className="border-l-2 border-line pl-1 font-mono text-muted-foreground">
                    {c.quote}
                  </blockquote>
                  <p>{c.body}</p>
                  {c.state === 'submitted' ? (
                    <div className="flex gap-1">
                      {(['addressed', 'obsolete'] as const).map((state) => (
                        <button
                          key={state}
                          type="button"
                          onClick={() =>
                            void workspaces
                              ?.setCommentState(session.sessionId, c.commentId, state)
                              .then(onChange)
                          }
                          className="rounded fill-control px-1"
                        >
                          {state === 'addressed' ? t('markAddressed') : t('markObsolete')}
                        </button>
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
 * made on another comparison, even one ending in the same tree, is shown as earlier (CR-046 P17).
 */
export function DecisionPanel({
  sessionId,
  from,
  to,
  changed,
  linked,
  active,
}: {
  sessionId: string;
  from: string;
  to: string;
  changed: number;
  linked: boolean;
  active: boolean;
}) {
  const t = useTranslations('Review');
  const { workspaces } = useServices();
  const [decisions, setDecisions] = useState<ReviewDecisionView[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationResultView[]>([]);
  const [plan, setPlan] = useState<IntegrationPlanFile[] | null>(null);
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
  const decide = async (decision: 'approved' | 'changes_requested') => {
    await workspaces?.decide(sessionId, { from, to, decision, note: '' });
    setPlan(null);
    await reload();
  };
  const applying = plan?.filter((f) => f.outcome === 'apply').length ?? 0;

  return (
    <section aria-labelledby="decision-heading" className="flex flex-col gap-2">
      <h3 id="decision-heading" className="text-sm font-semibold">
        {t('decisionHeading')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('decisionScope')}</p>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {latest ? (
        <p className="text-xs" data-testid="decision">
          {t(`decisionState.${latest.decision}`)}
          {earlier ? <span className="text-warning"> · {t('staleDecision')}</span> : null}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1 text-xs">
        <Button
          variant="tertiary"
          size="compact"
          type="button"
          disabled={busy}
          onClick={() => void act(() => decide('approved'))}
          className=""
        >
          {t('approve')}
        </Button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => decide('changes_requested'))}
          className="rounded fill-control px-2 py-0.5"
        >
          {t('requestChanges')}
        </button>
      </div>
      {approved && linked ? (
        <div className="flex flex-col gap-1 rounded fill-group p-2 text-xs">
          <h4 className="font-semibold">{t('integrateHeading')}</h4>
          <p className="text-muted-foreground">{t('integrateNote')}</p>
          <button
            type="button"
            onClick={() =>
              void act(async () => {
                if (workspaces)
                  setPlan(await workspaces.integrationPlan(sessionId, approved.decisionId));
              })
            }
            className="self-start rounded fill-control px-2 py-0.5"
          >
            {t('plan')}
          </button>
          {plan ? (
            <>
              <ul data-testid="integration-plan">
                {plan.map((f) => (
                  <li key={f.path} className={f.outcome === 'conflict' ? 'text-warning' : ''}>
                    <span className="font-mono">{f.path}</span> · {t(`planOutcome.${f.outcome}`)}
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
          className="flex flex-col gap-1 rounded fill-group p-2 text-xs"
        >
          <span className="font-medium">{t(`integrationState.${integration.state}`)}</span>
          <ul>
            {integration.files.map((f) => (
              <li key={f.path}>
                <span className="font-mono">{f.path}</span> · {t(`fileOutcome.${f.outcome}`)}
              </li>
            ))}
          </ul>
          {integration.files.some((f) => f.outcome === 'applied') ? (
            <button
              type="button"
              title={t('revertNote')}
              disabled={busy || active}
              onClick={() =>
                void act(async () => {
                  await workspaces?.revert(sessionId, integration.integrationId);
                  await reload();
                })
              }
              className="self-start rounded fill-control px-2 py-0.5"
            >
              {t('revert')}
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}

// ── file list helpers (02-UX-Spec §4) ───────────────────────────────────────

/** Lock files and build output: folded by default, but deletions stay in view. */
const GENERATED =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|(^|\/)(dist|build|generated|__generated__)\/|\.min\.(js|css)$/;

function FileList({
  sessionId,
  changes,
  selected,
  reviewed,
  onChoose,
  scopeIsRun = false,
}: {
  scopeIsRun?: boolean;
  sessionId: string;
  changes: ChangeSetView | null;
  selected: string | null;
  reviewed: ReviewMarks;
  onChoose: (path: string) => void;
}) {
  const t = useTranslations('Files');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | FileChangeView['status']>('all');
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  void sessionId;
  if (!changes) return <p className="text-xs text-muted-foreground">{t('preparing')}</p>;
  if (changes.unavailable)
    return <p className="text-xs text-muted-foreground">{t('noBaseline')}</p>;
  if (changes.files.length === 0)
    return (
      <p data-testid="no-changes" className="text-xs text-muted-foreground">
        {scopeIsRun ? t('runChangedNothing') : t('nothingChanged')}
      </p>
    );
  const needle = query.trim().toLowerCase();
  const matches = changes.files.filter(
    (f) =>
      (!needle || f.path.toLowerCase().includes(needle)) &&
      (kind === 'all' || f.status === kind) &&
      (!unreviewedOnly || !reviewed.changeReviewed(f)),
  );
  const folded = matches.filter((f) => GENERATED.test(f.path) && f.status !== 'deleted');
  const main = matches.filter((f) => !folded.includes(f));
  const row = (file: FileChangeView) => (
    <li key={file.path}>
      <button
        type="button"
        aria-current={selected === file.path ? 'true' : undefined}
        onClick={() => onChoose(file.path)}
        className={`flex w-full flex-col rounded border px-2 py-1 text-left text-xs ${
          selected === file.path ? 'border-primary bg-raised' : 'border-transparent fill-group'
        }`}
      >
        <span className="flex items-start gap-1 break-all font-mono">
          {reviewed.changeReviewed(file) ? (
            <>
              <Check aria-hidden className="mt-0.5 size-3 shrink-0 text-success" />
              <span className="sr-only">{t('reviewedFile')}</span>
            </>
          ) : reviewed.contentRead(file) ? (
            <span title={t('readElsewhere')} className="contents">
              <Eye aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
              <span className="sr-only">{t('readElsewhere')}</span>
            </span>
          ) : null}
          {file.path}
        </span>
        <span className="text-muted-foreground">
          {t(`status.${file.status}`)}
          {file.additions !== null ? ` · +${file.additions} −${file.deletions ?? 0}` : ''}
          {file.binary ? ' · bin' : ''} · {t(`provenance.${file.provenance}`)}
        </span>
      </button>
    </li>
  );
  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        aria-label={t('filterSearch')}
        placeholder={t('filterSearch')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="rounded fill-control px-2 py-1 text-xs"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          aria-label={t('kindAll')}
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="rounded fill-control px-1 py-0.5"
        >
          <option value="all">{t('kindAll')}</option>
          {(['added', 'modified', 'deleted', 'type_changed'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`status.${value}`)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={unreviewedOnly}
            onChange={(e) => setUnreviewedOnly(e.target.checked)}
          />
          {t('unreviewedOnly')}
        </label>
      </div>
      {changes.files.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('noChanges')}</p>
      ) : null}
      <ul className="flex flex-col gap-1">{main.map(row)}</ul>
      {folded.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t('generatedGroup', { count: folded.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-1">{folded.map(row)}</ul>
        </details>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('ignoredNote')}</p>
    </div>
  );
}
