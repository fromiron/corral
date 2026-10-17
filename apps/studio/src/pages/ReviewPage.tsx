import type {
  ChangeScopeQuery,
  ChangeSetView,
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
import { type DiffLine, diffLines } from '@corral/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { reviewRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { latestResult, startFollowUp, steer, steerTargets } from '../sessionActions.ts';
import { useBinding } from './FilesViews.tsx';
import { WorkbenchLayout, WorkbenchSidebar } from './Workbench.tsx';

// Reviewing a session's file changes (CR-012; WBT-15): a fixed comparison range, the files it
// changed with where each change came from, the diff in the middle, and the agreed checks.

const scopeFromSearch = (search: { scope?: string; runId?: string }): ChangeScopeQuery =>
  search.scope === 'run' && search.runId
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
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [version, setVersion] = useState(0);
  const { binding } = useBinding(session.projectId);
  const [comments, setComments] = useState<ReviewCommentView[]>([]);
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
    workspaces
      .changes(
        session.sessionId,
        scopeFromSearch({ scope: scopeKey.split(':')[0], runId: scopeKey.split(':')[1] }),
      )
      .then(
        (result) => live && setChanges(result),
        (failure) => live && setError(failure instanceof Error ? failure.message : String(failure)),
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
      sidebar={
        <WorkbenchSidebar projectId={session.projectId} activeSessionId={session.sessionId} />
      }
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
                {[...runs].reverse().map((r) => (
                  <option key={r.runId} value={`run:${r.runId}`}>
                    {t('scopes.run', { runId: r.runId })}
                  </option>
                ))}
              </select>
            </label>
            {changes ? (
              <span className="text-xs text-muted">
                {t('files', { count: changes.files.length })}
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
          {error ? (
            <p role="alert" className="p-3 text-sm text-danger">
              {t('failed', { message: error })}
            </p>
          ) : null}
          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[16rem_minmax(0,1fr)_20rem]">
            <nav
              aria-label={t('reviewHeading')}
              className="min-h-0 overflow-auto border-line p-2 md:border-r"
            >
              {changes?.unavailable ? (
                <p className="text-xs text-muted">{t('noBaseline')}</p>
              ) : null}
              {changes && !changes.unavailable && changes.files.length === 0 ? (
                <p className="text-xs text-muted">{t('noChanges')}</p>
              ) : null}
              <ul className="flex flex-col gap-1">
                {changes?.files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      aria-current={selected === file.path ? 'true' : undefined}
                      onClick={() => choose(file.path)}
                      className={`flex w-full flex-col rounded border px-2 py-1 text-left text-xs ${
                        selected === file.path ? 'border-accent bg-raised' : 'border-line'
                      }`}
                    >
                      <span className="break-all font-mono">{file.path}</span>
                      <span className="text-muted">
                        {t(`status.${file.status}`)}
                        {file.additions !== null
                          ? ` · +${file.additions} −${file.deletions ?? 0}`
                          : ''}
                        {file.binary ? ' · bin' : ''} · {t(`provenance.${file.provenance}`)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <section aria-label={selected ?? t('chooseFile')} className="min-h-0 overflow-auto p-3">
              {selected && changes?.from && changes.to ? (
                <FileDiff
                  sessionId={session.sessionId}
                  from={changes.from}
                  to={changes.to}
                  path={selected}
                  comments={comments.filter(
                    (c) => c.from === changes.from && c.to === changes.to && c.path === selected,
                  )}
                  onComment={async (comment) => {
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
  sessionId,
  from,
  to,
  path,
  comments,
  onComment,
}: {
  sessionId: string;
  from: string;
  to: string;
  path: string;
  comments: ReviewCommentView[];
  onComment: (comment: NewComment) => Promise<void>;
}) {
  const t = useTranslations('Files');
  const { workspaces } = useServices();
  const [sides, setSides] = useState<{ before: FileSideView; after: FileSideView } | null>(null);
  const [layout, setLayout] = useState<'unified' | 'split'>('unified');
  useEffect(() => {
    let live = true;
    setSides(null);
    void workspaces?.fileVersions(sessionId, from, to, path).then((v) => live && setSides(v));
    return () => {
      live = false;
    };
  }, [workspaces, sessionId, from, to, path]);
  const lines = useMemo(() => {
    if (!sides) return null;
    const before = sideText(sides.before);
    const after = sideText(sides.after);
    return before === null || after === null ? null : diffLines(before, after);
  }, [sides]);
  if (!sides) return <p className="text-sm text-muted">…</p>;
  const notText = (side: FileSideView) =>
    side.kind === 'binary' ? t('binary') : side.kind === 'too_large' ? t('tooLarge') : null;
  return (
    <div className="flex flex-col gap-2" data-testid="file-diff">
      <div className="flex items-center gap-2">
        <h3 className="break-all font-mono text-sm">{path}</h3>
        <fieldset className="ml-auto flex gap-1 text-xs">
          {(['unified', 'split'] as const).map((value) => (
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
      {notText(sides.before) || notText(sides.after) ? (
        <p className="text-sm text-muted">{notText(sides.after) ?? notText(sides.before)}</p>
      ) : lines ? (
        layout === 'unified' ? (
          <Unified lines={lines} comments={comments} onComment={onComment} />
        ) : (
          <Split lines={lines} />
        )
      ) : null}
    </div>
  );
}

const lineClass = (kind: DiffLine['kind']) =>
  kind === 'added' ? 'bg-success/15' : kind === 'removed' ? 'bg-danger/15' : '';

/** One column; each line can take a comment, fixed to its side and number (WB-REV-001). */
function Unified({
  lines,
  comments,
  onComment,
}: {
  lines: DiffLine[];
  comments: ReviewCommentView[];
  onComment: (comment: NewComment) => Promise<void>;
}) {
  const t = useTranslations('Review');
  const [open, setOpen] = useState<number | null>(null);
  const [body, setBody] = useState('');
  let before = 0;
  let after = 0;
  const numbered = lines.map((line) => {
    if (line.kind !== 'added') before++;
    if (line.kind !== 'removed') after++;
    return {
      line,
      side: line.kind === 'removed' ? ('before' as const) : ('after' as const),
      no: line.kind === 'removed' ? before : after,
    };
  });
  return (
    <div className="overflow-auto rounded border border-line bg-surface font-mono text-[13px]">
      {numbered.map(({ line, side, no }, index) => {
        const here = comments.filter((c) => c.side === side && c.startLine === no);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff rows have no identity beyond their place
          <div key={index}>
            <div data-diff={line.kind} className={`group flex ${lineClass(line.kind)}`}>
              <button
                type="button"
                aria-label={t('commentLine', { line: no })}
                onClick={() => {
                  setOpen(open === index ? null : index);
                  setBody('');
                }}
                className="w-12 shrink-0 select-none px-1 text-right text-muted hover:text-accent"
              >
                {no}
              </button>
              <span className="whitespace-pre-wrap break-all px-2">
                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                {line.text}
              </span>
            </div>
            {here.map((c) => (
              <p
                key={c.commentId}
                data-testid="inline-comment"
                className="ml-12 border-l-2 border-accent bg-raised px-2 py-1 font-sans text-xs"
              >
                {c.body} <span className="text-muted">· {t(`commentState.${c.state}`)}</span>
              </p>
            ))}
            {open === index ? (
              <form
                className="ml-12 flex flex-col gap-1 bg-raised p-2 font-sans"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!body.trim()) return;
                  void onComment({ side, startLine: no, endLine: no, quote: line.text, body }).then(
                    () => setOpen(null),
                  );
                }}
              >
                <textarea
                  aria-label={t('commentLine', { line: no })}
                  placeholder={t('commentPlaceholder')}
                  value={body}
                  rows={2}
                  onChange={(e) => setBody(e.target.value)}
                  className="rounded border border-line bg-surface p-1 text-xs"
                />
                <div className="flex gap-1 text-xs">
                  <button type="submit" className="rounded bg-accent px-2 py-0.5 text-on-accent">
                    {t('addComment')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpen(null)}
                    className="rounded border border-line px-2 py-0.5"
                  >
                    {t('cancel')}
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Split({ lines }: { lines: DiffLine[] }) {
  const t = useTranslations('Files');
  // Removed lines on the left, added on the right, shared lines on both, aligned in order.
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
  for (const line of lines) {
    if (line.kind === 'same') rows.push({ left: line, right: line });
    else if (line.kind === 'removed') rows.push({ left: line, right: null });
    else {
      const open = rows.findLast((r) => r.left?.kind === 'removed' && r.right === null);
      if (open) open.right = line;
      else rows.push({ left: null, right: line });
    }
  }
  return (
    <table className="w-full table-fixed border-collapse font-mono text-[13px]">
      <thead className="text-left text-xs text-muted">
        <tr>
          <th className="px-2">{t('before')}</th>
          <th className="px-2">{t('after')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff rows have no identity beyond their place
          <tr key={index} className="align-top">
            <td
              className={`whitespace-pre-wrap break-all px-2 ${row.left ? lineClass(row.left.kind) : ''}`}
            >
              {row.left?.text ?? ''}
            </td>
            <td
              className={`whitespace-pre-wrap break-all px-2 ${row.right ? lineClass(row.right.kind) : ''}`}
            >
              {row.right?.text ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const { workspaces } = useServices();
  const [results, setResults] = useState<VerificationResultView[]>([]);
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
      {commands.length === 0 ? <p className="text-xs text-muted">{t('noChecks')}</p> : null}
      <div className="flex flex-wrap gap-1">
        {commands.map((command) => (
          <button
            key={command.id}
            type="button"
            disabled={running}
            onClick={() => void workspaces?.verify(sessionId, command.id).then(reload)}
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
                {t(`checkState.${r.state}`)}
              </span>
              {r.endedAt ? (
                <span className="text-muted">
                  {t('checkMeta', { code: r.exitCode ?? '—', ms: r.durationMs ?? 0 })}
                </span>
              ) : null}
              {r.timedOut ? <span className="text-danger">{t('timedOut')}</span> : null}
              {r.stale ? <span className="text-warning">{t('stale')}</span> : null}
            </div>
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
      if (active && steerTo) {
        ({ sent, detail } = await steer(services, active.runId, steerTo.id, text));
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
