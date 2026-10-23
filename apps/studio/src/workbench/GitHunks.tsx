import { ApiError, type WorkspacesApi } from '@corral/client';
import {
  canonicalJson,
  type GitHunksRequest,
  type GitHunks as GitHunksView,
  type GitHunkWrite,
} from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

interface Props {
  sessionId: string;
  request: GitHunksRequest;
  disabled: boolean;
  onCommand(command: Omit<GitHunkWrite, 'operationId'>): Promise<void>;
}
const reasons = new Set([
  'binary',
  'too_large',
  'renamed',
  'mode',
  'filter',
  'symlink',
  'gitlink',
  'unmerged',
  'untracked',
  'added_deleted',
  'path',
  'no_hunks',
]);

export function GitHunks(props: Props) {
  const { workspaces, mode, workspaceId } = useServices();
  if (
    !workspaces?.gitHunks ||
    mode !== 'server' ||
    props.request.target.hostId !== workspaceId ||
    props.request.target.sessionId !== props.sessionId
  )
    return null;
  const queryKey = canonicalJson([props.sessionId, props.request]);
  return <HunkSelection key={queryKey} {...props} client={workspaces} queryKey={queryKey} />;
}

function HunkSelection({
  client,
  queryKey,
  sessionId,
  request,
  disabled,
  onCommand,
}: Props & {
  client: Pick<WorkspacesApi, 'gitHunks'>;
  queryKey: string;
}) {
  const t = useTranslations('GitHunks');
  const [loaded, setLoaded] = useState<{
    client: typeof client;
    value: GitHunksView | null;
    error: 'changed' | 'unavailable' | null;
  } | null>(null);
  const [selection, setSelection] = useState<{ snapshot: GitHunksView; ids: string[] } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState('');
  const inFlight = useRef(false);
  const epoch = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey fixes the entire request; a new parent object with the same request is not a new read.
  useEffect(() => {
    const revision = ++epoch.current;
    setLoaded(null);
    setFailure('');
    inFlight.current = false;
    setSubmitting(false);
    void client.gitHunks(sessionId, request).then(
      (value) => {
        if (epoch.current !== revision) return;
        const observed = {
          target: value.target,
          side: value.side,
          path: value.path,
          head: value.head,
          indexHash: value.indexHash,
        };
        const matches = canonicalJson(observed) === canonicalJson(request);
        setLoaded({ client, value: matches ? value : null, error: matches ? null : 'changed' });
      },
      (error) => {
        if (epoch.current === revision)
          setLoaded({
            client,
            value: null,
            error: error instanceof ApiError && error.status === 409 ? 'changed' : 'unavailable',
          });
      },
    );
    return () => {
      ++epoch.current;
    };
  }, [client, queryKey]);
  const view = loaded?.client === client ? loaded : null;
  const value = view?.value;
  const ids = value && selection?.snapshot === value ? selection.ids : [];
  const submit = async () => {
    if (value?.kind !== 'hunks' || !ids.length || disabled || inFlight.current) return;
    const revision = epoch.current;
    inFlight.current = true;
    setSubmitting(true);
    setFailure('');
    const { kind: _kind, ...target } = value.target;
    try {
      await onCommand({
        kind: value.side === 'staged' ? 'unstage_hunks' : 'stage_hunks',
        target,
        expect: { head: value.head, indexHash: value.indexHash },
        path: value.path,
        identity: value.identity,
        hunkIds: value.hunks.filter((hunk) => ids.includes(hunk.id)).map((hunk) => hunk.id),
      });
    } catch (error) {
      if (epoch.current === revision)
        setFailure(error instanceof Error ? error.message : t('unavailable'));
    } finally {
      if (epoch.current === revision) {
        inFlight.current = false;
        setSubmitting(false);
      }
    }
  };
  return (
    <section aria-label={t('title')} className="flex min-w-0 flex-col gap-2 text-xs">
      <h4 className="font-medium">{t('title')}</h4>
      {!view ? (
        <p role="status" className="text-muted">
          {t('loading')}
        </p>
      ) : view.error ? (
        <p role="alert" className="text-warning">
          {t(view.error)}
        </p>
      ) : null}
      {value?.kind === 'unsupported' ? (
        <p className="text-muted">
          {t('unsupported', {
            reason: t(`reason.${reasons.has(value.reason) ? value.reason : 'other'}`),
          })}
        </p>
      ) : null}
      {value?.kind === 'hunks' ? (
        <>
          <details className="text-muted">
            <summary className="cursor-pointer">{t('reviewBasis')}</summary>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {(
                [
                  ['head', value.head],
                  ['index', value.indexHash],
                  ['working', value.workingHash],
                  ['patch', value.identity],
                ] as const
              ).map(([label, hash]) => (
                <span key={label}>
                  {t(label)}: <code title={hash ?? undefined}>{hash?.slice(0, 12) ?? '—'}</code>
                </span>
              ))}
            </p>
          </details>
          {value.hunks.length ? (
            <ul className="flex min-w-0 flex-col gap-2">
              {value.hunks.map((hunk) => (
                <li key={hunk.id} className="flex min-w-0 flex-col gap-1">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={ids.includes(hunk.id)}
                      disabled={disabled || submitting}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...ids, hunk.id]
                          : ids.filter((id) => id !== hunk.id);
                        setSelection({ snapshot: value, ids: next });
                      }}
                    />
                    <span className="break-all font-mono">{hunk.header}</span>
                  </label>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded fill-group p-2">
                    {hunk.patch}
                  </pre>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">{t('empty')}</p>
          )}
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            disabled={disabled || submitting || !ids.length}
            onClick={() => void submit()}
          >
            {t(value.side === 'staged' ? 'unstage' : 'stage')}
          </Button>
        </>
      ) : null}
      {failure ? (
        <p role="alert" className="text-danger">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
