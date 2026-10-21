import { ApiError, type FileBrowseScope } from '@corral/client';
import {
  canonicalJson,
  type GitDiff,
  type GitDiffRequest,
  type GitStatus,
  type GitStatusEntry,
} from '@corral/contracts';
import { Button, Select } from '@corral/react/ui';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { FileDiff } from '../pages/ReviewPage.tsx';
import { useServices } from '../services.tsx';

type Side = GitDiffRequest['side'];
const sides: Side[] = ['staged', 'unstaged', 'untracked'];
const changed = (value: string) => value !== '.' && value.trim() !== '';
const belongs = (entry: GitStatusEntry, side: Side) =>
  side === 'untracked'
    ? entry.kind === 'untracked'
    : entry.kind !== 'untracked' &&
      entry.kind !== 'unmerged' &&
      changed(side === 'staged' ? entry.indexStatus : entry.worktreeStatus);

/** User Git observations are separate from Corral's internal snapshot comparisons. */
export function GitPanel({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const t = useTranslations('Git');
  const { workspaces, workspaceId, mode } = useServices();
  const [source, setSource] = useState<'session' | 'project'>('session');
  const [revision, setRevision] = useState(0);
  const query = useMemo(
    () => ({
      client: workspaces,
      hostId: workspaceId,
      projectId,
      revision,
      mode,
      scope: { kind: source, id: source === 'session' ? sessionId : projectId } as FileBrowseScope,
    }),
    [workspaces, workspaceId, projectId, revision, mode, source, sessionId],
  );
  const [loaded, setLoaded] = useState<{
    query: typeof query;
    data: GitStatus | null;
    error: boolean;
  } | null>(null);
  const [selection, setSelection] = useState<{
    query: typeof query;
    side: Side;
    path: string;
  } | null>(null);
  const result = loaded?.query === query ? loaded : null;
  const status = result?.data ?? null;
  const selected = selection?.query === query ? selection : null;
  const id = useId();
  useEffect(() => {
    let live = true;
    const client = query.client;
    if (!client || query.mode !== 'server' || !query.hostId) {
      setLoaded({ query, data: null, error: true });
      return;
    }
    void client.gitStatus(query.scope).then(
      (data) => {
        if (!live) return;
        const target = data.target;
        const matches =
          target.kind === query.scope.kind &&
          target.hostId === query.hostId &&
          target.projectId === query.projectId &&
          (target.kind === 'project'
            ? target.projectId === query.scope.id
            : target.sessionId === query.scope.id);
        setLoaded({ query, data: matches ? data : null, error: !matches });
      },
      () => {
        if (live) setLoaded({ query, data: null, error: true });
      },
    );
    return () => {
      live = false;
    };
  }, [query]);
  const loadKey =
    status && selected
      ? canonicalJson([
          status.target,
          selected.side,
          selected.path,
          status.head.oid,
          status.indexHash,
          revision,
        ])
      : '';
  const loadDiff = async () => {
    if (!status || !selected || !query.client) throw new Error(t('unavailable'));
    const request: GitDiffRequest = {
      target: status.target,
      side: selected.side,
      path: selected.path,
      head: status.head.oid,
      indexHash: status.indexHash,
    };
    let response: GitDiff;
    try {
      response = await query.client.gitDiff(query.scope, request);
    } catch (error) {
      throw new Error(
        t(error instanceof ApiError && error.status === 409 ? 'stateChanged' : 'unavailable'),
      );
    }
    if (
      canonicalJson(response.target) !== canonicalJson(request.target) ||
      response.side !== request.side ||
      response.path !== request.path ||
      response.head !== request.head ||
      response.indexHash !== request.indexHash
    )
      throw new Error(t('stateChanged'));
    if (response.kind === 'unsupported') throw new Error(t('unsupported'));
    return { before: response.before, after: response.after };
  };
  const conflicts = status?.entries.filter((entry) => entry.kind === 'unmerged') ?? [];
  return (
    <section aria-label={t('title')} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label={t('source')}
          size="sm"
          value={source}
          onValueChange={(value) => setSource(value as 'session' | 'project')}
          options={[
            { value: 'session', label: t('sessionSource') },
            { value: 'project', label: t('projectSource') },
          ]}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!result}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t('refresh')}
        </Button>
      </div>
      {!result ? (
        <p role="status" className="text-xs text-muted">
          {t('loading')}
        </p>
      ) : result.error ? (
        <p role="alert" className="text-xs text-muted">
          {t('unavailable')}
        </p>
      ) : null}
      {status ? (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span>
              {t('branch')}:{' '}
              <span className="break-all font-mono">{status.head.branch ?? '—'}</span>
            </span>
            <span title={status.head.oid ?? undefined}>
              {t('head')}: <code>{status.head.oid?.slice(0, 12) ?? '—'}</code>
            </span>
            {status.head.detached ? <span>{t('detached')}</span> : null}
            {status.head.unborn ? <span>{t('unborn')}</span> : null}
            {status.head.shallow ? <span>{t('shallow')}</span> : null}
            <span>
              {t('upstream')}:{' '}
              <span className="break-all font-mono">
                {status.head.upstream?.name ?? t('noUpstream')}
              </span>
            </span>
            {status.head.upstream &&
            status.head.upstream.ahead !== null &&
            status.head.upstream.behind !== null ? (
              <span>
                {t('aheadBehind', {
                  ahead: status.head.upstream.ahead,
                  behind: status.head.upstream.behind,
                })}
              </span>
            ) : null}
          </div>
          {status.filtersDisabled ? <p className="text-xs text-muted">{t('rawContent')}</p> : null}
          {status.truncated ? (
            <p role="status" className="text-xs text-warning">
              {t('truncated')}
            </p>
          ) : null}
          {!status.entries.length ? <p className="text-xs text-muted">{t('noChanges')}</p> : null}
          {sides.map((side) => {
            const entries = status.entries.filter((entry) => belongs(entry, side));
            return (
              <section key={side} aria-labelledby={`${id}-${side}`} className="flex flex-col gap-1">
                <h3 id={`${id}-${side}`} className="text-xs font-semibold">
                  {t(side)} · {entries.length}
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        data-git-side={side}
                        data-path={entry.path}
                        aria-pressed={selected?.side === side && selected.path === entry.path}
                        onClick={() => setSelection({ query, side, path: entry.path })}
                        className={`flex w-full flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-subtle ${selected?.side === side && selected.path === entry.path ? 'bg-subtle' : ''}`}
                      >
                        <span className="whitespace-pre-wrap break-all font-mono">
                          {entry.originalPath ? `${entry.originalPath} → ` : ''}
                          {entry.path}
                        </span>
                        <span className="text-muted">
                          {side === 'staged' ? entry.indexStatus : entry.worktreeStatus}
                          {entry.submodule ? ` · ${t('submodule')}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {conflicts.length ? (
            <section aria-labelledby={`${id}-conflicts`} className="flex flex-col gap-1">
              <h3 id={`${id}-conflicts`} className="text-xs font-semibold">
                {t('conflicts')} · {conflicts.length}
              </h3>
              <p className="text-xs text-warning">{t('conflictUnavailable')}</p>
              <ul>
                {conflicts.map((entry) => (
                  <li key={entry.path} className="whitespace-pre-wrap break-all font-mono text-xs">
                    {entry.path}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {selected ? (
            <section
              aria-label={t(`comparison.${selected.side}`)}
              className="flex min-w-0 flex-col gap-2"
            >
              <h3 className="text-xs font-semibold">{t(`comparison.${selected.side}`)}</h3>
              <FileDiff key={loadKey} path={selected.path} loadKey={loadKey} load={loadDiff} />
            </section>
          ) : (
            <p className="text-xs text-muted">{t('selectFile')}</p>
          )}
        </>
      ) : null}
    </section>
  );
}
