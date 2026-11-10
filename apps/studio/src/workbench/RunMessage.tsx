import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { canReadArtifactBody, pendingInteractions, type RunProjection } from '@corral/core';
import {
  ApprovalPanel,
  buildTurnProcess,
  CopyTextButton,
  ExecutionTranscript,
  FailureNotice,
  GeneratedImage,
  MessageBody,
  ReasoningSummary,
  type ResultItem,
  ReviewSummary,
  RunActions,
  RunReason,
  requestOpen,
  runResults,
  SafeMarkdown,
  StatusBadge,
  WorkPlanPanel,
} from '@corral/react';
import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  fontWeights,
  ThinkingIndicator,
  ThinkingStep,
  ThinkingStepDetails,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  Tooltip,
} from '@corral/react/design-kit';
import { ChevronRight, FileText, LoaderCircle, PanelRight, Pause } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { markRunReviewed } from '../pages/GettingStarted.tsx';
import { useRemembered } from '../pages/Workbench.tsx';
import { agentSummary } from './agentSummary.ts';
import { type ChatDensity, preferences } from './preferences.ts';
import { useQuestionNotice } from './questionNotice.ts';
import { TurnLine, TurnProcess } from './TurnProcess.tsx';
import { useCorralRun } from './useCorralChat.ts';
import { toolRows } from './widgets/selectors.ts';

