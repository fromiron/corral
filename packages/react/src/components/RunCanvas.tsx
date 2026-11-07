import { type CorralDefinition, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import {
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
  type FitViewOptions,
  getSmoothStepPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { AgentGraphNode, type AgentMark, type AgentStatus } from '../design-kit/index.ts';
import {
  buildRunAgentGraph,
  type RunAgentGraph,
  type RunAgentGraphRelation,
} from '../run/agent-graph.ts';
import { type AgentGraphPosition, layoutRunAgents } from '../run/agent-graph-layout.ts';
import { type ObservedAgentModel, observedAgentModels } from '../run/agent-models.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { NodeRunStatus } from '../run/selectors.ts';
import type { RunSessionStore } from '../run/session.ts';

type AgentData = {
  name: string;
  model?: string;
  logo?: AgentMark;
  status: AgentStatus;
  rawStatus: NodeRunStatus;
  statusLabel: string;
  detail: string;
  label: string;
  description: string;
  lead: boolean;
  dimmed: boolean;
};

const sides = [Position.Left, Position.Right, Position.Top, Position.Bottom];
function RelationshipNode({ data, selected }: NodeProps<Node<AgentData>>) {
  return (
    <div data-run-status={data.rawStatus}>
      {sides.flatMap((side) =>
        ['source', 'target'].map((type) => (
          <Handle
            key={`${side}-${type}`}
            id={`${side}-${type}`}
            type={type as 'source' | 'target'}
            position={side}
            isConnectable={false}
            style={{
              opacity: 0,
              pointerEvents: 'none',
              left: side === Position.Left ? 52 : side === Position.Right ? 108 : 80,
              top: side === Position.Top ? 0 : side === Position.Bottom ? 56 : 28,
            }}
          />
        )),
      )}
      <AgentGraphNode {...data} selected={selected} />
    </div>
  );
}

const relationColors: Record<RunAgentGraphRelation['kind'], string> = {
  delegate: 'var(--emphasis)',
  question: 'var(--warning)',
  answer: 'var(--success)',
  read: 'var(--success)',
  input: 'var(--success)',
};

function RelationshipEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  const self = props.source === props.target;
  let [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 14,
    offset: 92,
  });
  if (self) {
    path = `M${sourceX} ${sourceY} C${sourceX + 95} ${sourceY}, ${targetX + 95} ${targetY - 85}, ${targetX} ${targetY}`;
    labelX = sourceX + 65;
    labelY = targetY - 35;
  } else if (props.data?.opposite) {
    // Separate a reply/return path from its request instead of painting over its direction.
    const dx = targetX - sourceX,
      dy = targetY - sourceY;
    const length = Math.hypot(dx, dy) || 1;
    const verticalPorts = sourcePosition === targetPosition;
    const x = verticalPorts
        ? sourcePosition === Position.Right
          ? 105
          : -105
        : (-dy / length) * 105,
      y = verticalPorts ? 0 : (dx / length) * 105;
    path = `M${sourceX} ${sourceY} C${sourceX + dx / 3 + x} ${sourceY + dy / 3 + y}, ${sourceX + (dx * 2) / 3 + x} ${sourceY + (dy * 2) / 3 + y}, ${targetX} ${targetY}`;
    labelX = (sourceX + targetX) / 2 + x * 0.75;
    labelY = (sourceY + targetY) / 2 + y * 0.75;
  }
  return (
    <BaseEdge
      path={path}
      markerEnd={props.markerEnd}
      style={props.style}
      label={props.label}
      labelX={labelX}
      labelY={labelY}
    />
  );
}
const nodeTypes = { agent: RelationshipNode };
const edgeTypes = { observed: RelationshipEdge };
// Room for paths routed outside node labels, at both initial fit and the explicit Fit control.
const graphFit = { padding: '48px', maxZoom: 1 } satisfies FitViewOptions;

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
interface GraphSnapshot {
  graph: RunAgentGraph;
  models: Record<string, ObservedAgentModel[]>;
  ended: boolean;
}

