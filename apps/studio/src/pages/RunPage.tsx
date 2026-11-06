import { type CorralDefinition, type NodeLayout, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { pendingInteractions, type RunProjection } from '@corral/core';
import {
  AgentStatusText,
  ApprovalPanel,
  ArtifactViewer,
  BudgetInspector,
  EffortJudgments,
  ExecutionTranscript,
  ExecutionTree,
  HarnessDetails,
  QuestionsPanel,
  ReinsPanel,
  RunActions,
  RunCanvas,
  type RunCanvasLayout,
  type RunFlowCheck,
  RunFlowView,
  RunReason,
  RunResults,
  type RunSessionStore,
  runCanvasLayout,
  runResults,
  StatusBadge,
  TaskBoard,
  Timeline,
  useRunDisplay,
  useSteerTarget,
  WorkPlanPanel,
} from '@corral/react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  formatClock,
  MetaDot,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
  useNow,
} from '@corral/react/design-kit';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useModelPrices } from '../prices.ts';
import { projectOfRun, setCurrentProject } from '../projects.ts';
import { runRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { ExecutionEvidence } from '../workbench/ExecutionEvidence.tsx';
import { panelKey } from '../workbench/panels/registry.ts';
import type { RunDetailSearch } from '../workbench/panels/routes.ts';
import { RunStatusCards } from '../workbench/RunStatusCards.tsx';
import { RunTimeChart } from '../workbench/RunTimeChart.tsx';
import { runFlowChecks } from '../workbench/runFlowChecks.ts';
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
}: {
  sessionId?: string | null;
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
      () => {},
    );
    return () => {
      live = false;
    };
  }, [transport, repository, runId]);

  if (activeRunId !== runId || !definition) {
    return (
      <main className="flex flex-col items-start gap-3 p-6">
        <h2 className="text-lg font-semibold">{t('heading', { runId })}</h2>
        <p role="status" className="text-sm text-muted-foreground">
          {error ?? (missing ? t('missing') : t('loading'))}
        </p>
        {activeRunId === runId ? <RunActions session={session} /> : null}
        {error ? (
          <Button
            variant="tertiary"
            size="compact"
            onClick={() => void session.getState().open(runId)}
          >
            {t('retry')}
          </Button>
        ) : null}
        <Link to="/" className="text-sm underline">
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
      search={search}
      setSearch={setSearch}
      embedded={embedded}
    />
  );
}

