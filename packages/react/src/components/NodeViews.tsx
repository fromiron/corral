import { outputPortsOf } from '@corral/core';
import { Handle, type Node, type NodeProps, NodeResizer, Position } from '@xyflow/react';
import type { CSSProperties } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { findNode } from '../editor/model.ts';
import { nodeExecutionCount, nodeRunStatus } from '../run/selectors.ts';

// One view per node kind. Handle ids are the compiler's port names, so a drawn connection is
// exactly the ControlEdge it creates. Call links use separate handles below/above agents.
// Handles come after the node body in the DOM so the body never covers them.

export type CanvasNodeData = Record<string, never>;
export const FLOW_TYPES = {
  agent: 'corralAgent',
  decision: 'corralDecision',
  loop: 'corralLoop',
  output: 'corralOutput',
} as const;

function useNode(id: string) {
  const { editor } = useStudioStores();
  return useStore(editor, (s) => findNode(s.draft, id));
}

function RunOverlay({ nodeId }: { nodeId: string }) {
  const t = useTranslations('Canvas.nodeStatus');
  const { session } = useStudioStores();
  // Each node subscribes to its own status only, so stream updates do not re-render the canvas.
  const status = useStore(session, (s) => nodeRunStatus(s.projection, nodeId));
  const count = useStore(session, (s) => nodeExecutionCount(s.projection, nodeId));
  if (status === 'idle') return null;
  const symbol = { active: '◐', done: '✓', failed: '✕' }[status];
  return (
    <span className="mt-1 inline-flex items-center gap-1 text-xs" data-run-status={status}>
      <span aria-hidden="true">{symbol}</span>
      {t(status)}
      {/* A node is not one execution: Loop rounds and calls each add one (Spec §4.3). */}
      {count > 1 ? <span className="text-muted">· {t('executions', { count })}</span> : null}
    </span>
  );
}

function PortLabel({ children, style }: { children: string; style: CSSProperties }) {
  return (
    <span
      className="pointer-events-none absolute text-[10px] leading-none text-muted"
      style={style}
    >
      {children}
    </span>
  );
}

function Shell({
  id,
  kind,
  label,
  selected,
  children,
}: {
  id: string;
  kind: string;
  label: string;
  selected: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`relative min-w-40 rounded-lg border bg-raised px-3 py-2 shadow-sm ${
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-line'
      }`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{kind}</div>
      <div className="text-sm font-medium">{label}</div>
      {children}
      <RunOverlay nodeId={id} />
    </div>
  );
}

export function AgentNodeView({ id, selected, isConnectable }: NodeProps<Node<CanvasNodeData>>) {
  const t = useTranslations();
  const node = useNode(id);
  if (node?.type !== 'agent') return null;
  const callable = node.invocation === 'callable';
  return (
    <>
      <Shell
        id={id}
        kind={callable ? t('Canvas.callableAgent') : t('Palette.agent')}
        label={node.label}
        selected={selected}
      />
      {callable ? (
        <Handle
          isConnectable={isConnectable}
          type="target"
          position={Position.Top}
          id="callable"
          className="!h-3 !w-3 !rotate-45 !rounded-none"
        />
      ) : (
        <>
          <Handle isConnectable={isConnectable} type="target" position={Position.Left} id="in" />
          <Handle isConnectable={isConnectable} type="source" position={Position.Right} id="out" />
        </>
      )}
      <Handle
        isConnectable={isConnectable}
        type="source"
        position={Position.Bottom}
        id="delegate"
        style={{ left: '30%' }}
        className="!h-3 !w-3 !rotate-45 !rounded-none"
      />
      <PortLabel style={{ left: '30%', bottom: -18, transform: 'translateX(-50%)' }}>
        {t('Canvas.ports.delegate')}
      </PortLabel>
      <Handle
        isConnectable={isConnectable}
        type="source"
        position={Position.Bottom}
        id="question"
        style={{ left: '70%' }}
        className="!h-3 !w-3 !rotate-45 !rounded-none"
      />
      <PortLabel style={{ left: '70%', bottom: -18, transform: 'translateX(-50%)' }}>
        {t('Canvas.ports.question')}
      </PortLabel>
    </>
  );
}

