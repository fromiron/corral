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
  Button,
  fontWeights,
  Skeleton,
  ThinkingIndicator,
  ThinkingStep,
  ThinkingStepDetails,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  Tooltip,
  useSize,
} from '@corral/react/design-kit';
import { ChevronRight, FileText, LoaderCircle, PanelRight, Pause } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { markRunReviewed } from '../pages/GettingStarted.tsx';
import { useRemembered } from '../pages/Workbench.tsx';
import { agentSummary } from './agentSummary.ts';
import { holdPointer } from './ChatView.tsx';
import { type ChatDensity, preferences } from './preferences.ts';
import { chooseProcess, keepRowHeight, processChoice, rowHeight } from './processChoices.ts';
import { RunHead, RunRow, RunTail, TurnEnd } from './RunRow.tsx';
import { TurnProcess, useStepName } from './TurnProcess.tsx';
import { useCorralRun } from './useCorralChat.ts';
import { fileChangeCount, toolRows } from './widgets/selectors.ts';

/**
 * A height-capped reply keeps its own end in view until the person scrolls up inside it.
 * Layout moving the offset is not that person.
 */
function StreamingReply({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const followed = useRef(0);
  const touchY = useRef<number | null>(null);
  const scrollbarPointer = useRef(false);
  const pin = () => {
    const el = box.current;
    if (!el || !follow.current) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    // Already at the end: assigning scrollTop again would re-enter the scroll handler.
    if (el.scrollTop >= max - 1) {
      followed.current = el.scrollTop;
      return;
    }
    el.scrollTop = max;
    followed.current = el.scrollTop;
  };
  useLayoutEffect(() => {
    pin();
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: browsers focus a scroller for keyboard scrolling; this only observes those keys
    <div
      ref={box}
      className="live-text max-h-40 overflow-auto text-muted-foreground wrap-anywhere"
      onWheel={(event) => {
        if (event.deltaY < 0) follow.current = false;
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) holdPointer(scrollbarPointer);
      }}
      onKeyDown={(event) => {
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) follow.current = false;
      }}
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY;
        const start = touchY.current;
        if (y === undefined || start === null || y <= start) return;
        follow.current = false;
      }}
      onScroll={() => {
        const el = box.current;
        if (!el) return;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (!follow.current) {
          if (gap < 1) follow.current = true;
          return;
        }
        if (el.scrollTop >= followed.current - 1) followed.current = el.scrollTop;
        else if (scrollbarPointer.current) follow.current = false;
        else pin();
      }}
    >
      {children}
    </div>
  );
}

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
  const tturn = useTranslations('Turn');
  const stepName = useStepName();
  const chatDensity = useStore(preferences, (state) => state.chatDensity);
  const [disclosure, setDisclosure] = useState<{
    runId: string;
    density: ChatDensity;
    open: boolean;
  } | null>(null);
  // What the person chose for this run's process holds while the density stays the same. In a
  // conversation it outlives the row, which the timeline may unmount off screen.
  const local =
    disclosure?.runId === runId && disclosure.density === chatDensity ? disclosure.open : null;
  const chosen = sessionId ? (processChoice(runId, chatDensity) ?? local) : local;
  const choose = (open: boolean) => {
    if (sessionId) chooseProcess(runId, chatDensity, open);
    setDisclosure({ runId, density: chatDensity, open });
  };
  // Whether the run's steps are read: a live turn in a conversation reads them while it works,
  // closed or open, so its head counts them.
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
    settled = true,
  } = useCorralRun(runId, live, expanded, artifactMetadataVersion);
  // A conversation row the timeline mounts again keeps the height it left with until its record
  // and bodies are read again; what the read then changes is a real change.
  const [returning] = useState(() => Boolean(sessionId) && rowHeight(runId) !== null);
  const [hold, setHold] = useState(() => (sessionId ? rowHeight(runId) : null));
  const observer = useRef<ResizeObserver | null>(null);
  const rowRef = useCallback(
    (element: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!element || typeof ResizeObserver === 'undefined') return;
      const measure = () => {
        const height = element.getBoundingClientRect().height;
        if (height > 0) keepRowHeight(runId, height);
      };
      measure();
      observer.current = new ResizeObserver(measure);
      observer.current.observe(element);
    },
    [runId],
  );
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
  const bodiesPending =
    !resultError &&
    ids
      .split(',')
      .filter(Boolean)
      .some((id) => !(id in state.artifactTexts));
  if (hold !== null && settled && !bodiesPending) setHold(null);
  const held = hold !== null ? { ref: rowRef, minHeight: hold } : { ref: rowRef };
  const projection = state.projection;
  // The turn's observed work steps; the conversation's process lists them.
  const process = useMemo(
    () => buildTurnProcess(state.events, projection, {}, label),
    [state.events, projection, label],
  );
  // Waiting questions are answered in the exact run's response area; the composer's notice
  // names the first and carries the way there, so the turn does not repeat it. A waiting
  // approval is its card below, which says what it waits for.
  const interactions = sessionId ? pendingInteractions(state.events, projection) : [];
  if (!projection && sessionId)
    // The row's three lines before its record is read; the words come into the same places.
    return (
      <RunRow
        {...held}
        head={
          <RunHead trailing={runLine}>
            <Skeleton className="h-3 w-40 max-w-full" />
          </RunHead>
        }
        tail={<RunTail />}
      >
        {state.streamError ? (
          <p role="alert" className="text-body text-danger">
            {state.streamError}
          </p>
        ) : (
          <Skeleton className="my-1 h-3.5 w-2/3" />
        )}
        {/* Recovery stays reachable even when the run's record cannot be read. */}
        {endActions ? <TurnEnd actions={endActions} /> : null}
      </RunRow>
    );
  if (!projection)
    return (
      <div className="flex min-w-0 flex-col gap-3">
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
  // In a conversation the process opens only by the detailed density or by the person; the
  // run starting or ending neither opens nor folds it.
  const processOpen = chosen ?? chatDensity === 'detailed';
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
              // A conversation turn that ended with no result keeps the last words it showed
              // in their place; elsewhere only an unfinished response stays.
              ((sessionId !== null || !projection.modelCalls[id]?.responseRef) &&
                Boolean(state.streams[id]?.text)))
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
  // The head is the same in every density: it opens the log whenever the log holds something.
  const processShown = Boolean(sessionId);
  // Observed only: the run is starting or working, nothing waits on the person, and no words or
  // result have shown yet. The log's steps do not count: it is closed. A paused or waiting run
  // does not animate.
  const replyPending =
    Boolean(sessionId) &&
    ['created', 'validating', 'running'].includes(projection.status) &&
    interactions.length === 0 &&
    !streams.some(([, stream]) => stream.text) &&
    visible.length === 0;
  // The wait names the tool or role in progress, as the log names it; the head already says the
  // state. A model request's name says nothing to the person, so it waits with the mark alone.
  const activeStep = process.rows.filter((row) => row.active).at(-1);
  const pendingStep = activeStep && activeStep.kind !== 'model' ? stepName(activeStep) : null;
  const pendingWord = tw(projection.status === 'running' ? 'activityWorking' : 'activityStarting');
  // A turn that did not finish says so once: its readable cause, whether it made anything,
  // and what to do next. One agent's failure is the turn's failure; a team lists its agents.
  const unfinished = Boolean(sessionId) && !working && projection.status !== 'succeeded';
  const soleFailure = unfinished && executions.length <= 1 ? exposed[0] : undefined;
  const listed = soleFailure ? [] : exposed;
  // An unfinished conversation turn always ends with its cause: the answering role's failure,
  // however many roles the team has. Other roles' failures stay in the log and its count.
  const endFailure =
    soleFailure ??
    (unfinished && sessionId
      ? exposed.find((execution) => execution.executionId === projection.executionOrder[0])
      : undefined);
  const agentRow = (execution: (typeof executions)[number]) => (
    <li
      key={execution.executionId}
      // In a conversation a team role's row is a part of the run row, and says its own state.
      data-chat-part={sessionId ? `role:${execution.executionId}` : undefined}
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
      {sessionId ? (
        <span data-presence-label={`execution:${execution.executionId}`}>
          <StatusBadge status={execution.status} />
        </span>
      ) : (
        <StatusBadge status={execution.status} />
      )}
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
  const toolAttention = attention.length ? (
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
  ) : null;
  // An ended turn's reason closes its body; a waiting question is the composer notice's, and a
  // waiting approval is its card's.
  const reasonLine =
    projection.statusReason &&
    !unfinished &&
    !(sessionId && interactions.length) &&
    projection.status !== 'running' &&
    projection.status !== 'succeeded' ? (
      <p data-testid="run-reason" className="text-caption text-muted-foreground">
        {trun('reasonPrefix')} <RunReason code={projection.statusReason} nodeLabel={label} />
      </p>
    ) : null;
  const approval = (
    <ApprovalPanel
      session={store}
      onOpenArtifact={onOpenArtifact}
      showPlan={!sessionId}
      showRelatedPanels={!sessionId}
      // In a conversation the top bar's pill says the run waits; the card names the decision.
      headed={!sessionId}
      policySettingsAction={
        sessionId ? (
          // A way out of the card, quieter than its decisions.
          <Button
            variant="ghost"
            render={<Link to="/settings/harness" search={{ returnTo: `/sessions/${sessionId}` }} />}
          >
            {trun('permissionSettings')}
          </Button>
        ) : undefined
      }
    />
  );
  const textOf = (result: ResultItem) =>
    result.artifactVersionId === preservedTurn?.artifactVersionId
      ? (preservedTurn.answer ?? undefined)
      : bodyMetadataCurrent && canReadArtifactBody(projection, result.artifactVersionId)
        ? state.artifactTexts[result.artifactVersionId]
        : undefined;
  const partial = results?.kind === 'partial';
  const shownResults = handoff ? [] : visible;
  if (sessionId) {
    // The row's three lines (composer-flow.md "튐 없는 본문" rule 3). The team's role rows, what
    // went wrong in the steps and why the run stands still are in the log the head opens.
    const team = listed.filter(
      (execution) => execution.executionId === lead && execution !== endFailure,
    );
    const log =
      toolAttention || reasonLine || team.length ? (
        <>
          {toolAttention}
          {reasonLine}
          {team.length ? (
            <section aria-label={t('teamActivity')} data-testid="team-activity">
              <ul className="flex flex-col gap-1">{team.map(agentRow)}</ul>
            </section>
          ) : null}
        </>
      ) : null;
    const failed =
      attention.filter((row) => row.tone === 'failed' || row.tone === 'cancelled').length +
      exposed.filter((execution) => execution.executionId !== lead).length;
    const leadExecution = lead ? projection.executions[lead] : undefined;
    const status = (
      <span
        data-presence-label={`run:${runId}`}
        className={
          // A working run's word shimmers as the kit's work does; reduced motion stills it.
          ['created', 'validating', 'running'].includes(projection.status)
            ? 'shimmer-text'
            : projection.status === 'failed'
              ? 'text-danger'
              : projection.status === 'interrupted'
                ? 'text-warning'
                : undefined
        }
      >
        {ts.has(projection.status) ? ts(projection.status) : projection.status}
      </span>
    );
    const shownText = writing && chatDensity !== 'results' ? writing : undefined;
    // The words an ended turn kept; only a response that never completed is marked as cut off.
    const kept = shownText && !working && !handoff ? shownText[1].text : null;
    const cutOff =
      kept !== null && shownText !== undefined && !projection.modelCalls[shownText[0]]?.responseRef;
    // The answer the conversation shows as it is: the body itself, not a result to count.
    const inline = (result: ResultItem) =>
      !partial && !result.media && !projection.reviews[result.artifactVersionId];
    // The one such answer hands its icon actions to the tail.
    const sole = shownResults.length === 1 ? shownResults[0] : undefined;
    const tailResult = sole && inline(sole) ? sole : undefined;
    const changes = fileChangeCount(toolCalls);
    // Results drawn as their own folded blocks: images, reviews, partial results.
    const blocks = visible.filter((result) => !inline(result)).length;
    const tailValues = [
      changes ? { key: 'changes', node: tturn('changes', { count: changes }) } : null,
      blocks ? { key: 'results', node: tturn('results', { count: blocks }) } : null,
    ].filter((value) => value !== null);
    // The head names the answering role and the run's state: a reason saying only that this
    // role failed, or that the run was cancelled, would say it again.
    const code = projection.statusReason;
    const at = code ? code.indexOf(': ') : -1;
    const reasonHead = code && at >= 0 ? code.slice(0, at) : code;
    const reasonRest = code && at >= 0 ? code.slice(at + 2) : '';
    const repeatsHead =
      reasonHead === 'cancel_confirmed' ||
      (reasonHead === 'execution_failed' && reasonRest.split(' ')[0] === leadExecution?.nodeId);
    return (
      <RunRow
        {...held}
        head={
          <TurnProcess
            events={state.events}
            projection={projection}
            process={process}
            streams={state.streams}
            label={label}
            open={processOpen}
            onOpenChange={choose}
            trailing={runLine}
            role={leadExecution ? label(leadExecution.nodeId) : null}
            status={status}
            failed={failed}
            toggle={processShown}
            returning={returning}
          >
            {log}
          </TurnProcess>
        }
        tail={
          <RunTail values={tailValues}>
            {tailResult ? (
              <ResultActions
                projection={projection}
                result={tailResult}
                text={textOf(tailResult)}
                readable={
                  bodyMetadataCurrent &&
                  canReadArtifactBody(projection, tailResult.artifactVersionId)
                }
                sessionId={sessionId}
              />
            ) : kept !== null ? (
              <TurnActions>
                <CopyTextButton text={kept} />
              </TurnActions>
            ) : null}
          </RunTail>
        }
        after={approval}
      >
        {replyPending ? (
          // Where the answer will appear, until the run shows its first words or a result. It
          // takes the height of the answer's first line, so the words take its place.
          <ThinkingIndicator
            data-testid="reply-pending"
            aria-live="off"
            className="h-(--lh-title) p-0"
            // No words until a step is in progress: the mark alone.
            labels={{ status: pendingStep ?? pendingWord, words: [pendingStep ?? ''] }}
          />
        ) : null}
        {shownText ? (
          // The reply being written reads as the answer it may become.
          <div
            data-testid="live-text"
            aria-live="off"
            className="live-text flex min-w-0 flex-col gap-1 wrap-anywhere"
          >
            {working || handoff ? (
              <SafeMarkdown text={shownText[1].text} size="chat" />
            ) : (
              <MessageBody text={shownText[1].text} markdown size="chat" copy={false} />
            )}
            {/* Under the words it stopped at, so they keep their place. */}
            {cutOff ? (
              <p className="text-caption text-muted-foreground" role="note">
                {tm('interrupted')}
                {shownText[1].truncated ? ` · ${tm('truncated')}` : ''}
              </p>
            ) : null}
          </div>
        ) : null}
        {resultError ? (
          <p role="alert" className="flex items-center gap-2 text-caption text-danger">
            {t('resultUnavailable')}
            <Button variant="tertiary" onClick={() => setRetry((value) => value + 1)}>
              {t('retryResult')}
            </Button>
          </p>
        ) : null}
        {shownResults.map((result, index) => (
          <ChatResult
            key={result.artifactVersionId}
            result={result}
            text={textOf(result)}
            projection={projection}
            bodyMetadataCurrent={bodyMetadataCurrent}
            label={label}
            sessionId={sessionId}
            partial={partial}
            first={index === 0}
            actionsInTail={result === tailResult}
          />
        ))}
        {state.streamError ? (
          <p role="alert" className="text-caption text-danger">
            {state.streamError}
          </p>
        ) : null}
        {/* A turn that did not finish ends its body with why, and what to do next. The session
            may know the turn ended before this view has read it: recovery stays in that place. */}
        {unfinished || endActions ? (
          <TurnEnd
            reason={
              unfinished && code && !repeatsHead ? (
                <RunReason code={code} nodeLabel={label} />
              ) : null
            }
            failure={
              endFailure?.error ? (
                <FailureNotice
                  message={endFailure.error}
                  cancelled={endFailure.status === 'cancelled'}
                />
              ) : null
            }
            actions={endActions}
          />
        ) : null}
      </RunRow>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Outside a conversation: the run's controls, the cards that need the person, what went
          wrong, then the work log, the reply and the results. */}
      {working ? <RunActions session={store} compact /> : null}
      {approval}
      {toolAttention}
      {reasonLine}
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
      <ThinkingSteps
        id={`work-log-${runId}`}
        className="work-log w-full"
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
      {writing && chatDensity !== 'results' ? (
        <div data-testid="live-text" aria-live="off" className="min-w-0">
          <p className="mb-1 text-micro text-muted-foreground">
            {current
              ? t('writing', { name: writer ? name(writer) : '' })
              : writer
                ? name(writer)
                : null}
          </p>
          <StreamingReply>
            {!working && !handoff ? <p role="note">{tm('interrupted')}</p> : null}
            <SafeMarkdown text={writing[1].text} />
            {current ? (
              <span
                aria-hidden="true"
                className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-muted align-text-bottom motion-reduce:animate-none"
              />
            ) : null}
          </StreamingReply>
        </div>
      ) : null}
      {resultError ? (
        <p role="alert" className="flex items-center gap-2 text-caption text-danger">
          {t('resultUnavailable')}
          <Button variant="tertiary" onClick={() => setRetry((value) => value + 1)}>
            {t('retryResult')}
          </Button>
        </p>
      ) : null}
      {shownResults.map((result, index) => (
        <ChatResult
          key={result.artifactVersionId}
          result={result}
          text={textOf(result)}
          projection={projection}
          bodyMetadataCurrent={bodyMetadataCurrent}
          label={label}
          sessionId={sessionId}
          partial={partial}
          first={index === 0}
        />
      ))}
      {state.streamError ? (
        <p role="alert" className="text-caption text-danger">
          {state.streamError}
        </p>
      ) : null}
      {endActions ? <div className="flex flex-wrap gap-2">{endActions}</div> : null}
    </div>
  );
}

