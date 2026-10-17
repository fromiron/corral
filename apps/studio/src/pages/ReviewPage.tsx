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
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { Button } from '@corral/react/ui';
import type { FileDiffMetadata } from '@pierre/diffs';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { reviewRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { latestResult, startFollowUp, steer, steerTargets } from '../sessionActions.ts';
import { useBinding } from './FilesViews.tsx';
import { WorkbenchLayout } from './Workbench.tsx';

// Reviewing a session's file changes (CR-012; WBT-15): a fixed comparison range, the files it
// changed with where each change came from, the diff in the middle, and the agreed checks.

const DiffCode = lazy(() =>
  import('../workbench/PierreCode.tsx').then((module) => ({ default: module.DiffCode })),
);

type ReviewScope = ChangeScopeQuery | { kind: 'git' };

const scopeFromSearch = (search: { scope?: string; runId?: string }): ReviewScope =>
  search.scope === 'git'
    ? { kind: 'git' }
    : search.scope === 'run' && search.runId
      ? { kind: 'run', runId: search.runId }
      : search.scope === 'review'
        ? { kind: 'review' }
        : { kind: 'session' };

export function ReviewPage() {
  const t = useTranslations('Files');
  const { session } = reviewRoute.useLoaderData();
  const search = reviewRoute.useSearch();
  const navigate = useNavigate({ from: '/sessions/$sessionId/review' });
  const { workspaces, transport } = useServices();
  const scope = scopeFromSearch(search);
  const scopeKey = scope.kind === 'run' ? `run:${scope.runId}` : scope.kind;
  const [changes, setChanges] = useState<ChangeSetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // UX-05: a session without a working copy has nothing to compare; that is not a failure.
  const [noCopy, setNoCopy] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [version, setVersion] = useState(0);
  const { binding } = useBinding(session.projectId);
  const [comments, setComments] = useState<ReviewCommentView[]>([]);
  const reviewed = useReviewedFiles(session.sessionId);
  const reloadComments = useCallback(async () => {
    if (workspaces) setComments(await workspaces.comments(session.sessionId).catch(() => []));
  }, [workspaces, session.sessionId]);
  useEffect(() => {
    void reloadComments();
  }, [reloadComments]);

  useEffect(() => {
    void transport
      .listRuns()
      .then((all) => setRuns(all.filter((r) => r.sessionId === session.sessionId)));
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
      if (chosen.kind !== 'git') {
        const copy = await workspaces.worktree(session.sessionId).catch(() => null);
        if (!copy || copy.missing) return live && setNoCopy(true);
      }
      const result = await (chosen.kind === 'git'
        ? workspaces.folderChanges(session.projectId)
        : workspaces.changes(session.sessionId, chosen));
      if (live) setChanges(result);
    })().catch(
      (failure: unknown) =>
        live && setError(failure instanceof Error ? failure.message : String(failure)),
    );
    return () => {
      live = false;
    };
  }, [workspaces, session.sessionId, session.projectId, scopeKey, version]);

  const selected = search.file ?? null;
  const choose = (file: string) => void navigate({ search: (s) => ({ ...s, file }) });
  const setScope = (value: string) => {
    const [kind, runId] = value.split(':');
    void navigate({
      search: (s) => ({
        ...s,
        scope: kind as 'session' | 'review' | 'run' | 'git',
        runId,
        file: undefined,
      }),
    });
  };

  return (
    <WorkbenchLayout
      main={
        <main className="flex h-full min-h-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: session.sessionId }}
              className="text-xs underline"
            >
              ← {session.title}
            </Link>
            <h2 className="text-base font-semibold">{t('reviewHeading')}</h2>
            <label className="flex items-center gap-1 text-xs">
              {t('scope')}
              <select
                value={scopeKey}
                onChange={(e) => setScope(e.target.value)}
                className="rounded border border-line bg-surface px-1 py-0.5"
              >
                <option value="session">{t('scopes.session')}</option>
                <option value="review">{t('scopes.review')}</option>
                {binding?.isGit ? <option value="git">{t('scopes.git')}</option> : null}
                {[...runs].reverse().map((r) => (
                  <option key={r.runId} value={`run:${r.runId}`}>
                    {t('scopes.run', { runId: r.runId })}
                  </option>
                ))}
              </select>
            </label>
            {changes?.from && changes.to ? (
              <span
                className="font-mono text-xs text-muted"
                title={`${changes.from} → ${changes.to}`}
              >
                {t('compareRange', { from: changes.from.slice(0, 8), to: changes.to.slice(0, 8) })}
              </span>
            ) : null}
            {changes ? (
              <span className="text-xs text-muted">
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
              className="ml-auto rounded border border-line px-2 py-1 text-xs"
            >
              {t('markReviewed')}
            </button>
          </header>
          {noCopy ? (
            <section
              data-testid="review-empty"
              className="mx-auto flex max-w-lg flex-col items-start gap-3 p-8 text-sm"
            >
              <h3 className="text-base font-semibold">{t('noCopyTitle')}</h3>
              <p className="text-muted">{t('noCopyBody')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
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
                  variant="outline"
                  size="sm"
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
              <Button variant="outline" size="xs" onClick={() => setVersion((n) => n + 1)}>
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div
            className={`${noCopy || error ? 'hidden' : 'grid'} min-h-0 flex-1 grid-cols-1 md:grid-cols-[16rem_minmax(0,1fr)_20rem]`}
          >
            <nav
              aria-label={t('reviewHeading')}
              className="min-h-0 overflow-auto border-line p-2 md:border-r"
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
            <section aria-label={selected ?? t('chooseFile')} className="min-h-0 overflow-auto p-3">
              {scope.kind === 'git' ? (
                <p className="mb-2 text-xs text-muted">{t('gitScopeNote')}</p>
              ) : null}
              {selected && changes?.from && (changes.to || scope.kind === 'git') ? (
                <FileDiff
                  path={selected}
                  loadKey={`${scopeKey}:${changes.from}:${changes.to}:${selected}`}
                  load={() =>
                    scope.kind === 'git'
                      ? (workspaces as NonNullable<typeof workspaces>).folderFileVersions(
                          session.projectId,
                          selected,
                        )
                      : (workspaces as NonNullable<typeof workspaces>).fileVersions(
                          session.sessionId,
                          changes.from as string,
                          changes.to as string,
                          selected,
                        )
                  }
                  reviewedKey={fileKey(
                    changes.files.find((f) => f.path === selected),
                    selected,
                  )}
                  reviewed={reviewed}
                  comments={comments.filter(
                    (c) => c.from === changes.from && c.to === changes.to && c.path === selected,
                  )}
                  {...(scope.kind === 'git' || !changes.to
                    ? {}
                    : {
                        onComment: async (comment: NewComment) => {
                          await workspaces?.addComment(session.sessionId, {
                            ...comment,
                            from: changes.from as string,
                            to: changes.to as string,
                            path: selected,
                          });
                          await reloadComments();
                        },
                      })}
                />
              ) : (
                <p className="text-sm text-muted">{t('chooseFile')}</p>
              )}
            </section>
            <aside className="flex min-h-0 flex-col gap-3 overflow-auto border-line p-3 md:border-l">
              <CommentsPanel
                session={session}
                runs={runs}
                comments={comments}
                current={changes}
                onChange={reloadComments}
              />
              {scope.kind === 'session' && changes?.from && changes.to ? (
                <DecisionPanel
                  sessionId={session.sessionId}
                  from={changes.from}
                  to={changes.to}
                  changed={version}
                  linked={Boolean(binding)}
                />
              ) : null}
              <Checks sessionId={session.sessionId} binding={binding ?? null} changed={version} />
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

function FileDiff({
  path,
  loadKey,
  load,
  reviewedKey,
  reviewed,
  comments,
  onComment,
}: {
  path: string;
  /** Changes whenever what to load changes. */
  loadKey: string;
  load: () => Promise<{ before: FileSideView; after: FileSideView }>;
  reviewedKey: string;
  reviewed: ReviewedFiles;
  comments: ReviewCommentView[];
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
  if (!sides) return <p className="text-sm text-muted">…</p>;
  const notText = (side: FileSideView) =>
    side.kind === 'binary' ? t('binary') : side.kind === 'too_large' ? t('tooLarge') : null;
  const before = sideText(sides.before);
  const after = sideText(sides.after);
  const source = sides.after.kind === 'text' ? sides.after.text : (before ?? '');
  const isReviewed = reviewed.has(reviewedKey);
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
        <button
          type="button"
          aria-pressed={isReviewed}
          onClick={() => reviewed.toggle(reviewedKey)}
          title={t('reviewedNote')}
          className={`rounded px-2 py-0.5 text-xs ${isReviewed ? 'bg-success/20' : 'border border-line'}`}
        >
          {isReviewed ? `✓ ${t('reviewedFile')}` : t('markFileReviewed')}
        </button>
        <fieldset className="ml-auto flex gap-1 text-xs">
          {(['unified', 'split', 'raw'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={layout === value}
              onClick={() => setLayout(value)}
              className={`rounded px-2 py-0.5 ${layout === value ? 'bg-accent text-on-accent' : 'border border-line'}`}
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
        <p className="text-xs text-muted">{t('computing')}</p>
      ) : null}
      {notText(sides.before) || notText(sides.after) ? (
        <p className="text-sm text-muted">{notText(sides.after) ?? notText(sides.before)}</p>
      ) : layout === 'raw' ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={download}
            className="self-start rounded border border-line px-2 py-0.5 text-xs"
          >
            {t('downloadFile')}
          </button>
          <pre className="overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-surface p-2 font-mono text-ui">
            {source}
          </pre>
        </div>
      ) : diff && diff !== 'stopped' ? (
        <Suspense fallback={<p className="text-xs text-muted">{t('computing')}</p>}>
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
  binding,
  changed,
}: {
  sessionId: string;
  binding: WorkspaceBindingView | null;
  changed: number;
}) {
  const t = useTranslations('Files');
  const { workspaces, mode } = useServices();
  const [results, setResults] = useState<VerificationResultView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const checkAction = async (action: Promise<unknown>) => {
    setError(null);
    try {
      await action;
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const reload = useCallback(async () => {
    if (workspaces) setResults(await workspaces.verifications(sessionId).catch(() => []));
  }, [workspaces, sessionId]);
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
  return (
    <section aria-labelledby="checks-heading" className="flex flex-col gap-2">
      <h3 id="checks-heading" className="text-sm font-semibold">
        {t('checksHeading')}
      </h3>
      {mode !== 'browser' && commands.length ? (
        <p className="text-xs text-muted">{t('isolatedChecksNote')}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {commands.length === 0 ? (
        <p className="text-xs text-muted">
          {mode === 'browser' ? t('checksServerOnly') : t('noChecks')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {commands.map((command) => (
          <button
            key={command.id}
            type="button"
            disabled={running}
            onClick={() => workspaces && void checkAction(workspaces.verify(sessionId, command.id))}
            className="rounded border border-accent px-2 py-0.5 text-xs text-accent disabled:opacity-50"
          >
            {t('runCheck', { name: command.name })}
          </button>
        ))}
      </div>
      <ul className="flex flex-col gap-1">
        {results.map((r) => (
          <li
            key={r.verificationId}
            className="rounded border border-line p-2 text-xs"
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
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    workspaces &&
                    void checkAction(workspaces.cancelVerification(sessionId, r.verificationId))
                  }
                >
                  {t('cancelCheck')}
                </Button>
              ) : null}
              {r.endedAt ? (
                <span className="text-muted">
                  {t('checkMeta', { code: r.exitCode ?? '—', ms: r.durationMs ?? 0 })}
                </span>
              ) : null}
              {r.timedOut ? <span className="text-danger">{t('timedOut')}</span> : null}
              {r.stale ? <span className="text-warning">{t('stale')}</span> : null}
            </div>
            {r.report ? (
              <details className="text-muted">
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
              </details>
            ) : null}
            {r.output ? (
              <details>
                <summary className="cursor-pointer text-muted">{r.argv.join(' ')}</summary>
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
          <li key={op.id} className={op.state === 'uncertain' ? 'text-warning' : 'text-muted'}>
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
      <p className="text-xs text-muted">{t('draftCount', { count: drafts.length })}</p>
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
                  className="rounded border border-line px-1"
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
              className="rounded border border-line bg-surface px-1 py-0.5"
            >
              {active ? null : <option value="next">{t('sendNext')}</option>}
              {targets.map((x) => (
                <option key={x.id} value={x.id}>
                  {t('sendSteer', { label: x.label })}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || (Boolean(active) && !steerTo)}
            onClick={() => void send()}
            className="self-start rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent disabled:opacity-50"
          >
            {t('sendReview')}
          </button>
        </>
      ) : null}
      {note ? (
        <p role="status" className="text-xs">
          {note}
        </p>
      ) : null}
      {comments.filter((c) => c.state !== 'draft').length > 0 ? (
        <details open={earlier.length > 0}>
          <summary className="cursor-pointer text-xs text-muted">{t('earlier')}</summary>
          <ul className="mt-1 flex flex-col gap-1 text-xs">
            {comments
              .filter((c) => c.state !== 'draft')
              .map((c) => (
                <li key={c.commentId} className="rounded border border-line p-1">
                  <span className="font-mono">
                    {c.path}:{c.startLine}
                  </span>{' '}
                  · {t(`commentState.${c.state}`)}
                  <blockquote className="border-l-2 border-line pl-1 font-mono text-muted">
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
                          className="rounded border border-line px-1"
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

/** Approve or ask for changes to exactly these two trees; applying follows an approval. */
function DecisionPanel({
  sessionId,
  from,
  to,
  changed,
  linked,
}: {
  sessionId: string;
  from: string;
  to: string;
  changed: number;
  linked: boolean;
}) {
  const t = useTranslations('Review');
  const { workspaces } = useServices();
  const [decisions, setDecisions] = useState<ReviewDecisionView[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationResultView[]>([]);
  const [plan, setPlan] = useState<IntegrationPlanFile[] | null>(null);
  const [busy, setBusy] = useState(false);
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
  const approved = latest && latest.decision === 'approved' ? latest : null;
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
      <p className="text-xs text-muted">{t('decisionScope')}</p>
      {latest ? (
        <p className="text-xs" data-testid="decision">
          {t(`decisionState.${latest.decision}`)}
          {latest.stale ? <span className="text-warning"> · {t('staleDecision')}</span> : null}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1 text-xs">
        <button
          type="button"
          onClick={() => void decide('approved')}
          className="rounded border border-accent px-2 py-0.5 text-accent"
        >
          {t('approve')}
        </button>
        <button
          type="button"
          onClick={() => void decide('changes_requested')}
          className="rounded border border-line px-2 py-0.5"
        >
          {t('requestChanges')}
        </button>
      </div>
      {approved && linked ? (
        <div className="flex flex-col gap-1 rounded border border-line p-2 text-xs">
          <h4 className="font-semibold">{t('integrateHeading')}</h4>
          <p className="text-muted">{t('integrateNote')}</p>
          <button
            type="button"
            onClick={() =>
              void workspaces?.integrationPlan(sessionId, approved.decisionId).then(setPlan)
            }
            className="self-start rounded border border-line px-2 py-0.5"
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
              <button
                type="button"
                disabled={busy || applying === 0}
                onClick={() => {
                  setBusy(true);
                  void workspaces
                    ?.integrate(sessionId, approved.decisionId)
                    .then(() => setPlan(null))
                    .then(reload)
                    .finally(() => setBusy(false));
                }}
                className="self-start rounded-md bg-accent px-2 py-1 font-medium text-on-accent disabled:opacity-50"
              >
                {t('apply', { count: applying })}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {integrations.map((integration) => (
        <div
          key={integration.integrationId}
          data-testid="integration"
          className="flex flex-col gap-1 rounded border border-line p-2 text-xs"
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
              onClick={() =>
                void workspaces?.revert(sessionId, integration.integrationId).then(reload)
              }
              className="self-start rounded border border-line px-2 py-0.5"
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

/** "Reviewed" is reading, per file content: it holds while the file's after-blob is the same. */
const fileKey = (file: FileChangeView | undefined, path: string) =>
  `${path}@${file?.afterBlob ?? file?.beforeBlob ?? 'gone'}`;

interface ReviewedFiles {
  has(key: string): boolean;
  toggle(key: string): void;
}

/** Kept in this browser (a view state, 02-UX-Spec §9), per session. */
function useReviewedFiles(sessionId: string): ReviewedFiles {
  const storageKey = `corral:reviewed:${sessionId}`;
  const [keys, setKeys] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  return {
    has: (key) => keys.has(key),
    toggle: (key) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setKeys(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next].slice(-2000)));
      } catch {
        // Remembered for this page only.
      }
    },
  };
}

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
  reviewed: ReviewedFiles;
  onChoose: (path: string) => void;
}) {
  const t = useTranslations('Files');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | FileChangeView['status']>('all');
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  void sessionId;
  if (!changes) return <p className="text-xs text-muted">{t('preparing')}</p>;
  if (changes.unavailable) return <p className="text-xs text-muted">{t('noBaseline')}</p>;
  if (changes.files.length === 0)
    return (
      <p data-testid="no-changes" className="text-xs text-muted">
        {scopeIsRun ? t('runChangedNothing') : t('nothingChanged')}
      </p>
    );
  const needle = query.trim().toLowerCase();
  const matches = changes.files.filter(
    (f) =>
      (!needle || f.path.toLowerCase().includes(needle)) &&
      (kind === 'all' || f.status === kind) &&
      (!unreviewedOnly || !reviewed.has(fileKey(f, f.path))),
  );
  const folded = matches.filter((f) => GENERATED.test(f.path) && f.status !== 'deleted');
  // Only the linked folder's Git state has a staged list.
  const staged = new Set((changes as ChangeSetView & { staged?: string[] }).staged ?? []);
  const main = matches.filter((f) => !folded.includes(f));
  const row = (file: FileChangeView) => (
    <li key={file.path}>
      <button
        type="button"
        aria-current={selected === file.path ? 'true' : undefined}
        onClick={() => onChoose(file.path)}
        className={`flex w-full flex-col rounded border px-2 py-1 text-left text-xs ${
          selected === file.path ? 'border-accent bg-raised' : 'border-line'
        }`}
      >
        <span className="break-all font-mono">
          {reviewed.has(fileKey(file, file.path)) ? '✓ ' : ''}
          {file.path}
        </span>
        <span className="text-muted">
          {t(`status.${file.status}`)}
          {file.additions !== null ? ` · +${file.additions} −${file.deletions ?? 0}` : ''}
          {file.binary ? ' · bin' : ''} · {t(`provenance.${file.provenance}`)}
          {staged.has(file.path) ? ` · ${t('staged')}` : ''}
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
        className="rounded border border-line bg-surface px-2 py-1 text-xs"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          aria-label={t('kindAll')}
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="rounded border border-line bg-surface px-1 py-0.5"
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
      {changes.files.length === 0 ? <p className="text-xs text-muted">{t('noChanges')}</p> : null}
      <ul className="flex flex-col gap-1">{main.map(row)}</ul>
      {folded.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted">
            {t('generatedGroup', { count: folded.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-1">{folded.map(row)}</ul>
        </details>
      ) : null}
      <p className="text-xs text-muted">{t('ignoredNote')}</p>
    </div>
  );
}
