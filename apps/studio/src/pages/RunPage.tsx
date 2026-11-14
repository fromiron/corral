import {
  type CorralDefinition,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import {
  canReadArtifactBody,
  compileDefinition,
  forkSteps,
  pendingInteractions,
  type RunProjection,
  stepResultIds,
} from '@corral/core';
import {
  ArtifactViewer,
  ExecutionTranscript,
  ExecutionTree,
  executionViewPresence,
  FailureNotice,
  PresenceBadge,
  primaryWorkPlan,
  projectionPresence,
  QuestionsPanel,
  RecipeStatusPanel,
  ReinsPanel,
  RoutingTally,
  RunActions,
  RunCanvas,
  type RunFlowCheck,
  RunFlowDecisions,
  RunReason,
  RunResults,
  type RunSessionStore,
  SettingsPatchPanel,
  TaskBoard,
  Timeline,
  UsageInspector,
  useAgentName,
  useRoundInspection,
  useRunDisplay,
  useRunWorkPlan,
  useSteerTarget,
  WorkPlanPanel,
} from '@corral/react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  cn,
  fontWeights,
  formatClock,
  MetaDot,
  Switch,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
  ToolStack,
  useNow,
} from '@corral/react/design-kit';
import { Check, Copy, Info, X } from '@corral/react/icons';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useModelPrices } from '../prices.ts';
import { projectOfRun, setCurrentProject } from '../projects.ts';
import { runRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { ExecutionEvidence } from '../workbench/ExecutionEvidence.tsx';
import { panelKey } from '../workbench/panels/registry.ts';
import type { RunDetailSearch } from '../workbench/panels/routes.ts';
import { RunPlanStrip } from '../workbench/RunActivity.tsx';
import { breakpointSteps } from '../workbench/RunBreakpoints.tsx';
import { RunResponseArea } from '../workbench/RunResponseArea.tsx';
import { RunResultVersions } from '../workbench/RunResultVersions.tsx';
import { ExecutionContext, RunStatusCards } from '../workbench/RunStatusCards.tsx';
import { RunTimeChart } from '../workbench/RunTimeChart.tsx';
import { RunViews } from '../workbench/RunViews.tsx';
import { runFlowChecks } from '../workbench/runFlowChecks.ts';
import { useRespondInConversation } from '../workbench/session/PendingTray.tsx';
import { toolMarks } from '../workbench/toolMarks.ts';
import { useContainerAtLeast } from '../workbench/useContainerAtLeast.ts';
import { failedExecutionId } from '../workbench/widgets/selectors.ts';
import { markRunReviewed } from './GettingStarted.tsx';

export type { RunDetailSearch } from '../workbench/panels/routes.ts';

/** One run: observed work flow, execution details and Reins. */
export function RunPage() {
  const services = useServices();
  const { runId } = runRoute.useParams();
  const search = runRoute.useSearch();
  const navigate = useNavigate({ from: '/runs/$runId' });
  return (
    <RunDetail
      key={panelKey(services, { kind: 'run', runId })}
      runId={runId}
      search={search}
      setSearch={(patch, options) =>
        void navigate({ search: (s) => ({ ...s, ...patch }), replace: options?.replace })
      }
    />
  );
}

/**
 * A run's detail, on its own page or inside a session's workbench.
 * The caller keeps the search state; `embedded` drops the page landmarks.
 */
export function RunDetail({
  runId,
  search,
  setSearch,
  embedded = false,
  sessionId = null,
  request = null,
}: {
  sessionId?: string | null;
  /** The request that started the run, when the caller knows it: the run's title. */
  request?: string | null;
  runId: string;
  search: RunDetailSearch;
  setSearch: (patch: RunDetailSearch, options?: { replace?: boolean }) => void;
  embedded?: boolean;
}) {
  const t = useTranslations('RunPage');
  const { runFor, retainRun, transport, repository } = useServices();
  const session = runFor(runId);
  const activeRunId = useStore(session, (s) => s.runId);
  const missing = useStore(session, (s) => s.missingRunId === runId);
  const error = useStore(session, (s) => s.streamError ?? s.definitionError);
  const definition = useStore(session, (s) => s.definition);
  const [recordSession, setRecordSession] = useState<{
    runId: string;
    sessionId: string | null;
  } | null>(null);
  // On its own page, a run whose session could not be looked up says so instead of guessing one.
  const [lookupFailed, setLookupFailed] = useState<string | null>(null);

  // A direct link or a reload: follow the run from the runtime's record.
  useEffect(() => {
    const release = retainRun(runId);
    void session.getState().open(runId);
    return release;
  }, [session, runId, retainRun]);

  // the header shows the project this run started in.
  useEffect(() => {
    let live = true;
    Promise.all([transport.listRuns(), repository.list()]).then(
      ([runs, corrals]) => {
        const run = runs.find((r) => r.runId === runId);
        if (live && run) {
          setCurrentProject(projectOfRun(run, corrals));
          setRecordSession({ runId: run.runId, sessionId: run.sessionId });
        }
      },
      () => {
        if (live) setLookupFailed(runId);
      },
    );
    return () => {
      live = false;
    };
  }, [transport, repository, runId]);

  if (activeRunId !== runId || !definition) {
    return (
      <main className="flex flex-col items-start gap-3 p-6">
        <h2 className="text-title" style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('heading', { runId })}
        </h2>
        <p role="status" className="text-body text-muted-foreground">
          {error ?? (missing ? t('missing') : t('loading'))}
        </p>
        {activeRunId === runId ? <RunActions session={session} /> : null}
        {error ? (
          <Button variant="tertiary" onClick={() => void session.getState().open(runId)}>
            {t('retry')}
          </Button>
        ) : null}
        <Link to="/" className="text-body underline">
          ←
        </Link>
      </main>
    );
  }
  return (
    <RunWorkspace
      runId={runId}
      key={runId}
      session={session}
      definition={definition}
      sessionId={sessionId ?? (recordSession?.runId === runId ? recordSession.sessionId : null)}
      request={request}
      search={search}
      setSearch={setSearch}
      embedded={embedded}
      notice={
        !embedded && lookupFailed === runId ? (
          <p role="alert" className="shrink-0 border-b border-line px-4 py-2 text-caption">
            {t('sessionLookupFailed')}
          </p>
        ) : null
      }
    />
  );
}