function ResultChoices({
  results,
  onOpen,
}: {
  results: NonNullable<ReturnType<typeof runResults>>;
  onOpen: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('Results');
  const items =
    results.kind === 'partial' ? results.intermediate.map((group) => group.latest) : results.final;
  if (!items.length)
    return (
      <p className="text-sm text-muted-foreground">
        {t(`kind.${results.kind === 'final' ? 'none' : results.kind}`)}
      </p>
    );
  return (
    <ul aria-label={t('label')} className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.artifactVersionId}>
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => onOpen(item.artifactVersionId)}
          >
            {t('itemName', { name: item.name, version: item.version })}
            {results.kind === 'partial' ? ` · ${t('partial')}` : ''}
          </Button>
        </li>
      ))}
    </ul>
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
}: {
  runId: string;
  session: RunSessionStore;
  sessionId: string | null;
  definition: CorralDefinition;
  search: RunDetailSearch;
  setSearch: (patch: RunDetailSearch, options?: { replace?: boolean }) => void;
  embedded: boolean;
}) {
  const t = useTranslations('RunPage');
  const m = useTranslations('RunMonitor');
  const { execution, artifact, result } = search;
  const view = search.view ?? (result ? 'results' : 'run');
  const Main = embedded ? 'div' : 'main';
  const { previewUrl, workspaces } = useServices();
  const projection = useStore(session, (s) => s.projection);
  const events = useStore(session, (s) => s.events);
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

  useEffect(() => {
    if (search.atSeq !== undefined) setSearch({ atSeq: undefined }, { replace: true });
  }, [search.atSeq, setSearch]);
  const savedTeam = useSavedTeam(projection?.corralId);
  const layout = useSavedLayout(definition, projection?.corralId ?? null, savedTeam);
  const prices = useModelPrices();
  const target = useSteerTarget(session, execution ?? null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [panel, setPanel] = useState('canvas');
  const [detailOpen, setDetailOpen] = useState(Boolean(execution || artifact));
  const [monitor, setMonitor] = useState('flow');
  const [detail, setDetail] = useState('overview');
  const trigger = useRef<HTMLElement | null>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const response = useRef<HTMLDivElement>(null);
  const openedResponseRun = useRef<string | null>(null);
  const hasOutput = useStore(session, (s) => s.outputText !== null);
  useEffect(() => {
    if (hasOutput) markRunReviewed();
  }, [hasOutput]);
  useEffect(() => {
    if (!execution && !artifact) return;
    setDetailOpen(true);
    setPanel('side');
  }, [execution, artifact]);
  useEffect(() => {
    if (!projection?.startedAt || openedResponseRun.current === projection.runId) return;
    openedResponseRun.current = projection.runId;
    // Only an existing decision at entry may move focus; later events leave editing alone.
    if (
      execution ||
      artifact ||
      result ||
      view === 'results' ||
      !pendingInteractions(session.getState().events, projection).length
    )
      return;
    response.current?.focus({ preventScroll: true });
    response.current?.scrollIntoView({ block: 'nearest' });
  }, [projection, session, execution, artifact, result, view]);
  const rememberTrigger = () => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const chooseExecution = (id: string) => {
    rememberTrigger();
    setSelectedNodeId(null);
    setDetailOpen(true);
    setPanel('side');
    setSearch({ execution: id, artifact: undefined });
  };
  const openArtifact = (id: string) => {
    rememberTrigger();
    setDetailOpen(true);
    setDetail('overview');
    setPanel('side');
    setSearch({ artifact: id, view: 'run', result: undefined });
  };
  const closeDetail = () => {
    setSelectedNodeId(null);
    setDetailOpen(false);
    const returnTo = trigger.current?.closest('.run-tree') ? 'tree' : 'canvas';
    setPanel(returnTo);
    setSearch({ execution: undefined, artifact: undefined });
    requestAnimationFrame(() =>
      (trigger.current?.isConnected ? trigger.current : detailsButton.current)?.focus(),
    );
  };
  const highlightedNode =
    selectedNodeId ?? (execution ? (projection?.executions[execution]?.nodeId ?? null) : null);
  const selectedTarget = execution ? target : null;
  const results = projection ? runResults(projection) : null;

  return (
    <div className="@container flex h-full min-h-0 flex-col" data-testid="run-monitor">
      <RunSummary
        session={session}
        definition={definition}
        view={view}
        onView={(view) => setSearch({ view })}
      />
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <div
          ref={response}
          data-run-response={projection?.runId}
          tabIndex={-1}
          className="shrink-0 outline-none"
        >
          <ApprovalPanel
            session={session}
            compact
            showPlan={false}
            onOpenArtifact={openArtifact}
            className="shrink-0 border-b border-line px-3 py-2"
          />
        </div>
      </fieldset>
      <Main
        style={view !== 'results' ? { display: 'none' } : undefined}
        className="min-h-0 flex-1 overflow-auto"
      >
        <RunResults
          session={session}
          selectedId={result ?? null}
          onSelect={(id) => setSearch({ view: 'results', result: id })}
          {...(previewUrl ? { previewUrl } : {})}
        />
      </Main>
      <Tabs
        style={view === 'results' ? { display: 'none' } : undefined}
        value={monitor}
        onValueChange={(value) => {
          setMonitor(value);
          setPanel('canvas');
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
          <TabsList aria-label={m('views')}>
            <TabItem
              value="flow"
              label={m('flow')}
              data-testid="run-flow-tab"
              onClick={() => setPanel('canvas')}
            />
            <TabItem value="graph" label={m('graph')} onClick={() => setPanel('canvas')} />
            <TabItem value="time" label={m('time')} onClick={() => setPanel('canvas')} />
            <TabItem value="events" label={m('events')} onClick={() => setPanel('canvas')} />
          </TabsList>
          <Button
            variant="tertiary"
            size="compact"
            aria-pressed={panel === 'tree'}
            onClick={() => setPanel(panel === 'tree' ? 'canvas' : 'tree')}
          >
            {t('executions')}
          </Button>
          <Button
            ref={detailsButton}
            variant="tertiary"
            size="compact"
            aria-pressed={detailOpen && panel !== 'tree'}
            onClick={() => {
              setDetailOpen(true);
              setPanel('side');
            }}
          >
            {m('details')}
          </Button>
        </div>
        <Main className="run-layout min-h-0 flex-1" data-panel={panel} data-details={detailOpen}>
          <aside
            aria-label={t('executions')}
            className="run-tree min-h-0 overflow-auto border-r border-line p-3"
          >
            <ExecutionTree
              session={session}
              onSteer={chooseExecution}
              selectedExecutionId={execution ?? null}
            />
          </aside>
          <div className="run-center relative min-h-0">
            <TabPanel value="flow" keepMounted className="h-full overflow-auto p-3">
              <RunFlowView
                session={session}
                definition={definition}
                checks={checks}
                selectedExecutionId={execution ?? null}
                onSelectExecution={chooseExecution}
                onOpenArtifact={openArtifact}
              />
            </TabPanel>
            <TabPanel value="graph" keepMounted className="h-full min-h-0">
              {layout ? (
                <RunCanvas
                  session={session}
                  definition={definition}
                  layout={layout}
                  selectedNodeId={highlightedNode}
                  onSelectNode={(id) => {
                    rememberTrigger();
                    setSelectedNodeId(id);
                    if (id) {
                      setDetailOpen(true);
                      setDetail('overview');
                      setPanel('side');
                      setSearch({ execution: undefined, artifact: undefined });
                    }
                  }}
                />
              ) : null}
            </TabPanel>
            <TabPanel value="time" keepMounted className="h-full min-h-0">
              <RunTimeChart
                events={events}
                projection={projection}
                definition={definition}
                selected={execution}
                onSelect={chooseExecution}
              />
            </TabPanel>
            <TabPanel value="events" keepMounted className="h-full overflow-auto p-3">
              <Timeline session={session} />
            </TabPanel>
          </div>
          <aside
            tabIndex={-1}
            aria-label={m('details')}
            className="run-side min-h-0 overflow-auto border-l border-line p-3 outline-none"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">{selectedTarget?.nodeLabel ?? m('details')}</h2>
              <Button variant="ghost" size="compact" onClick={closeDetail}>
                {m('closeDetails')}
              </Button>
            </div>
            {execution && projection && !projection.executions[execution] ? (
              <p role="alert">{t('executionMissing', { executionId: execution })}</p>
            ) : null}
            {selectedNodeId && projection ? (
              <NodeExecutions
                projection={projection}
                definition={definition}
                nodeId={selectedNodeId}
                selectedExecutionId={execution ?? null}
                onChoose={chooseExecution}
                onClose={closeDetail}
              />
            ) : null}
            <Tabs value={detail} onValueChange={setDetail}>
              <div className="overflow-x-auto">
                <TabsList aria-label={m('details')}>
                  <TabItem value="overview" label={m('overview')} />
                  <TabItem value="calls" label={m('calls')} />
                  <TabItem value="usage" label={m('usage')} />
                  <TabItem value="reins" label="Reins" />
                </TabsList>
              </div>
              <TabPanel value="overview" keepMounted className="space-y-3 pt-3">
                {artifact ? (
                  <ArtifactViewer
                    session={session}
                    versionId={artifact}
                    onOpen={openArtifact}
                    onClose={() => {
                      setSearch({ artifact: undefined });
                      (trigger.current?.isConnected
                        ? trigger.current
                        : detailsButton.current
                      )?.focus();
                    }}
                  />
                ) : results ? (
                  <ResultChoices
                    results={results}
                    onOpen={(id) => setSearch({ view: 'results', result: id })}
                  />
                ) : null}
                {sessionId && selectedTarget ? (
                  <ExecutionEvidence
                    session={session}
                    sessionId={sessionId}
                    executionId={selectedTarget.executionId}
                    onOpenArtifact={openArtifact}
                  />
                ) : null}
                <Accordion>
                  {Object.keys(projection?.workPlans ?? {}).length > 0 ? (
                    <AccordionItem value="plans">
                      <AccordionTrigger>{m('workPlans')}</AccordionTrigger>
                      <AccordionContent>
                        <WorkPlanPanel session={session} />
                      </AccordionContent>
                    </AccordionItem>
                  ) : null}
                  {Object.keys(projection?.tasks ?? {}).length > 0 ? (
                    <AccordionItem value="tasks">
                      <AccordionTrigger>
                        {t('tabs.tasks')} · {Object.keys(projection?.tasks ?? {}).length}
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="max-w-full overflow-x-auto">
                          <TaskBoard session={session} onOpenArtifact={openArtifact} />
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  ) : null}
                  {Object.keys(projection?.questions ?? {}).length > 0 ? (
                    <AccordionItem value="questions">
                      <AccordionTrigger>
                        {t('tabs.questions')} · {Object.keys(projection?.questions ?? {}).length}
                      </AccordionTrigger>
                      <AccordionContent>
                        <QuestionsPanel session={session} onOpenArtifact={openArtifact} />
                      </AccordionContent>
                    </AccordionItem>
                  ) : null}
                </Accordion>
                {detailOpen && detail === 'overview' ? (
                  <RunStatusCards
                    session={session}
                    sessionId={sessionId}
                    executionId={execution ?? null}
                  />
                ) : null}
              </TabPanel>
              <TabPanel value="calls" keepMounted className="space-y-3 pt-3">
                {selectedTarget ? (
                  <div className="flex h-[50vh] min-h-40 flex-col">
                    <ExecutionTranscript
                      session={session}
                      executionId={selectedTarget.executionId}
                      onOpenArtifact={openArtifact}
                    />
                  </div>
                ) : (
                  <p>{m('chooseExecution')}</p>
                )}
                <HarnessDetails session={session} />
              </TabPanel>
              <TabPanel value="usage" keepMounted className="space-y-3 pt-3">
                <BudgetInspector session={session} prices={prices} />
                <EffortJudgments session={session} />
              </TabPanel>
              <TabPanel value="reins" keepMounted className="pt-3">
                <fieldset className="m-0 min-w-0 border-0 p-0">
                  <ReinsPanel session={session} target={execution ? target : null} />
                </fieldset>
              </TabPanel>
            </Tabs>
          </aside>
        </Main>
      </Tabs>
    </div>
  );
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

/** The Corral's saved layout, once looked up; null while loading (avoids a layout jump). */
function useSavedLayout(
  definition: CorralDefinition,
  corralId: string | null,
  savedTeam: boolean | null,
) {
  const { repository } = useServices();
  const [saved, setSaved] = useState<{ nodes: Record<string, NodeLayout> | null } | null>(null);
  useEffect(() => {
    if (!savedTeam || !corralId) return;
    let live = true;
    repository.get(corralId).then(
      (record) => live && setSaved({ nodes: record?.layout.nodes ?? null }),
      () => live && setSaved({ nodes: null }),
    );
    return () => {
      live = false;
    };
  }, [repository, corralId, savedTeam]);
  return useMemo<RunCanvasLayout | null>(
    () =>
      savedTeam === false
        ? runCanvasLayout(definition, null)
        : saved
          ? runCanvasLayout(definition, saved.nodes)
          : null,
    [definition, saved, savedTeam],
  );
}

/**
 * What the run is doing, from committed facts only: which steps are working, the
 * Loop round, completed tasks and requests in flight. No percentage. Whole-run controls live
 * here and nowhere else on the page.
 */
function RunSummary({
  session,
  definition,
  view = 'run',
  onView,
  compact = false,
  readOnly = false,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  view?: RunPageView;
  onView?: (view: RunPageView) => void;
  compact?: boolean;
  readOnly?: boolean;
}) {
  const t = useTranslations('RunPage');
  const tr = useTranslations('Run');
  const projection = useRunDisplay(session, (s) => s.projection);
  const savedTeam = useSavedTeam(projection?.corralId);
  if (!projection) return null;
  const labelOf = (nodeId: string) =>
    definition.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const executions = projection.executionOrder.flatMap((id) => projection.executions[id] ?? []);
  const working = [
    ...new Set(executions.filter((e) => e.status === 'active').map((e) => labelOf(e.nodeId))),
  ];
  const waiting = executions.filter((e) => e.status.startsWith('waiting_')).length;
  const tasks = Object.values(projection.tasks);
  const inFlight = Object.values(projection.modelCalls).filter((c) => !c.finished).length;
  const loops = definition.nodes.flatMap((node) =>
    node.type === 'loop' && projection.loopIterations[node.id]?.length
      ? [
          t('loopRound', {
            label: node.label,
            round: projection.loopIterations[node.id]?.length ?? 0,
            max: loopLimit(projection, node.id) ?? node.maxIterations,
          }),
        ]
      : [],
  );
  const corralId = projection.corralId;
  const identity = [
    compact ? null : (
      <span key="run" className="min-w-0 break-all font-mono">
        {projection.runId}
      </span>
    ),
    corralId && savedTeam && !compact ? (
      <Link
        key="team"
        to="/corrals/$corralId/edit"
        params={{ corralId }}
        className="underline-offset-2 hover:underline"
      >
        {t('openCorral')}
      </Link>
    ) : corralId && savedTeam === false && !compact ? (
      <span key="team">{t('unsavedTeam')}</span>
    ) : null,
    projection.startedFrom && !compact ? (
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
  ];
  const progress =
    compact && projection.status === 'succeeded' && working.length === 0
      ? []
      : [
          working.length ? (
            <span key="working">{t('working', { labels: working.join(', ') })}</span>
          ) : compact ? null : (
            <span key="working">{t('idle')}</span>
          ),
          waiting ? <span key="waiting">{t('waitingExecutions', { count: waiting })}</span> : null,
          ...loops.map((text) => <span key={text}>{text}</span>),
          compact && inFlight === 0 ? null : (
            <span key="requests">{t('requests', { count: inFlight })}</span>
          ),
          compact ? null : (
            <span key="tasks">
              {t('tasks', {
                done: tasks.filter((task) => task.status === 'completed').length,
                total: tasks.length,
              })}
            </span>
          ),
          projection.statusReason && !(compact && projection.status === 'succeeded') ? (
            <span key="reason">
              {tr('reasonPrefix')} <RunReason code={projection.statusReason} nodeLabel={labelOf} />
            </span>
          ) : null,
        ];
  return (
    <section
      aria-label={t('summary')}
      className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate text-title">{definition.name}</h2>
          <span aria-live="polite" data-testid="run-status">
            <AgentStatusText kind="run" status={projection.status} />
          </span>
          <RunElapsed
            startedAt={projection.startedAt}
            endedAt={projection.endedAt}
            live={!readOnly && !TERMINAL_RUN_STATUSES.has(projection.status)}
          />
        </div>
        <MetaLine items={identity} />
        <MetaLine items={progress} />
      </div>
      <div className="flex max-w-full shrink-0 flex-wrap items-start justify-end gap-2">
        {onView ? <ViewSwitch view={view} onView={onView} /> : null}
        {readOnly ? null : (
          <div className="max-h-28 w-[24rem] max-w-full overflow-auto">
            <RunActions session={session} compact />
          </div>
        )}
      </div>
    </section>
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
}: {
  startedAt: string | null;
  endedAt: string | null;
  live: boolean;
}) {
  const t = useTranslations('RunPage');
  const now = useNow(1000, live && startedAt !== null);
  if (!startedAt) return null;
  const end = endedAt ? Date.parse(endedAt) : live ? now : null;
  if (end === null) return null;
  const clock = formatClock(end - Date.parse(startedAt));
  return (
    <span className="font-mono text-caption tabular-nums text-muted-foreground">
      <span className="sr-only">{t('elapsed')} </span>
      {clock}
    </span>
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

/** A design node's executions in this run: one per Loop round, call and attempt. */
function NodeExecutions({
  projection,
  definition,
  nodeId,
  selectedExecutionId,
  onChoose,
  onClose,
}: {
  projection: RunProjection;
  definition: CorralDefinition;
  nodeId: string;
  selectedExecutionId: string | null;
  onChoose: (executionId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('RunPage');
  const tr = useTranslations('Run');
  const m = useTranslations('RunMonitor');
  const node = definition.nodes.find((n) => n.id === nodeId);
  const label = node?.label ?? nodeId;
  const ids = projection.nodeExecutions[nodeId] ?? [];
  return (
    <section
      aria-label={t('nodeExecutions', { label })}
      className="flex flex-col gap-2 rounded-md fill-group p-2 text-xs"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('nodeExecutions', { label })}</h2>
        <Button variant="ghost" size="compact" onClick={onClose}>
          {t('closeNode')}
        </Button>
      </div>
      {ids.length === 0 ? (
        <p className="text-muted-foreground">
          {node && node.type !== 'agent' ? m('nonAgentNode') : t('noNodeExecutions')}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {ids.map((id) => {
          const e = projection.executions[id];
          if (!e) return null;
          const round = e.iterationId ? projection.iterations[e.iterationId]?.no : null;
          return (
            <li key={id}>
              <Button
                variant={id === selectedExecutionId ? 'secondary' : 'ghost'}
                size="compact"
                aria-pressed={id === selectedExecutionId}
                onClick={() => onChoose(id)}
                className="w-full justify-between"
              >
                <span>
                  {round ? `${tr('round', { no: round })} · ` : ''}
                  {e.attemptNo > 1 ? `${tr('attempt', { no: e.attemptNo })} · ` : ''}
                  <span className="font-mono">{id}</span>
                </span>
                <StatusBadge status={e.status} />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type RunPageView = 'results' | 'run';

function ViewSwitch({ view, onView }: { view: RunPageView; onView: (view: RunPageView) => void }) {
  const t = useTranslations('RunPage.view');
  const next = view === 'run' ? 'results' : 'run';
  return (
    <Button variant="tertiary" size="compact" onClick={() => onView(next)}>
      {t(next)}
    </Button>
  );
}
