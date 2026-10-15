import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react';
import { type DragEvent, useCallback, useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { checkConnection, type EditorNodeType } from '../editor/model.ts';
import { nodeRunStatus } from '../run/selectors.ts';

export const NODE_DRAG_TYPE = 'application/x-corral-node';

type CanvasNodeData = { label: string };
// React Flow reserves 'input'/'output'/'default'/'group' for built-in styles, so map our kinds.
const FLOW_TYPE = { agent: 'corralAgent', output: 'corralOutput' } as const;
type AgentFlowNode = Node<CanvasNodeData, 'corralAgent'>;
type OutputFlowNode = Node<CanvasNodeData, 'corralOutput'>;

function RunOverlay({ nodeId }: { nodeId: string }) {
  const t = useTranslations('Canvas.nodeStatus');
  const { session } = useStudioStores();
  // Each node subscribes to its own status only, so stream updates do not re-render the canvas.
  const status = useStore(session, (s) => nodeRunStatus(s.projection, nodeId));
  if (status === 'idle') return null;
  const symbol = { active: '◐', done: '✓', failed: '✕' }[status];
  return (
    <span className="mt-1 inline-flex items-center gap-1 text-xs" data-run-status={status}>
      <span aria-hidden="true">{symbol}</span>
      {t(status)}
    </span>
  );
}

function NodeShell({
  id,
  kind,
  label,
  selected,
}: {
  id: string;
  kind: EditorNodeType;
  label: string;
  selected: boolean;
}) {
  const t = useTranslations('Palette');
  return (
    <div
      className={`min-w-36 rounded-lg border bg-raised px-3 py-2 shadow-sm ${
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-line'
      }`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t(kind)}</div>
      <div className="text-sm font-medium">{label}</div>
      <RunOverlay nodeId={id} />
    </div>
  );
}

function AgentNodeView({ id, data, selected }: NodeProps<AgentFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} id="in" />
      <NodeShell id={id} kind="agent" label={data.label} selected={selected} />
      <Handle type="source" position={Position.Right} id="out" />
    </>
  );
}

function OutputNodeView({ id, data, selected }: NodeProps<OutputFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} id="in" />
      <NodeShell id={id} kind="output" label={data.label} selected={selected} />
    </>
  );
}

const nodeTypes = { corralAgent: AgentNodeView, corralOutput: OutputNodeView };

export function CorralCanvas() {
  const t = useTranslations('Canvas');
  const { editor } = useStudioStores();
  const draft = useStore(editor, (s) => s.draft);
  const selectedNodeId = useStore(editor, (s) => s.selectedNodeId);
  const { screenToFlowPosition } = useReactFlow();

  const nodes = useMemo<Node<CanvasNodeData>[]>(
    () =>
      draft.nodes.map((node) => ({
        id: node.id,
        type: FLOW_TYPE[node.type],
        position: draft.layout[node.id] ?? { x: 0, y: 0 },
        data: { label: node.label },
        selected: node.id === selectedNodeId,
      })),
    [draft.nodes, draft.layout, selectedNodeId],
  );
  const edges = useMemo<Edge[]>(
    () =>
      draft.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: 'out',
        targetHandle: 'in',
      })),
    [draft.edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CanvasNodeData>>[]) => {
      const state = editor.getState();
      for (const change of changes) {
        if (change.type === 'position' && change.position)
          state.moveNode(change.id, change.position);
        if (change.type === 'select' && change.selected) state.select(change.id);
        if (change.type === 'remove') state.removeNode(change.id);
      }
    },
    [editor],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'remove') editor.getState().removeEdge(change.id);
      }
    },
    [editor],
  );
  const isValidConnection = useCallback(
    (connection: Connection | Edge) =>
      checkConnection(editor.getState().draft, connection.source, connection.target).ok,
    [editor],
  );
  const onConnect = useCallback(
    (connection: Connection) => editor.getState().connect(connection.source, connection.target),
    [editor],
  );
  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid === false && state.fromNode && state.toNode) {
        editor.getState().explainRejectedConnection(state.fromNode.id, state.toNode.id);
      }
    },
    [editor],
  );

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);
  const onDrop = useCallback(
    (event: DragEvent) => {
      const kind = event.dataTransfer.getData(NODE_DRAG_TYPE);
      if (kind !== 'agent' && kind !== 'output') return;
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      editor.getState().addNode(kind, position);
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
        onPaneClick={() => editor.getState().select(null)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView={false}
        colorMode="system"
      >
        <Background />
        <Controls />
      </ReactFlow>
      {draft.nodes.length === 0 ? (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">
          {t('empty')}
        </p>
      ) : null}
    </div>
  );
}
