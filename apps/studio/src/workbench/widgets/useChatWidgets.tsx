import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import {
  canReadArtifactBody,
  canReleaseArtifactBodies,
  pendingInteractions,
  type RunProjection,
} from '@corral/core';
import {
  estimateRunCost,
  type RunCostEstimate,
  type RunSessionState,
  type RunSessionStore,
  runResults,
  useWorkPlanSnapshot,
} from '@corral/react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useRemembered } from '../../pages/Workbench.tsx';
import { useModelPrices } from '../../prices.ts';
import { useServices } from '../../services.tsx';
import { type CompactReason, compactTarget } from '../compactTarget.ts';
import { useQuestionNotice } from '../questionNotice.ts';
import { readRunView } from '../readRunView.ts';
import { contextCalls } from './contextCalls.ts';
import {
  actionRequired,
  activityLine,
  agentActivity,
  type ContextPresentation,
  changesPresentation,
  currentAgentExecutions,
  effectAttention,
  failedToolExecutionId,
  fileChangeSignals,
  type PlanRef,
  presentContext,
  runToolRows,
  selectPresentedPlan,
  type UsageSummary,
  usageSummary,
  viewedRun,
  visibleWidgets,
  widgetReadState,
  workPlanOpen,
  workPlanPreferenceKey,
} from './selectors.ts';

export interface ChatWidgetModel {
  sessionId: string;
  runId: string | null;
  runNumber: number | null;
  live: boolean;
  /** The finished run on screen and its place among the session's runs. */
  viewed: ReturnType<typeof viewedRun>;
  simulated: boolean;
  readState: 'empty' | 'loading' | 'ready' | 'error';
  retryRead: () => void;
  context: ContextPresentation;
  reserveTokens: number | null;
  chips: ReturnType<typeof visibleWidgets>;
  changesLabel: 'provisional' | 'fixed' | 'unavailable' | 'error' | null;
  changeFiles: number | null;
  changeLines: number | null;
  changeAdditions: number | null;
  changeDeletions: number | null;
  agents: { total: number; working: number; waiting: number; failed: number } | null;
  /** Current attempts only; the execution view retains retry history. */
  agentRows: { id: string; name: string; status: string }[];
  tools: { id: string; name: string; tone: string }[];
  results: { id: string; label: string }[];
  environment: 'simulated' | 'restricted' | null;
  /** Output tokens, calls and their limits for the Usage widget. */
  usage: UsageSummary | null;
  /** The list-price estimate, or why there is none; null before the run is read. */
  cost: RunCostEstimate | null;
  action: ReturnType<typeof actionRequired>;
  /** The waiting questions' notice (first title, count from two), once the first is read. */
  questionNotice: string | null;
  failedExecutionId: string | null;
  /** Manual compaction for the execution this context is showing. */
  compaction?: {
    reason: CompactReason | null;
    pending: boolean;
    phase: 'queued' | 'started' | 'completed' | 'failed' | 'cancelled' | 'skipped' | null;
    request: () => Promise<string | null>;
  };
  activity: ReturnType<typeof activityLine> & { runId: string | null };
  plan: {
    open: boolean;
    setOpen: (open: boolean) => void;
    status: ReturnType<typeof useWorkPlanSnapshot>['status'];
    choices: ReturnType<typeof selectPresentedPlan>['choices'];
    multiple: boolean;
    auto: boolean;
    selectedKey: string | null;
    selectedChoice: ReturnType<typeof selectPresentedPlan>['choices'][number] | null;
    runStatus: string | null;
    retry: () => void;
    follow: () => void;
    choose: (key: string) => void;
  };
  notice: string;
}

type PlanProgressStatus = Extract<
  ReturnType<typeof useWorkPlanSnapshot>['status'],
  { plan: unknown }
>;

const ChatWidgetContext = createContext<ChatWidgetModel | null>(null);
const NO_TEXTS: Readonly<Record<string, string>> = {};

export function useChatWidget() {
  return useContext(ChatWidgetContext);
}