/** Expandable work log and response surface, projected from Corral executions. */
export function RunMessage({
  runId,
  sessionId,
  live,
  onOpenArtifact,
  artifactMetadataVersion,
  runLine,
  endActions,
}: {
  runId: string;
  sessionId: string | null;
  live: boolean;
  onOpenArtifact(id: string): void;
  artifactMetadataVersion?: string;
  /** What closes the turn's process line: the run's number, which opens its record. */
  runLine?: ReactNode;
  /** What the person can do next when the turn did not finish: retry, restore. */
  endActions?: ReactNode;
}) {
  const t = useTranslations('Desktop');
  const trun = useTranslations('Run');
  const tt = useTranslations('Transcript');
  const tw = useTranslations('Widgets');
  const tm = useTranslations('MessageBody');
  const ts = useTranslations('Status');
  const chatDensity = useStore(preferences, (state) => state.chatDensity);
  const [disclosure, setDisclosure] = useState<{
    runId: string;
    density: ChatDensity;
    open: boolean;
  } | null>(null);
  // a chat turn shows its process while it works and folds it when it ends.
  const chosen =
    disclosure?.runId === runId && disclosure.density === chatDensity ? disclosure.open : null;
  const expanded = chosen ?? (chatDensity === 'detailed' || (sessionId !== null && live));
  const [openExecutions, setOpenExecutions] = useState<Record<string, boolean>>({});
  // The log's steps load when it first opens and stay for its closing animation.
  const [logShown, setLogShown] = useState(false);
  if (expanded && !logShown) setLogShown(true);
  // Whether this view saw the turn working: only a turn finishing here hands its reply over.
  const [watched, setWatched] = useState(false);
  const [resultError, setResultError] = useState(false);
  const [retry, setRetry] = useState(0);
  const {
    store,
    state,
    conversationTurn,
    bodyMetadataCurrent = true,
  } = useCorralRun(runId, live, expanded, artifactMetadataVersion);
  const label = useCallback(
    (nodeId: string) => state.definition?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId,
    [state.definition],
  );
  const results = useMemo(
    () => (state.projection ? runResults(state.projection) : null),
    [state.projection],
  );
  const visible = results?.final.length
    ? results.final
    : results?.kind === 'partial'
      ? results.intermediate.map((g) => g.latest)
      : [];
  const preservedTurn =
    sessionId &&
    conversationTurn?.runId === runId &&
    state.projection &&
    TERMINAL_RUN_STATUSES.has(state.projection.status) &&
    conversationTurn.answer !== null
      ? conversationTurn
      : null;
  const ids = visible
    .filter(
      (item) =>
        !item.media &&
        item.artifactVersionId !== preservedTurn?.artifactVersionId &&
        state.projection &&
        bodyMetadataCurrent &&
        canReadArtifactBody(state.projection, item.artifactVersionId),
    )
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
  // The turn's observed work steps; the conversation's process lists them.
  const process = useMemo(
    () => buildTurnProcess(state.events, projection, {}, label),
    [state.events, projection, label],
  );
  // Waiting questions are answered in the exact run's response area; the notice names the first.
  const interactions = sessionId ? pendingInteractions(state.events, projection) : [];
  const questions = interactions.flatMap((interaction) =>
    interaction.kind === 'approval' ? [] : [interaction],
  );
  const loadBody = useCallback(
    (bodyRef: string) => store.getState().loadArtifact(bodyRef),
    [store],
  );
  const questionNotice = useQuestionNotice(questions, state.artifactTexts, loadBody);
  if (!projection)
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {sessionId && runLine ? <TurnLine>{runLine}</TurnLine> : null}
        {state.streamError ? (
          <p role="alert" className="text-body text-danger">
            {state.streamError}
          </p>
        ) : (
          <div className="h-4 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        )}
        {/* Recovery stays reachable even when the run's record cannot be read. */}
        {endActions ? <div className="flex flex-wrap gap-2">{endActions}</div> : null}
      </div>
    );
  const working = !TERMINAL_RUN_STATUSES.has(projection.status);
  if (working && !watched) setWatched(true);
  const processOpen = chosen ?? (chatDensity === 'detailed' || working);
  // Until its text is read, the notice keeps the generic count.
  const requiredLabel =
    questionNotice ??
    (questions.length === 1
      ? tw('actionQuestion')
      : tw('actionMixed', { count: questions.length }));
  const executions = projection.executionOrder.flatMap((id) => projection.executions[id] ?? []);
  // Current session activity lives by the composer and in the agent widget.
  // Historical failures stay visible here, while standalone consumers keep their activity row.
  const busy =
    working && !sessionId && chatDensity !== 'results'
      ? executions.filter((execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status))
      : [];
  const summary = agentSummary(busy.map((execution) => execution.status));
  // Failures and cancellations stay in view. An ordinary success folds them.
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
  // What a model is writing right now, shown in the conversation; never a fact.
  // A turn finishing here hands its last reply (if any) over to the result once the result's
  // text is read, so the answer never flashes "Loading…" in between. A failed read ends it.
  const handoff =
    watched &&
    !working &&
    !resultError &&
    visible.some(
      (result) =>
        !result.media &&
        !projection.reviews[result.artifactVersionId] &&
        result.artifactVersionId !== preservedTurn?.artifactVersionId &&
        bodyMetadataCurrent &&
        canReadArtifactBody(projection, result.artifactVersionId) &&
        state.artifactTexts[result.artifactVersionId] === undefined,
    );
  // In a conversation only the lead's reply can become the answer; delegates speak in rows.
  const lead = projection.executionOrder[0];
  const streams =
    working || handoff || !projection.output
      ? Object.entries(state.streams).filter(([id]) => {
          const owner = projection.modelCalls[id]?.executionId;
          return (
            (!sessionId || !owner || owner === lead) &&
            (working ||
              handoff ||
              (!projection.modelCalls[id]?.responseRef && Boolean(state.streams[id]?.text)))
          );
        })
      : [];
  const current = working
    ? streams
        .filter(
          ([id, stream]) =>
            !stream.completed && !stream.broken && !projection.modelCalls[id]?.finished,
        )
        .at(-1)
    : undefined;
  // Between model calls the last reply keeps its place until the run ends, so the block
  // does not vanish and return with every call.
  const writing = current ?? streams.filter(([, stream]) => stream.text).at(-1);
  const writer = writing ? projection.modelCalls[writing[0]]?.executionId : undefined;
  const processShown = Boolean(sessionId) && (!working || chatDensity !== 'results');
  // Observed only: the run is starting or working, nothing waits on the person, and no step,
  // words or result have shown yet. A paused or waiting run does not animate.
  const replyPending =
    Boolean(sessionId) &&
    ['created', 'validating', 'running'].includes(projection.status) &&
    interactions.length === 0 &&
    !(processShown && process.rows.length > 0) &&
    !streams.some(([, stream]) => stream.text) &&
    visible.length === 0;
  const pendingWord = tw(projection.status === 'running' ? 'activityWorking' : 'activityStarting');
  // A turn that did not finish says so once: its readable cause, whether it made anything,
  // and what to do next. One agent's failure is the turn's failure; a team lists its agents.
  const unfinished = Boolean(sessionId) && !working && projection.status !== 'succeeded';
  const soleFailure = unfinished && executions.length <= 1 ? exposed[0] : undefined;
  const listed = soleFailure ? [] : exposed;
  const madeResults = Object.keys(projection.artifacts).length > 0;
  const agentRow = (execution: (typeof executions)[number]) => (
    <li
      key={execution.executionId}
      className="flex min-w-0 flex-wrap items-center gap-x-2 text-caption"
    >
      <Link
        to={sessionId ? '/sessions/$sessionId' : '/runs/$runId'}
        params={sessionId ? { sessionId } : { runId }}
        search={{
          ...(sessionId ? { panel: 'run' as const, run: runId } : {}),
          view: 'run',
          execution: execution.executionId,
        }}
        title={execution.executionId}
        className="text-foreground hover:underline"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {name(execution.executionId)}
      </Link>
      <StatusBadge status={execution.status} />
      {execution.modelCallIds.at(-1) ? (
        <ReasoningSummary
          call={projection.modelCalls[execution.modelCallIds.at(-1)!]!}
          open={requestOpen(projection, execution.modelCallIds.at(-1)!)}
        />
      ) : null}
      {execution.waitingOn ? (
        <span className="text-muted-foreground">
          {trun(`waiting.${execution.waitingOn.kind}`, {
            count: execution.waitingOn.targetIds.length,
          })}
        </span>
      ) : null}
      {execution.error ? (
        <FailureNotice message={execution.error} cancelled={execution.status === 'cancelled'} />
      ) : null}
    </li>
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* The turn reads top down: its process in one line, what needs the person, the answer. */}
      {processShown ? (
        <TurnProcess
          events={state.events}
          projection={projection}
          process={process}
          streams={state.streams}
          label={label}
          open={processOpen}
          onOpenChange={(open) => setDisclosure({ runId, density: chatDensity, open })}
          trailing={runLine}
        />
      ) : sessionId && runLine ? (
        // No process to fold: a state other than plain work still shows beside the run number.
        <TurnLine>
          {['created', 'validating', 'running'].includes(projection.status) ? null : (
            <span className="py-1.5 pl-2.5">
              {ts.has(projection.status) ? ts(projection.status) : projection.status}
            </span>
          )}
          {runLine}
        </TurnLine>
      ) : null}
      {sessionId && questions.length ? (
        // The composer's notice announces it and carries the way to the answer; the turn it
        // belongs to keeps one quiet line naming the question.
        <p
          data-testid="run-required-action"
          role="note"
          className="text-caption text-muted-foreground"
        >
          {requiredLabel}
        </p>
      ) : null}
      {working && !sessionId ? <RunActions session={store} compact /> : null}
      <ApprovalPanel
        session={store}
        onOpenArtifact={onOpenArtifact}
        showPlan={!sessionId}
        showRelatedPanels={!sessionId}
        policySettingsAction={
          sessionId ? (
            <Button
              size="compact"
              variant="tertiary"
              render={
                <Link to="/settings/harness" search={{ returnTo: `/sessions/${sessionId}` }} />
              }
            >
              {trun('permissionSettings')}
            </Button>
          ) : undefined
        }
      />
      {unfinished ? (
        <Banner
          data-testid="run-ended"
          status={
            projection.status === 'failed'
              ? 'error'
              : projection.status === 'interrupted'
                ? 'warning'
                : 'default'
          }
          size="compact"
          role="note"
        >
          <BannerTitle>
            {projection.statusReason ? (
              <RunReason code={projection.statusReason} nodeLabel={label} />
            ) : ts.has(projection.status) ? (
              ts(projection.status)
            ) : (
              projection.status
            )}
          </BannerTitle>
          {soleFailure?.error || madeResults ? (
            // The banner's description slot, holding blocks a paragraph cannot.
            <div
              data-slot="banner-description"
              className="col-start-2 row-start-2 mt-1 flex min-w-0 flex-col gap-1 text-caption text-foreground"
            >
              {soleFailure?.error ? (
                <FailureNotice
                  message={soleFailure.error}
                  cancelled={soleFailure.status === 'cancelled'}
                />
              ) : null}
              {madeResults ? <p data-testid="run-made-results">{trun('madeResults')}</p> : null}
            </div>
          ) : null}
          {endActions ? <BannerActions>{endActions}</BannerActions> : null}
        </Banner>
      ) : null}
      {attention.length ? (
        <ul
          className="flex flex-col gap-1 text-caption"
          aria-label={t('toolActivity', { count: attention.length })}
        >
          {projection.status === 'succeeded' && attention.some((row) => row.tone === 'failed') ? (
            <li>{tw('actionCompletedWithFailures')}</li>
          ) : null}
          {attention.map((row) => {
            const call = projection.toolCalls[row.id];
            return (
              <li key={row.id} className="flex flex-wrap gap-x-2">
                <code>{row.name}</code>
                <span className="text-danger">{t(`toolPhase.${row.tone}`)}</span>
                {call?.reason ? (
                  <FailureNotice
                    message={call.reason}
                    code={call.errorCode}
                    cancelled={row.tone === 'cancelled'}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {/* An ended turn's reason is its notice's title, and a waiting question names itself. */}
      {projection.statusReason &&
      !unfinished &&
      !(sessionId && questions.length) &&
      projection.status !== 'running' &&
      projection.status !== 'succeeded' ? (
        <p data-testid="run-reason" className="text-caption text-muted-foreground">
          {trun('reasonPrefix')} <RunReason code={projection.statusReason} nodeLabel={label} />
        </p>
      ) : null}
      {busy.length || listed.length ? (
        <section
          aria-label={t('teamActivity')}
          data-testid="team-activity"
          className="text-caption"
        >
          {listed.length ? (
            <ul className={`flex flex-col gap-1 ${busy.length ? 'mb-1' : ''}`}>
              {listed.map(agentRow)}
            </ul>
          ) : null}
          {busy.length ? (
            <details className="group/agents">
              <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 text-muted-foreground hover:text-foreground">
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
                  className="transition-transform group-open/agents:rotate-90 motion-reduce:transition-none"
                />
              </summary>
              <ul className="mt-1.5 flex flex-col gap-1 border-l border-border pl-3">
                {busy.map(agentRow)}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
      {/* The work log leads the turn, above its reply and result, from the turn's start. */}
      {!sessionId ? (
        <ThinkingSteps
          id={`work-log-${runId}`}
          className="work-log w-full"
          size="compact"
          open={expanded}
          onOpenChange={(open) => setDisclosure({ runId, density: chatDensity, open })}
        >
          <ThinkingStepsHeader>
            {t('activity')} <span className="tabular-nums">{projection.executionOrder.length}</span>
          </ThinkingStepsHeader>
          <ThinkingStepsContent>
            {expanded || logShown ? (
              <>
                <WorkPlanPanel session={store} />
                {projection.executionOrder.map((id, index) => {
                  const execution = projection.executions[id];
                  if (!execution) return null;
                  const key = `${runId}:${id}`;
                  const call = execution.modelCallIds.at(-1);
                  return (
                    <ThinkingStep
                      key={id}
                      label={name(id)}
                      status={execution.status === 'active' ? 'active' : 'complete'}
                      icon={
                        execution.status === 'succeeded'
                          ? 'check'
                          : execution.status === 'failed' || execution.status === 'cancelled'
                            ? 'x'
                            : 'dot'
                      }
                      isLast={index === projection.executionOrder.length - 1}
                    >
                      <span className="flex flex-wrap items-center gap-2 text-caption">
                        <StatusBadge status={execution.status} />
                        {call ? (
                          <ReasoningSummary
                            call={projection.modelCalls[call]!}
                            open={requestOpen(projection, call)}
                          />
                        ) : null}
                      </span>
                      <ThinkingStepDetails
                        summary={tt('label')}
                        open={Boolean(openExecutions[key])}
                        onOpenChange={(open) =>
                          setOpenExecutions((current) => ({ ...current, [key]: open }))
                        }
                      >
                        {/* Loaded on first open and kept for the closing animation. */}
                        {key in openExecutions ? (
                          <ExecutionTranscript session={store} executionId={id} compact />
                        ) : null}
                      </ThinkingStepDetails>
                    </ThinkingStep>
                  );
                })}
              </>
            ) : null}
          </ThinkingStepsContent>
        </ThinkingSteps>
      ) : null}
      {replyPending ? (
        // Where the answer will appear, until the run shows its first words or a result.
        // The composer's region announces the run, so this status stays silent.
        <ThinkingIndicator
          data-testid="reply-pending"
          aria-live="off"
          size="compact"
          className="px-0"
          labels={{ status: pendingWord, words: [pendingWord] }}
        />
      ) : null}
      {writing && sessionId && chatDensity !== 'results' ? (
        // The reply being written reads as the answer it may become.
        <div
          data-testid="live-text"
          aria-live="off"
          className="live-text turn-actions-scope flex min-w-0 flex-col gap-1 wrap-anywhere"
        >
          {!working && !handoff ? (
            <p className="text-caption text-muted-foreground" role="note">
              {tm('interrupted')}
              {writing[1].truncated ? ` · ${tm('truncated')}` : ''}
            </p>
          ) : null}
          {working || handoff ? (
            <SafeMarkdown text={writing[1].text} size="chat" />
          ) : (
            <>
              <MessageBody text={writing[1].text} markdown size="chat" copy={false} />
              <TurnActions>
                <CopyTextButton text={writing[1].text} />
              </TurnActions>
            </>
          )}
        </div>
      ) : writing && chatDensity !== 'results' ? (
        <div data-testid="live-text" aria-live="off" className="min-w-0">
          <p className="mb-1 text-micro text-muted-foreground">
            {current
              ? t('writing', { name: writer ? name(writer) : '' })
              : writer
                ? name(writer)
                : null}
          </p>
          <div className="live-text max-h-40 overflow-auto text-muted-foreground wrap-anywhere">
            {!working && !handoff ? <p role="note">{tm('interrupted')}</p> : null}
            <SafeMarkdown text={writing[1].text} />
            {current ? (
              <span
                aria-hidden="true"
                className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-muted align-text-bottom motion-reduce:animate-none"
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {resultError ? (
        <p role="alert" className="flex items-center gap-2 text-caption text-danger">
          {t('resultUnavailable')}
          <Button variant="tertiary" size="compact" onClick={() => setRetry((value) => value + 1)}>
            {t('retryResult')}
          </Button>
        </p>
      ) : null}
      {(handoff ? [] : visible).map((result, index) => (
        <ChatResult
          key={result.artifactVersionId}
          result={result}
          text={
            result.artifactVersionId === preservedTurn?.artifactVersionId
              ? (preservedTurn.answer ?? undefined)
              : bodyMetadataCurrent && canReadArtifactBody(projection, result.artifactVersionId)
                ? state.artifactTexts[result.artifactVersionId]
                : undefined
          }
          projection={projection}
          bodyMetadataCurrent={bodyMetadataCurrent}
          label={label}
          sessionId={sessionId}
          partial={results?.kind === 'partial'}
          first={index === 0}
        />
      ))}
      {state.streamError ? (
        <p role="alert" className="text-caption text-danger">
          {state.streamError}
        </p>
      ) : null}
      {/* The session knows the turn ended before this view has read it: recovery stays. */}
      {endActions && !unfinished ? <div className="flex flex-wrap gap-2">{endActions}</div> : null}
    </div>
  );
}

/**
 * The icon row under a message: quiet until its message is hovered or holds focus, always
 * shown under the latest answer and on touch screens (index.css). Its buttons keep their
 * place in the tab order either way.
 */
export function TurnActions({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="turn-actions"
      className="turn-actions -ml-1.5 flex min-h-7 flex-wrap items-center gap-0.5 text-muted-foreground transition-opacity duration-(--duration-moderate) ease-(--ease-out-soft) motion-reduce:transition-none"
    >
      {children}
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
  bodyMetadataCurrent,
}: {
  result: ResultItem;
  text: string | undefined;
  projection: RunProjection;
  label: (nodeId: string) => string;
  sessionId: string | null;
  partial: boolean;
  first: boolean;
  bodyMetadataCurrent: boolean;
}) {
  const t = useTranslations('Desktop');
  const tr = useTranslations('Results');
  const ta = useTranslations('Artifact');
  const [open, setOpen] = useRemembered(
    `corral:chat-result:v1:${projection.runId}:${result.artifactVersionId}`,
    first,
  );
  // Reading a result in the conversation is the checklist's last step.
  const inline = Boolean(sessionId && !partial && !result.media);
  useEffect(() => {
    if ((open === true || inline) && (text !== undefined || result.media)) markRunReviewed();
  }, [open, inline, text, result.media]);
  const author = projection.executions[result.authorExecutionId];
  const review = projection.reviews[result.artifactVersionId];
  const readable = bodyMetadataCurrent && canReadArtifactBody(projection, result.artifactVersionId);
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
  const actions =
    text !== undefined || readable ? (
      <TurnActions>
        {text !== undefined ? <CopyTextButton text={text} /> : null}
        {readable ? (
          <Tooltip content={tr('openResults')}>
            <Button
              size="icon-compact"
              variant="ghost"
              aria-label={tr('openResults')}
              render={<Link {...location} search={search(result.artifactVersionId)} />}
            >
              <PanelRight />
            </Button>
          </Tooltip>
        ) : null}
      </TurnActions>
    ) : null;
  // in a conversation the answer is always visible, without a version header.
  if (sessionId && !partial && !result.media && !review)
    return (
      <div
        className="turn-actions-scope flex min-w-0 flex-col gap-1 wrap-anywhere"
        data-testid="chat-result"
      >
        {text === undefined ? (
          <p className="text-caption text-muted-foreground">
            {ta(!bodyMetadataCurrent || readable ? 'loading' : 'retired')}
          </p>
        ) : (
          <MessageBody text={text} markdown size="chat" copy={false} />
        )}
        {actions}
      </div>
    );
  return (
    <details
      open={open === true}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="turn-actions-scope flex min-w-0 flex-col gap-2 wrap-anywhere"
      data-testid="chat-result"
    >
      <summary className="flex w-fit cursor-pointer list-none flex-wrap items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground">
        <FileText size={13} />
        {partial ? tr('partial') : t('result')} · {result.name} v{result.version}
        {author ? (
          <span>
            · {label(author.nodeId)} #{projection.executionOrder.indexOf(author.executionId) + 1}
          </span>
        ) : null}
        <ChevronRight
          size={12}
          className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        />
      </summary>
      {open === true ? (
        <div className="mt-2 flex min-w-0 flex-col gap-1">
          {!bodyMetadataCurrent ? (
            <p className="text-caption text-muted-foreground">{ta('loading')}</p>
          ) : !readable ? (
            <p className="text-caption text-muted-foreground">{ta('retired')}</p>
          ) : result.media ? (
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
            <p className="text-caption text-muted-foreground">{ta('loading')}</p>
          ) : (
            <SafeMarkdown text={text} size={sessionId ? 'chat' : 'compact'} />
          )}
          {actions}
        </div>
      ) : null}
    </details>
  );
}
