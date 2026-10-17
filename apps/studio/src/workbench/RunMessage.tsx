import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { ExecutionTranscript, runResults, SafeMarkdown, StatusBadge } from '@corral/react';
import { Activity, ChevronRight, FileText, LoaderCircle } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useCorralRun } from './useCorralChat.ts';

/** T3's expandable work log and response surface, projected from Corral executions. */
export function RunMessage({
  runId,
  sessionId,
  live,
}: {
  runId: string;
  sessionId: string | null;
  live: boolean;
}) {
  const t = useTranslations('Desktop');
  const tr = useTranslations('Results');
  const [expanded, setExpanded] = useState(false);
  const [resultError, setResultError] = useState(false);
  const [retry, setRetry] = useState(0);
  const { store, state } = useCorralRun(runId, live, expanded);
  const results = useMemo(
    () => (state.projection ? runResults(state.projection) : null),
    [state.projection],
  );
  const visible = results?.final.length
    ? results.final
    : results?.kind === 'partial'
      ? results.intermediate.map((g) => g.latest)
      : [];
  const ids = visible.map((x) => x.artifactVersionId).join(',');
  useEffect(() => {
    void retry;
    let current = true;
    setResultError(false);
    void Promise.all(
      ids
        .split(',')
        .filter(Boolean)
        .map(async (id) => {
          await store.getState().loadArtifact(id);
          if (!(id in store.getState().artifactTexts)) throw new Error('unavailable');
        }),
    ).catch(() => {
      if (current) setResultError(true);
    });
    return () => {
      current = false;
    };
  }, [ids, store, retry]);
  const projection = state.projection;
  if (!projection)
    return state.streamError ? (
      <p role="alert" className="text-sm text-danger">
        {state.streamError}
      </p>
    ) : (
      <div className="h-4 w-24 animate-pulse rounded bg-line/30" />
    );
  const working = !TERMINAL_RUN_STATUSES.has(projection.status);
  const label = (nodeId: string) =>
    state.definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {resultError ? (
        <p role="alert" className="text-xs text-danger">
          {t('resultUnavailable')}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t('retryResult')}
          </button>
        </p>
      ) : null}
      <details className="work-log" onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-xs text-muted hover:text-text">
          {working ? (
            <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Activity size={14} />
          )}
          {t('activity')}
          <span className="tabular-nums">{projection.executionOrder.length}</span>
          <ChevronRight size={13} className={expanded ? 'rotate-90' : ''} />
        </summary>
        {expanded ? (
          <div className="mt-3 space-y-3 border-l border-line pl-4">
            {projection.executionOrder.map((id) => {
              const execution = projection.executions[id];
              if (!execution) return null;
              return (
                <details key={id} className="text-xs">
                  <summary className="flex cursor-pointer items-center gap-2 py-2">
                    <span className="font-medium">{label(execution.nodeId)}</span>
                    <StatusBadge status={execution.status} />
                  </summary>
                  <ExecutionTranscript session={store} executionId={id} />
                </details>
              );
            })}
          </div>
        ) : null}
      </details>
      {working
        ? Object.entries(state.streams)
            .filter(([, s]) => !s.completed && s.text)
            .map(([id, stream]) => {
              const call = projection.modelCalls[id];
              const execution = call ? projection.executions[call.executionId] : null;
              return (
                <div key={id} className="text-sm">
                  <p className="mb-2 text-xs text-muted">
                    {execution ? label(execution.nodeId) : t('working')}
                  </p>
                  <SafeMarkdown text={stream.text} />
                </div>
              );
            })
        : null}
      {visible.map((result) => (
        <div key={result.artifactVersionId} className="min-w-0 text-[14px] leading-7">
          <div className="mb-3 flex items-center gap-2 text-xs text-muted">
            <FileText size={14} />
            {results?.kind === 'partial' ? tr('partial') : t('result')} · {result.name} v
            {result.version}
          </div>
          <SafeMarkdown text={state.artifactTexts[result.artifactVersionId] ?? ''} />
          <Link
            to={sessionId ? '/sessions/$sessionId' : '/runs/$runId'}
            params={sessionId ? { sessionId } : { runId }}
            search={{
              ...(sessionId ? { tab: 'run' as const, run: runId } : {}),
              view: 'results',
              result: result.artifactVersionId,
            }}
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted hover:text-text"
          >
            {tr('openResults')}
            <ChevronRight size={12} />
          </Link>
        </div>
      ))}
      {state.streamError ? (
        <p role="alert" className="text-xs text-danger">
          {state.streamError}
        </p>
      ) : null}
    </div>
  );
}
