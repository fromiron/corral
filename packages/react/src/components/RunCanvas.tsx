import type { CorralDefinition } from '@corral/contracts';
import { Background, Controls, type Node, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { StudioStoresProvider } from '../context.tsx';
import { draftFromDefinition } from '../editor/model.ts';
import { createEditorStore } from '../editor/store.ts';
import type { RunCanvasLayout } from '../run/layout.ts';
import type { RunSessionStore } from '../run/session.ts';
import { flowEdges, flowNodes } from './CorralCanvas.tsx';
import { type CanvasNodeData, nodeTypes } from './NodeViews.tsx';

/**
 * The run's definition drawn with run state on each node. Read-only: it has
 * no drag, connect, delete or resize, and selecting a node only reports which node it was.
 * Nodes subscribe to their own status, so streamed text does not re-render the graph.
 */
export function RunCanvas({
  session,
  definition,
  layout,
  selectedNodeId,
  onSelectNode,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  layout: RunCanvasLayout;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}) {
  const t = useTranslations('RunCanvas');
  const tc = useTranslations('Canvas');
  // Node views read node settings from an editor store; this one is never edited.
  const editor = useMemo(
    () => createEditorStore({ ...draftFromDefinition(definition), layout: layout.nodes }),
    [definition, layout],
  );
  const nodes = useMemo<Node<CanvasNodeData>[]>(
    () =>
      flowNodes(definition.nodes, layout.nodes, selectedNodeId).map((node) => ({
        ...node,
        draggable: false,
        connectable: false,
        deletable: false,
      })),
    [definition.nodes, layout.nodes, selectedNodeId],
  );
  const edges = useMemo(
    () =>
      flowEdges(definition, (kind) => tc(`linkLabel.${kind}`)).map((edge) => ({
        ...edge,
        deletable: false,
        selectable: false,
      })),
    [definition, tc],
  );
  return (
    <StudioStoresProvider editor={editor} session={session} readOnly>
      <ReactFlowProvider>
        <div className="relative h-full w-full" role="application" aria-label={t('label')}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            onNodeClick={(_event, node) => onSelectNode(node.id)}
            onPaneClick={() => onSelectNode(null)}
            elevateNodesOnSelect={false}
            fitView
            fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
            minZoom={0.2}
            colorMode="system"
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
          <p className="pointer-events-none absolute right-2 top-2 rounded bg-raised/90 px-2 py-0.5 text-2xs text-muted-foreground">
            {t(`layout.${layout.source}`)} · {t('layoutNote')}
          </p>
        </div>
      </ReactFlowProvider>
    </StudioStoresProvider>
  );
}