/**
 * The icon row under a message: quiet until its message is hovered or holds focus, always
 * shown under the latest answer and on touch screens (index.css). Its buttons keep their
 * place in the tab order either way.
 */
export function TurnActions({ children }: { children: ReactNode }) {
  const compact = useSize().variant === 'compact';
  return (
    <div
      data-testid="turn-actions"
      className={`turn-actions ${compact ? '-ml-1.5 min-h-7' : '-ml-2.5 min-h-9'} flex flex-wrap items-center gap-0.5 text-muted-foreground transition-opacity duration-(--duration-moderate) ease-(--ease-out-soft) motion-reduce:transition-none`}
    >
      {children}
    </div>
  );
}

/** Where a result opens: the run's results, beside the conversation when there is one. */
function resultLink(projection: RunProjection, sessionId: string | null) {
  return {
    location: {
      to: sessionId ? ('/sessions/$sessionId' as const) : ('/runs/$runId' as const),
      params: sessionId ? { sessionId } : { runId: projection.runId },
    },
    search: (id: string) => ({
      ...(sessionId ? { panel: 'run' as const, run: projection.runId } : {}),
      view: 'results' as const,
      result: id,
    }),
  };
}

/** A result's icon actions: copy its text, open it in the results. */
function ResultActions({
  projection,
  result,
  text,
  readable,
  sessionId,
}: {
  projection: RunProjection;
  result: ResultItem;
  text: string | undefined;
  readable: boolean;
  sessionId: string | null;
}) {
  const tr = useTranslations('Results');
  if (text === undefined && !readable) return null;
  const { location, search } = resultLink(projection, sessionId);
  return (
    <TurnActions>
      {text !== undefined ? <CopyTextButton text={text} /> : null}
      {readable ? (
        <Tooltip content={tr('openResults')}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={tr('openResults')}
            render={<Link {...location} search={search(result.artifactVersionId)} />}
          >
            <PanelRight />
          </Button>
        </Tooltip>
      ) : null}
    </TurnActions>
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
  actionsInTail = false,
}: {
  result: ResultItem;
  text: string | undefined;
  projection: RunProjection;
  label: (nodeId: string) => string;
  sessionId: string | null;
  partial: boolean;
  first: boolean;
  bodyMetadataCurrent: boolean;
  /** The run row's tail holds this answer's icon actions. */
  actionsInTail?: boolean;
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
  const { location, search } = resultLink(projection, sessionId);
  const actions = actionsInTail ? null : (
    <ResultActions
      projection={projection}
      result={result}
      text={text}
      readable={readable}
      sessionId={sessionId}
    />
  );
  // in a conversation the answer is always visible, without a version header.
  if (sessionId && !partial && !result.media && !review)
    return (
      <div className="flex min-w-0 flex-col gap-1 wrap-anywhere" data-testid="chat-result">
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
