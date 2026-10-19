import type { CorralDefinition, NodeLayout } from '@corral/contracts';
import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import {
  ApprovalPanel,
  ArtifactViewer,
  BudgetInspector,
  EffortJudgments,
  ExecutionTranscript,
  ExecutionTree,
  HarnessDetails,
  QuestionsPanel,
  ReinsPanel,
  ResultReader,
  RunActions,
  RunCanvas,
  type RunCanvasLayout,
  RunOutput,
  RunReason,
  RunResults,
  type RunSessionStore,
  runCanvasLayout,
  runResults,
  StatusBadge,
  TaskBoard,
  Timeline,
  useSteerTarget,
} from '@corral/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useModelPrices } from '../prices.ts';
import { projectOfRun, setCurrentProject } from '../projects.ts';
import { runRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { MessageBranch } from '../workbench/MessageBranch.tsx';
import { RunStatusCards } from '../workbench/RunStatusCards.tsx';
import { markRunReviewed } from './GettingStarted.tsx';

/** What a run's detail keeps in the address: the view, chosen execution, version and result. */
export interface RunDetailSearch {
  execution?: string | undefined;
  artifact?: string | undefined;
  view?: 'results' | 'run' | undefined;
  result?: string | undefined;
}

/** /runs/$runId?execution=…&artifact=… — one run: graph, call tree, details and Reins (C-066). */
export function RunPage() {
  const { runId } = runRoute.useParams();
  const search = runRoute.useSearch();
  const navigate = useNavigate({ from: '/runs/$runId' });
  return (
    <RunDetail
      runId={runId}
      search={search}
      setSearch={(patch) => void navigate({ search: (s) => ({ ...s, ...patch }) })}
    />
  );
}

/**
 * A run's detail, on its own page or inside a session's workbench (02-UX-Spec §3 실행 상세).
 * The caller keeps the search state; `embedded` drops the page landmarks.
 */
export function RunDetail({
  runId,
  search,
  setSearch,
  embedded = false,
  compact = false,
  sessionId = null,
}: {
  sessionId?: string | null;
  runId: string;
  search: RunDetailSearch;
  setSearch: (patch: RunDetailSearch) => void;
  embedded?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations('RunPage');
  const { session: sharedSession, editorSessions, transport, repository } = useServices();
  const session = useMemo(
    () =>
      [...editorSessions.values()].find((view) => view.getState().runId === runId) ?? sharedSession,
    [editorSessions, sharedSession, runId],
  );
  const activeRunId = useStore(session, (s) => s.runId);
  const missing = useStore(session, (s) => s.missingRunId === runId);
  const error = useStore(session, (s) => s.streamError ?? s.definitionError);
  const definition = useStore(session, (s) => s.definition);

  // A direct link or a reload: follow the run from the runtime's record.
  useEffect(() => {
    void session.getState().open(runId);
  }, [session, runId]);

  // CR-010: the header shows the project this run started in.
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

  // CR-009: whether the run had already ended when the page opened. Decided once, so a run
  // that ends while it is watched never moves the page to its results.
  const [openedEnded, setOpenedEnded] = useState<{ runId: string; ended: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    transport.getSnapshot(runId).then(
      ({ projection }) =>
        live && setOpenedEnded({ runId, ended: TERMINAL_RUN_STATUSES.has(projection.status) }),
      () => live && setOpenedEnded({ runId, ended: false }),
    );
    return () => {
      live = false;
    };
  }, [transport, runId]);

  if (activeRunId !== runId || !definition) {
    return (
      <main className="flex flex-col items-start gap-3 p-6">
        <h2 className="text-lg font-semibold">{t('heading', { runId })}</h2>
        <p role="status" className="text-sm text-muted">
          {error ?? (missing ? t('missing') : t('loading'))}
        </p>
        {activeRunId === runId ? <RunActions session={session} /> : null}
        {error ? (
          <button
            type="button"
            className="rounded border border-line px-2 py-1 text-sm"
            onClick={() => void session.getState().open(runId)}
          >
            {t('retry')}
          </button>
        ) : null}
        <Link to="/" className="text-sm underline">
          ←
        </Link>
      </main>
    );
  }
  const opened = openedEnded?.runId === runId ? openedEnded.ended : null;
  if (compact)
    return (
      <CompactRunWorkspace
        key={runId}
        sessionId={sessionId}
        session={session}
        definition={definition}
        search={search}
        setSearch={setSearch}
      />
    );
  return (
    <RunWorkspace
      key={runId}
      session={session}
      definition={definition}
      openedEnded={opened}
      search={search}
      setSearch={setSearch}
      embedded={embedded}
    />
  );
}

/** A session observes and controls its run here; the graph and full history keep their own page. */
function CompactRunWorkspace({
  session,
  sessionId,
  definition,
  search,
  setSearch,
}: {
  session: RunSessionStore;
  sessionId: string | null;
  definition: CorralDefinition;
  search: RunDetailSearch;
  setSearch: (patch: RunDetailSearch) => void;
}) {
  const t = useTranslations('RunPage');
  const n = useTranslations('Navigation');
  const navigate = useNavigate();
  const projection = useStore(session, (state) => state.projection);
  const target = useSteerTarget(session, search.execution ?? null);
  const controls = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const detailsLink = useRef<HTMLAnchorElement>(null);
  const { previewUrl } = useServices();
  useEffect(() => {
    if (search.execution) {
      controls.current?.focus({ preventScroll: true });
      controls.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [search.execution]);
  if (!projection) return null;
  const version =
    search.view === 'results'
      ? (search.result ?? search.artifact)
      : (search.artifact ?? search.result);
  const results = search.view === 'results' ? runResults(projection) : null;
  const result = results
    ? [...results.final, ...results.intermediate.flatMap((group) => group.versions)].find(
        (item) => item.artifactVersionId === version,
      )
    : null;
  const startFrom = projection.corralId
    ? (from: { runId: string; artifactVersionId: string }) =>
        void navigate({
          to: '/corrals/$corralId/edit',
          params: { corralId: projection.corralId ?? '' },
          search: { fromRun: from.runId, fromVersion: from.artifactVersionId },
        })
    : null;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="compact-run">
      <RunSummary session={session} definition={definition} compact />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        <Link
          ref={detailsLink}
          to="/runs/$runId"
          params={{ runId: projection.runId }}
          search={{ ...search, view: search.view ?? 'run' }}
          className="rounded-md border border-line bg-raised px-3 py-2 text-center text-sm hover:bg-sidebar-accent"
        >
          {n('openRunDetails')}
        </Link>
        <RunStatusCards
          session={session}
          sessionId={sessionId}
          executionId={search.execution ?? null}
        />
        <section aria-label={t('executions')} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted">{t('executions')}</h3>
          <ExecutionTree
            session={session}
            compact
            selectedExecutionId={search.execution ?? null}
            onSteer={(execution) => {
              trigger.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
              setSearch({ execution, view: 'run' });
            }}
          />
        </section>
        <ApprovalPanel
          session={session}
          compact
          onOpenArtifact={(artifact) => setSearch({ artifact, view: 'run', result: undefined })}
        />
        {result ? (
          <div className="rounded-lg border border-line">
            <div className="flex justify-end p-2">
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-muted hover:bg-raised"
                onClick={() => setSearch({ artifact: undefined, result: undefined })}
              >
                {n('closeResult')}
              </button>
            </div>
            <ResultReader
              key={result.artifactVersionId}
              session={session}
              item={result}
              {...(previewUrl ? { previewUrl } : {})}
              {...(startFrom ? { onStartFrom: startFrom } : {})}
            />
          </div>
        ) : version ? (
          <ArtifactViewer
            session={session}
            versionId={version}
            onOpen={(artifact) => setSearch({ artifact, view: 'run', result: undefined })}
            {...(startFrom ? { onStartFrom: startFrom } : {})}
            onClose={() => setSearch({ artifact: undefined, result: undefined })}
          />
        ) : null}
        {sessionId && (result || version) ? (
          <MessageBranch
            runId={projection.runId}
            artifactVersionId={result?.artifactVersionId ?? version!}
            disabled={!TERMINAL_RUN_STATUSES.has(projection.status)}
          />
        ) : null}
        <div
          ref={controls}
          tabIndex={-1}
          hidden={!search.execution}
          className="rounded-lg border border-line p-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-muted hover:bg-raised"
              onClick={() => {
                setSearch({ execution: undefined });
                (trigger.current?.isConnected ? trigger.current : detailsLink.current)?.focus();
              }}
            >
              {n('closeControls')}
            </button>
          </div>
          {search.execution && !projection.executions[search.execution] ? (
            <p role="alert" className="mb-3 text-xs text-warning">
              {t('executionMissing', { executionId: search.execution })}
            </p>
          ) : null}
          <ReinsPanel session={session} target={target} />
          {search.execution && target ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs font-medium">{t('conversation')}</summary>
              <div className="mt-2 flex h-64 flex-col">
                <ExecutionTranscript
                  session={session}
                  executionId={target.executionId}
                  onOpenArtifact={(artifact) =>
                    setSearch({ artifact, view: 'run', result: undefined })
                  }
                />
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RunWorkspace({
  session,
  definition,
  openedEnded,
  search,
  setSearch,
  embedded,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  /** Whether the run had ended when the page opened; null until known. */
  openedEnded: boolean | null;
  search: RunDetailSearch;
  setSearch: (patch: RunDetailSearch) => void;
  embedded: boolean;
}) {
  const t = useTranslations('RunPage');
  const { execution, artifact, view: chosenView, result } = search;
  const navigate = useNavigate();
  const Main = embedded ? 'div' : 'main';
  const { previewUrl } = useServices();
  const projection = useStore(session, (s) => s.projection);
  // CR-009: a run that had ended when the page opened shows its results first. A chosen
  // view, or something picked in the run view, is kept; results arriving later never move it.
  const view: RunPageView | null =
    chosenView ??
    (execution || artifact ? 'run' : openedEnded === null ? null : openedEnded ? 'results' : 'run');
  const chooseView = (next: RunPageView) => setSearch({ view: next });
  const startFrom = projection?.corralId
    ? (from: { runId: string; artifactVersionId: string }) =>
        void navigate({
          to: '/corrals/$corralId/edit',
          params: { corralId: projection.corralId ?? '' },
          search: { fromRun: from.runId, fromVersion: from.artifactVersionId },
        })
    : null;
  const hasOutput = useStore(session, (s) => s.outputText !== null);
  useEffect(() => {
    if (hasOutput) markRunReviewed();
  }, [hasOutput]);
  const target = useSteerTarget(session, execution ?? null);
  const layout = useSavedLayout(definition, projection?.corralId ?? null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Below 768px one panel shows at a time (roadmap 19); wider screens show them all.
  const [panel, setPanel] = useState<NarrowPanel>('canvas');
  // UX-03: the run view follows its own width (a side panel is narrow on any screen).
  const shown = (name: NarrowPanel) => (panel === name ? '' : '@max-3xl:hidden');

  const chooseExecution = (id: string) => {
    setSelectedNodeId(null);
    setPanel('side');
    setSearch({ execution: id });
  };
  const openArtifact = (id: string) => {
    setPanel('side');
    setSearch({ artifact: id });
  };
  const unknownExecution =
    execution && projection && !projection.executions[execution] ? execution : null;
  const highlightedNode =
    selectedNodeId ?? (execution ? (projection?.executions[execution]?.nodeId ?? null) : null);

  if (view === null) {
    return (
      <div className="@container flex h-full min-h-0 flex-col">
        <RunSummary session={session} definition={definition} view="run" onView={chooseView} />
      </div>
    );
  }

  if (view === 'results') {
    return (
      <div className="@container flex h-full min-h-0 flex-col">
        <RunSummary session={session} definition={definition} view={view} onView={chooseView} />
        <Main className="min-h-0 flex-1">
          <RunResults
            session={session}
            selectedId={result ?? null}
            onSelect={(id) => setSearch({ view: 'results', result: id })}
            {...(previewUrl ? { previewUrl } : {})}
            {...(startFrom ? { onStartFrom: startFrom } : {})}
          />
        </Main>
        {/* A waiting decision stays at the foot of what it is about: read, then decide (UX-03). */}
        <ApprovalPanel
          session={session}
          compact
          onOpenArtifact={(id) => setSearch({ view: 'results', result: id })}
          className="shrink-0 border-t border-line px-3 py-2"
        />
      </div>
    );
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <RunSummary session={session} definition={definition} view={view} onView={chooseView} />
      <NarrowViews panel={panel} onChoose={setPanel} />
      <Main className="run-layout min-h-0 flex-1">
        <aside
          aria-labelledby="run-executions-heading"
          className={`flex min-h-0 flex-col gap-2 overflow-auto border-r border-line p-3 [grid-area:tree] max-[1279px]:border-t ${shown('tree')}`}
        >
          <h2 id="run-executions-heading" className="text-sm font-semibold">
            {t('executions')}
          </h2>
          <ExecutionTree
            session={session}
            onSteer={chooseExecution}
            selectedExecutionId={execution ?? null}
          />
        </aside>
        <div className={`relative min-h-0 [grid-area:canvas] ${shown('canvas')}`}>
          {layout ? (
            <RunCanvas
              session={session}
              definition={definition}
              layout={layout}
              selectedNodeId={highlightedNode}
              onSelectNode={(id) => {
                setSelectedNodeId(id);
                if (id) setPanel('side');
              }}
            />
          ) : null}
        </div>
        <aside
          className={`flex min-h-0 flex-col gap-4 overflow-auto border-l border-line p-3 [grid-area:side] ${shown('side')}`}
        >
          {unknownExecution ? (
            <p role="alert" className="rounded border border-warning p-2 text-xs text-warning">
              {t('executionMissing', { executionId: unknownExecution })}
            </p>
          ) : null}
          {selectedNodeId && projection ? (
            <NodeExecutions
              projection={projection}
              definition={definition}
              nodeId={selectedNodeId}
              selectedExecutionId={execution ?? null}
              onChoose={chooseExecution}
              onClose={() => setSelectedNodeId(null)}
            />
          ) : null}
          <ApprovalPanel session={session} onOpenArtifact={openArtifact} />
          {artifact ? (
            <ArtifactViewer
              session={session}
              versionId={artifact}
              onOpen={openArtifact}
              {...(startFrom ? { onStartFrom: startFrom } : {})}
              onClose={() => setSearch({ artifact: undefined })}
            />
          ) : null}
          {target ? (
            <section aria-label={t('conversation')} className="flex shrink-0 flex-col gap-1">
              <h2 className="text-sm font-semibold">{t('conversation')}</h2>
              <div className="flex h-[40vh] min-h-40 flex-col">
                <ExecutionTranscript
                  session={session}
                  executionId={target.executionId}
                  onOpenArtifact={openArtifact}
                />
              </div>
            </section>
          ) : null}
          <ReinsPanel session={session} target={target} />
        </aside>
        <div
          className={`flex min-h-0 flex-col border-t border-line [grid-area:dock] ${shown('dock')}`}
        >
          <RunDetails
            session={session}
            openArtifact={openArtifact}
            openResult={(id) => setSearch({ view: 'results', result: id })}
          />
        </div>
      </Main>
    </div>
  );
}

/** The Corral's saved layout, once looked up; null while loading (avoids a layout jump). */
function useSavedLayout(definition: CorralDefinition, corralId: string | null) {
  const { repository } = useServices();
  const [saved, setSaved] = useState<{ nodes: Record<string, NodeLayout> | null } | null>(null);
  const id = corralId ?? definition.id;
  useEffect(() => {
    let live = true;
    repository.get(id).then(
      (record) => live && setSaved({ nodes: record?.layout.nodes ?? null }),
      () => live && setSaved({ nodes: null }),
    );
    return () => {
      live = false;
    };
  }, [repository, id]);
  return useMemo<RunCanvasLayout | null>(
    () => (saved ? runCanvasLayout(definition, saved.nodes) : null),
    [definition, saved],
  );
}

/**
 * What the run is doing, from committed facts only (Spec §4.3): which steps are working, the
 * Loop round, completed tasks and requests in flight. No percentage. Whole-run controls live
 * here and nowhere else on the page (Spec §4.4).
 */
function RunSummary({
  session,
  definition,
  view = 'run',
  onView,
  compact = false,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  view?: RunPageView;
  onView?: (view: RunPageView) => void;
  compact?: boolean;
}) {
  const t = useTranslations('RunPage');
  const tr = useTranslations('Run');
  const projection = useStore(session, (s) => s.projection);
  if (!projection) return null;
  const labelOf = (nodeId: string) =>
    definition.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const executions = projection.executionOrder.flatMap((id) => projection.executions[id] ?? []);
  const working = [
    ...new Set(
      executions
        .filter((e) => !TERMINAL_EXECUTION_STATUSES.has(e.status))
        .map((e) => labelOf(e.nodeId)),
    ),
  ];
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
  return (
    <section
      aria-label={t('summary')}
      className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-2"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {onView ? <ViewSwitch view={view} onView={onView} /> : null}
          <h2 className="text-base font-semibold">{definition.name}</h2>
          {!compact ? (
            <span className="font-mono text-xs text-muted">{projection.runId}</span>
          ) : null}
          <span aria-live="polite" data-testid="run-status">
            <StatusBadge status={projection.status} />
          </span>
          {corralId && !compact ? (
            <Link to="/corrals/$corralId/edit" params={{ corralId }} className="text-xs underline">
              {t('openCorral')}
            </Link>
          ) : null}
          {projection.startedFrom && !compact ? (
            <span className="text-xs text-muted">
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
        <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
          <span>{working.length ? t('working', { labels: working.join(', ') }) : t('idle')}</span>
          {loops.map((text) => (
            <span key={text}>{text}</span>
          ))}
          <span>
            {t('tasks', {
              done: tasks.filter((task) => task.status === 'completed').length,
              total: tasks.length,
            })}
          </span>
          <span>{t('requests', { count: inFlight })}</span>
          {projection.statusReason ? (
            <span>
              {tr('reasonPrefix')} <RunReason code={projection.statusReason} nodeLabel={labelOf} />
            </span>
          ) : null}
        </p>
      </div>
      <div className="max-h-28 w-[24rem] max-w-full overflow-auto">
        <RunActions session={session} compact />
      </div>
    </section>
  );
}

/** The Loop limit in force: the latest committed loop_limit patch, if any (Spec §8.3). */
function loopLimit(projection: RunProjection, loopId: string): number | null {
  const patches = Object.values(projection.patches)
    .filter((p) => p.kind === 'loop_limit' && p.scope.nodeId === loopId)
    .sort((a, b) => a.controlRevision - b.controlRevision);
  const value = patches.at(-1)?.after.maxIterations;
  return typeof value === 'number' ? value : null;
}

/** A design node's executions in this run: one per Loop round, call and attempt (Spec §4.3). */
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
  const label = definition.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const ids = projection.nodeExecutions[nodeId] ?? [];
  return (
    <section
      aria-label={t('nodeExecutions', { label })}
      className="flex flex-col gap-2 rounded-md border border-line p-2 text-xs"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('nodeExecutions', { label })}</h2>
        <button type="button" onClick={onClose} className="rounded border border-line px-1.5">
          {t('closeNode')}
        </button>
      </div>
      {ids.length === 0 ? <p className="text-muted">{t('noNodeExecutions')}</p> : null}
      <ul className="flex flex-col gap-1">
        {ids.map((id) => {
          const e = projection.executions[id];
          if (!e) return null;
          const round = e.iterationId ? projection.iterations[e.iterationId]?.no : null;
          return (
            <li key={id}>
              <button
                type="button"
                aria-pressed={id === selectedExecutionId}
                onClick={() => onChoose(id)}
                className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left ${
                  id === selectedExecutionId ? 'border-accent' : 'border-line'
                }`}
              >
                <span>
                  {round ? `${tr('round', { no: round })} · ` : ''}
                  {e.attemptNo > 1 ? `${tr('attempt', { no: e.attemptNo })} · ` : ''}
                  <span className="font-mono">{id}</span>
                </span>
                <StatusBadge status={e.status} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type RunPageView = 'results' | 'run';
const VIEWS: RunPageView[] = ['results', 'run'];

/** Results or the run itself (CR-009): two tabs in the summary bar, arrow keys move between. */
function ViewSwitch({ view, onView }: { view: RunPageView; onView: (view: RunPageView) => void }) {
  const t = useTranslations('RunPage.view');
  const refs = useRef<Partial<Record<RunPageView, HTMLButtonElement | null>>>({});
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = VIEWS[(index + step + VIEWS.length) % VIEWS.length];
    if (!next) return;
    onView(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t('label')}
      className="flex rounded-md border border-line p-0.5"
    >
      {VIEWS.map((name, index) => (
        <button
          key={name}
          ref={(el) => {
            refs.current[name] = el;
          }}
          type="button"
          role="tab"
          aria-selected={view === name}
          tabIndex={view === name ? 0 : -1}
          onClick={() => onView(name)}
          onKeyDown={(event) => move(event, index)}
          className={`rounded px-2 py-0.5 text-xs ${view === name ? 'bg-accent text-on-accent' : 'text-muted'}`}
        >
          {t(name)}
        </button>
      ))}
    </div>
  );
}

const TABS = ['output', 'tasks', 'questions', 'activity', 'budget'] as const;
type Tab = (typeof TABS)[number];

/** The run's details as tabs (WAI-ARIA tabs). The Output tab opens once the run succeeds. */
type NarrowPanel = 'canvas' | 'tree' | 'side' | 'dock';
const NARROW_PANELS: NarrowPanel[] = ['canvas', 'tree', 'side', 'dock'];

/** The panel switcher of a narrow Run page (roadmap 19); hidden from 768px up. */
function NarrowViews({
  panel,
  onChoose,
}: {
  panel: NarrowPanel;
  onChoose: (panel: NarrowPanel) => void;
}) {
  const t = useTranslations('RunPage.views');
  const refs = useRef<Partial<Record<NarrowPanel, HTMLButtonElement | null>>>({});
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = NARROW_PANELS[(index + step + NARROW_PANELS.length) % NARROW_PANELS.length];
    if (!next) return;
    onChoose(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t('label')}
      className="flex gap-1 overflow-x-auto border-b border-line px-2 py-1 @3xl:hidden"
    >
      {NARROW_PANELS.map((name, index) => (
        <button
          key={name}
          ref={(el) => {
            refs.current[name] = el;
          }}
          type="button"
          role="tab"
          aria-selected={panel === name}
          tabIndex={panel === name ? 0 : -1}
          onClick={() => onChoose(name)}
          onKeyDown={(event) => move(event, index)}
          className={`shrink-0 rounded px-2 py-1 text-xs ${panel === name ? 'bg-accent text-on-accent' : 'border border-line'}`}
        >
          {t(name)}
        </button>
      ))}
    </div>
  );
}

function RunDetails({
  session,
  openArtifact,
  openResult,
}: {
  session: RunSessionStore;
  openArtifact: (id: string) => void;
  openResult: (id: string) => void;
}) {
  const t = useTranslations('RunPage.tabs');
  const prices = useModelPrices();
  const succeeded = useStore(session, (s) => s.projection?.status === 'succeeded');
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab: Tab = chosen ?? (succeeded ? 'output' : 'activity');
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const move = (event: KeyboardEvent, index: number) => {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const id = TABS[next] as Tab;
    setChosen(id);
    refs.current[id]?.focus();
  };
  return (
    <>
      <div
        role="tablist"
        aria-label={t('label')}
        className="flex gap-1 border-b border-line px-2 pt-1"
      >
        {TABS.map((id, index) => (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`run-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`run-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setChosen(id)}
            onKeyDown={(event) => move(event, index)}
            className={`rounded-t px-3 py-1 text-xs ${
              tab === id ? 'border border-b-0 border-line bg-raised font-medium' : 'text-muted'
            }`}
          >
            {t(id)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`run-panel-${tab}`}
        aria-labelledby={`run-tab-${tab}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs: a panel that scrolls text must be reachable by keyboard
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto p-3"
      >
        {tab === 'output' ? (
          <RunOutput session={session} heading={false} onOpenResults={openResult} />
        ) : null}
        {tab === 'tasks' ? <TaskBoard session={session} onOpenArtifact={openArtifact} /> : null}
        {tab === 'questions' ? (
          <QuestionsPanel session={session} onOpenArtifact={openArtifact} />
        ) : null}
        {tab === 'activity' ? (
          <>
            <HarnessDetails session={session} />
            <Timeline session={session} />
          </>
        ) : null}
        {tab === 'budget' ? (
          <div className="flex flex-col gap-3">
            <BudgetInspector session={session} prices={prices} />
            <EffortJudgments session={session} />
          </div>
        ) : null}
      </div>
    </>
  );
}
