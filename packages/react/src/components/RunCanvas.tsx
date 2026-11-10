import { type CorralDefinition, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { motion, useReducedMotion } from 'motion/react';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  AgentCard,
  AgentGraphNode,
  type AgentMark,
  type AgentStatus,
  Button,
  Popover,
  PopoverClose,
  PopoverCreateHandle,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from '../design-kit/index.ts';
import { useShape } from '../design-kit/lib/shape-context.tsx';
import { spring } from '../design-kit/lib/springs.ts';
import { cn } from '../design-kit/lib/utils.ts';
import {
  buildRunAgentGraph,
  type RunAgentGraph,
  type RunAgentGraphNode,
  type RunAgentGraphRelation,
} from '../run/agent-graph.ts';
import {
  type AgentGraphPosition,
  labelRect,
  layoutRunAgents,
  markRect,
  TILE,
} from '../run/agent-graph-layout.ts';
import { type AgentGraphRoute, openMidpoint, routeRelation } from '../run/agent-graph-routes.ts';
import { type ObservedAgentModel, observedAgentModels } from '../run/agent-models.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { NodeRunStatus } from '../run/selectors.ts';
import type { RunSessionStore } from '../run/session.ts';
import { ArrowRight, X } from '../ui/icons.ts';
import { type Bounds, type FitRule, useGraphViewport, ZoomControls } from './GraphViewport.tsx';
import { type AgentPresentation, RunAgentList } from './RunAgentList.tsx';

/**
 * The kit legend's Call, Answer (data), Needs you and Failed colours for work in progress;
 * a finished relation keeps flowing slowly in grey so its direction stays readable.
 */
type RelationState = 'call' | 'data' | 'ask' | 'failed' | 'settled';
const stateColors: Record<RelationState, string> = {
  call: 'var(--emphasis)',
  data: 'var(--success)',
  ask: 'var(--warning)',
  failed: 'var(--destructive)',
  settled: 'var(--muted-foreground)',
};
const relationStates: RelationState[] = ['call', 'data', 'ask', 'failed', 'settled'];

/**
 * A fit frames the agents with a margin and may enlarge a small run, so four agents read large
 * while twenty still fit (down to the stage's smallest zoom).
 */
export const RUN_GRAPH_FIT: FitRule = { padding: 40, maxZoom: 1.5 };
/** Room above a mark for its breathing halo and selected scale. */
const HALO = 8;

function kitStatus(status: NodeRunStatus): AgentStatus {
  if (['active', 'model', 'tool', 'finalizing'].includes(status)) return 'running';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (['cancelled', 'paused', 'pausing', 'cancelling'].includes(status)) return 'stopped';
  if (status === 'waiting_approval') return 'waiting';
  return 'queued';
}

function providerMark(provider: string | null | undefined): AgentMark | undefined {
  if (!provider) return undefined;
  if (provider.startsWith('anthropic')) return 'claude';
  if (provider.startsWith('openai')) return 'openai';
  if (provider.startsWith('google') || provider.startsWith('gemini')) return 'gemini';
  if (provider.startsWith('mistral')) return 'mistral';
  return undefined;
}

/** Work in progress wins (question, call, data), then a failure, then finished. */
function relationState(relations: RunAgentGraphRelation[]): RelationState {
  const active = relations.filter((relation) => relation.activeCount > 0);
  if (active.some((relation) => relation.kind === 'question')) return 'ask';
  if (active.some((relation) => relation.kind === 'delegate')) return 'call';
  if (active.length) return 'data';
  if (relations.some((relation) => relation.failedCount > 0)) return 'failed';
  return 'settled';
}

function graphBounds(positions: Iterable<AgentGraphPosition>): Bounds | null {
  const points = [...positions];
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map((p) => p.x)) - TILE.halfWidth,
    maxX: Math.max(...points.map((p) => p.x)) + TILE.halfWidth,
    minY: Math.min(...points.map((p) => p.y)) - TILE.markHalf - HALO,
    maxY: Math.max(...points.map((p) => p.y)) + TILE.labelBottom,
  };
}