export function ChatWidgetProvider({
  sessionId,
  presentationRunId,
  live,
  runIds,
  children,
}: {
  sessionId: string;
  presentationRunId: string | null;
  live: boolean;
  /** The session's runs, oldest first. */
  runIds: readonly string[];
  children: ReactNode;
}) {
  const model = useChatWidgetState(sessionId, presentationRunId, live, runIds);
  return <ChatWidgetContext.Provider value={model}>{children}</ChatWidgetContext.Provider>;
}

function useChatWidgetState(
  sessionId: string,
  presentationRunId: string | null,
  live: boolean,
  runIds: readonly string[],
): ChatWidgetModel {
  const { runFor, sessionFor, retainRun, transport, readHistory, workspaces, mode } = useServices();
  const prices = useModelPrices();
  const session = presentationRunId ? runFor(presentationRunId) : sessionFor(sessionId);
  useEffect(() => {
    if (!presentationRunId || !live) return;
    const release = retainRun(presentationRunId);
    void session.getState().open(presentationRunId);
    return release;
  }, [session, presentationRunId, live, retainRun]);
  // Token deltas update streams only. They must not rescan all committed events or plan bodies.
  const shared = useStore(
    session,
    useShallow((state) => ({
      runId: state.runId,
      projection: state.projection,
      definition: state.definition,
      events: state.events,
      artifactTexts: state.artifactTexts,
      streamError: state.streamError,
      missingRunId: state.missingRunId,
    })),
  );
  const usingLive = Boolean(
    presentationRunId &&
      shared.runId === presentationRunId &&
      shared.projection?.runId === presentationRunId,
  );
  const target = useMemo(
    () => ({ sessionId, runId: presentationRunId, transport, readHistory }),
    [sessionId, presentationRunId, transport, readHistory],
  );
  const [snapshot, setSnapshot] = useState<{
    target: typeof target;
    view: Awaited<ReturnType<typeof readRunView>> | null;
    failed: boolean;
  } | null>(null);
  const [retryRead, setRetryRead] = useState(0);
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    void retryRead;
    if (!presentationRunId || live || usingLive) return;
    let current = true;
    void readRunView(transport, readHistory, presentationRunId, true).then(
      (view) => {
        if (current && view.runId === presentationRunId)
          setSnapshot({ target, view, failed: false });
      },
      () => {
        if (current) setSnapshot({ target, view: null, failed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [target, presentationRunId, live, usingLive, transport, readHistory, retryRead]);
  const view = usingLive ? shared : snapshot?.target === target ? snapshot.view : null;
  const projection = view?.runId === presentationRunId ? view.projection : null;
  const [changeRead, setChangeRead] = useState<{
    target: typeof target;
    source: typeof workspaces;
    value: ReturnType<typeof changesPresentation> | null;
  } | null>(null);
  const changes =
    changeRead?.target === target && changeRead.source === workspaces ? changeRead.value : null;
  const { revision: fileRevision, poll: pollChanges } = useMemo(
    () => fileChangeSignals(Object.values(projection?.toolCalls ?? {}), projection?.status, live),
    [projection?.toolCalls, projection?.status, live],
  );
  useEffect(() => {
    void fileRevision;
    void projection?.status;
    if (!presentationRunId || !workspaces) return;
    let current = true;
    let pending = false;
    const setChanges = (value: ReturnType<typeof changesPresentation> | null) =>
      setChangeRead({ target, source: workspaces, value });
    const read = () => {
      if (pending) return;
      pending = true;
      void workspaces
        .worktree(sessionId)
        .then((tree) => {
          if (!current) return;
          if (!tree || tree.missing) {
            setChanges(null);
            return;
          }
          return workspaces
            .changes(sessionId, { kind: 'run', runId: presentationRunId })
            .then((value) => {
              if (!current) return;
              const uncounted = value.files.filter(
                (file) => file.additions == null || file.deletions == null,
              ).length;
              const additions = value.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
              const deletions = value.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
              const lines = additions + deletions;
              setChanges(
                changesPresentation({
                  baselineApplied: true,
                  provisional: live,
                  state: value.unavailable ? 'unavailable' : 'ready',
                  files: value.files.length,
                  lines: uncounted ? null : lines,
                  additions: uncounted ? null : additions,
                  deletions: uncounted ? null : deletions,
                  uncounted,
                }),
              );
            });
        })
        .catch(() => {
          if (current) setChanges({ kind: 'error' });
        })
        .finally(() => {
          pending = false;
        });
    };
    read();
    // A service may write later without another tool event. Keep the live run's diff fresh,
    // with at most one read in flight; paused, terminal and historical runs do not poll.
    const timer = pollChanges ? setInterval(read, 2000) : null;
    return () => {
      current = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [
    target,
    workspaces,
    sessionId,
    presentationRunId,
    live,
    projection?.status,
    fileRevision,
    pollChanges,
  ]);

  const plans = useMemo(() => planRefs(projection?.workPlans), [projection?.workPlans]);
  const executions = useMemo(
    () =>
      executionFacts(projection?.executions, projection?.executionOrder, view?.definition ?? null),
    [projection?.executions, projection?.executionOrder, view?.definition],
  );
  const [manualKey, setManualKey] = useRemembered<string | null>(
    `corral:work-plan-role:v1:${sessionId}:${presentationRunId ?? 'none'}`,
    null,
  );
  const selected = selectPresentedPlan({
    plans,
    executions,
    manualKey: manualKey && manualKey !== 'auto' ? manualKey : null,
  });
  const ref = selected.selected;
  const selectedChoice =
    selected.choices.find((choice) => choice.key === selected.selectedKey) ?? null;
  const preferenceKey = ref
    ? workPlanPreferenceKey({
        sessionId,
        runId: presentationRunId ?? 'none',
        scope: ref.scope,
        owner: ref.executionId,
        attempt: ref.attemptNo,
      })
    : `corral:work-plan:v1:${sessionId}:none`;
  const [preference, setPreference] = useRemembered<'auto' | 'open' | 'closed'>(
    preferenceKey,
    'auto',
  );
  const text = ref && view ? view.artifactTexts[ref.bodyRef] : undefined;
  const loadPlan = useCallback(
    async (bodyRef: string, options?: { reload?: boolean }) => {
      if (!presentationRunId) return null;
      if (usingLive) {
        if (session.getState().runId !== presentationRunId) return null;
        await session.getState().loadArtifact(bodyRef, options);
        return session.getState().runId === presentationRunId
          ? (session.getState().artifactTexts[bodyRef] ?? null)
          : null;
      }
      return transport.getArtifactText(presentationRunId, bodyRef);
    },
    [presentationRunId, usingLive, session, transport],
  );
  const { status: readPlan, retry: retryPlan } = useWorkPlanSnapshot({
    runId: presentationRunId,
    ref,
    currentCriteriaVersionId: projection?.currentCriteriaVersionId ?? null,
    currentAttemptNo: ref ? projection?.executions[ref.executionId]?.attemptNo : null,
    runStatus: projection?.status,
    load: loadPlan,
    cacheScope: usingLive ? session : transport,
    text,
  });
  // A settled run releases its plan body. The chip keeps the count it last read for this plan
  // revision, or is not shown; a released body is never a load error.
  const planOwner =
    presentationRunId && ref
      ? [presentationRunId, ref.scope, ref.executionId, ref.attemptNo].join('|')
      : null;
  const planKey = planOwner && ref ? [planOwner, ref.revision, ref.bodyHash].join('|') : null;
  const [lastPlan, setLastPlan] = useState<{
    key: string;
    owner: string;
    status: PlanProgressStatus;
  } | null>(null);
  if (
    planKey &&
    planOwner &&
    'plan' in readPlan &&
    (lastPlan?.key !== planKey ||
      lastPlan.status.plan !== readPlan.plan ||
      lastPlan.status.state !== readPlan.state)
  ) {
    setLastPlan({ key: planKey, owner: planOwner, status: readPlan });
  }
  // A newer revision of the same plan is read while the one before stays: its rows change in
  // place, and the plan never gives its place to a loading line it would take back.
  const revising =
    readPlan.state === 'loading' && lastPlan !== null && lastPlan.owner === planOwner;
  const planStatus: ReturnType<typeof useWorkPlanSnapshot>['status'] =
    projection &&
    (readPlan.state === 'loading' || readPlan.state === 'error') &&
    canReleaseArtifactBodies(projection)
      ? lastPlan && lastPlan.key === planKey
        ? { ...lastPlan.status, runFinished: true }
        : { state: 'hidden' }
      : revising && lastPlan
        ? lastPlan.status
        : readPlan;
  // Loading and error details must remain expandable so their scoped Retry is reachable.
  const open = Boolean(ref) && workPlanOpen(preference);
  const calls = useMemo(
    () =>
      contextCalls(
        view?.events ?? [],
        projection?.modelCalls,
        projection?.modelProfiles,
        executions,
      ),
    [view?.events, projection?.modelCalls, projection?.modelProfiles, executions],
  );
  const compactions = useMemo(
    () =>
      (view?.events ?? []).flatMap((event) =>
        event.type === 'context.compaction_changed'
          ? [
              {
                executionId: event.executionId ?? event.payload.executionId,
                phase: event.payload.phase,
                automatic: event.payload.trigger === 'automatic',
                recordedAt: event.recordedAt,
              },
            ]
          : [],
      ),
    [view?.events],
  );
  const executionIds = executions.map((execution) => execution.executionId);
  const context = presentContext({
    calls,
    compactions,
    executionIds,
    selectedExecutionId:
      !selected.auto && selected.selectedKey && selected.selectedKey !== 'team'
        ? selected.selectedKey
        : executionIds.length === 1
          ? (executionIds[0] ?? null)
          : null,
  });
  const readState = widgetReadState({
    presentationRunId,
    projectionRunId: projection?.runId ?? null,
    sharedRunId: shared.runId,
    sharedStreamError: live || usingLive ? shared.streamError : null,
    sharedMissingRunId: live || usingLive ? shared.missingRunId : null,
    archiveFailed: Boolean(snapshot?.target === target && snapshot.failed),
  });
  const retryCurrentRead = () => {
    if ((live || usingLive) && presentationRunId) {
      const current = session.getState();
      // WorkTab owns this stream. Retry only its failed target, never retarget another run.
      if (
        current.runId === presentationRunId &&
        (current.streamError || current.missingRunId === presentationRunId)
      )
        void current.open(presentationRunId);
      return;
    }
    setRetryRead((value) => value + 1);
  };
  const runOpen = Boolean(
    projection && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(projection.status),
  );
  const interactions =
    runOpen && projection ? pendingInteractions(view?.events ?? [], projection) : [];
  const questionNotice = useQuestionNotice(
    interactions.flatMap((item) => (item.kind === 'approval' ? [] : [item])),
    view?.artifactTexts ?? NO_TEXTS,
    loadPlan,
  );
  const action = actionRequired({
    pendingApprovals: interactions.filter((item) => item.kind === 'approval').length,
    pendingQuestions: interactions.filter((item) => item.kind !== 'approval').length,
    ...effectAttention(projection),
    runStatus: projection?.status,
  });
  const activeItem =
    planStatus.state === 'ready' && selectedChoice?.live
      ? planStatus.plan.items.find((item) => item.status === 'in_progress')
      : undefined;
  const tools = runToolRows(projection);
  const currentTool = tools.find((row) => row.tone === 'running') ?? null;
  const resultText = useTranslations('Results');
  const turnText = useTranslations('Turn');
  const listed = projection ? runResults(projection) : null;
  const resultItems = (
    listed?.final.length ? listed.final : (listed?.intermediate.map((group) => group.latest) ?? [])
  )
    .filter((item) => canReadArtifactBody(projection, item.artifactVersionId))
    .map((item) => {
      const nodeId = projection?.executions[item.authorExecutionId]?.nodeId;
      const author = view?.definition?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
      return {
        id: item.artifactVersionId,
        label: [
          `${item.name} v${item.version}`,
          author,
          item.authorExecutionNumber
            ? resultText('authorExecution', { number: item.authorExecutionNumber })
            : null,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    });
  useEffect(() => {
    if (!presentationRunId || !live || projection?.endedAt) return;
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [live, projection?.endedAt, presentationRunId]);
  const activity = {
    ...activityLine({
      runStatus: projection?.status ?? (live ? 'created' : 'succeeded'),
      startedAt: projection?.startedAt ?? null,
      endedAt: projection?.endedAt ?? null,
      now,
      planTitle: activeItem?.title ?? null,
      planVisible: open && Boolean(activeItem),
      // The tool is named as the work log names it (Wait, not await_tasks).
      toolName: currentTool
        ? turnText.has(`tool.${currentTool.name}`)
          ? turnText(`tool.${currentTool.name}`)
          : currentTool.name
        : null,
      failed: action.hasFailure,
      needsUser: action.needsUser,
    }),
    runId: presentationRunId,
  };
  const currentIds = new Set(
    currentAgentExecutions(projection).map((execution) => execution.executionId),
  );
  const awaitingApproval = new Set(
    Object.values(projection?.approvals ?? {}).flatMap((approval) =>
      approval.status === 'pending' && approval.tool ? [approval.tool.executionId] : [],
    ),
  );
  const currentAgents = executions
    .filter((execution) => currentIds.has(execution.executionId))
    .map((execution) =>
      execution.status === 'active' && awaitingApproval.has(execution.executionId)
        ? { ...execution, status: 'waiting_approval' }
        : execution,
    );
  const agents = agentActivity(currentAgents);
  const simulated =
    projection?.mode === 'mock' || (mode === 'browser' && projection?.mode !== 'live');
  const restricted =
    view?.definition?.input.taskScope === 'review_only' ||
    Object.values(projection?.modelProfiles ?? {}).some((profile) => profile.workerIsolation);
  const chips = visibleWidgets({
    hasContext: Boolean(presentationRunId),
    agents: {
      total: agents?.total ?? currentAgents.length,
      working: agents?.working ?? 0,
      waiting: agents?.waiting ?? 0,
      failed: agents?.failed ?? 0,
      delegated: currentAgents.length > 1,
    },
    toolCount: tools.length,
    resultCount: resultItems.length,
    changes,
    environment:
      simulated || restricted
        ? { simulated: Boolean(simulated), restricted: Boolean(restricted) }
        : null,
  });
  const notice = [
    planStatus.state === 'ready' ? `${planStatus.completed}/${planStatus.total}` : '',
    action.visible ? action.summary : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    sessionId,
    runId: presentationRunId,
    live,
    runNumber: presentationRunId ? runIds.indexOf(presentationRunId) + 1 || null : null,
    viewed: viewedRun({ runIds, presentationRunId, live }),
    simulated: Boolean(simulated),
    readState,
    retryRead: retryCurrentRead,
    context:
      readState === 'error'
        ? { ...context, completeness: 'error' }
        : presentationRunId
          ? context
          : { ...context, kind: 'empty' },
    reserveTokens: context.reserveTokens,
    chips,
    changesLabel:
      changes?.kind === 'count'
        ? changes.provisional
          ? 'provisional'
          : 'fixed'
        : changes?.kind === 'unavailable'
          ? 'unavailable'
          : changes?.kind === 'error'
            ? 'error'
            : null,
    changeFiles: changes?.kind === 'count' ? changes.files : null,
    changeLines: changes?.kind === 'count' ? changes.lines : null,
    changeAdditions: changes?.kind === 'count' ? changes.additions : null,
    changeDeletions: changes?.kind === 'count' ? changes.deletions : null,
    agents,
    agentRows: currentAgents.map((execution) => ({
      id: execution.executionId,
      name: execution.roleName,
      status: execution.status,
    })),
    tools,
    results: resultItems,
    environment: simulated ? 'simulated' : restricted ? 'restricted' : null,
    usage: usageSummary(projection),
    cost: projection && prices ? estimateRunCost(projection, prices) : null,
    action,
    questionNotice,
    failedExecutionId: failedToolExecutionId(projection, tools),
    compaction: compactionControl(
      session,
      presentationRunId,
      projection,
      context.executionId,
      compactions,
    ),
    activity,
    plan: {
      open,
      setOpen: (next) => setPreference(next ? 'open' : 'closed'),
      status: plans.length || ref ? planStatus : { state: 'hidden' },
      choices: selected.choices,
      multiple: selected.multiple,
      auto: selected.auto,
      selectedKey: selected.selectedKey,
      selectedChoice,
      runStatus: projection?.status ?? null,
      retry: () => {
        retryPlan();
        if (snapshot?.target === target && snapshot.failed) setRetryRead((value) => value + 1);
      },
      follow: () => setManualKey('auto'),
      choose: (key) => setManualKey(key),
    },
    notice,
  };
}

function compactionControl(
  session: RunSessionStore,
  presentationRunId: string | null,
  projection: RunProjection | null,
  executionId: string | null,
  compactions: {
    executionId?: string;
    phase: NonNullable<ChatWidgetModel['compaction']>['phase'];
    automatic?: boolean;
  }[],
): NonNullable<ChatWidgetModel['compaction']> {
  const decision = compactTarget(projection, executionId);
  const targetId = decision.ok ? decision.executionId : executionId;
  const phase =
    [...compactions].reverse().find((item) => !item.automatic && item.executionId === targetId)
      ?.phase ?? null;
  return {
    reason: decision.ok ? (presentationRunId ? null : 'compactNoExecution') : decision.reason,
    pending: decision.ok && decision.pending,
    phase,
    request: async () => {
      const current = session.getState();
      if (!presentationRunId || current.runId !== presentationRunId || !current.projection)
        return null;
      const next = compactTarget(current.projection, executionId);
      if (!next.ok || next.pending) return null;
      try {
        const receipt = await current.sendCommand({
          type: 'compact_context',
          expectedControlRevision: next.expectedControlRevision,
          payload: { executionId: next.executionId, attemptNo: next.attemptNo },
        });
        return receipt.error?.message ?? null;
      } catch (failure) {
        return failure instanceof Error ? failure.message : String(failure);
      }
    },
  };
}

function planRefs(workPlans: RunProjection['workPlans']): PlanRef[] {
  return Object.values(workPlans ?? {}).map((plan) => ({
    scope: plan.scope,
    executionId: plan.executionId,
    attemptNo: plan.attemptNo,
    revision: plan.revision,
    criteriaVersionId: plan.criteriaVersionId,
    bodyRef: plan.bodyRef,
    bodyHash: plan.bodyHash,
  }));
}

function executionFacts(
  executionViews: RunProjection['executions'] | undefined,
  executionOrder: RunProjection['executionOrder'] | undefined,
  definition: RunSessionState['definition'],
) {
  if (!executionViews) return [];
  return (executionOrder ?? []).flatMap((id) => {
    const execution = executionViews[id];
    if (!execution) return [];
    const node = definition?.nodes.find((item) => item.id === execution.nodeId);
    const role =
      node?.type === 'agent' ? definition?.roles.find((item) => item.id === node.roleId) : null;
    return [
      {
        executionId: id,
        roleId: role?.id ?? execution.nodeId,
        roleName: role?.name ?? node?.label ?? id,
        status: execution.status,
        attemptNo: execution.attemptNo,
        ended: TERMINAL_EXECUTION_STATUSES.has(execution.status),
      },
    ];
  });
}