/** An observed relationship graph. Authoring nodes, ports and saved layout never enter this view. */
export function RunCanvas({
  session,
  definition,
  selectedNodeId,
  onSelectNode,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}) {
  const t = useTranslations('RunCanvas');
  const statusText = useTranslations('Canvas.nodeStatus');
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
  const viewport = useRef<HTMLDivElement>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const hasNodes = graph.nodes.length > 0;
  useLayoutEffect(() => {
    const element = viewport.current;
    if (canvasReady || readingInitialHistory || !hasNodes || !element) return;
    const measure = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) setCanvasReady(true);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasReady, hasNodes, readingInitialHistory]);
  const adjacent = useMemo(() => {
    const set = new Set([selectedNodeId]);
    for (const relation of graph.relations)
      if (relation.source === selectedNodeId || relation.target === selectedNodeId) {
        set.add(relation.source);
        set.add(relation.target);
      }
    return set;
  }, [graph.relations, selectedNodeId]);
  const descriptions = useMemo(
    () =>
      graph.relations.map((relation) => ({
        source: relation.source,
        target: relation.target,
        label: t('relationship', {
          source: graph.nodes.find((node) => node.id === relation.source)?.label ?? relation.source,
          target: graph.nodes.find((node) => node.id === relation.target)?.label ?? relation.target,
          relations: t('relationCount', {
            kind: t(`relation.${relation.kind}`),
            count: relation.count,
          }),
        }),
      })),
    [graph, t],
  );
  const nodes = useMemo<Node<AgentData>[]>(
    () =>
      graph.nodes.map((node) => {
        const position = positions.get(node.id) ?? { x: 0, y: 0 };
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
        const unsettled =
          ended && !['done', 'failed', 'cancelled', 'idle'].includes(summary.status);
        const label = !node.executionIds.length
          ? t('requested')
          : unsettled
            ? t('unsettled')
            : statusText(summary.status);
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
        return {
          id: node.id,
          type: 'agent',
          position: { x: position.x - 80, y: position.y - 28 },
          selected: selectedNodeId === node.id,
          draggable: false,
          connectable: false,
          deletable: false,
          focusable: false,
          data: {
            name: node.label,
            ...(model ? { model } : {}),
            ...(logo ? { logo } : {}),
            rawStatus: summary.status,
            status: unsettled ? 'stopped' : kitStatus(summary.status),
            statusLabel: label,
            detail: details,
            label: [node.label, model, label, details].filter(Boolean).join(' · '),
            description: descriptions
              .filter((relation) => relation.source === node.id || relation.target === node.id)
              .map((relation) => relation.label)
              .join('; '),
            lead: node.lead,
            dimmed: !!selectedNodeId && !adjacent.has(node.id),
          },
        };
      }),
    [graph.nodes, positions, models, ended, selectedNodeId, adjacent, descriptions, t, statusText],
  );
  const edges = useMemo<Edge[]>(() => {
    const groups = new Map<string, RunAgentGraphRelation[]>();
    for (const relation of graph.relations) {
      const key = JSON.stringify([relation.source, relation.target]);
      groups.set(key, [...(groups.get(key) ?? []), relation]);
    }
    return [...groups].map(([id, relations]) => {
      const first = relations[0]!;
      const from = positions.get(first.source) ?? { x: 0, y: 0 };
      const to = positions.get(first.target) ?? { x: 0, y: 0 };
      const self = first.source === first.target;
      const horizontal = Math.abs(to.x - from.x) > Math.abs(to.y - from.y);
      const source = self
        ? Position.Right
        : horizontal
          ? to.x > from.x
            ? Position.Right
            : Position.Left
          : first.source < first.target
            ? Position.Right
            : Position.Left;
      const target = self
        ? Position.Top
        : !horizontal
          ? source
          : source === Position.Right
            ? Position.Left
            : source === Position.Left
              ? Position.Right
              : source === Position.Top
                ? Position.Bottom
                : Position.Top;
      const selected = selectedNodeId === first.source || selectedNodeId === first.target;
      const active = relations.some((relation) => relation.activeCount > 0);
      const dominant = relations.find((relation) => relation.activeCount > 0) ?? first;
      const color = relationColors[dominant.kind];
      const description = relations
        .map((relation) =>
          t('relationCount', { kind: t(`relation.${relation.kind}`), count: relation.count }),
        )
        .join(' · ');
      const sourceName =
        graph.nodes.find((node) => node.id === first.source)?.label ?? first.source;
      const targetName =
        graph.nodes.find((node) => node.id === first.target)?.label ?? first.target;
      return {
        id,
        source: first.source,
        target: first.target,
        type: 'observed',
        data: { opposite: !self && groups.has(JSON.stringify([first.target, first.source])) },
        sourceHandle: `${source}-source`,
        targetHandle: `${target}-target`,
        ariaLabel: t('relationship', {
          source: sourceName,
          target: targetName,
          relations: description,
        }),
        label: selected ? description : undefined,
        className: active ? 'flow-dash' : undefined,
        style: {
          stroke: color,
          strokeWidth: 1.5,
          opacity: selectedNodeId && !selected ? 0.15 : active || selected ? 1 : 0.55,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
        selectable: false,
        deletable: false,
      };
    });
  }, [graph, positions, selectedNodeId, t]);
  const kinds = [...new Set(graph.relations.map((relation) => relation.kind))];
  return (
    <ReactFlowProvider>
      <div
        className="flex h-full w-full flex-col bg-surface-2"
        role="application"
        aria-label={t('label')}
      >
        <div ref={viewport} className="relative min-h-0 flex-1">
          {canvasReady ? (
            <ReactFlow
              className="corral-flow corral-run-graph"
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              deleteKeyCode={null}
              onNodeClick={(_event, node) => onSelectNode(node.id)}
              onPaneClick={() => onSelectNode(null)}
              elevateNodesOnSelect={false}
              fitView
              fitViewOptions={graphFit}
              minZoom={0.2}
              colorMode="system"
            >
              <Controls showInteractive={false} fitViewOptions={graphFit} />
            </ReactFlow>
          ) : null}
          {readingInitialHistory || !nodes.length ? (
            <p className="pointer-events-none absolute inset-0 grid place-items-center text-caption text-muted-foreground">
              {t(readingInitialHistory ? 'loading' : 'empty')}
            </p>
          ) : null}
        </div>
        {kinds.length ? (
          <ul
            aria-label={t('relationsLegend')}
            className="flex shrink-0 flex-wrap justify-center gap-x-4 gap-y-1 px-4 py-2 text-caption text-muted-foreground"
          >
            {kinds.map((kind) => (
              <li key={kind} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-px w-4"
                  style={{ backgroundColor: relationColors[kind] }}
                />
                {t(`relation.${kind}`)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </ReactFlowProvider>
  );
}
