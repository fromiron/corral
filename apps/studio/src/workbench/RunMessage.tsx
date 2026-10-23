import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { pendingInteractions, type RunProjection } from '@corral/core';
import {
  ApprovalPanel,
  ExecutionTranscript,
  GeneratedImage,
  ReasoningSummary,
  type ResultItem,
  ReviewSummary,
  RunActions,
  RunReason,
  runResults,
  SafeMarkdown,
  StatusBadge,
  WorkPlanPanel,
} from '@corral/react';
import { Activity, ChevronRight, FileText, LoaderCircle, Pause } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { markRunReviewed } from '../pages/GettingStarted.tsx';
import { useRemembered } from '../pages/Workbench.tsx';
import { agentSummary } from './agentSummary.ts';
import { MessageBranch } from './MessageBranch.tsx';
import { type ChatDensity, preferences } from './preferences.ts';
import { useCorralRun } from './useCorralChat.ts';
import { toolRows } from './widgets/selectors.ts';

/** Expandable work log and response surface, projected from Corral executions. */
export function RunMessage({
  runId,
  sessionId,
  live,
  onOpenArtifact,
}: {
  runId: string;
  sessionId: string | null;
  live: boolean;
  onOpenArtifact(id: string): void;
}) {
  const t = useTranslations('Desktop');
  const trun = useTranslations('Run');
  const tw = useTranslations('Widgets');
  const chatDensity = useStore(preferences, (state) => state.chatDensity);
  const [disclosure, setDisclosure] = useState<{
    runId: string;
    density: ChatDensity;
    open: boolean;
  } | null>(null);
  const expanded =
    disclosure?.runId === runId && disclosure.density === chatDensity
      ? disclosure.open
      : chatDensity === 'detailed';
  const [openExecutions, setOpenExecutions] = useState<Record<string, boolean>>({});
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
  const ids = visible
    .filter((item) => !item.media)
    .map((x) => x.artifactVersionId)
    .join(',');
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
  const interactions = sessionId ? pendingInteractions(state.events, projection) : [];
  const requiredLabel =
    interactions.length === 1
      ? tw(interactions[0]?.kind === 'approval' ? 'actionApproval' : 'actionQuestion')
      : tw('actionMixed', { count: interactions.length });
  const label = (nodeId: string) =>
    state.definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const executions = projection.executionOrder.flatMap((id) => projection.executions[id] ?? []);
  // Current session activity lives by the composer and in the agent widget.
  // Historical failures stay visible here, while standalone consumers keep their activity row.
  const busy =
    working && !sessionId && chatDensity !== 'results'
      ? executions.filter((execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status))
      : [];
  const summary = agentSummary(busy.map((execution) => execution.status));
  // Failures and cancellations stay in view (CR-015-03). An ordinary success folds them.
  const exposed = executions.filter(
    (execution) => execution.status === 'failed' || execution.status === 'cancelled',
  );
  const name = (executionId: string) => {
    const execution = projection.executions[executionId];
    return execution
      ? `${label(execution.nodeId)} · #${projection.executionOrder.indexOf(executionId) + 1}`
      : executionId;
  };
  const toolCalls = Object.values(projection.toolCalls);
  const attention = toolRows(
    toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      name: call.name,
      phase: call.phase ?? call.status,
      effect: call.effectId ? projection.effects[call.effectId]?.outcome : null,
    })),
  ).filter((row) => row.tone !== 'ok' && row.tone !== 'running');
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
      {sessionId && interactions.length ? (
        <div
          data-testid="run-required-action"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs"
        >
          <span>{requiredLabel}</span>
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId }}
            search={{ panel: 'run', run: runId, view: 'run' }}
            className="ml-auto rounded px-2 py-1 font-medium hover:bg-subtle focus-visible:ring-2 focus-visible:ring-ring"
          >
            {tw('actionOpen')}
          </Link>
        </div>
      ) : null}
      {working && !sessionId ? <RunActions session={store} compact /> : null}
      {sessionId ? null : <ApprovalPanel session={store} onOpenArtifact={onOpenArtifact} />}
      {attention.length ? (
        <ul
          className="space-y-1 text-xs"
          aria-label={t('toolActivity', { count: attention.length })}
        >
          {attention.map((row) => (
            <li key={row.id} className="flex flex-wrap gap-x-2">
              <code>{row.name}</code>
              <span className="text-danger">{t(`toolPhase.${row.tone}`)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {projection.statusReason &&
      projection.status !== 'running' &&
      projection.status !== 'succeeded' ? (
        <p data-testid="run-reason" className="text-xs text-muted">
          {trun('reasonPrefix')} <RunReason code={projection.statusReason} nodeLabel={label} />
        </p>
      ) : null}
      {busy.length || exposed.length ? (
        <section aria-label={t('teamActivity')} data-testid="team-activity" className="text-xs">
          {exposed.length ? (
            <ul className="mb-1 flex flex-col gap-1">{exposed.map(agentRow)}</ul>
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
      {writing && chatDensity !== 'results' ? (
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
      {!working || !sessionId || chatDensity === 'detailed' ? (
        <details
          id={`work-log-${runId}`}
          className="work-log group/log"
          open={expanded}
          onToggle={(e) =>
            setDisclosure({ runId, density: chatDensity, open: e.currentTarget.open })
          }
        >
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded py-0.5 text-xs text-muted hover:text-text">
            <Activity size={13} />
            {t('activity')}
            <span className="tabular-nums">{projection.executionOrder.length}</span>
            <ChevronRight size={12} className="transition-transform group-open/log:rotate-90" />
          </summary>
          {expanded ? (
            <div className="mt-2 space-y-1 border-l border-line pl-3">
              <WorkPlanPanel session={store} />
              {projection.executionOrder.map((id) => {
                const execution = projection.executions[id];
                if (!execution) return null;
                return (
                  <details
                    key={id}
                    className="text-xs"
                    open={Boolean(openExecutions[`${runId}:${id}`])}
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setOpenExecutions((current) => ({ ...current, [`${runId}:${id}`]: open }));
                    }}
                  >
                    <summary className="flex cursor-pointer items-center gap-2 py-1.5">
                      <span className="font-medium">{name(id)}</span>
                      <StatusBadge status={execution.status} />
                      {execution.modelCallIds.at(-1) ? (
                        <ReasoningSummary
                          call={projection.modelCalls[execution.modelCallIds.at(-1)!]!}
                        />
                      ) : null}
                    </summary>
                    {openExecutions[`${runId}:${id}`] ? (
                      <ExecutionTranscript session={store} executionId={id} compact />
                    ) : null}
                  </details>
                );
              })}
            </div>
          ) : null}
        </details>
      ) : null}
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
    if (open === true && (text !== undefined || result.media)) markRunReviewed();
  }, [open, text, result.media]);
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
          {result.media ? (
            <GeneratedImage
              runId={projection.runId}
              versionId={result.artifactVersionId}
              name={result.name}
              media={result.media}
            />
          ) : review ? (
            <ReviewSummary
              review={review}
              artifactLink={(id) => (
                <Link {...location} search={search(id)} className="underline">
                  {projection.artifacts[id]?.name ?? id} · {id}
                </Link>
              )}
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
          {sessionId ? (
            <MessageBranch
              runId={projection.runId}
              artifactVersionId={result.artifactVersionId}
              disabled={!TERMINAL_RUN_STATUSES.has(projection.status)}
            />
          ) : null}
        </>
      ) : null}
    </details>
  );
}
