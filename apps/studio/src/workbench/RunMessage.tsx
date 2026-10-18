import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import {
  ExecutionTranscript,
  ReasoningSummary,
  type ResultItem,
  ReviewSummary,
  RunReason,
  runResults,
  SafeMarkdown,
  StatusBadge,
} from '@corral/react';
import { Activity, ChevronRight, FileText, LoaderCircle, Pause } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { markRunReviewed } from '../pages/GettingStarted.tsx';
import { useRemembered } from '../pages/Workbench.tsx';
import { agentSummary } from './agentSummary.ts';
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
  const busy = working
    ? executions.filter((execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status))
    : [];
  const summary = agentSummary(busy.map((execution) => execution.status));
  // Failures are never folded away (CR-015-03): each failed agent and its error stays in view.
  const failed = executions.filter((execution) => execution.status === 'failed');
  const name = (executionId: string) => {
    const execution = projection.executions[executionId];
    return execution
      ? `${label(execution.nodeId)} · #${projection.executionOrder.indexOf(executionId) + 1}`
      : executionId;
  };
  // What a model is writing right now, shown in the conversation; never a fact (C-018).
  const writing = working
    ? Object.entries(state.streams)
        .filter(
          ([id, stream]) =>
            !stream.completed && !stream.broken && !projection.modelCalls[id]?.finished,
        )
        .at(-1)
    : undefined;
  const writer = writing ? projection.modelCalls[writing[0]]?.executionId : undefined;
  const agentRow = (execution: (typeof executions)[number]) => (
    <li key={execution.executionId} className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
      <Link
        to={sessionId ? '/sessions/$sessionId' : '/runs/$runId'}
        params={sessionId ? { sessionId } : { runId }}
        search={{
          ...(sessionId ? { panel: 'run' as const, run: runId } : {}),
          view: 'run',
          execution: execution.executionId,
        }}
        title={execution.executionId}
        className="font-medium hover:underline"
      >
        {name(execution.executionId)}
      </Link>
      <StatusBadge status={execution.status} />
      {execution.modelCallIds.at(-1) ? (
        <ReasoningSummary call={projection.modelCalls[execution.modelCallIds.at(-1)!]!} />
      ) : null}
      {execution.waitingOn ? (
        <span className="text-muted">
          {trun(`waiting.${execution.waitingOn.kind}`, {
            count: execution.waitingOn.targetIds.length,
          })}
        </span>
      ) : null}
      {execution.error ? <p className="w-full text-danger">{execution.error}</p> : null}
    </li>
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {projection.statusReason &&
      projection.status !== 'running' &&
      projection.status !== 'succeeded' ? (
        <p data-testid="run-reason" className="text-xs text-muted">
          {trun('reasonPrefix')} <RunReason code={projection.statusReason} nodeLabel={label} />
        </p>
      ) : null}
      {busy.length || failed.length ? (
        <section aria-label={t('teamActivity')} data-testid="team-activity" className="text-xs">
          {failed.length ? (
            <ul className="mb-1 flex flex-col gap-1">{failed.map(agentRow)}</ul>
          ) : null}
          {busy.length ? (
            <details className="group/agents">
              <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 text-muted hover:text-text">
                {summary.working > 0 && projection.status === 'running' ? (
                  <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <Pause size={13} />
                )}
                <span data-testid="agent-summary">
                  {[
                    t('agents.working', { count: summary.working }),
                    ...summary.groups.map(([group, count]) => t(`agents.${group}`, { count })),
                  ].join(' · ')}
                </span>
                <ChevronRight
                  size={12}
                  className="transition-transform group-open/agents:rotate-90"
                />
              </summary>
              <ul className="mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
                {busy.map(agentRow)}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
      {writing ? (
        <div data-testid="live-text" aria-live="off" className="min-w-0">
          <p className="mb-1 text-2xs text-muted">
            {t('writing', { name: writer ? name(writer) : '' })}
          </p>
          <p className="live-text max-h-40 overflow-hidden text-sm leading-6 whitespace-pre-wrap text-text/80 wrap-anywhere">
            {writing[1].text.slice(-1200)}
            <span
              aria-hidden="true"
              className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-muted align-text-bottom motion-reduce:animate-none"
            />
          </p>
        </div>
      ) : null}
      {resultError ? (
        <p role="alert" className="flex items-center gap-2 text-xs text-danger">
          {t('resultUnavailable')}
          <Button variant="outline" size="xs" onClick={() => setRetry((value) => value + 1)}>
            {t('retryResult')}
          </Button>
        </p>
      ) : null}
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
      <details className="work-log group/log" onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded py-0.5 text-xs text-muted hover:text-text">
          <Activity size={13} />
          {t('activity')}
          <span className="tabular-nums">{projection.executionOrder.length}</span>
          <ChevronRight size={12} className="transition-transform group-open/log:rotate-90" />
        </summary>
        {expanded ? (
          <div className="mt-2 space-y-1 border-l border-line pl-3">
            {projection.executionOrder.map((id) => {
              const execution = projection.executions[id];
              if (!execution) return null;
              return (
                <details key={id} className="text-xs">
                  <summary className="flex cursor-pointer items-center gap-2 py-1.5">
                    <span className="font-medium">{name(id)}</span>
                    <StatusBadge status={execution.status} />
                    {execution.modelCallIds.at(-1) ? (
                      <ReasoningSummary
                        call={projection.modelCalls[execution.modelCallIds.at(-1)!]!}
                      />
                    ) : null}
                  </summary>
                  <ExecutionTranscript session={store} executionId={id} />
                </details>
              );
            })}
          </div>
        ) : null}
      </details>
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
  // Reading a result in the conversation is the checklist's last step (UX-09).
  useEffect(() => {
    if (open === true && text !== undefined) markRunReviewed();
  }, [open, text]);
  const author = projection.executions[result.authorExecutionId];
  const review = projection.reviews[result.artifactVersionId];
  const target = review ? projection.artifacts[review.targetVersionId] : null;
  const location = {
    to: sessionId ? ('/sessions/$sessionId' as const) : ('/runs/$runId' as const),
    params: sessionId ? { sessionId } : { runId: projection.runId },
  };
  const search = (id: string) => ({
    ...(sessionId ? { panel: 'run' as const, run: projection.runId } : {}),
    view: 'results' as const,
    result: id,
  });
  return (
    <details
      open={open === true}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0 space-y-3 text-sm leading-7 wrap-anywhere"
      data-testid="chat-result"
    >
      <summary className="flex w-fit cursor-pointer list-none flex-wrap items-center gap-1.5 rounded text-xs text-muted hover:text-text">
        <FileText size={13} />
        {partial ? tr('partial') : t('result')} · {result.name} v{result.version}
        {author ? (
          <span>
            · {label(author.nodeId)} #{projection.executionOrder.indexOf(author.executionId) + 1}
          </span>
        ) : null}
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </summary>
      {open === true ? (
        <>
          {review ? (
            <ReviewSummary
              review={review}
              target={
                <Link
                  {...location}
                  search={search(review.targetVersionId)}
                  className="underline-offset-2 hover:underline"
                >
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
