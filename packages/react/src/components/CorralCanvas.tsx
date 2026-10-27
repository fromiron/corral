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
import { type DragEvent, useCallback, useEffect, useMemo, useState } from 'react';
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

/** React Flow nodes for a definition's nodes at the given positions (editor and Run graph). */
export function flowNodes(
  definitionNodes: EditorDraft['definition']['nodes'],
  layout: EditorDraft['layout'],
  selectedNodeId: string | null,
): Node<CanvasNodeData>[] {
  return definitionNodes.map((node) => {
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
  });
}

/** Control edges, and call links drawn apart from them. */
export function flowEdges(
  definition: Pick<EditorDraft['definition'], 'controlEdges' | 'capabilityLinks'>,
  linkLabel: (kind: CapabilityLink['kind']) => string,
): Edge[] {
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
    label: linkLabel(link.kind),
    className: 'corral-call-link',
    style: { strokeDasharray: '6 4' },
    markerEnd: { type: MarkerType.Arrow },
  }));
  return [...control, ...links];
}

export function CorralCanvas({ onNodeSelect }: { onNodeSelect?: () => void } = {}) {
  const t = useTranslations('Canvas');
  const { editor } = useStudioStores();
  const draft = useStore(editor, (s) => s.draft);
  const selectedNodeId = useStore(editor, (s) => s.selectedNodeId);
  const { screenToFlowPosition } = useReactFlow();
  const { definition, layout } = draft;

  const nodes = useMemo(
    () => flowNodes(definition.nodes, layout, selectedNodeId),
    [definition.nodes, layout, selectedNodeId],
  );
  const { controlEdges, capabilityLinks } = definition;
  const edges = useMemo(
    () => flowEdges({ controlEdges, capabilityLinks }, (kind) => t(`linkLabel.${kind}`)),
    [controlEdges, capabilityLinks, t],
  );

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
        // Removals arrive together in onDelete, so they are one undo step.
      }
    },
    [editor],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    // Removals arrive together in onDelete, so they are one undo step.
    void changes;
  }, []);

  /**
   * One deletion (Delete or Backspace) as one undo step: React Flow reports a node's connected
   * edges separately, and one Undo must bring the node back with its links.
   */
  const onDelete = useCallback(
    ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
      const state = editor.getState();
      const removed = new Set(nodes.map((n) => n.id));
      state.beginBatch();
      try {
        for (const edge of edges) {
          // A removed node takes its own edges and links with it.
          if (removed.has(edge.source) || removed.has(edge.target)) continue;
          if (edge.id.startsWith(LINK_PREFIX)) state.removeLink(edge.id.slice(LINK_PREFIX.length));
          else state.removeEdge(edge.id);
        }
        for (const node of nodes) state.removeNode(node.id);
      } finally {
        state.endBatch();
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

  // A refused drop explains itself instead of silently doing nothing.
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

  // Crossing a Loop boundary changes the team, not only the drawing (#76 GA-02): say so while
  // dragging, and say what changed after the drop. Undo restores both.
  const [loopNotice, setLoopNotice] = useState<{ text: string; preview: boolean } | null>(null);
  const loopChange = useCallback(
    (node: Node) => {
      const state = editor.getState();
      const current = findNode(state.draft, node.id);
      if (
        !current ||
        (current.type !== 'agent' && current.type !== 'decision') ||
        (current.type === 'agent' && current.invocation === 'callable')
      )
        return null;
      const width = node.measured?.width ?? 160;
      const height = node.measured?.height ?? 60;
      const center = { x: node.position.x + width / 2, y: node.position.y + height / 2 };
      const inside = loopAt(state.draft, center);
      const from = current.loopId ?? null;
      if (inside === from) return null;
      const loopId = (inside ?? from) as string;
      return {
        nodeId: node.id,
        inside,
        node: current.label,
        loop: findNode(state.draft, loopId)?.label ?? loopId,
      };
    },
    [editor],
  );
  useEffect(() => {
    if (!loopNotice || loopNotice.preview) return;
    const timer = setTimeout(() => setLoopNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [loopNotice]);
  const onNodeDragStart = useCallback(() => editor.getState().beginBatch(), [editor]);
  const onNodeDrag = useCallback(
    (_event: unknown, node: Node) => {
      const change = loopChange(node);
      setLoopNotice(
        change
          ? {
              preview: true,
              text: t(change.inside ? 'loopEnterPreview' : 'loopLeavePreview', {
                node: change.node,
                loop: change.loop,
              }),
            }
          : null,
      );
    },
    [loopChange, t],
  );
  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      const state = editor.getState();
      const change = loopChange(node);
      if (change) state.setLoopMembership(change.nodeId, change.inside);
      state.endBatch();
      setLoopNotice(
        change
          ? {
              preview: false,
              text: t(change.inside ? 'loopEntered' : 'loopLeft', {
                node: change.node,
                loop: change.loop,
              }),
            }
          : null,
      );
    },
    [editor, loopChange, t],
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
        onNodeClick={onNodeSelect}
        onEdgesChange={onEdgesChange}
        onDelete={onDelete}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => editor.getState().select(null)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        deleteKeyCode={['Backspace', 'Delete']}
        elevateNodesOnSelect={false}
        // The saved viewport frames the Corral when it opens; later pans stay local.
        defaultViewport={draft.viewport}
        className="corral-flow"
        colorMode="system"
      >
        <Background />
        <Controls />
      </ReactFlow>
      {loopNotice ? (
        <p
          role="status"
          data-testid="loop-notice"
          data-preview={loopNotice.preview || undefined}
          className={`pointer-events-none absolute top-3 left-1/2 z-10 max-w-[90%] -translate-x-1/2 rounded-md px-3 py-1.5 text-xs shadow-popup ${loopNotice.preview ? 'bg-warning/15 text-warning' : 'bg-raised text-foreground'}`}
        >
          {loopNotice.text}
        </p>
      ) : null}
      {definition.nodes.length === 0 ? (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : null}
    </div>
  );
}
