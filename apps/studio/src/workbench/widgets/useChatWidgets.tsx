import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import { pendingInteractions, type RunProjection } from '@corral/core';
import { type RunSessionState, runResults, useWorkPlanSnapshot } from '@corral/react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useRemembered } from '../../pages/Workbench.tsx';
import { useServices } from '../../services.tsx';
import { readRunView } from '../readRunView.ts';
import { contextCalls } from './contextCalls.ts';
import {
  actionRequired,
  activityLine,
  agentActivity,
  type ContextPresentation,
  changesPresentation,
  type PlanRef,
  presentContext,
  selectPresentedPlan,
  toolRows,
  visibleWidgets,
  widgetReadState,
  workPlanOpen,
  workPlanPreferenceKey,
} from './selectors.ts';

export interface ChatWidgetModel {
  sessionId: string;
  runId: string | null;
  live: boolean;
  lastRun: boolean;
  simulated: boolean;
  readState: 'empty' | 'loading' | 'ready' | 'error';
  retryRead: () => void;
  context: ContextPresentation;
  reserveTokens: number | null;
  chips: ReturnType<typeof visibleWidgets>;
  changesLabel: 'provisional' | 'fixed' | 'unavailable' | 'error' | null;
  changeFiles: number | null;
  changeLines: number | null;
  agents: { total: number; working: number; waiting: number; failed: number } | null;
  tools: { id: string; name: string; tone: string }[];
  results: { id: string; label: string }[];
  environment: 'simulated' | 'restricted' | null;
  action: ReturnType<typeof actionRequired>;
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

const ChatWidgetContext = createContext<ChatWidgetModel | null>(null);

export function useChatWidget() {
  return useContext(ChatWidgetContext);
}

export function ChatWidgetProvider({
  sessionId,
  presentationRunId,
  live,
  children,
}: {
  sessionId: string;
  presentationRunId: string | null;
  live: boolean;
  children: ReactNode;
}) {
  const model = useChatWidgetState(sessionId, presentationRunId, live);
  return <ChatWidgetContext.Provider value={model}>{children}</ChatWidgetContext.Provider>;
}

function useChatWidgetState(
  sessionId: string,
  presentationRunId: string | null,
  live: boolean,
): ChatWidgetModel {
  const { session, transport, readHistory, workspaces, mode } = useServices();
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
  const fileRevision = useMemo(
    () =>
      Object.values(projection?.toolCalls ?? {}).filter(
        (call) =>
          ['write_file', 'delete_file', 'move_file', 'write', 'edit'].includes(call.name) &&
          (call.phase === 'finished' || call.phase === 'failed'),
      ).length,
    [projection?.toolCalls],
  );
  useEffect(() => {
    void fileRevision;
    void projection?.status;
    if (!presentationRunId || !workspaces) return;
    let current = true;
    const setChanges = (value: ReturnType<typeof changesPresentation> | null) =>
      setChangeRead({ target, source: workspaces, value });
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
            const lines = value.files.reduce(
              (sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0),
              0,
            );
            setChanges(
              changesPresentation({
                baselineApplied: true,
                provisional: live,
                state: value.unavailable ? 'unavailable' : 'ready',
                files: value.files.length,
                lines: uncounted ? null : lines,
                uncounted,
              }),
            );
          });
      })
      .catch(() => {
        if (current) setChanges({ kind: 'error' });
      });
    return () => {
      current = false;
    };
  }, [target, workspaces, sessionId, presentationRunId, live, projection?.status, fileRevision]);

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
  const { status: planStatus, retry: retryPlan } = useWorkPlanSnapshot({
    runId: presentationRunId,
    ref,
    currentCriteriaVersionId: projection?.currentCriteriaVersionId ?? null,
    currentAttemptNo: ref ? projection?.executions[ref.executionId]?.attemptNo : null,
    runStatus: projection?.status,
    load: loadPlan,
    cacheScope: usingLive ? session : transport,
    text,
  });
  // Loading and error details must remain expandable so their scoped Retry is reachable.
  const open = Boolean(ref) && workPlanOpen(preference, projection?.status ?? 'running');
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
  const effects = Object.values(projection?.effects ?? {});
  const action = actionRequired({
    pendingApprovals: interactions.filter((item) => item.kind === 'approval').length,
    pendingQuestions: interactions.filter((item) => item.kind !== 'approval').length,
    failedEffects: effects.filter((effect) => effect.outcome === 'failed').length,
    unclearEffects: effects.filter(
      (effect) => effect.outcome === 'unknown' || effect.outcome === 'cancelled',
    ).length,
    runStatus: projection?.status,
  });
  const activeItem =
    planStatus.state === 'ready' && selectedChoice?.live
      ? planStatus.plan.items.find((item) => item.status === 'in_progress')
      : undefined;
  const tools = toolRows(
    Object.values(projection?.toolCalls ?? {}).map((call) => ({
      toolCallId: call.toolCallId,
      name: call.name,
      phase: call.phase ?? call.status,
      effect: call.effectId ? projection?.effects[call.effectId]?.outcome : null,
    })),
  );
  const currentTool = tools.find((row) => row.tone === 'running') ?? null;
  const listed = projection ? runResults(projection) : null;
  const resultItems = (
    listed?.final.length ? listed.final : (listed?.intermediate.map((group) => group.latest) ?? [])
  ).map((item) => ({ id: item.artifactVersionId, label: `${item.name} v${item.version}` }));
  useEffect(() => {
    if (!presentationRunId || !live || projection?.endedAt) return;
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [live, projection?.endedAt, presentationRunId]);
  const activity = {
    ...activityLine({
      runStatus: projection?.status ?? (live ? 'running' : 'succeeded'),
      startedAt: projection?.startedAt ?? null,
      endedAt: projection?.endedAt ?? null,
      now,
      planTitle: activeItem?.title ?? null,
      planVisible: open && Boolean(activeItem),
      toolName: currentTool?.name ?? null,
      failed: action.hasFailure,
      needsUser: action.needsUser,
    }),
    runId: presentationRunId,
  };
  const agents = agentActivity(executions);
  const simulated =
    projection?.mode === 'mock' || (mode === 'browser' && projection?.mode !== 'live');
  const restricted =
    view?.definition?.input.taskScope === 'review_only' ||
    Object.values(projection?.modelProfiles ?? {}).some((profile) => profile.workerIsolation);
  const chips = visibleWidgets({
    hasContext: Boolean(presentationRunId),
    agents: {
      total: agents?.total ?? executions.length,
      working: agents?.working ?? 0,
      waiting: agents?.waiting ?? 0,
      failed: agents?.failed ?? 0,
      delegated: executions.length > 1,
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
    lastRun: Boolean(presentationRunId) && !live,
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
    agents,
    tools,
    results: resultItems,
    environment: simulated ? 'simulated' : restricted ? 'restricted' : null,
    action,
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