function RunWorkspace({
  runId,
  session,
  sessionId,
  definition,
  search,
  setSearch,
  embedded,
  request,
  notice,
}: {
  runId: string;
  request: string | null;
  session: RunSessionStore;
  sessionId: string | null;
  definition: CorralDefinition;
  search: RunDetailSearch;
  setSearch: (patch: RunDetailSearch, options?: { replace?: boolean }) => void;
  embedded: boolean;
  notice?: ReactNode;
}) {
  const t = useTranslations('RunPage');
  const m = useTranslations('RunMonitor');
  const tp = useTranslations('Presence');
  const harness = useTranslations('Harness');
  const nameOf = useAgentName(definition);
  const { execution, artifact, result } = search;
  const resultOpen = search.view === 'results' || result !== undefined;
  const documentOpen = resultOpen || artifact !== undefined;
  const Main = embedded ? 'div' : 'main';
  // Beside its session's conversation, the run record only shows what waits: the conversation's
  // needed-now tray is the one place it is answered, and Respond goes there (workbench.md).
  const conversationResponds = useRespondInConversation();
  const respondElsewhere = embedded && sessionId ? conversationResponds : null;
  const { previewUrl, workspaces } = useServices();
  const projection = useStore(session, (s) => s.projection);
  const events = useStore(session, (s) => s.events);
  // The work flow's tree and decisions show the same inspected Loop rounds.
  const rounds = useRoundInspection(projection, execution ?? null);
  // Why the selected execution failed, as recorded; the detail leads its failure with it.
  const selectedExecution = execution ? projection?.executions[execution] : undefined;
  const failedError =
    selectedExecution && executionViewPresence(selectedExecution).kind === 'failed'
      ? selectedExecution.error
      : null;
  const failedTools = execution
    ? Object.values(projection?.toolCalls ?? {}).filter(
        (call) =>
          call.executionId === execution &&
          call.phase === 'failed' &&
          (!call.effectId || projection?.effects[call.effectId]?.outcome !== 'cancelled'),
      )
    : [];
  const checkReferences = useMemo(
    () =>
      [
        ...new Set(
          Object.values(projection?.workflowBranches ?? {}).flatMap((branch) =>
            branch.evidenceRefs.filter((ref) => ref.kind === 'check').map((ref) => ref.id),
          ),
        ),
      ]
        .sort()
        .join('|'),
    [projection?.workflowBranches],
  );
  const [loadedChecks, setLoadedChecks] = useState<{ key: string; values: RunFlowCheck[] } | null>(
    null,
  );
  const checkOwner = `${sessionId}:${runId}:${checkReferences}`;
  useEffect(() => {
    if (!workspaces || !sessionId || !checkReferences) return;
    let active = true;
    void workspaces
      .verifications(sessionId)
      .then((records) => {
        if (active)
          setLoadedChecks({
            key: checkOwner,
            values: runFlowChecks(records, runId, checkReferences.split('|')),
          });
      })
      .catch(() => {
        if (active) setLoadedChecks({ key: checkOwner, values: [] });
      });
    return () => {
      active = false;
    };
  }, [workspaces, sessionId, runId, checkReferences, checkOwner]);
  const checks = loadedChecks?.key === checkOwner ? loadedChecks.values : [];

  const normalizingCursor = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (search.atSeq === undefined) {
      normalizingCursor.current = undefined;
      return;
    }
    // Remembering the view can render the parent before the router commits this patch.
    if (normalizingCursor.current === search.atSeq) return;
    normalizingCursor.current = search.atSeq;
    setSearch({ atSeq: undefined }, { replace: true });
  }, [search.atSeq, setSearch]);
  const prices = useModelPrices();
  const target = useSteerTarget(session, execution ?? null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [listedNodeId, setListedNodeId] = useState<string | null>(null);
  // The graph view's display, kept with the other view state across view switches. Until the
  // person picks one, a stage too narrow for the map's names to read starts as the list.
  const [graphChoice, setGraphChoice] = useState<'map' | 'list' | null>(null);
  const [fittedDisplay, setFittedDisplay] = useState<'map' | 'list'>('map');
  const graphDisplay = graphChoice ?? fittedDisplay;
  const fitZoomed = useCallback(
    (zoom: number) => setFittedDisplay(zoom < READABLE_MAP_ZOOM ? 'list' : 'map'),
    [],
  );
  const [panel, setPanel] = useState<'closed' | 'selection' | 'approval' | 'run'>(
    execution ? 'selection' : 'closed',
  );
  const [steeringId, setSteeringId] = useState<string | null>(null);
  const [steeringOpen, setSteeringOpen] = useState(false);
  const [steeringTargets, setSteeringTargets] = useState<Set<string>>(() => new Set());
  const documentTrigger = useRef<HTMLElement | null>(null);
  const steeringTrigger = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const wide = useContainerAtLeast(body, 640 + 360);
  const [detail, setDetail] = useState('overview');
  const trigger = useRef<HTMLElement | null>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const response = useRef<HTMLDivElement>(null);
  const detailPane = useRef<HTMLElement>(null);
  const documentPane = useRef<HTMLElement>(null);
  const steeringPane = useRef<HTMLElement>(null);
  const hasOutput = useStore(session, (s) => s.outputText !== null);
  const workPlan = useRunWorkPlan(session, primaryWorkPlan(projection?.workPlans));
  const plan = 'plan' in workPlan.status ? workPlan.status.plan : null;
  const interactions = projection ? pendingInteractions(events, projection) : [];
  const pending = interactions.length;
  const waitingKey = interactions
    .map((item) =>
      item.kind === 'approval' ? item.approval.approvalId : item.event.payload.requestId,
    )
    .join('|');
  // An extension can answer back after its prompt: what it says shows in the response area
  // under the prompt that was answered, so the area stays while the live run may still reply,
  // and holds the extension's notices while their text is kept (it is released with the run's
  // other working bodies when the run ends; api-contract.md, 산출물 본문 수명).
  const extensionSaid = useStore(session, (s) =>
    s.events.some(
      (event) =>
        event.type === 'extension.ui_notified' &&
        canReadArtifactBody(s.projection, event.payload.bodyRef),
    ),
  );
  const extensionReplying = useStore(
    session,
    (s) =>
      Boolean(s.projection && !TERMINAL_RUN_STATUSES.has(s.projection.status)) &&
      s.events.findLast(
        (event) =>
          event.type === 'extension.ui_requested' || event.type === 'extension.ui_answered',
      )?.type === 'extension.ui_answered',
  );
  const responding = pending > 0 || extensionSaid || extensionReplying;
  const sideShown =
    !documentOpen && !steeringOpen && panel !== 'closed' && (panel !== 'approval' || responding);
  // The response area beside the run is on screen: it is the one way to respond there, so the
  // header's state names the wait without a second Respond.
  const responseShown = sideShown && panel === 'approval' && responding;
  useEffect(() => {
    if (hasOutput) markRunReviewed();
  }, [hasOutput]);
  const executionNodeId = execution ? (projection?.executions[execution]?.nodeId ?? null) : null;
  const routedExecution = useRef(execution);
  useEffect(() => {
    // Only navigation selects an inspector. Replayed data and local close/list changes do not.
    if (routedExecution.current === execution) return;
    routedExecution.current = execution;
    if (execution) {
      setPanel('selection');
      setSelectedNodeId(executionNodeId);
    } else if (listedNodeId) {
      setSelectedNodeId(listedNodeId);
    } else {
      setPanel((current) => (current === 'selection' ? 'closed' : current));
    }
  }, [execution, executionNodeId, listedNodeId]);
  useEffect(() => {
    if (panel === 'approval' && !responding) setPanel('closed');
  }, [panel, responding]);
  // The response area leaves with the last answer; focus that was in it goes to the run's title
  // instead of falling to the page.
  const wasResponding = useRef(responding);
  useEffect(() => {
    const left = wasResponding.current && !responding;
    wasResponding.current = responding;
    if (!left) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body)
        document.querySelector<HTMLElement>('[data-run-title]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [responding]);
  // A new question or approval opens the response area once, only into free space on a wide
  // page. An item counts as announced only once the area has actually shown it, so one first seen
  // behind a document, an inspector or a narrow page still opens it when the space frees up.
  const announced = useRef(new Set<string>());
  useEffect(() => {
    const waitingIds = waitingKey.split('|').filter(Boolean);
    if (panel === 'approval' && sideShown) {
      for (const id of waitingIds) announced.current.add(id);
      return;
    }
    if (
      waitingIds.some((id) => !announced.current.has(id)) &&
      wide &&
      panel === 'closed' &&
      !documentOpen &&
      !steeringOpen
    )
      setPanel('approval');
  }, [waitingKey, wide, panel, sideShown, documentOpen, steeringOpen]);
  // An explicit request to respond opens the response area whatever the width and moves focus
  // there. It waits until the history says whether anything waits, and is consumed once.
  const historyRead = useStore(session, (s) => s.initialLoadSeq === undefined);
  const focusResponse = useRef(false);
  const [respondRequests, setRespondRequests] = useState(0);
  const respondHandled = useRef(false);
  useEffect(() => {
    if (!search.respond) {
      respondHandled.current = false;
      return;
    }
    if (respondHandled.current || (pending === 0 && !historyRead)) return;
    // Remembering the view can render the parent before the router commits this patch.
    respondHandled.current = true;
    if (pending > 0) {
      trigger.current = null;
      focusResponse.current = true;
      setRespondRequests((count) => count + 1);
      setSteeringOpen(false);
      setPanel('approval');
    }
    setSearch(
      {
        respond: undefined,
        ...(documentOpen ? { artifact: undefined, result: undefined, view: undefined } : {}),
      },
      { replace: true },
    );
  }, [search.respond, pending, historyRead, documentOpen, setSearch]);
  useEffect(() => {
    void respondRequests;
    if (!focusResponse.current || panel !== 'approval' || !sideShown) return;
    focusResponse.current = false;
    let frame = 0;
    let tries = 0;
    // The run view may still be coming into view in its dock; focus once it can be seen.
    const attempt = () => {
      const target = response.current;
      if (!target) return;
      if (typeof target.checkVisibility === 'function' && !target.checkVisibility() && tries < 10) {
        tries++;
        frame = requestAnimationFrame(attempt);
        return;
      }
      target.focus({ preventScroll: true });
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [panel, sideShown, respondRequests]);
  const activeElement = () =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const rememberTrigger = (origin = activeElement()) => {
    trigger.current = origin;
  };
  const chooseExecution = (id: string, origin = activeElement()) => {
    rememberTrigger(origin);
    const nodeId = projection?.executions[id]?.nodeId ?? null;
    setSelectedNodeId(nodeId);
    setListedNodeId((current) => (current === nodeId ? current : null));
    setPanel('selection');
    setDetail('overview');
    setSearch({ execution: id, artifact: undefined, result: undefined, view: undefined });
    requestAnimationFrame(() => detailPane.current?.focus({ preventScroll: true }));
  };
  const openArtifact = (id: string, origin = activeElement()) => {
    documentTrigger.current = origin;
    setSearch({ artifact: id, view: undefined, result: undefined });
    requestAnimationFrame(() => documentPane.current?.focus({ preventScroll: true }));
  };
  const openResult = (id: string, origin = activeElement()) => {
    documentTrigger.current = origin;
    setSearch({ result: id, view: undefined, artifact: undefined });
    requestAnimationFrame(() => documentPane.current?.focus({ preventScroll: true }));
  };
  const closeDocument = () => {
    setSearch({ artifact: undefined, result: undefined, view: undefined });
    requestAnimationFrame(() => {
      if (documentTrigger.current?.isConnected) documentTrigger.current.focus();
      else detailsButton.current?.focus();
    });
  };
  const openSteering = (id: string, origin = activeElement()) => {
    if (!projection?.executions[id]) return;
    steeringTrigger.current = origin;
    setSteeringId(id);
    setSteeringTargets((previous) => new Set(previous).add(id));
    setSteeringOpen(true);
    // Opening it is asking to type: the instruction box takes focus, or the pane when the
    // execution takes no instruction any more.
    requestAnimationFrame(() =>
      (
        steeringPane.current?.querySelector<HTMLElement>('textarea:not([disabled])') ??
        steeringPane.current
      )?.focus({ preventScroll: true }),
    );
  };
  const closeSteering = () => {
    setSteeringOpen(false);
    requestAnimationFrame(() =>
      (steeringTrigger.current?.isConnected
        ? steeringTrigger.current
        : detailsButton.current
      )?.focus(),
    );
  };
  const closeDetail = () => {
    setListedNodeId(null);
    setPanel('closed');
    setSearch({ execution: undefined, artifact: undefined });
    requestAnimationFrame(() =>
      (trigger.current?.isConnected ? trigger.current : detailsButton.current)?.focus(),
    );
  };
  const highlightedNode = selectedNodeId ?? executionNodeId;
  const selectedTarget = execution ? target : null;
  const closeDetails = (
    <Button
      variant="ghost"
      size="icon-compact"
      aria-label={m('closeDetails')}
      onClick={closeDetail}
    >
      <X />
    </Button>
  );
  return (
    <div className="@container flex h-full min-h-0 flex-col" data-testid="run-monitor">
      {notice}
      <RunHeader
        session={session}
        definition={definition}
        request={request}
        waiting={responseShown ? 0 : pending}
        onRespond={() => {
          if (respondElsewhere) {
            respondElsewhere();
            return;
          }
          rememberTrigger();
          setSteeringOpen(false);
          setSearch({ artifact: undefined, result: undefined, view: undefined });
          setPanel('approval');
          requestAnimationFrame(() => response.current?.focus({ preventScroll: true }));
        }}
        onOpenExecution={(id) => {
          setSteeringOpen(false);
          chooseExecution(id);
        }}
        onOpenArtifact={(id) => openArtifact(id)}
        trailing={
          <Button
            ref={detailsButton}
            variant={panel === 'run' && sideShown ? 'secondary' : 'ghost'}
            size="compact"
            className="@max-[44rem]/run-head:w-7 @max-[44rem]/run-head:px-0"
            aria-pressed={panel === 'run' && sideShown}
            onClick={() => {
              rememberTrigger();
              setSteeringOpen(false);
              setSearch({ artifact: undefined, result: undefined, view: undefined });
              setDetail('overview');
              setPanel(panel === 'run' && sideShown ? 'closed' : 'run');
            }}
          >
            <Info aria-hidden="true" className="hidden @max-[44rem]/run-head:inline" />
            <span className="@max-[44rem]/run-head:sr-only">{m('runInfo')}</span>
          </Button>
        }
      />
      <div ref={body} className="flex min-h-0 flex-1">
        <div
          data-testid="run-column"
          hidden={!wide && sideShown}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <Main
            data-testid="run-column-scroll"
            hidden={documentOpen || steeringOpen}
            className="min-h-0 flex-1"
          >
            <RunViews
              visible={!documentOpen && !steeringOpen && (wide || !sideShown)}
              views={[
                {
                  id: 'graph',
                  label: m('graph'),
                  render: () => (
                    <div className="flex h-full min-h-0 flex-col">
                      <div className="flex shrink-0 justify-end px-3 pt-2">
                        <GraphDisplayToggle value={graphDisplay} onChange={setGraphChoice} />
                      </div>
                      <div className="min-h-0 flex-1">
                        <RunCanvas
                          session={session}
                          definition={definition}
                          display={graphDisplay}
                          onFitWidthZoom={fitZoomed}
                          selectedNodeId={highlightedNode}
                          onSelectNode={(id) => setSelectedNodeId(id)}
                          renderNodePreview={(nodeId, { close, trigger: origin }) =>
                            projection ? (
                              <>
                                <NodeExecutions
                                  projection={projection}
                                  definition={definition}
                                  nodeId={nodeId}
                                  selectedExecutionId={execution ?? null}
                                  preview
                                  onChoose={(id) => {
                                    close();
                                    chooseExecution(id, origin);
                                  }}
                                  onOpenArtifact={(id) => {
                                    close();
                                    openArtifact(id, origin);
                                  }}
                                  onSteer={(id) => {
                                    close();
                                    openSteering(id, origin);
                                  }}
                                  onShowAll={() => {
                                    close();
                                    rememberTrigger(origin);
                                    setListedNodeId(nodeId);
                                    setSelectedNodeId(nodeId);
                                    setPanel('selection');
                                    setDetail('overview');
                                    setSearch({
                                      execution: undefined,
                                      artifact: undefined,
                                      result: undefined,
                                      view: undefined,
                                    });
                                    requestAnimationFrame(() =>
                                      detailPane.current?.focus({ preventScroll: true }),
                                    );
                                  }}
                                />
                                <NodeRunActions
                                  session={session}
                                  definition={definition}
                                  nodeId={nodeId}
                                />
                              </>
                            ) : null
                          }
                        />
                      </div>
                    </div>
                  ),
                },
                {
                  id: 'flow',
                  label: m('flow'),
                  testId: 'run-flow-tab',
                  render: () => (
                    <div
                      data-testid="run-work-flow"
                      className="mx-auto grid w-full max-w-[1040px] gap-4 px-6 py-5"
                    >
                      {projection ? (
                        <RunPlanStrip
                          projection={projection}
                          plan={plan}
                          planCount={Object.keys(projection.workPlans ?? {}).length}
                          allPlans={<WorkPlanPanel session={session} />}
                        />
                      ) : null}
                      <ExecutionTree
                        session={session}
                        onSteer={chooseExecution}
                        selectedExecutionId={execution ?? null}
                        rounds={rounds}
                        compact
                        wideCards
                        titled={false}
                      />
                      <RunFlowDecisions
                        session={session}
                        definition={definition}
                        checks={checks}
                        onOpenArtifact={openArtifact}
                        selectedIterations={rounds.selected}
                      />
                    </div>
                  ),
                },
                {
                  id: 'time',
                  label: m('time'),
                  render: () => (
                    <RunTimeChart
                      events={events}
                      projection={projection}
                      definition={definition}
                      selected={execution}
                      onSelect={chooseExecution}
                    />
                  ),
                },
                {
                  id: 'events',
                  label: `${m('events')} ${events.length}`,
                  render: () => (
                    <Timeline
                      session={session}
                      fill
                      headed={false}
                      onOpenExecution={(id) => chooseExecution(id)}
                    />
                  ),
                },
                {
                  id: 'results',
                  label: m('results'),
                  render: () => (
                    <RunResultVersions
                      session={session}
                      onOpenResult={openResult}
                      onOpenArtifact={openArtifact}
                    />
                  ),
                },
              ]}
            />
          </Main>
          <section
            ref={documentPane}
            tabIndex={-1}
            data-testid="run-document"
            hidden={!documentOpen}
            className="min-h-0 flex-1 overflow-auto p-6 outline-none"
            aria-label={m('results')}
          >
            <Button variant="ghost" onClick={closeDocument}>
              {m('backToWork')}
            </Button>
            {documentOpen ? (
              artifact ? (
                <ArtifactViewer
                  session={session}
                  versionId={artifact}
                  onOpen={openArtifact}
                  onClose={closeDocument}
                />
              ) : (
                <RunResults
                  session={session}
                  headed={false}
                  embedded
                  selectedId={result ?? null}
                  onSelect={(id) => setSearch({ result: id })}
                  {...(previewUrl ? { previewUrl } : {})}
                />
              )
            ) : null}
          </section>
          <section
            ref={steeringPane}
            tabIndex={-1}
            hidden={!steeringOpen || documentOpen}
            className="min-h-0 flex-1 overflow-auto p-6 outline-none"
            data-testid="run-instructions"
          >
            <div className="mx-auto grid w-full max-w-[760px] gap-4">
              <Button variant="ghost" className="justify-self-start" onClick={closeSteering}>
                {m('backToWork')}
              </Button>
              {[...steeringTargets].map((id) => (
                <div key={id} hidden={id !== steeringId}>
                  <RunInstructions session={session} executionId={id} />
                </div>
              ))}
            </div>
          </section>
        </div>
        <aside
          ref={detailPane}
          data-testid="run-side"
          hidden={!sideShown}
          tabIndex={-1}
          aria-label={m('details')}
          className={
            'min-h-0 overflow-auto p-4 outline-none ' +
            (wide ? 'w-[360px] shrink-0 border-l border-line' : 'min-w-0 flex-1')
          }
        >
          {/* One column the panel's width: an open part wraps or scrolls in it, never widens it. */}
          <div className="grid grid-cols-1 gap-4">
            {panel === 'approval' ? (
              // The response area's state is the header's status: its heading stays unseen, and
              // the close sits on the area's first row instead of a row of its own.
              <h2 className="sr-only">
                {pending > 0 ? tp('state.awaiting_user') : harness('extensionNotice')}
              </h2>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2
                    className="truncate text-subtitle"
                    style={{ fontVariationSettings: fontWeights.semibold }}
                  >
                    {panel === 'run'
                      ? m('runInfo')
                      : (selectedTarget?.nodeLabel ??
                        (listedNodeId && definition.nodes.some((node) => node.id === listedNodeId)
                          ? nameOf(listedNodeId)
                          : null) ??
                        m('details'))}
                  </h2>
                  {panel === 'selection' && execution && projection?.executions[execution] ? (
                    <div className="text-caption text-muted-foreground">
                      <ExecutionIdentity projection={projection} executionId={execution} />
                    </div>
                  ) : null}
                </div>
                {closeDetails}
              </div>
            )}
            <div hidden={panel !== 'approval'}>
              {responding ? (
                <RunResponseArea
                  session={session}
                  focusRef={response}
                  onOpenArtifact={openArtifact}
                  {...(panel === 'approval' ? { action: closeDetails } : {})}
                  {...(respondElsewhere ? { onRespond: respondElsewhere } : {})}
                />
              ) : null}
            </div>
            <div hidden={panel === 'approval'}>
              {execution && projection && !projection.executions[execution] ? (
                <p role="alert">{t('executionMissing', { executionId: execution })}</p>
              ) : null}
              {listedNodeId && !execution && projection && panel === 'selection' ? (
                <NodeExecutions
                  projection={projection}
                  definition={definition}
                  nodeId={listedNodeId}
                  selectedExecutionId={execution ?? null}
                  onChoose={(id) => chooseExecution(id, trigger.current)}
                />
              ) : null}
              {selectedTarget && !selectedTarget.finished && panel === 'selection' ? (
                <Button variant="primary" onClick={() => openSteering(selectedTarget.executionId)}>
                  {m('steer')}
                </Button>
              ) : null}
              {panel === 'run' ? (
                <Tabs value={detail} onValueChange={setDetail} className="mt-3">
                  <div className="overflow-x-auto">
                    <TabsList aria-label={m('details')}>
                      {['overview', 'usage'].map((value) => (
                        <TabItem key={value} value={value} label={m(value)} />
                      ))}
                    </TabsList>
                  </div>
                  <TabPanel value="overview" keepMounted className="space-y-3 pt-3">
                    <RunFacts session={session} definition={definition} request={request} />
                    {/* Run info's parts open independently, as one kind of row. */}
                    <Accordion type="multiple" className="w-full">
                      <AccordionItem value="tasks">
                        <AccordionTrigger>{t('tabs.tasks')}</AccordionTrigger>
                        <AccordionContent>
                          <TaskBoard session={session} onOpenArtifact={openArtifact} />
                        </AccordionContent>
                      </AccordionItem>
                      {Object.keys(projection?.questions ?? {}).length ? (
                        <AccordionItem value="questions">
                          <AccordionTrigger>{t('tabs.questions')}</AccordionTrigger>
                          <AccordionContent>
                            <QuestionsPanel session={session} onOpenArtifact={openArtifact} />
                          </AccordionContent>
                        </AccordionItem>
                      ) : null}
                      <AccordionItem value="settings">
                        <AccordionTrigger>{m('settings')}</AccordionTrigger>
                        <AccordionContent>
                          <SettingsPatchPanel session={session} />
                        </AccordionContent>
                      </AccordionItem>
                      <RunStepOptions session={session} definition={definition} />
                      <RunStatusCards session={session} sessionId={sessionId} executionId={null} />
                    </Accordion>
                  </TabPanel>
                  <TabPanel value="usage" keepMounted className="space-y-3 pt-3" data-run-usage>
                    <UsageInspector session={session} prices={prices} headed={false} />
                    {projection ? <RoutingTally projection={projection} /> : null}
                  </TabPanel>
                </Tabs>
              ) : null}
              {panel === 'selection' && selectedTarget && sessionId ? (
                <ExecutionEvidence
                  session={session}
                  sessionId={sessionId}
                  executionId={selectedTarget.executionId}
                  onOpenArtifact={openArtifact}
                />
              ) : null}
              {panel === 'selection' && (failedError || failedTools.length) ? (
                <section
                  aria-label={m('failedSteps')}
                  data-testid="execution-failure"
                  className="mt-4 grid gap-2"
                >
                  {failedError ? <FailureNotice message={failedError} open /> : null}
                  {failedTools.map((call) => (
                    <div key={call.toolCallId} data-testid={`failed-step-${call.toolCallId}`}>
                      <p
                        className="text-caption"
                        style={{ fontVariationSettings: fontWeights.semibold }}
                      >
                        {call.name}
                      </p>
                      <FailureNotice code={call.errorCode} message={call.reason ?? ''} />
                    </div>
                  ))}
                </section>
              ) : null}
              {panel === 'selection' && selectedTarget ? (
                <div className="mt-4 grid gap-4">
                  <ExecutionContext session={session} executionId={selectedTarget.executionId} />
                  <section aria-label={m('calls')} className="-mx-4 grid">
                    <ExecutionTranscript
                      session={session}
                      executionId={selectedTarget.executionId}
                      onOpenArtifact={openArtifact}
                      failureShown={Boolean(failedError)}
                    />
                  </section>
                </div>
              ) : null}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * The smallest zoom at which the map's names stay readable: its 12px labels at 9px. A narrower
 * stage starts the graph view as the list.
 */
const READABLE_MAP_ZOOM = 0.75;

/** The graph view's two displays of one question: the relationship map and the agent list. */
function GraphDisplayToggle({
  value,
  onChange,
}: {
  value: 'map' | 'list';
  onChange: (value: 'map' | 'list') => void;
}) {
  const t = useTranslations('RunMonitor.graphDisplay');
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled pair of toggle buttons, not a form.
    <div role="group" aria-label={t('label')} className="flex shrink-0 items-center gap-1">
      {(['map', 'list'] as const).map((option) => (
        <Button
          key={option}
          variant={value === option ? 'secondary' : 'ghost'}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {t(option)}
        </Button>
      ))}
    </div>
  );
}

/** A draft belongs to its explicitly opened execution, independently of inspected nodes. */
function RunInstructions({
  session,
  executionId,
}: {
  session: RunSessionStore;
  executionId: string;
}) {
  const target = useSteerTarget(session, executionId);
  return <ReinsPanel session={session} target={target} compact />;
}

/**
 * Whether the run's team is a saved team that can be edited: an automatically composed team
 * records its inline id as corralId but has no saved record (#73). null while looking it up.
 */
function useSavedTeam(corralId: string | null | undefined) {
  const { repository } = useServices();
  const [saved, setSaved] = useState<{ id: string; exists: boolean } | null>(null);
  useEffect(() => {
    if (!corralId) return;
    let live = true;
    // The saved list, not a lookup by id: an unsaved id is an expected answer, not a failed
    // request.
    repository.list().then(
      (corrals) =>
        live && setSaved({ id: corralId, exists: corrals.some((c) => c.corralId === corralId) }),
      () => live && setSaved({ id: corralId, exists: false }),
    );
    return () => {
      live = false;
    };
  }, [repository, corralId]);
  if (!corralId) return false;
  return saved?.id === corralId ? saved.exists : null;
}

/** A compact, bounded run heading; optional diagnostics belong to the run inspector. */
function RunHeader({
  session,
  definition,
  request,
  trailing,
  waiting = 0,
  onRespond,
  onOpenExecution,
  onOpenArtifact,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  request: string | null;
  trailing?: ReactNode;
  /** Questions and approvals waiting for the person; the status becomes the way to them. */
  waiting?: number;
  onRespond?: () => void;
  /** Opens an execution's detail: a failed run's one way to the execution that failed. */
  onOpenExecution?: (executionId: string) => void;
  /** Opens a version the review recipe evaluated. */
  onOpenArtifact?: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('RunPage');
  const m = useTranslations('RunMonitor');
  const tp = useTranslations('Presence');
  const nameOf = useAgentName(definition);
  const projection = useRunDisplay(session, (s) => s.projection);
  const events = useRunDisplay(session, (s) => s.events);
  const recipeStopped = useStore(session, (s) =>
    s.events.some((event) => event.type === 'recipe.stopped'),
  );
  if (!projection) return null;
  // The run's state, as every screen says it (docs/specs/features/presence.md): every open
  // request once, by the order the record holds them.
  const presence = projectionPresence(projection, events);
  // A failed run says why beside its state, in Run info's words, and leads to what failed. With
  // one agent, "{agent} failed" only restates the state chip, so it is left out.
  const failed = presence.kind === 'failed';
  const failedExecution = failed ? failedExecutionId(projection) : null;
  // A run its review recipe stopped says why in the recipe's panel, with the rounds it judged;
  // the reason is not said again beside the state.
  const recipeStop =
    failed &&
    recipeStopped &&
    Boolean(onOpenArtifact) &&
    Boolean(projection.statusReason?.startsWith('review_recipe:'));
  // The run's agents: those it schedules, and any callable helper that actually ran. An advisor
  // watches from outside the flow and is not one of them.
  const ran = new Set(Object.values(projection.executions).map((execution) => execution.nodeId));
  const soleAgent =
    definition.nodes.filter(
      (node) =>
        node.type === 'agent' &&
        node.invocation !== 'observer' &&
        (node.invocation !== 'callable' || ran.has(node.id)),
    ).length <= 1;
  const endReason =
    projection.statusReason &&
    !recipeStop &&
    !(soleAgent && projection.statusReason.split(': ')[0] === 'execution_failed')
      ? projection.statusReason
      : null;
  const labelOf = nameOf;
  // The path bar names the run by its number; the header is its request.
  const title = request ?? definition.name;
  return (
    <section
      data-testid="run-header"
      aria-label={t('summary')}
      className="@container/run-head max-h-[40%] shrink-0 overflow-auto border-b border-line px-4 py-2"
    >
      {/* One line on a wide header. On a narrow one the title, its state and clock keep the
          first line and the controls take the next, instead of leaving the screen. */}
      <div className="flex min-h-9 min-w-0 items-center gap-x-3 gap-y-1 @max-[44rem]/run-head:flex-wrap">
        <div className="flex items-center gap-3 @max-[44rem]/run-head:basis-full">
          <h2
            title={title}
            tabIndex={-1}
            data-run-title
            className="line-clamp-2 min-w-[16ch] shrink text-subtitle outline-none [overflow-wrap:anywhere]"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {title}
          </h2>
          <span aria-live="polite" data-testid="run-status" className="shrink-0">
            {waiting > 0 && onRespond ? (
              <Button
                variant="warning-outline"
                size="compact"
                data-testid="run-respond"
                onClick={onRespond}
              >
                <span data-presence-label={`run:${projection.runId}`}>{tp(presence.labelKey)}</span>{' '}
                · {m('respond', { count: waiting })}
              </Button>
            ) : (
              <PresenceBadge presence={presence} target={`run:${projection.runId}`} />
            )}
          </span>
          <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
            <RunElapsed
              startedAt={projection.startedAt}
              endedAt={projection.endedAt}
              live={!TERMINAL_RUN_STATUSES.has(projection.status)}
            />
          </span>
        </div>
        {failed && (endReason || (failedExecution && onOpenExecution)) ? (
          <div className="flex min-w-0 items-center gap-2 @max-[44rem]/run-head:flex-1">
            {endReason ? (
              <span
                data-testid="run-end-reason"
                className="min-w-0 truncate text-caption text-muted-foreground"
              >
                <RunReason code={endReason} nodeLabel={labelOf} />
              </span>
            ) : null}
            {failedExecution && onOpenExecution ? (
              <Button
                variant="tertiary"
                size="compact"
                className="shrink-0"
                onClick={() => onOpenExecution(failedExecution)}
              >
                {m('openFailure')}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className={cn('ml-auto flex shrink-0 items-center gap-1', HEAD_ACTIONS)}>
          <RunActions session={session} compact narrowIcons />
          {trailing}
        </div>
      </div>
      {recipeStop && onOpenArtifact ? (
        <div className="pt-1 pb-2">
          <RecipeStatusPanel session={session} onOpenArtifact={onOpenArtifact} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * In a narrow run header the whole-run controls give up their words before the title gives up
 * its first sixteen characters: Pause/Resume and Cancel show the icons RunActions carries for a
 * narrow window, and their words stay their accessible names.
 */
const HEAD_ACTIONS = [
  // The controls' receipts live region stays mounted; empty, it must not lift the buttons.
  '[&>section]:gap-0 [&>section>[aria-live]:not(:empty)]:mt-2',
  '@max-[44rem]/run-head:[&_[data-run-action-label]]:sr-only',
  '@max-[44rem]/run-head:[&_button_svg]:inline',
  '@max-[44rem]/run-head:[&_button:has([data-run-action-label])]:w-7',
  '@max-[44rem]/run-head:[&_button:has([data-run-action-label])]:px-0',
].join(' ');

/** Diagnostics live in the run inspector, not in a second expanding workspace header. */
function RunFacts({
  session,
  definition,
  request,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  request: string | null;
}) {
  const t = useTranslations('RunPage');
  const tr = useTranslations('Run');
  const format = useFormatter();
  const projection = useRunDisplay(session, (s) => s.projection);
  const savedTeam = useSavedTeam(definition.sourceTeam?.corralId ?? projection?.corralId);
  const labelOf = useAgentName(definition);
  if (!projection) return null;
  const executions = projection.executionOrder.flatMap((id) => projection.executions[id] ?? []);
  const kinds = executions.map((e) => ({ e, presence: executionViewPresence(e) }));
  const working = [
    ...new Set(
      kinds
        .filter(({ presence }) => presence.kind === 'working' && !presence.detail)
        .map(({ e }) => labelOf(e.nodeId)),
    ),
  ];
  const waiting = kinds.filter(({ presence }) => presence.detail || presence.need).length;
  const runKind = projectionPresence(projection).kind;
  const tasks = Object.values(projection.tasks);
  const calls = Object.values(projection.toolCalls);
  const requests = Object.values(projection.modelCalls);
  const inFlight = requests.filter((c) => !c.finished).length;
  const ended = TERMINAL_RUN_STATUSES.has(projection.status);
  const loops = definition.nodes.flatMap((node) => {
    if (node.type !== 'loop' || !projection.loopIterations[node.id]?.length) return [];
    const round = projection.loopIterations[node.id]?.length ?? 0;
    const max = loopLimit(projection, node.id) ?? node.maxIterations;
    return [
      max === undefined
        ? t('loopRoundUnlimited', { label: node.label, round })
        : t('loopRound', { label: node.label, round, max }),
    ];
  });
  const team = definition.sourceTeam
    ? `${definition.sourceTeam.name} · r${definition.sourceTeam.revision}`
    : definition.name;
  const corralId = definition.sourceTeam?.corralId ?? projection.corralId;
  const facts = [
    corralId && savedTeam ? (
      <Link
        key="team"
        to="/corrals/$corralId/edit"
        params={{ corralId }}
        className="underline-offset-2 hover:underline"
      >
        {t('openCorral')}
      </Link>
    ) : corralId && !definition.sourceTeam && savedTeam === false ? (
      <span key="team">{t('unsavedTeam')}</span>
    ) : null,
    projection.startedFrom ? (
      <span key="from">
        {t('startedFrom')}:{' '}
        <Link
          to="/runs/$runId"
          params={{ runId: projection.startedFrom.runId }}
          search={{ artifact: projection.startedFrom.artifactVersionId }}
          className="underline"
        >
          {t('startedFromLink', {
            name: projection.startedFrom.artifactVersionId,
            runId: projection.startedFrom.runId,
          })}
        </Link>
      </span>
    ) : null,
    projection.forkedFrom ? (
      <span key="forked">
        {t('forkedFrom')}:{' '}
        <Link
          to="/runs/$runId"
          params={{ runId: projection.forkedFrom.runId }}
          className="underline"
        >
          {t('forkedFromLink', {
            step: labelOf(projection.forkedFrom.nodeId),
            runId: projection.forkedFrom.runId,
          })}
        </Link>
      </span>
    ) : null,
    projection.statusReason ? (
      <span key="reason">
        {tr('reasonPrefix')} <RunReason code={projection.statusReason} nodeLabel={labelOf} />
      </span>
    ) : null,
  ];
  // What is still moving; an ended run keeps only requests whose end was never confirmed.
  const progress = [
    runKind === 'stopping' ? (
      <span key="working">{t('cancelling')}</span>
    ) : ended ? null : working.length ? (
      <span key="working">{t('working', { labels: working.join(', ') })}</span>
    ) : inFlight || waiting || runKind === 'paused' ? null : (
      <span key="working">{t('starting')}</span>
    ),
    waiting ? <span key="waiting">{t('waitingExecutions', { count: waiting })}</span> : null,
    ...loops.map((text) => <span key={text}>{text}</span>),
    inFlight ? (
      <span key="requests">
        {t(ended || runKind === 'stopping' ? 'unconfirmedRequests' : 'requests', {
          count: inFlight,
        })}
      </span>
    ) : null,
  ];
  const marks = toolMarks(calls.map((call) => call.name));
  return (
    <div data-testid="run-facts" className="grid gap-3 text-caption text-muted-foreground">
      {request ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{request}</p> : null}
      <p data-run-meta className="flex flex-wrap items-center gap-2">
        <span>{team}</span>
        {projection.startedAt ? (
          <time dateTime={projection.startedAt}>
            {format.dateTime(new Date(projection.startedAt), {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
        ) : null}
        <span className="break-all font-mono">{projection.runId}</span>
        <CopyRunId runId={projection.runId} />
      </p>
      {marks.length ? <ToolStack tools={marks} max={5} size={20} /> : null}
      <p data-run-stats className="flex flex-wrap items-center gap-2 tabular-nums">
        <span>
          {t('stats.tasks', {
            done: tasks.filter((task) => task.status === 'completed').length,
            total: tasks.length,
          })}
        </span>
        <span>{t('stats.toolCalls', { count: calls.length })}</span>
        <span>{t('stats.modelRequests', { count: requests.length })}</span>
      </p>
      <MetaLine items={progress} />
      <MetaLine items={facts} />
    </div>
  );
}

/** Copies the run's id; the icon turns into a check once it is on the clipboard. */
function CopyRunId({ runId }: { runId: string }) {
  const t = useTranslations('RunPage');
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('copyRunId')}
        onClick={() =>
          void navigator.clipboard?.writeText(runId).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <span role="status" className="sr-only">
        {copied ? t('runIdCopied') : ''}
      </span>
    </>
  );
}

/** Caption-sized facts separated by the kit's meta dot; empty entries are skipped. */
function MetaLine({ items }: { items: ReactNode[] }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-muted-foreground">
      {shown.map((item, index) => (
        <Fragment key={(item as ReactElement).key ?? index}>
          {index > 0 ? <MetaDot /> : null}
          {item}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Run time as a clock. It ticks only while the latest view of a live run is shown; a past
 * record without an observed end shows no clock rather than one running to the present.
 */
function RunElapsed({
  startedAt,
  endedAt,
  live,
  lead,
}: {
  startedAt: string | null;
  endedAt: string | null;
  live: boolean;
  /** Shown before the clock, only when there is one. */
  lead?: ReactNode;
}) {
  const t = useTranslations('RunPage');
  const now = useNow(1000, live && startedAt !== null);
  if (!startedAt) return null;
  const end = endedAt ? Date.parse(endedAt) : live ? now : null;
  if (end === null) return null;
  const clock = formatClock(end - Date.parse(startedAt));
  return (
    <>
      {lead}
      <span className="tabular-nums">
        <span className="sr-only">{t('elapsed')} </span>
        {clock}
      </span>
    </>
  );
}

/** The Loop limit in force: the latest committed loop_limit patch, if any. */
function loopLimit(projection: RunProjection, loopId: string): number | null {
  const patches = Object.values(projection.patches)
    .filter((p) => p.kind === 'loop_limit' && p.scope.nodeId === loopId)
    .sort((a, b) => a.controlRevision - b.controlRevision);
  const value = patches.at(-1)?.after.maxIterations;
  return typeof value === 'number' ? value : null;
}

function ExecutionIdentity({
  projection,
  executionId,
}: {
  projection: RunProjection;
  executionId: string;
}) {
  const t = useTranslations('Run');
  const reins = useTranslations('Reins');
  const execution = projection.executions[executionId];
  if (!execution) return null;
  const number = projection.executionOrder.indexOf(executionId) + 1;
  const round = execution.iterationId ? projection.iterations[execution.iterationId]?.no : null;
  const parts = [
    number ? reins('executionNumber', { number }) : executionId,
    ...(round ? [t('round', { no: round })] : []),
    t('attempt', { no: execution.attemptNo }),
  ];
  return <span title={executionId}>{parts.join(' · ')}</span>;
}

/**
 * One step's run options: its breakpoint while the run goes on, and once the run has ended a new
 * run from this step with the team as it is saved now.
 */
/**
 * The run options of a run's steps (docs/specs/features/fork-and-breakpoints.md): breakpoints on
 * scheduled Agents and Decisions while it runs, a fork from a top-level step once it has ended.
 */
function useStepRunOptions(session: RunSessionStore, definition: CorralDefinition) {
  const t = useTranslations('RunPage');
  const { repository, transport, mode } = useServices();
  const navigate = useNavigate();
  const projection = useStore(session, (s) => s.projection);
  const savedTeam = useSavedTeam(definition.sourceTeam?.corralId ?? projection?.corralId);
  const plan = useMemo(() => {
    const compiled = compileDefinition(definition);
    return compiled.ok ? compiled.plan : null;
  }, [definition]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ended = !!projection && TERMINAL_RUN_STATUSES.has(projection.status);
  const live = !!projection && !ended && projection.status !== 'cancelling';
  const corralId = definition.sourceTeam?.corralId ?? projection?.corralId;
  // Until a later run of the session succeeds, the run keeps the step results a fork copies.
  const resultsKept =
    !!projection &&
    stepResultIds(projection).every((id) => projection.artifacts[id]?.bodyAvailable !== false);
  const breakpoints = projection?.breakpoints ?? [];
  const breakable = (nodeId: string) =>
    live && breakpointSteps(definition.nodes).some((node) => node.id === nodeId);
  const forkable = (nodeId: string) =>
    ended &&
    savedTeam === true &&
    !!corralId &&
    !!plan &&
    resultsKept &&
    !('error' in forkSteps(definition, plan, nodeId));
  const toggle = (nodeId: string) =>
    void session.getState().sendCommand({
      type: 'set_breakpoints',
      payload: {
        nodeIds: breakpoints.includes(nodeId)
          ? breakpoints.filter((id) => id !== nodeId)
          : [...breakpoints, nodeId],
      },
    });
  const fork = async (nodeId: string) => {
    if (!corralId || !projection) return;
    setBusy(true);
    setError(null);
    try {
      const [record, runs] = await Promise.all([repository.get(corralId), transport.listRuns()]);
      if (!record) throw new Error(t('unsavedTeam'));
      const sessionId = runs.find((run) => run.runId === projection.runId)?.sessionId;
      const base = {
        schemaVersion: '0.1' as const,
        commandId: `cmd_${globalThis.crypto.randomUUID()}`,
        mode: projection.mode ?? 'mock',
        ...(sessionId ? { sessionId } : {}),
        forkFrom: { runId: projection.runId, nodeId },
      };
      const { runId, receipt } = await transport.startRun(
        mode === 'browser'
          ? { ...base, definition: record.definition }
          : { ...base, corralId, definitionRevision: record.definitionRevision },
      );
      if (!runId) throw new Error(receipt.error?.message ?? receipt.status);
      void navigate({ to: '/runs/$runId', params: { runId } });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return { breakable, forkable, breakpoints, toggle, fork, busy, error };
}

/** One step's run options, in its quick view. */
function NodeRunActions({
  session,
  definition,
  nodeId,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  nodeId: string;
}) {
  const t = useTranslations('RunPage');
  const options = useStepRunOptions(session, definition);
  const breakable = options.breakable(nodeId);
  const forkable = options.forkable(nodeId);
  if (!breakable && !forkable) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-2 text-caption">
      {breakable ? (
        <Switch
          label={t('pauseBefore')}
          checked={options.breakpoints.includes(nodeId)}
          onToggle={() => options.toggle(nodeId)}
        />
      ) : null}
      {forkable ? (
        <Button
          variant="secondary"
          className="justify-start"
          disabled={options.busy}
          onClick={() => void options.fork(nodeId)}
        >
          {t('forkHere')}
        </Button>
      ) : null}
      {options.error ? <p role="alert">{t('forkFailed', { message: options.error })}</p> : null}
    </div>
  );
}

/** Every step a run option applies to now, including steps the graph has not seen run. */
function RunStepOptions({
  session,
  definition,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
}) {
  const t = useTranslations('RunPage');
  const options = useStepRunOptions(session, definition);
  const steps = definition.nodes.filter(
    (node) => options.breakable(node.id) || options.forkable(node.id),
  );
  if (!steps.length) return null;
  return (
    <AccordionItem value="steps">
      <AccordionTrigger>{t('steps')}</AccordionTrigger>
      <AccordionContent>
        <ul className="flex flex-col gap-1 text-caption" data-testid="run-step-options">
          {steps.map((step) => (
            <li key={step.id} className="flex min-h-8 items-center justify-between gap-2">
              {options.breakable(step.id) ? (
                <Switch
                  label={step.label}
                  checked={options.breakpoints.includes(step.id)}
                  onToggle={() => options.toggle(step.id)}
                />
              ) : (
                <>
                  <span className="min-w-0 truncate">{step.label}</span>
                  <Button
                    variant="secondary"
                    disabled={options.busy}
                    onClick={() => void options.fork(step.id)}
                  >
                    {t('forkHere')}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        {options.error ? (
          <p role="alert" className="text-caption">
            {t('forkFailed', { message: options.error })}
          </p>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  );
}

/** Exact executions of one observed agent, either a quick list or its complete inspector. */
function NodeExecutions({
  projection,
  definition,
  nodeId,
  selectedExecutionId,
  onChoose,
  preview = false,
  onShowAll,
  onOpenArtifact,
  onSteer,
}: {
  projection: RunProjection;
  definition: CorralDefinition;
  nodeId: string;
  selectedExecutionId: string | null;
  onChoose: (executionId: string) => void;
  preview?: boolean;
  onShowAll?: () => void;
  onOpenArtifact?: (artifactVersionId: string) => void;
  onSteer?: (executionId: string) => void;
}) {
  const t = useTranslations('RunPage');
  const m = useTranslations('RunMonitor');
  const results = useTranslations('Results');
  const identityPrefix = useId();
  const node = definition.nodes.find((n) => n.id === nodeId);
  const label = useAgentName(definition)(nodeId);
  const ids = (projection.nodeExecutions[nodeId] ?? []).filter(
    (id) => projection.executions[id]?.nodeId === nodeId,
  );
  const runEnded = TERMINAL_RUN_STATUSES.has(projection.status);
  const isActive = (id: string) => {
    const execution = projection.executions[id];
    return !!execution && !runEnded && !TERMINAL_EXECUTION_STATUSES.has(execution.status);
  };
  const visibleIds = preview
    ? [...ids]
        .reverse()
        .sort((a, b) => Number(isActive(b)) - Number(isActive(a)))
        .slice(0, 3)
    : ids;
  return (
    <section
      aria-label={t('nodeExecutions', { label })}
      className="flex flex-col gap-2 text-caption"
    >
      {ids.length === 0 ? (
        <p className="text-muted-foreground">
          {node && node.type !== 'agent' ? m('nonAgentNode') : t('noNodeExecutions')}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-line">
        {visibleIds.map((id) => {
          const e = projection.executions[id];
          if (!e) return null;
          const identityId = `${identityPrefix}-${id}`;
          const artifacts = Object.values(projection.artifacts).filter(
            (artifact) => artifact.authorExecutionId === id,
          );
          const latest = artifacts.at(-1);
          const readable = artifacts
            .filter((artifact) => canReadArtifactBody(projection, artifact.artifactVersionId))
            .at(-1);
          return (
            <li key={id} data-execution-id={id} className="grid gap-1 px-2 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 break-words">
                  {latest ? (
                    readable?.artifactVersionId === latest.artifactVersionId && onOpenArtifact ? (
                      <Button
                        variant="ghost"
                        className="max-w-full justify-start whitespace-normal text-left"
                        aria-describedby={identityId}
                        onClick={() => onOpenArtifact(latest.artifactVersionId)}
                      >
                        {results('itemName', { name: latest.name, version: latest.version })}
                      </Button>
                    ) : (
                      <div style={{ fontVariationSettings: fontWeights.semibold }}>
                        {results('itemName', { name: latest.name, version: latest.version })}
                      </div>
                    )
                  ) : null}
                  <div id={identityId}>
                    <ExecutionIdentity projection={projection} executionId={id} />
                  </div>
                </div>
                <PresenceBadge presence={executionViewPresence(e)} target={`execution:${id}`} />
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  variant={id === selectedExecutionId ? 'secondary' : 'ghost'}
                  aria-pressed={id === selectedExecutionId}
                  aria-describedby={identityId}
                  onClick={() => onChoose(id)}
                >
                  {m('details')}
                </Button>
                {readable &&
                readable.artifactVersionId !== latest?.artifactVersionId &&
                onOpenArtifact ? (
                  <Button
                    variant="ghost"
                    aria-describedby={identityId}
                    onClick={() => onOpenArtifact(readable.artifactVersionId)}
                  >
                    {results('itemName', { name: readable.name, version: readable.version })}
                  </Button>
                ) : null}
                {isActive(id) &&
                projection.status !== 'cancelling' &&
                e.status !== 'cancelling' &&
                onSteer ? (
                  <Button variant="ghost" aria-describedby={identityId} onClick={() => onSteer(id)}>
                    {m('steer')}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {preview && ids.length > visibleIds.length ? (
        <Button variant="ghost" className="justify-start" onClick={onShowAll}>
          {t('allExecutions')} · {ids.length}
        </Button>
      ) : null}
    </section>
  );
}