export function DecisionNodeView({ id, selected, isConnectable }: NodeProps<Node<CanvasNodeData>>) {
  const t = useTranslations();
  const node = useNode(id);
  if (node?.type !== 'decision') return null;
  const ports = outputPortsOf(node);
  return (
    <>
      <Shell id={id} kind={t('Palette.decision')} label={node.label} selected={selected}>
        <div className="text-xs text-muted">{t(`Inspector.modes.${node.mode}`)}</div>
      </Shell>
      <Handle isConnectable={isConnectable} type="target" position={Position.Left} id="in" />
      {ports.map((port, index) => {
        const top = `${((index + 1) / (ports.length + 1)) * 100}%`;
        return (
          <span key={port}>
            <Handle
              isConnectable={isConnectable}
              type="source"
              position={Position.Right}
              id={port}
              style={{ top }}
            />
            <PortLabel
              style={{ right: -6, top, transform: 'translate(100%, -50%)', paddingLeft: 8 }}
            >
              {t(`Canvas.ports.${port}`)}
            </PortLabel>
          </span>
        );
      })}
    </>
  );
}

export function OutputNodeView({ id, selected, isConnectable }: NodeProps<Node<CanvasNodeData>>) {
  const t = useTranslations('Palette');
  const node = useNode(id);
  if (node?.type !== 'output') return null;
  return (
    <>
      <Shell id={id} kind={t('output')} label={node.label} selected={selected} />
      <Handle isConnectable={isConnectable} type="target" position={Position.Left} id="in" />
    </>
  );
}

const LOOP_PORTS = [
  { id: 'enter', type: 'target', position: Position.Left, top: '25%', inside: false },
  { id: 'body', type: 'source', position: Position.Left, top: '55%', inside: true },
  { id: 'repeat', type: 'target', position: Position.Right, top: '25%', inside: true },
  { id: 'exit', type: 'target', position: Position.Right, top: '50%', inside: true },
  { id: 'next', type: 'source', position: Position.Right, top: '78%', inside: false },
] as const;

export function LoopNodeView({ id, selected, isConnectable }: NodeProps<Node<CanvasNodeData>>) {
  const t = useTranslations();
  const { editor, readOnly } = useStudioStores();
  const node = useNode(id);
  const members = useStore(
    editor,
    (s) => s.draft.definition.nodes.filter((n) => 'loopId' in n && n.loopId === id).length,
  );
  if (node?.type !== 'loop') return null;
  return (
    <>
      <NodeResizer
        isVisible={selected && !readOnly}
        minWidth={240}
        minHeight={160}
        onResizeStart={() => editor.getState().beginBatch()}
        onResize={(_event, box) => editor.getState().resizeNode(id, box)}
        onResizeEnd={() => editor.getState().endBatch()}
      />
      <div
        className={`h-full w-full rounded-xl border-2 border-dashed bg-accent/5 p-2 ${
          selected ? 'border-accent' : 'border-line'
        }`}
      >
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          {t('Palette.loop')}
        </div>
        <div className="text-sm font-medium">{node.label}</div>
        <div className="text-xs text-muted">
          {t('Canvas.loopMembers', { count: members, max: node.maxIterations })}
        </div>
        <RunOverlay nodeId={id} />
      </div>
      {LOOP_PORTS.map((port) => (
        <span key={port.id}>
          <Handle
            isConnectable={isConnectable}
            type={port.type}
            position={port.position}
            id={port.id}
            style={{ top: port.top }}
          />
          <PortLabel
            style={{
              top: port.top,
              ...(port.position === Position.Left
                ? {
                    left: port.inside ? 10 : -8,
                    transform: port.inside ? 'translateY(-50%)' : 'translate(-100%, -50%)',
                  }
                : {
                    right: port.inside ? 10 : -8,
                    transform: port.inside ? 'translateY(-50%)' : 'translate(100%, -50%)',
                  }),
            }}
          >
            {t(`Canvas.ports.${port.id}`)}
          </PortLabel>
        </span>
      ))}
    </>
  );
}

export const nodeTypes = {
  [FLOW_TYPES.agent]: AgentNodeView,
  [FLOW_TYPES.decision]: DecisionNodeView,
  [FLOW_TYPES.loop]: LoopNodeView,
  [FLOW_TYPES.output]: OutputNodeView,
};
