import type { CorralDefinition, NodeLayout } from '@corral/contracts';
import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { pendingInteractions, type RunProjection } from '@corral/core';
import {
  ApprovalPanel,
  ArtifactViewer,
  BudgetInspector,
  EffortJudgments,
  ExecutionTranscript,
  ExecutionTree,
  HarnessDetails,
  historicalStreams,
  QuestionsPanel,
  ReinsPanel,
  RunActions,
  RunCanvas,
  type RunCanvasLayout,
  RunDisplayProvider,
  type RunDisplaySnapshot,
  RunReason,
  RunResults,
  type RunSessionStore,
  reconstructRunHistory,
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
  Slider,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
} from '@corral/react/design-kit';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useModelPrices } from '../prices.ts';
import { projectOfRun, setCurrentProject } from '../projects.ts';
import { runRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { ExecutionEvidence } from '../workbench/ExecutionEvidence.tsx';
import { MessageBranch } from '../workbench/MessageBranch.tsx';
import { panelKey } from '../workbench/panels/registry.ts';
import type { RunDetailSearch } from '../workbench/panels/routes.ts';
import { RunStatusCards } from '../workbench/RunStatusCards.tsx';
import { RunTimeChart } from '../workbench/RunTimeChart.tsx';
import { markRunReviewed } from './GettingStarted.tsx';

export type { RunDetailSearch } from '../workbench/panels/routes.ts';

/** /runs/$runId?execution=…&artifact=… — one run: graph, call tree, details and Reins. */
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
  runNumber,
  search,
  setSearch,
  embedded = false,
  sessionId = null,
}: {
  sessionId?: string | null;
  runId: string;
  runNumber?: number;
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
        if (live && run) setCurrentProject(projectOfRun(run, corrals));
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
        {activeRunId === runId && search.atSeq === undefined ? (
          <RunActions session={session} />
        ) : null}
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
      runNumber={runNumber}
      key={runId}
      session={session}
      definition={definition}
      sessionId={sessionId}
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

const NO_STREAMS = {};

function RunWorkspace({
  runId,
  runNumber,
  session,
  sessionId,
  definition,
  search,
  setSearch,
  embedded,
}: {
  runId: string;
  runNumber: number | undefined;
  session: RunSessionStore;
  sessionId: string | null;
  definition: CorralDefinition;
  search: RunDetailSearch;
  setSearch: (patch: RunDetailSearch, options?: { replace?: boolean }) => void;
  embedded: boolean;
}) {
  const t = useTranslations('RunPage');
  const m = useTranslations('RunMonitor');
  const { execution, artifact, result, atSeq } = search;
  const historical = atSeq !== undefined;
  const view = search.view ?? (result ? 'results' : 'run');
  const navigate = useNavigate();
  const Main = embedded ? 'div' : 'main';
  const { previewUrl } = useServices();
  const liveProjection = useStore(session, (s) => s.projection);
  const events = useStore(session, (s) => s.events);
  const history = useMemo(
    () => (atSeq === undefined ? null : reconstructRunHistory(runId, events, atSeq)),
    [runId, events, atSeq],
  );
  const completedStreams = useStore(
    session,
    useShallow((s) => (history ? historicalStreams(history.projection, s.streams) : NO_STREAMS)),
  );
  const display = useMemo<RunDisplaySnapshot | null>(
    () =>
      history
        ? { projection: history.projection, events: history.events, streams: completedStreams }
        : null,
    [history, completedStreams],
  );
  const projection = display?.projection ?? liveProjection;
  const head = events.at(-1)?.runSeq ?? 0;
  const chooseSeq = (value: number | undefined) => setSearch({ atSeq: value }, { replace: true });
  const savedTeam = useSavedTeam(liveProjection?.corralId);
  const layout = useSavedLayout(definition, liveProjection?.corralId ?? null, savedTeam);
  const prices = useModelPrices();
  const target = useSteerTarget(session, execution ?? null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [panel, setPanel] = useState('canvas');
  const [detailOpen, setDetailOpen] = useState(Boolean(execution || artifact));
  const [monitor, setMonitor] = useState('graph');
  const [detail, setDetail] = useState('overview');
  const trigger = useRef<HTMLElement | null>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const response = useRef<HTMLDivElement>(null);
  const openedResponseRun = useRef<string | null>(null);
  const hasOutput = useStore(session, (s) => s.outputText !== null);
  useEffect(() => {
    if (hasOutput && !historical) markRunReviewed();
  }, [hasOutput, historical]);
  useEffect(() => {
    if (!execution && !artifact) return;
    setDetailOpen(true);
    setPanel('side');
  }, [execution, artifact]);
  useEffect(() => {
    if (historical || !projection?.startedAt || openedResponseRun.current === projection.runId)
      return;
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
  }, [projection, session, execution, artifact, result, view, historical]);
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
  const startFrom =
    savedTeam && !historical
      ? (from: { runId: string; artifactVersionId: string }) =>
          void navigate({
            to: '/corrals/$corralId/edit',
            params: { corralId: projection?.corralId ?? '' },
            search: { fromRun: from.runId, fromVersion: from.artifactVersionId },
          })
      : null;
  const highlightedNode =
    selectedNodeId ?? (execution ? (projection?.executions[execution]?.nodeId ?? null) : null);
  const historicalExecution = execution ? projection?.executions[execution] : null;
  const selectedTarget = historical
    ? historicalExecution
      ? {
          executionId: historicalExecution.executionId,
          nodeLabel:
            definition.nodes.find((node) => node.id === historicalExecution.nodeId)?.label ??
            historicalExecution.nodeId,
          finished: TERMINAL_EXECUTION_STATUSES.has(historicalExecution.status),
        }
      : null
    : execution
      ? target
      : null;
  const results = projection ? runResults(projection) : null;
  const selectedResultId = result ?? results?.defaultId ?? undefined;

  if (history?.status === 'loading') {
    return (
      <section className="flex flex-col items-start gap-3 p-4" aria-busy="true">
        <p role="status">{t('loading')}</p>
        <Button variant="tertiary" size="compact" onClick={() => chooseSeq(undefined)}>
          {m('latest')}
        </Button>
      </section>
    );
  }
  return (
    <RunDisplayProvider snapshot={display}>
      <div className="@container flex h-full min-h-0 flex-col" data-testid="run-monitor">
        <RunSummary
          session={session}
          definition={definition}
          view={view}
          readOnly={historical}
          onView={(view) => setSearch({ view })}
        />
        <div className="shrink-0 border-b border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-40 flex-1">
              <Slider
                size="compact"
                label={m('cursor')}
                min={0}
                max={Math.max(1, head)}
                step={1}
                value={Math.min(atSeq ?? head, head)}
                formatValue={(value) => m('record', { seq: value })}
                disabled={head === 0}
                onChange={(value) => chooseSeq(typeof value === 'number' ? value : value[0])}
              />
            </div>
            <Button
              variant="tertiary"
              size="compact"
              disabled={(atSeq ?? head) === 0}
              onClick={() => chooseSeq(Math.max(0, (atSeq ?? head) - 1))}
            >
              {m('previous')}
            </Button>
            <Button
              variant="tertiary"
              size="compact"
              disabled={!historical || atSeq >= head}
              onClick={() => chooseSeq(Math.min(head, (atSeq ?? head) + 1))}
            >
              {m('next')}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              disabled={!historical}
              onClick={() => chooseSeq(undefined)}
            >
              {m('latest')}
            </Button>
          </div>
          {historical ? (
            <p
              role="status"
              data-testid="history-mode"
              className="mt-2 text-xs text-muted-foreground"
            >
              {m('historical', {
                seq: atSeq,
                visible: projection?.lastSeq ?? 0,
                newer: Math.max(0, head - atSeq),
              })}
            </p>
          ) : null}
          {history?.gap ? (
            <p role="alert" className="mt-2 text-xs text-warning">
              {m('historyGap', {
                expected: history.gap.expectedSeq,
                visible: history.projection.lastSeq,
              })}
            </p>
          ) : null}
        </div>
        <fieldset disabled={historical} hidden={historical} className="m-0 min-w-0 border-0 p-0">
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
            runNumber={runNumber}
            selectedId={result ?? null}
            onSelect={(id) => setSearch({ view: 'results', result: id })}
            {...(previewUrl ? { previewUrl } : {})}
            {...(startFrom ? { onStartFrom: startFrom } : {})}
          />
          {sessionId && selectedResultId && projection?.artifacts[selectedResultId] ? (
            <MessageBranch
              runId={projection.runId}
              artifactVersionId={selectedResultId}
              disabled={historical || !TERMINAL_RUN_STATUSES.has(projection.status)}
            />
          ) : null}
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
                  events={display?.events ?? events}
                  projection={projection}
                  definition={definition}
                  selected={execution}
                  onSelect={chooseExecution}
                />
              </TabPanel>
              <TabPanel value="events" keepMounted className="h-full overflow-auto p-3">
                <Timeline session={session} selectedSeq={atSeq} onSelectSeq={chooseSeq} />
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
                <p role="alert">
                  {historical
                    ? m('executionMissingAt', { executionId: execution })
                    : t('executionMissing', { executionId: execution })}
                </p>
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
                      {...(startFrom ? { onStartFrom: startFrom } : {})}
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
                  {sessionId && artifact && projection?.artifacts[artifact] ? (
                    <MessageBranch
                      runId={projection.runId}
                      artifactVersionId={artifact}
                      disabled={historical || !TERMINAL_RUN_STATUSES.has(projection.status)}
                    />
                  ) : null}
                  {!historical && sessionId && selectedTarget ? (
                    <ExecutionEvidence
                      session={session}
                      sessionId={sessionId}
                      executionId={selectedTarget.executionId}
                      onOpenArtifact={openArtifact}
                    />
                  ) : null}
                  {historical ? (
                    <p className="text-xs text-muted-foreground">{m('currentEvidence')}</p>
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
                  {!historical && detailOpen && detail === 'overview' ? (
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
                  {historical ? (
                    <p className="text-xs text-muted-foreground">{m('readOnly')}</p>
                  ) : null}
                  <fieldset
                    disabled={historical}
                    hidden={historical}
                    className="m-0 min-w-0 border-0 p-0"
                  >
                    <ReinsPanel session={session} target={execution ? target : null} />
                  </fieldset>
                </TabPanel>
              </Tabs>
            </aside>
          </Main>
        </Tabs>
      </div>
    </RunDisplayProvider>
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
  const savedTeam = useSavedTeam(definition.sourceTeam?.corralId ?? projection?.corralId);
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
  const ended = TERMINAL_RUN_STATUSES.has(projection.status);
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
  const corralId = definition.sourceTeam?.corralId ?? projection.corralId;
  return (
    <section
      aria-label={t('summary')}
      className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-2"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {onView ? <ViewSwitch view={view} onView={onView} /> : null}
          <h2 className="text-base font-semibold">
            {definition.sourceTeam
              ? `${definition.sourceTeam.name} · r${definition.sourceTeam.revision}`
              : definition.name}
          </h2>
          {!compact ? (
            <span className="font-mono text-xs text-muted-foreground">{projection.runId}</span>
          ) : null}
          {readOnly ? (
            <span className="text-xs text-muted-foreground">{t('historicalStatus')}</span>
          ) : null}
          <span aria-live="polite" data-testid="run-status">
            <StatusBadge status={projection.status} />
          </span>
          {corralId && savedTeam && !compact ? (
            <Link to="/corrals/$corralId/edit" params={{ corralId }} className="text-xs underline">
              {t('openCorral')}
            </Link>
          ) : corralId && !definition.sourceTeam && savedTeam === false && !compact ? (
            <span className="text-xs text-muted-foreground">{t('unsavedTeam')}</span>
          ) : null}
          {projection.startedFrom && !compact ? (
            <span className="text-xs text-muted-foreground">
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
          ) : null}
        </div>
        {compact && projection.status === 'succeeded' && working.length === 0 ? null : (
          <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              {projection.status === 'cancelling'
                ? t('cancelling')
                : ended
                  ? null
                  : working.length
                    ? t('working', { labels: working.join(', ') })
                    : inFlight || waiting || projection.status === 'paused'
                      ? null
                      : t('starting')}
            </span>
            {waiting ? <span>{t('waitingExecutions', { count: waiting })}</span> : null}
            {loops.map((text) => (
              <span key={text}>{text}</span>
            ))}
            {inFlight ? (
              <span>
                {t(
                  ended || projection.status === 'cancelling' ? 'unconfirmedRequests' : 'requests',
                  { count: inFlight },
                )}
              </span>
            ) : null}
            {compact ? null : (
              <span>
                {t('tasks', {
                  done: tasks.filter((task) => task.status === 'completed').length,
                  total: tasks.length,
                })}
              </span>
            )}
            {projection.statusReason && !(compact && projection.status === 'succeeded') ? (
              <span>
                {tr('reasonPrefix')}{' '}
                <RunReason code={projection.statusReason} nodeLabel={labelOf} />
              </span>
            ) : null}
          </p>
        )}
      </div>
      <div className="max-h-28 w-[24rem] max-w-full overflow-auto">
        {readOnly ? null : <RunActions session={session} compact />}
      </div>
    </section>
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