interface GraphSnapshot {
  graph: RunAgentGraph;
  models: Record<string, ObservedAgentModel[]>;
  ended: boolean;
}

interface Edge {
  id: string;
  source: string;
  target: string;
  route: AgentGraphRoute;
  state: RelationState;
  description: string;
  label: string;
}

/** An observed relationship graph. Authoring nodes, ports and saved layout never enter this view. */
export function RunCanvas({
  session,
  definition,
  display = 'map',
  selectedNodeId,
  onSelectNode,
  renderNodePreview,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  /**
   * The relationship map, or the same agents as a list. The map stays mounted while the list
   * is shown, so its position and zoom survive the switch.
   */
  display?: 'map' | 'list';
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null, trigger?: HTMLElement | null) => void;
  renderNodePreview?: (
    nodeId: string,
    context: { close: () => void; trigger: HTMLElement | null },
  ) => ReactNode;
}) {
  const t = useTranslations('RunCanvas');
  const statusText = useTranslations('Canvas.nodeStatus');
  const reduce = useReducedMotion() ?? false;
  const shape = useShape();
  const hasPreview = renderNodePreview !== undefined;
  const previewId = useId();
  const [previewHandle] = useState(() => PopoverCreateHandle<string>());
  const previewTrigger = useRef<HTMLElement | null>(null);
  const [restorePreviewFocus, setRestorePreviewFocus] = useState(true);
  const closePreviewForNavigation = () => {
    setRestorePreviewFocus(false);
    previewHandle.close();
  };
  const readGraph = useMemo(() => {
    let previous: RunProjection | null | undefined;
    let serialized = '';
    return ({ projection }: { projection: RunProjection | null }) => {
      if (projection === previous && serialized) return serialized;
      previous = projection;
      const graph = buildRunAgentGraph(projection, definition);
      const models = Object.fromEntries(
        graph.nodes.map((node) => [node.id, observedAgentModels(projection, node.executionIds)]),
      );
      serialized = JSON.stringify({
        graph,
        models,
        ended: !!projection && TERMINAL_RUN_STATUSES.has(projection.status),
      });
      return serialized;
    };
  }, [definition]);
  const signature = useRunDisplay(session, readGraph);
  const { graph, models, ended } = useMemo(
    () => JSON.parse(signature) as GraphSnapshot,
    [signature],
  );
  const readingInitialHistory = useStore(session, (state) => state.initialLoadSeq !== undefined);
  const placed = useRef(new Map<string, AgentGraphPosition>());
  const positions = useMemo(() => {
    if (readingInitialHistory) return placed.current;
    placed.current = layoutRunAgents(graph, placed.current);
    return placed.current;
  }, [graph, readingInitialHistory]);
  const hasNodes = graph.nodes.length > 0;
  const { pane, viewport, fit, zoomAt, paneHandlers } = useGraphViewport({
    bounds: () => graphBounds(placed.current.values()),
    ready: hasNodes && !readingInitialHistory,
    fitRule: RUN_GRAPH_FIT,
    // Fit on first display and on request only; new agents and a panel opening keep the view.
    fitOnce: true,
    onMove: () => previewHandle.close(),
    // A press on the empty stage that did not pan dismisses the quick view.
    onTap: () => previewHandle.close(),
  });

  // A quick view belongs to the display it opened from; switching displays closes it.
  const shownDisplay = useRef(display);
  useEffect(() => {
    if (shownDisplay.current === display) return;
    shownDisplay.current = display;
    // Focus stays on the control that switched; the closed view's trigger may be gone.
    setRestorePreviewFocus(false);
    previewHandle.close();
  }, [display, previewHandle]);

  const adjacent = useMemo(() => {
    const set = new Set([selectedNodeId]);
    for (const relation of graph.relations)
      if (relation.source === selectedNodeId || relation.target === selectedNodeId) {
        set.add(relation.source);
        set.add(relation.target);
      }
    return set;
  }, [graph.relations, selectedNodeId]);
  const nameOf = useCallback(
    (id: string) => graph.nodes.find((node) => node.id === id)?.label ?? id,
    [graph.nodes],
  );
  const edges = useMemo<Edge[]>(() => {
    const groups = new Map<string, RunAgentGraphRelation[]>();
    for (const relation of graph.relations) {
      const key = JSON.stringify([relation.source, relation.target]);
      groups.set(key, [...(groups.get(key) ?? []), relation]);
    }
    const leads = new Set(graph.nodes.filter((node) => node.lead).map((node) => node.id));
    // A direction mark sits on a stretch of its line that no mark or label covers.
    const covered = [...positions.values()].flatMap((at) => [markRect(at), labelRect(at)]);
    return [...groups].map(([id, relations]) => {
      const first = relations[0] as RunAgentGraphRelation;
      const description = relations
        .map((relation) =>
          t('relationCount', { kind: t(`relation.${relation.kind}`), count: relation.count }),
        )
        .join(' · ');
      const route = routeRelation({
        source: first.source,
        target: first.target,
        from: positions.get(first.source) ?? { x: 0, y: 0 },
        to: positions.get(first.target) ?? { x: 0, y: 0 },
        leads,
        opposite: groups.has(JSON.stringify([first.target, first.source])),
      });
      const mark = openMidpoint(route, covered);
      return {
        id,
        source: first.source,
        target: first.target,
        route: { ...route, label: mark.point, angle: mark.angle },
        state: relationState(relations),
        description,
        label: t('relationship', {
          source: nameOf(first.source),
          target: nameOf(first.target),
          relations: description,
        }),
      };
    });
  }, [graph, positions, nameOf, t]);

  // One reading of each agent for both displays: the map's node and the list's row.
  const present = useCallback(
    (node: RunAgentGraphNode): AgentPresentation & { logo?: AgentMark } => {
      const recordedModels = models[node.id] ?? [];
      const model =
        recordedModels.length > 1
          ? t(recordedModels.every((model) => model.identified) ? 'models' : 'profiles', {
              count: recordedModels.length,
            })
          : recordedModels[0]?.name;
      const provider = recordedModels.length === 1 ? recordedModels[0]?.provider : null;
      const logo = providerMark(provider);
      const summary = node.summary;
      const unsettled = ended && !['done', 'failed', 'cancelled', 'idle'].includes(summary.status);
      return {
        ...(model ? { model } : {}),
        ...(logo ? { logo } : {}),
        status: unsettled ? 'stopped' : kitStatus(summary.status),
        statusLabel: !node.executionIds.length
          ? t('requested')
          : unsettled
            ? t('unsettled')
            : statusText(summary.status),
      };
    },
    [models, ended, t, statusText],
  );
  const triggerFor = useCallback(
    (nodeId: string, button: ReactElement) => (
      <PopoverTrigger
        id={`${previewId}-${nodeId}`}
        handle={previewHandle}
        payload={nodeId}
        render={button}
      />
    ),
    [previewId, previewHandle],
  );

  const nodeLayer = useMemo(
    () =>
      graph.nodes.map((node, index) => {
        const position = positions.get(node.id) ?? { x: 0, y: 0 };
        const { model, logo, status, statusLabel: label } = present(node);
        const summary = node.summary;
        const details = [
          ...(node.executionIds.length > 1
            ? [statusText('executions', { count: node.executionIds.length })]
            : []),
          ...(Object.keys(summary.counts).length > 1
            ? Object.entries(summary.counts).map(([state, count]) =>
                statusText('stateCount', { status: statusText(state), count: count ?? 0 }),
              )
            : []),
          ...(summary.previousFailures
            ? [statusText('previousFailures', { count: summary.previousFailures })]
            : []),
        ].join(' · ');
        return (
          <div
            key={node.id}
            data-agent-id={node.id}
            className="absolute top-0 left-0 size-0"
            style={{
              transform: `translate(${position.x}px, ${position.y}px)`,
              zIndex: node.lead ? 2 : 1,
            }}
          >
            <motion.div
              data-run-status={summary.status}
              className="absolute"
              style={{ left: -TILE.halfWidth, top: -TILE.markHalf }}
              initial={reduce ? false : { opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ ...spring.moderate, delay: reduce ? 0 : Math.min(index, 8) * 0.07 }}
            >
              <AgentGraphNode
                name={node.label}
                {...(model ? { model } : {})}
                {...(logo ? { logo } : {})}
                status={status}
                statusLabel={label}
                detail={details}
                label={[node.label, model, label, details].filter(Boolean).join(' · ')}
                description={edges
                  .filter((edge) => edge.source === node.id || edge.target === node.id)
                  .map((edge) => edge.label)
                  .join('; ')}
                lead={node.lead}
                selected={selectedNodeId === node.id}
                dimmed={!!selectedNodeId && !adjacent.has(node.id)}
                onClick={(event) => onSelectNode(node.id, event.currentTarget)}
                renderTrigger={hasPreview ? (button) => triggerFor(node.id, button) : undefined}
              />
            </motion.div>
          </div>
        );
      }),
    [
      graph.nodes,
      positions,
      present,
      edges,
      selectedNodeId,
      adjacent,
      onSelectNode,
      statusText,
      triggerFor,
      hasPreview,
      reduce,
    ],
  );
  const edgeLayer = useMemo(
    () => (
      <svg
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        width={1}
        height={1}
        aria-hidden
      >
        {edges.map((edge, index) => {
          const flowing = edge.state !== 'failed';
          const settled = edge.state === 'settled';
          const touched = edge.source === selectedNodeId || edge.target === selectedNodeId;
          const opacity = selectedNodeId && !touched ? 0.1 : 1;
          const color = stateColors[edge.state];
          const { label, angle } = edge.route;
          // Flowing dashes run from sender to receiver (CSS `.flow-dash`, stopped under
          // reduced motion, when the direction mark appears instead); a failure draws in once.
          return (
            <g key={edge.id}>
              <motion.path
                data-relation
                data-source={edge.source}
                data-target={edge.target}
                data-relation-state={edge.state}
                d={edge.route.d}
                fill="none"
                stroke={color}
                strokeOpacity={settled ? 0.8 : 1}
                strokeWidth={1.5}
                strokeLinecap="round"
                className={flowing ? cn('flow-dash', settled && 'flow-dash-slow') : undefined}
                initial={reduce ? false : flowing ? { opacity: 0 } : { pathLength: 0 }}
                animate={flowing ? { opacity } : { pathLength: 1, opacity }}
                transition={{ ...spring.slow, delay: reduce ? 0 : Math.min(index, 12) * 0.06 }}
              />
              <path
                data-direction-marker
                className="run-graph-direction"
                d="M-3 -3.5L1.5 0L-3 3.5"
                transform={`translate(${label.x} ${label.y}) rotate(${angle})`}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity }}
              />
            </g>
          );
        })}
      </svg>
    ),
    [edges, selectedNodeId, reduce],
  );
  const selectedRelations = selectedNodeId
    ? edges.filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
    : [];
  const shownStates = relationStates.filter((state) => edges.some((edge) => edge.state === state));
  return (
    // The source AgentGraph names its stage as a group; a fieldset would imply form controls.
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of agent buttons, not a form.
    <div className="flex h-full w-full flex-col p-3" role="group" aria-label={t('label')}>
      {display === 'list' ? (
        <AgentCard className="min-h-0 flex-1 overflow-auto p-2">
          {readingInitialHistory || !hasNodes ? (
            <p className="grid h-full place-items-center text-caption text-muted-foreground">
              {t(readingInitialHistory ? 'loading' : 'empty')}
            </p>
          ) : (
            <RunAgentList
              session={session}
              nodes={graph.nodes}
              present={present}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              {...(hasPreview ? { trigger: triggerFor } : {})}
            />
          )}
        </AgentCard>
      ) : null}
      <AgentCard className="flex min-h-0 flex-1 flex-col" hidden={display === 'list'}>
        <div
          ref={pane}
          data-graph-pane
          className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
          {...paneHandlers}
        >
          {viewport && !readingInitialHistory ? (
            <div
              data-graph-stage
              className="absolute top-0 left-0 origin-top-left"
              style={{
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
              }}
            >
              {edgeLayer}
              {nodeLayer}
            </div>
          ) : null}
          {selectedRelations.length ? (
            <ul className="pointer-events-none absolute top-3 left-3 grid justify-items-start gap-1">
              {selectedRelations.map((edge) => (
                <li
                  key={edge.id}
                  data-relation-label
                  aria-hidden
                  className={cn(
                    shape.chip,
                    'inline-flex items-center gap-1 whitespace-nowrap bg-muted px-1.5 text-caption text-muted-foreground',
                  )}
                >
                  <span className="text-foreground">{nameOf(edge.source)}</span>
                  <ArrowRight data-direction size={12} />
                  <span className="text-foreground">{nameOf(edge.target)}</span>
                  <span>{edge.description}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {readingInitialHistory || !hasNodes ? (
            <p className="pointer-events-none absolute inset-0 grid place-items-center text-caption text-muted-foreground">
              {t(readingInitialHistory ? 'loading' : 'empty')}
            </p>
          ) : null}
          {viewport && hasNodes ? (
            <ZoomControls
              labels={{ zoomIn: t('zoomIn'), zoomOut: t('zoomOut'), fit: t('fit') }}
              onZoom={(factor) => zoomAt(factor)}
              onFit={() => {
                previewHandle.close();
                fit();
              }}
            />
          ) : null}
        </div>
        {shownStates.length ? (
          <ul
            aria-label={t('relationsLegend')}
            className="flex shrink-0 flex-wrap justify-center gap-x-3.5 gap-y-1 px-2.5 py-2 text-caption text-muted-foreground"
          >
            {shownStates.map((state) => (
              <li key={state} className="inline-flex items-center gap-1.5">
                <svg width="20" height="8" aria-hidden>
                  <path
                    d="M2 4H18"
                    stroke={stateColors[state]}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                </svg>
                {t(`state.${state}`)}
              </li>
            ))}
          </ul>
        ) : null}
      </AgentCard>
      <ul className="sr-only">
        {edges.map((edge) => (
          <li key={edge.id} data-source={edge.source} data-target={edge.target}>
            {edge.label}
          </li>
        ))}
      </ul>
      {renderNodePreview ? (
        <Popover
          handle={previewHandle}
          onOpenChange={(open, details) => {
            if (open) {
              previewTrigger.current =
                details.trigger instanceof HTMLElement ? details.trigger : null;
              setRestorePreviewFocus(true);
            }
          }}
        >
          {({ payload }) => {
            const node = graph.nodes.find((item) => item.id === payload);
            return node ? (
              <PopoverPopup
                width="md"
                side="right"
                align="start"
                padding="compact"
                finalFocus={restorePreviewFocus}
              >
                <div className="flex items-center justify-between gap-3 px-2 pb-2">
                  <PopoverTitle className="min-w-0 truncate">{node.label}</PopoverTitle>
                  <PopoverClose
                    render={<Button variant="ghost" size="icon-compact" />}
                    aria-label={t('closePreview')}
                  >
                    <X />
                  </PopoverClose>
                </div>
                {renderNodePreview(node.id, {
                  close: closePreviewForNavigation,
                  trigger: previewTrigger.current,
                })}
              </PopoverPopup>
            ) : null;
          }}
        </Popover>
      ) : null}
    </div>
  );
}
