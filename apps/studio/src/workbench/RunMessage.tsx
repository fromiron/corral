import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { canReadArtifactBody, pendingInteractions, type RunProjection } from '@corral/core';
import {
  type AdviceEntry,
  AdviceSummary,
  AdviceText,
  ApprovalPanel,
  agentName,
  buildTurnProcess,
  CopyTextButton,
  ExecutionTranscript,
  executionViewPresence,
  FailureNotice,
  GeneratedImage,
  MessageBody,
  type Presence,
  PresenceBadge,
  type PresenceKind,
  presenceTextClass,
  projectionPresence,
  ReasoningSummary,
  type ResultItem,
  ReviewSummary,
  RunActions,
  RunReason,
  requestOpen,
  runResults,
  SafeMarkdown,
  unreadAdviceOf,
  useAdviceSeen,
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
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { markRunReviewed } from '../pages/GettingStarted.tsx';
import { useRemembered } from '../pages/Workbench.tsx';
import { AdviceArrival, type AdviceArrivalValue, bringAdviceIntoView } from './adviceArrival.ts';
import { agentSummary } from './agentSummary.ts';
import { holdPointer } from './ChatView.tsx';
import { type ChatDensity, preferences } from './preferences.ts';
import { chooseProcess, keepRowHeight, processChoice, rowHeight } from './processChoices.ts';
import { ReplyBody } from './ReplySelection.tsx';
import { RunHead, RunRow, RunTail, TurnEnd } from './RunRow.tsx';
import { TurnProcess, useStepName } from './TurnProcess.tsx';
import { useCorralRun } from './useCorralChat.ts';
import { fileChangeCount, toolRows } from './widgets/selectors.ts';

/** An execution that ended without its work: failed or cancelled. */
const ENDED_SHORT = new Set<PresenceKind>(['failed', 'cancelled']);

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
  listedPresence,
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
  /**
   * The run's state as the run list has it: said to assistive tech in the state's place while
   * the record is read, as the head line says it once it is.
   */
  listedPresence?: Presence;
}) {
  const t = useTranslations('Desktop');
  const trun = useTranslations('Run');
  const tt = useTranslations('Transcript');
  const tw = useTranslations('Widgets');
  const tm = useTranslations('MessageBody');
  const tp = useTranslations('Presence');
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
  const [bodyReadFailed, setResultError] = useState(false);
  const [retry, setRetry] = useState(0);
  const groupLabel = useId();
  const {
    store,
    state,
    conversationTurn,
    bodyMetadataCurrent = true,
    bodyCheckFailed = false,
    settled = true,
  } = useCorralRun(runId, live, expanded, artifactMetadataVersion);
  // The last words a finishing conversation turn showed, kept while its answer is still on the way.
  const heldWords = useRef<[string, (typeof state.streams)[string]] | null>(null);
  // The answers' texts this row has read, by result version: what it drew does not go while it
  // waits for the conversation turn's record, live or reading it.
  const answersRead = useRef(new Map<string, string>());
  const waitingForTurn = Boolean(sessionId) && (live || !settled);
  // In a conversation the turn's record keeps the answer before any body of it is released, so a
  // body read that fails (a later run's success released it first, say) waits for that record:
  // only a record read without the answer leaves the failure to say.
  const resultError = bodyReadFailed && !waitingForTurn;
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
  const ta = useTranslations('Advice');
  const advisorWord = ta('advisor');
  // A conversation's own advisor has no name: it is called by the one word (features/advisor.md).
  const label = useCallback(
    (nodeId: string) => agentName(state.definition, nodeId, advisorWord),
    [state.definition, advisorWord],
  );
  // Advice no target read, on the row's tail: opened when the person comes here to read it,
  // whether the row was drawn before or mounts for it (features/inbox.md `advice`).
  const arrival = useContext(AdviceArrival);
  const [adviceOpen, setAdviceOpen] = useState(false);
  const adviceId = useId();
  const adviceSeen = useAdviceSeen();
  const unreadCount = useMemo(
    () => (state.projection ? unreadAdviceOf(state.projection).length : 0),
    [state.projection],
  );
  const recordRead = Boolean(state.projection);
  const taken = useRef<number | null>(null);
  const [placing, setPlacing] = useState<AdviceArrivalValue | null>(null);
  const settling = useRef<(() => void) | null>(null);
  useEffect(() => () => settling.current?.(), []);
  useEffect(() => {
    if (!arrival || arrival.runId !== runId || !recordRead || taken.current === arrival.key) return;
    taken.current = arrival.key;
    if (unreadCount) {
      setAdviceOpen(true);
      setPlacing(arrival);
    }
    arrival.done();
  }, [arrival, runId, recordRead, unreadCount]);
  // Once open and laid out, the words are brought above the composer.
  useEffect(() => {
    if (!placing || !adviceOpen) return;
    const frame = requestAnimationFrame(() => {
      const words = document
        .getElementById(adviceId)
        ?.querySelector<HTMLElement>('[data-advice-text]');
      settling.current?.();
      settling.current = words ? bringAdviceIntoView(words, sessionId ?? null) : null;
      setPlacing(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [placing, adviceOpen, adviceId, sessionId]);
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
  // What waits on the person is answered in the conversation's needed-now tray, and the
  // composer's notice names a waiting question, so the turn does not repeat either.
  const interactions = sessionId ? pendingInteractions(state.events, projection) : [];
  if (!projection && sessionId)
    // The row's three lines before its record is read; the words come into the same places. The
    // place of the run's state is its own already, so the activity bar does not say the state for
    // a row on screen while its words load.
    return (
      <RunRow
        {...held}
        head={
          <RunHead trailing={runLine}>
            <Skeleton data-presence-label={`run:${runId}`} className="h-3 w-40 max-w-full">
              {listedPresence && tp.has(listedPresence.labelKey) ? (
                <span className="sr-only">{tp(listedPresence.labelKey)}</span>
              ) : null}
            </Skeleton>
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
  // The run's state, as every screen says it (docs/specs/features/presence.md): every open
  // request once, by the order the record holds them.
  const presence = projectionPresence(projection, state.events);
  // In a conversation the process opens only by the detailed density or by the person; the
  // run starting or ending neither opens nor folds it.
  const processOpen = chosen ?? chatDensity === 'detailed';
  // The run's roles: an advisor watches them and is not one (features/advisor.md).
  const roles = projection.executionOrder.filter((id) => !projection.executions[id]?.advisor);
  const executions = roles.flatMap((id) => projection.executions[id] ?? []);
  // Current session activity lives by the composer and in the agent widget.
  // Historical failures stay visible here, while standalone consumers keep their activity row.
  const busy =
    working && !sessionId && chatDensity !== 'results'
      ? executions.filter((execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status))
      : [];
  const summary = agentSummary(busy.map((execution) => execution.status));
  // Failures and cancellations stay in view. An ordinary success folds them.
  const exposed = executions.filter((execution) =>
    ENDED_SHORT.has(executionViewPresence(execution).kind),
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
  const textOf = (result: ResultItem) => {
    const text =
      result.artifactVersionId === preservedTurn?.artifactVersionId
        ? (preservedTurn.answer ?? undefined)
        : bodyMetadataCurrent && canReadArtifactBody(projection, result.artifactVersionId)
          ? state.artifactTexts[result.artifactVersionId]
          : undefined;
    if (text !== undefined) answersRead.current.set(result.artifactVersionId, text);
    // A later run's success can release a body this row read while the row still waits for its
    // turn's record, which keeps the answer: the text read stays until that record is read.
    return text ?? (waitingForTurn ? answersRead.current.get(result.artifactVersionId) : undefined);
  };
  // What a model is writing right now, shown in the conversation; never a fact.
  // A turn finishing here hands its last reply (if any) over to the result once the result's
  // text is read, so the answer never flashes "Loading…" in between. A failed read ends it.
  // A conversation turn's answer may come only with the turn's record, read once the row is no
  // longer live: until that read has settled, its last words keep their place.
  const handoff =
    watched &&
    !working &&
    !resultError &&
    (sessionId
      ? !bodyCheckFailed &&
        (live || !settled || bodiesPending) &&
        visible.some(
          (result) =>
            !result.media &&
            !projection.reviews[result.artifactVersionId] &&
            textOf(result) === undefined,
        )
      : visible.some(
          (result) =>
            !result.media &&
            !projection.reviews[result.artifactVersionId] &&
            result.artifactVersionId !== preservedTurn?.artifactVersionId &&
            bodyMetadataCurrent &&
            canReadArtifactBody(projection, result.artifactVersionId) &&
            state.artifactTexts[result.artifactVersionId] === undefined,
        ));
  // In a conversation only the lead's reply can become the answer; delegates speak in rows.
  const lead = projection.executionOrder[0];
  // Responses an interrupt cut, in call order: interrupted output, never the answer. In a
  // conversation they stay where they stood, through later replies and the run's end; what the
  // run writes after them comes below.
  const stopped =
    sessionId && chatDensity !== 'results'
      ? Object.entries(state.streams).filter(([id, stream]) => {
          const call = projection.modelCalls[id];
          return (
            call?.interrupted === true &&
            (!call.executionId || call.executionId === lead) &&
            Boolean(stream.text)
          );
        })
      : [];
  const lastCut = stopped.length
    ? Object.keys(state.streams).indexOf(stopped[stopped.length - 1]?.[0] ?? '')
    : -1;
  const streams =
    working || handoff || !projection.output
      ? Object.entries(state.streams).filter(([id], index) => {
          const owner = projection.modelCalls[id]?.executionId;
          return (
            index > lastCut &&
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
    (presence.kind === 'starting' || presence.kind === 'working') &&
    interactions.length === 0 &&
    !streams.some(([, stream]) => stream.text) &&
    stopped.length === 0 &&
    visible.length === 0;
  // The wait names the tool or role in progress, as the log names it; the head already says the
  // state. A model request's name says nothing to the person, so it waits with the mark alone.
  const activeStep = process.rows.filter((row) => row.active).at(-1);
  const pendingStep =
    activeStep && activeStep.kind !== 'model' && activeStep.kind !== 'advice'
      ? stepName(activeStep)
      : null;
  const pendingWord = tw(presence.kind === 'working' ? 'activityWorking' : 'activityStarting');
  // A turn that did not finish says so once: its readable cause, whether it made anything,
  // and what to do next. One agent's failure is the turn's failure; a team lists its agents.
  const unfinished = Boolean(sessionId) && !working && presence.kind !== 'succeeded';
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
      <PresenceBadge
        presence={executionViewPresence(execution)}
        target={sessionId ? `execution:${execution.executionId}` : undefined}
      />
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
        <FailureNotice
          message={execution.error}
          cancelled={executionViewPresence(execution).kind === 'cancelled'}
        />
      ) : null}
    </li>
  );
  const toolAttention = attention.length ? (
    <ul
      className="flex flex-col gap-1 text-caption"
      aria-label={t('toolActivity', { count: attention.length })}
    >
      {presence.kind === 'succeeded' && attention.some((row) => row.tone === 'failed') ? (
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
  // An ended turn's reason closes its body; what waits on the person says itself in the tray.
  const reasonLine =
    projection.statusReason &&
    !unfinished &&
    !(sessionId && interactions.length) &&
    presence.kind !== 'working' &&
    presence.kind !== 'succeeded' ? (
      <p data-testid="run-reason" className="text-caption text-muted-foreground">
        {trun('reasonPrefix')} <RunReason code={projection.statusReason} nodeLabel={label} />
      </p>
    ) : null;
  // Outside a conversation the run's cards stand in its turn. In one, what waits on the person is
  // answered in the conversation's needed-now tray at the end of the timeline, not in the row.
  const approval = sessionId ? null : (
    <ApprovalPanel session={store} onOpenArtifact={onOpenArtifact} />
  );
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
    // The state's name alone is the run's label; its detail (a loop that ran out of rounds
    // before the run completed) stands beside it, so the row tells it without its log open.
    const status = (
      <>
        <span
          data-presence-label={`run:${runId}`}
          data-presence={presence.kind}
          className={
            // A working run's word shimmers as the kit's work does; reduced motion stills it.
            // Otherwise a state that needs a look takes its tone's colour.
            presence.tone === 'active'
              ? 'shimmer-text'
              : presence.tone === 'danger' || presence.tone === 'warning'
                ? presenceTextClass(presence.tone)
                : undefined
          }
        >
          {tp(presence.labelKey)}
        </span>
        {presence.detailKey ? (
          <span data-presence-detail>{` · ${tp(presence.detailKey)}`}</span>
        ) : null}
      </>
    );
    const liveWords = writing && chatDensity !== 'results' ? writing : undefined;
    // The store may let a finished reply's words go before its answer is read: the words it
    // showed stay until the answer takes their place.
    if (liveWords) heldWords.current = liveWords;
    else if (!handoff) heldWords.current = null;
    const shownText = liveWords ?? (handoff ? (heldWords.current ?? undefined) : undefined);
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
    const shownBlocks = shownResults.filter((result) => !inline(result));
    const resultBlock = (result: ResultItem, index: number) => (
      <ChatResult
        key={result.artifactVersionId}
        result={result}
        text={textOf(result)}
        projection={projection}
        bodyMetadataCurrent={bodyMetadataCurrent}
        readEnded={bodyCheckFailed || resultError}
        label={label}
        sessionId={sessionId}
        partial={partial}
        first={index === 0}
        kindShown={false}
        actionsInTail={result === tailResult}
      />
    );
    // The blocks say their kind once, over them (features/presence.md), from the first block on:
    // a later one changes only the name's number, so nothing above or in the first block moves.
    // A list named by its kind, so each block is read as one of those results. Every block of a
    // row is of one kind: all are final results, or all are partial ones (runResults).
    const resultGroup = (
      <div key="result-group" className="flex min-w-0 flex-col gap-1.5">
        <p id={groupLabel} className="text-caption text-muted-foreground">
          {tturn(partial ? 'partialKind' : 'resultKind', { count: shownBlocks.length })}
        </p>
        <ul aria-labelledby={groupLabel} className="flex min-w-0 flex-col gap-3">
          {shownBlocks.map((result) => (
            <li key={result.artifactVersionId} className="min-w-0">
              {resultBlock(result, shownResults.indexOf(result))}
            </li>
          ))}
        </ul>
      </div>
    );
    // The answers in their places; the blocks where the first of them stands.
    const resultParts = shownResults.flatMap((result, index) =>
      inline(result)
        ? [resultBlock(result, index)]
        : result === shownBlocks[0]
          ? [resultGroup]
          : [],
    );
    // Advice a role ended before reading: a concern or a blocker stays here (features/advisor.md).
    const unread = unreadAdviceOf(projection);
    const adviserOf = (item: AdviceEntry) => {
      const observer = projection.executions[item.observerExecutionId];
      return observer ? label(observer.nodeId) : item.observerExecutionId;
    };
    const advisers = new Set(unread.map((item) => item.observerExecutionId));
    const unreadName =
      advisers.size > 1
        ? ta('advisors', { count: advisers.size })
        : unread[0]
          ? adviserOf(unread[0])
          : '';
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
          <>
            <RunTail values={tailValues}>
              {/* The answer's actions keep their place whatever the line holds after them. */}
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
              {unread.length ? (
                // Written into the tail's own line, after what it held: an ended row keeps its
                // height and nothing on it moves (rule 3). Narrow, its first line gives way.
                <AdviceSummary
                  name={unreadName}
                  items={unread}
                  open={adviceOpen}
                  controls={adviceId}
                  onToggle={() => setAdviceOpen((value) => !value)}
                />
              ) : null}
            </RunTail>
            {unread.length ? (
              // Opened by the person, so the row may grow under its tail.
              <AdviceText
                id={adviceId}
                open={adviceOpen}
                items={unread}
                nameOf={adviserOf}
                {...(adviceSeen ? { onSeen: (shown) => adviceSeen.seen(runId, shown) } : {})}
                className="text-caption"
              />
            ) : null}
          </>
        }
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
        {stopped.map(([id, stream], index) => (
          // Drawn as the reply being written is, so a cut takes nothing from its height; it reads
          // as interrupted once something follows it or the run has ended.
          <div
            key={id}
            data-testid="stopped-text"
            className="flex min-w-0 flex-col gap-1 wrap-anywhere"
          >
            {/* Interrupted output can be quoted too, as that call's words. */}
            <ReplyBody runId={runId} modelCallId={id}>
              {working || handoff ? (
                <SafeMarkdown text={stream.text} size="chat" />
              ) : (
                <MessageBody text={stream.text} markdown size="chat" copy={false} />
              )}
            </ReplyBody>
            {index < stopped.length - 1 || shownText || shownResults.length || !working ? (
              <p className="text-caption text-muted-foreground" role="note">
                {tm('interrupted')}
                {stream.truncated ? ` · ${tm('truncated')}` : ''}
              </p>
            ) : null}
          </div>
        ))}
        {shownText ? (
          // The reply being written reads as the answer it may become.
          <div
            data-testid="live-text"
            aria-live="off"
            className="live-text flex min-w-0 flex-col gap-1 wrap-anywhere"
          >
            <ReplyBody runId={runId} modelCallId={shownText[0]}>
              {working || handoff ? (
                <SafeMarkdown text={shownText[1].text} size="chat" />
              ) : (
                <MessageBody text={shownText[1].text} markdown size="chat" copy={false} />
              )}
            </ReplyBody>
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
        {resultParts}
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
                  cancelled={executionViewPresence(endFailure).kind === 'cancelled'}
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
                {summary.working > 0 && presence.kind === 'working' ? (
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
          {t('activity')} <span className="tabular-nums">{roles.length}</span>
        </ThinkingStepsHeader>
        <ThinkingStepsContent>
          {expanded || logShown ? (
            <>
              <WorkPlanPanel session={store} />
              {roles.map((id, index) => {
                const execution = projection.executions[id];
                if (!execution) return null;
                const key = `${runId}:${id}`;
                const call = execution.modelCallIds.at(-1);
                return (
                  <ThinkingStep
                    key={id}
                    label={name(id)}
                    status={
                      // Working on its own, not waiting on others (no detail).
                      executionViewPresence(execution).kind === 'working' &&
                      !executionViewPresence(execution).detail
                        ? 'active'
                        : 'complete'
                    }
                    icon={
                      executionViewPresence(execution).kind === 'succeeded'
                        ? 'check'
                        : ENDED_SHORT.has(executionViewPresence(execution).kind)
                          ? 'x'
                          : 'dot'
                    }
                    isLast={index === roles.length - 1}
                  >
                    <span className="flex flex-wrap items-center gap-2 text-caption">
                      <PresenceBadge presence={executionViewPresence(execution)} />
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
          readEnded={bodyCheckFailed || resultError}
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
      className={`turn-actions ${compact ? '-ml-1.5 min-h-7' : '-ml-2.5 min-h-9'} flex shrink-0 flex-wrap items-center gap-0.5 text-muted-foreground transition-opacity duration-(--duration-moderate) ease-(--ease-out-soft) motion-reduce:transition-none`}
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
  readEnded = false,
  kindShown = true,
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
  /** Reading ended without this body: the row's error says why, so it does not say loading. */
  readEnded?: boolean;
  /** Whether its line names its kind; a group of blocks names it once, over them. */
  kindShown?: boolean;
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
  // No body is on its way: what is unconfirmed or readable but unread waits for nothing.
  const unread = readEnded && (!bodyMetadataCurrent || (readable && !result.media && !review));
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
  // The model call that wrote the answer: a quote of it counts in its drawn text.
  const replyCall = projection.artifacts[result.artifactVersionId]?.modelCallId;
  // in a conversation the answer is always visible, without a version header.
  if (sessionId && !partial && !result.media && !review)
    return (
      <div className="flex min-w-0 flex-col gap-1 wrap-anywhere" data-testid="chat-result">
        {text !== undefined ? (
          replyCall ? (
            <ReplyBody runId={projection.runId} modelCallId={replyCall}>
              <MessageBody text={text} markdown size="chat" copy={false} />
            </ReplyBody>
          ) : (
            <MessageBody text={text} markdown size="chat" copy={false} />
          )
        ) : unread ? null : (
          <p className="text-caption text-muted-foreground">
            {ta(!bodyMetadataCurrent || readable ? 'loading' : 'retired')}
          </p>
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
        {kindShown ? `${partial ? tr('partial') : t('result')} · ` : null}
        {result.name} v{result.version}
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
          {unread ? null : !bodyMetadataCurrent ? (
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
