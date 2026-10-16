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
  QuestionsPanel,
  ReinsPanel,
  RunActions,
  RunCanvas,
  type RunCanvasLayout,
  RunOutput,
  RunReason,
  RunResults,
  type RunSessionStore,
  runCanvasLayout,
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
import { runRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { markRunReviewed } from './GettingStarted.tsx';

/** /runs/$runId?execution=…&artifact=… — one run: graph, call tree, details and Reins (C-066). */
export function RunPage() {
  const t = useTranslations('RunPage');
  const { runId } = runRoute.useParams();
  const { session } = useServices();
  const activeRunId = useStore(session, (s) => s.runId);
  const missing = useStore(session, (s) => s.missingRunId === runId);
  const error = useStore(session, (s) => s.streamError);
  const definition = useStore(session, (s) => s.definition);

  // A direct link or a reload: follow the run from the runtime's record.
  useEffect(() => {
    void session.getState().open(runId);
  }, [session, runId]);

  // CR-009: whether the run had already ended when the page opened. Decided once, so a run
  // that ends while it is watched never moves the page to its results.
  const { transport } = useServices();
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
  return (
    <RunWorkspace key={runId} session={session} definition={definition} openedEnded={opened} />
  );
}

function RunWorkspace({
  session,
  definition,
  openedEnded,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  /** Whether the run had ended when the page opened; null until known. */
  openedEnded: boolean | null;
}) {
  const t = useTranslations('RunPage');
  const { execution, artifact, view: chosenView, result } = runRoute.useSearch();
  const navigate = useNavigate({ from: '/runs/$runId' });
  const { previewUrl } = useServices();
  const projection = useStore(session, (s) => s.projection);
  // CR-009: a run that had ended when the page opened shows its results first. A chosen
  // view, or something picked in the run view, is kept; results arriving later never move it.
  const view: RunPageView | null =
    chosenView ??
    (execution || artifact ? 'run' : openedEnded === null ? null : openedEnded ? 'results' : 'run');
  const chooseView = (next: RunPageView) =>
    void navigate({ search: (s) => ({ ...s, view: next }) });
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
  const shown = (name: NarrowPanel) => (panel === name ? '' : 'max-md:hidden');

  const chooseExecution = (id: string) => {
    setSelectedNodeId(null);
    setPanel('side');
    void navigate({ search: (s) => ({ ...s, execution: id }) });
  };
  const openArtifact = (id: string) => {
    setPanel('side');
    void navigate({ search: (s) => ({ ...s, artifact: id }) });
  };
  const unknownExecution =
    execution && projection && !projection.executions[execution] ? execution : null;
  const highlightedNode =
    selectedNodeId ?? (execution ? (projection?.executions[execution]?.nodeId ?? null) : null);

  if (view === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <RunSummary session={session} definition={definition} view="run" onView={chooseView} />
      </div>
    );
  }

  if (view === 'results') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <RunSummary session={session} definition={definition} view={view} onView={chooseView} />
        <main className="min-h-0 flex-1">
          <RunResults
            session={session}
            selectedId={result ?? null}
            onSelect={(id) =>
              void navigate({ search: (s) => ({ ...s, view: 'results', result: id }) })
            }
            {...(previewUrl ? { previewUrl } : {})}
            {...(startFrom ? { onStartFrom: startFrom } : {})}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RunSummary session={session} definition={definition} view={view} onView={chooseView} />
      <NarrowViews panel={panel} onChoose={setPanel} />
      <main className="run-layout min-h-0 flex-1">
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
              onClose={() => void navigate({ search: (s) => ({ ...s, artifact: undefined }) })}
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
            openResult={(id) =>
              void navigate({ search: (s) => ({ ...s, view: 'results', result: id }) })
            }
          />
        </div>
      </main>
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
  view,
  onView,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  view: RunPageView;
  onView: (view: RunPageView) => void;
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
          <ViewSwitch view={view} onView={onView} />
          <h2 className="text-base font-semibold">{definition.name}</h2>
          <span className="font-mono text-xs text-muted">{projection.runId}</span>
          <span aria-live="polite" data-testid="run-status">
            <StatusBadge status={projection.status} />
          </span>
          {corralId ? (
            <Link to="/corrals/$corralId/edit" params={{ corralId }} className="text-xs underline">
              {t('openCorral')}
            </Link>
          ) : null}
          {projection.startedFrom ? (
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
      className="flex gap-1 overflow-x-auto border-b border-line px-2 py-1 md:hidden"
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
        {tab === 'activity' ? <Timeline session={session} /> : null}
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
