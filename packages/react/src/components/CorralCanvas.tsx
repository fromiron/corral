import type { CapabilityLink, SourcePort, TargetPort } from '@corral/contracts';
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  MarkerType,
  type Node,
  type NodeChange,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react';
import { type DragEvent, useCallback, useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import {
  checkConnection,
  connectCapability,
  type EditorDraft,
  type EditorNodeType,
  findNode,
} from '../editor/model.ts';
import { type CanvasNodeData, FLOW_TYPES, nodeTypes } from './NodeViews.tsx';

export const NODE_DRAG_TYPE = 'application/x-corral-node';
const NODE_KINDS: EditorNodeType[] = ['agent', 'decision', 'loop', 'output'];
const CALL_KINDS = new Set(['delegate', 'question']);
const LINK_PREFIX = 'link:';

/** The Loop whose area contains the point, if any. */
function loopAt(draft: EditorDraft, point: { x: number; y: number }): string | null {
  for (const node of draft.definition.nodes) {
    const box = draft.layout[node.id];
    if (node.type !== 'loop' || !box?.width || !box.height) continue;
    if (
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height
    ) {
      return node.id;
    }
  }
  return null;
}

function asRequest(connection: {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}) {
  return {
    source: connection.source,
    sourcePort: (connection.sourceHandle ?? 'out') as SourcePort,
    target: connection.target,
    targetPort: (connection.targetHandle ?? 'in') as TargetPort,
  };
}

export function CorralCanvas() {
  const t = useTranslations('Canvas');
  const { editor } = useStudioStores();
  const draft = useStore(editor, (s) => s.draft);
  const selectedNodeId = useStore(editor, (s) => s.selectedNodeId);
  const { screenToFlowPosition } = useReactFlow();
  const { definition, layout } = draft;

  const nodes = useMemo<Node<CanvasNodeData>[]>(
    () =>
      definition.nodes.map((node) => {
        const box = layout[node.id] ?? { x: 0, y: 0 };
        return {
          id: node.id,
          type: FLOW_TYPES[node.type],
          position: { x: box.x, y: box.y },
          data: {},
          selected: node.id === selectedNodeId,
          ariaLabel: `${node.type}: ${node.label}`,
          // Loop areas sit behind their members so members stay clickable.
          zIndex: node.type === 'loop' ? 0 : 1,
          ...(node.type === 'loop' ? { width: box.width ?? 460, height: box.height ?? 260 } : {}),
        };
      }),
    [definition.nodes, layout, selectedNodeId],
  );

  const edges = useMemo<Edge[]>(() => {
    // Port names are printed at each handle, so control edges carry no labels of their own.
    const control = definition.controlEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourcePort,
      target: edge.target,
      targetHandle: edge.targetPort,
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
    const links = definition.capabilityLinks.map((link) => ({
      id: `${LINK_PREFIX}${link.id}`,
      source: link.sourceNodeId,
      sourceHandle: link.kind,
      target: link.targetNodeId,
      targetHandle: 'callable',
      label: t(`linkLabel.${link.kind}`),
      className: 'corral-call-link',
      style: { strokeDasharray: '6 4' },
      markerEnd: { type: MarkerType.Arrow },
    }));
    return [...control, ...links];
  }, [definition.controlEdges, definition.capabilityLinks, t]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CanvasNodeData>>[]) => {
      const state = editor.getState();
      const movingLoops = new Set<string>();
      for (const change of changes) {
        if (change.type === 'position' && findNode(state.draft, change.id)?.type === 'loop') {
          movingLoops.add(change.id);
        }
      }
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          const node = findNode(editor.getState().draft, change.id);
          // A moving Loop carries its members; ignore their own position changes in that case.
          if (node && 'loopId' in node && node.loopId && movingLoops.has(node.loopId)) continue;
          state.moveNode(change.id, change.position);
        }
        if (change.type === 'select' && change.selected) state.select(change.id);
        if (change.type === 'remove') state.removeNode(change.id);
      }
    },
    [editor],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type !== 'remove') continue;
        if (change.id.startsWith(LINK_PREFIX))
          editor.getState().removeLink(change.id.slice(LINK_PREFIX.length));
        else editor.getState().removeEdge(change.id);
      }
    },
    [editor],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const draft = editor.getState().draft;
      if (connection.sourceHandle && CALL_KINDS.has(connection.sourceHandle)) {
        if (connection.targetHandle !== 'callable') return false;
        const kind = connection.sourceHandle as CapabilityLink['kind'];
        return connectCapability(draft, connection.source, connection.target, kind).ok;
      }
      return checkConnection(draft, asRequest(connection)).ok;
    },
    [editor],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const state = editor.getState();
      if (connection.sourceHandle && CALL_KINDS.has(connection.sourceHandle)) {
        state.connectCapability(
          connection.source,
          connection.target,
          connection.sourceHandle as CapabilityLink['kind'],
        );
      } else {
        state.connect(asRequest(connection));
      }
    },
    [editor],
  );

  // A refused drop explains itself instead of silently doing nothing (Spec §4.2).
  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid !== false || !state.fromNode || !state.toNode || !state.fromHandle) return;
      const from = {
        node: state.fromNode.id,
        handle: state.fromHandle.id ?? null,
        type: state.fromHandle.type,
      };
      const to = { node: state.toNode.id, handle: state.toHandle?.id ?? null };
      // Users may start the drag from either end; normalize to source → target.
      const [source, target] = from.type === 'source' ? [from, to] : [to, from];
      const store = editor.getState();
      if (source.handle && CALL_KINDS.has(source.handle)) {
        const result = connectCapability(
          store.draft,
          source.node,
          target.node,
          source.handle as CapabilityLink['kind'],
        );
        if (!result.ok)
          store.connectCapability(
            source.node,
            target.node,
            source.handle as CapabilityLink['kind'],
          );
        return;
      }
      store.explainRejectedConnection(
        asRequest({
          source: source.node,
          sourceHandle: source.handle,
          target: target.node,
          targetHandle: target.handle,
        }),
      );
    },
    [editor],
  );

  const onNodeDragStart = useCallback(() => editor.getState().beginBatch(), [editor]);
  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      const state = editor.getState();
      const current = findNode(state.draft, node.id);
      if (
        current &&
        (current.type === 'agent' || current.type === 'decision') &&
        !(current.type === 'agent' && current.invocation === 'callable')
      ) {
        const width = node.measured?.width ?? 160;
        const height = node.measured?.height ?? 60;
        const center = { x: node.position.x + width / 2, y: node.position.y + height / 2 };
        const inside = loopAt(state.draft, center);
        if (inside !== (current.loopId ?? null)) state.setLoopMembership(node.id, inside);
      }
      state.endBatch();
    },
    [editor],
  );

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);
  const onDrop = useCallback(
    (event: DragEvent) => {
      const kind = event.dataTransfer.getData(NODE_DRAG_TYPE) as EditorNodeType;
      if (!NODE_KINDS.includes(kind)) return;
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const state = editor.getState();
      state.beginBatch();
      const id = state.addNode(kind, position);
      const inside = kind === 'agent' || kind === 'decision' ? loopAt(state.draft, position) : null;
      if (inside) state.setLoopMembership(id, inside);
      state.endBatch();
    },
    [editor, screenToFlowPosition],
  );

  return (
    <div className="relative h-full w-full" aria-label={t('label')} role="application">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => editor.getState().select(null)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        deleteKeyCode={['Backspace', 'Delete']}
        elevateNodesOnSelect={false}
        colorMode="system"
      >
        <Background />
        <Controls />
      </ReactFlow>
      {definition.nodes.length === 0 ? (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">
          {t('empty')}
        </p>
      ) : null}
    </div>
  );
}
