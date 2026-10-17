import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import {
  ExecutionTranscript,
  type ResultItem,
  ReviewSummary,
  RunReason,
  runResults,
  SafeMarkdown,
  StatusBadge,
} from '@corral/react';
import { Activity, ChevronRight, FileText, LoaderCircle } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useRemembered } from '../pages/Workbench.tsx';
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
  const trun = useTranslations('Run');
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
  const executions = projection.executionOrder.flatMap((id) => projection.executions[id] ?? []);
  const agents = executions.filter((execution) =>
    working ? !TERMINAL_EXECUTION_STATUSES.has(execution.status) : execution.status === 'failed',
  );
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {projection.statusReason &&
      projection.status !== 'running' &&
      projection.status !== 'succeeded' ? (
        <p data-testid="run-reason" className="text-xs text-muted">
          {trun('reasonPrefix')} <RunReason code={projection.statusReason} nodeLabel={label} />
        </p>
      ) : null}
      {agents.length ? (
        <section aria-label={t('teamActivity')} data-testid="team-activity" className="space-y-2">
          <h3 className="text-xs font-medium text-muted">{t('teamActivity')}</h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {agents.map((execution) => (
              <li
                key={execution.executionId}
                className="min-w-0 rounded-lg border border-line p-2 text-xs wrap-anywhere"
              >
                <Link
                  to={sessionId ? '/sessions/$sessionId' : '/runs/$runId'}
                  params={sessionId ? { sessionId } : { runId }}
                  search={{
                    ...(sessionId ? { tab: 'run' as const, run: runId } : {}),
                    view: 'run',
                    execution: execution.executionId,
                  }}
                  title={execution.executionId}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {label(execution.nodeId)} · #
                  {projection.executionOrder.indexOf(execution.executionId) + 1}
                </Link>
                <div className="mt-1">
                  <StatusBadge status={execution.status} />
                </div>
                {execution.waitingOn ? (
                  <p className="mt-1 text-muted">
                    {trun(`waiting.${execution.waitingOn.kind}`, {
                      count: execution.waitingOn.targetIds.length,
                    })}
                  </p>
                ) : null}
                {execution.error ? <p className="mt-1 text-danger">{execution.error}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
          {projection.status === 'running' ? (
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
                    <span className="font-medium">
                      {label(execution.nodeId)} · #{projection.executionOrder.indexOf(id) + 1}
                    </span>
                    <StatusBadge status={execution.status} />
                  </summary>
                  <ExecutionTranscript session={store} executionId={id} />
                </details>
              );
            })}
          </div>
        ) : null}
      </details>
      {visible.map((result, index) => (
        <ChatResult
          key={result.artifactVersionId}
          result={result}
          text={state.artifactTexts[result.artifactVersionId]}
          projection={projection}
          label={label}
          sessionId={sessionId}
          partial={results?.kind === 'partial'}
          first={index === 0}
        />
      ))}
      {state.streamError ? (
        <p role="alert" className="text-xs text-danger">
          {state.streamError}
        </p>
      ) : null}
    </div>
  );
}

function ChatResult({
  result,
  text,
  projection,
  label,
  sessionId,
  partial,
  first,
}: {
  result: ResultItem;
  text: string | undefined;
  projection: RunProjection;
  label: (nodeId: string) => string;
  sessionId: string | null;
  partial: boolean;
  first: boolean;
}) {
  const t = useTranslations('Desktop');
  const tr = useTranslations('Results');
  const ta = useTranslations('Artifact');
  const [open, setOpen] = useRemembered(
    `corral:chat-result:v1:${projection.runId}:${result.artifactVersionId}`,
    first,
  );
  const author = projection.executions[result.authorExecutionId];
  const review = projection.reviews[result.artifactVersionId];
  const target = review ? projection.artifacts[review.targetVersionId] : null;
  const location = {
    to: sessionId ? ('/sessions/$sessionId' as const) : ('/runs/$runId' as const),
    params: sessionId ? { sessionId } : { runId: projection.runId },
  };
  const search = (id: string) => ({
    ...(sessionId ? { tab: 'run' as const, run: projection.runId } : {}),
    view: 'results' as const,
    result: id,
  });
  return (
    <details
      open={open === true}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0 space-y-3 text-[14px] leading-7 wrap-anywhere"
      data-testid="chat-result"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-xs text-muted hover:text-text">
        <FileText size={14} />
        {partial ? tr('partial') : t('result')} · {result.name} v{result.version}
        {author ? (
          <span>
            · {label(author.nodeId)} #{projection.executionOrder.indexOf(author.executionId) + 1}
          </span>
        ) : null}
        <ChevronRight size={13} className={open ? 'rotate-90' : ''} />
      </summary>
      {open === true ? (
        <>
          {review ? (
            <ReviewSummary
              review={review}
              target={
                <Link {...location} search={search(review.targetVersionId)} className="underline">
                  {target ? `${target.name} v${target.version}` : review.targetVersionId}
                </Link>
              }
            />
          ) : text === undefined ? (
            <p className="text-xs text-muted">{ta('loading')}</p>
          ) : (
            <SafeMarkdown text={text} />
          )}
          <Link
            {...location}
            search={search(result.artifactVersionId)}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-text"
          >
            {tr('openResults')}
            <ChevronRight size={12} />
          </Link>
        </>
      ) : null}
    </details>
  );
}
