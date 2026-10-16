import type {
  ChangeScopeQuery,
  ChangeSetView,
  FileOperationView,
  FileSideView,
  VerificationResultView,
  WorkspaceBindingView,
} from '@corral/client';
import type { RunSummary } from '@corral/core';
import { type DiffLine, diffLines } from '@corral/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { reviewRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { useBinding } from './FilesViews.tsx';

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
    <main className="flex h-full min-h-0 flex-col">
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
          <span className="text-xs text-muted">{t('files', { count: changes.files.length })}</span>
        ) : null}
        <button
          type="button"
          onClick={() =>
            void workspaces?.markReviewed(session.sessionId).then(() => setVersion((n) => n + 1))
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
          {changes?.unavailable ? <p className="text-xs text-muted">{t('noBaseline')}</p> : null}
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
                    {file.additions !== null ? ` · +${file.additions} −${file.deletions ?? 0}` : ''}
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
            />
          ) : (
            <p className="text-sm text-muted">{t('chooseFile')}</p>
          )}
        </section>
        <aside className="flex min-h-0 flex-col gap-3 overflow-auto border-line p-3 md:border-l">
          <Checks sessionId={session.sessionId} binding={binding ?? null} changed={version} />
          <Operations sessionId={session.sessionId} />
        </aside>
      </div>
    </main>
  );
}

const sideText = (side: FileSideView) =>
  side.kind === 'text' ? side.text : side.kind === 'absent' ? '' : null;

function FileDiff({
  sessionId,
  from,
  to,
  path,
}: {
  sessionId: string;
  from: string;
  to: string;
  path: string;
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
          <Unified lines={lines} />
        ) : (
          <Split lines={lines} />
        )
      ) : null}
    </div>
  );
}

const lineClass = (kind: DiffLine['kind']) =>
  kind === 'added' ? 'bg-success/15' : kind === 'removed' ? 'bg-danger/15' : '';

function Unified({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="overflow-auto rounded border border-line bg-surface font-mono text-[13px]">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff rows have no identity beyond their place
        <div key={index} data-diff={line.kind} className={`px-2 ${lineClass(line.kind)}`}>
          {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
          {line.text}
        </div>
      ))}
    </pre>
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

function Checks({
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
