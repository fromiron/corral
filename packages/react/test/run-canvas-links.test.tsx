import type { RunProjection } from '@corral/core';
import { render } from '@testing-library/react';
import { type Edge, type EdgeProps, Position } from '@xyflow/react';
import type { ReactElement } from 'react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { RunCanvas } from '../src/components/RunCanvas.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { runCanvasLayout } from '../src/run/layout.ts';
import { projectionWith, researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';

const rendered = vi.hoisted(() => ({
  edges: [] as Edge[],
  observed: null as null | ((props: EdgeProps) => ReactElement<{ labelX: number; labelY: number }>),
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  ReactFlow: ({
    edges,
    edgeTypes,
  }: {
    edges: Edge[];
    edgeTypes: { observed: NonNullable<typeof rendered.observed> };
  }) => {
    rendered.edges = edges;
    rendered.observed = edgeTypes.observed;
    return null;
  },
}));

const execution = (
  executionId: string,
  nodeId: string,
  parentExecutionId: string | null,
): RunProjection['executions'][string] => ({
  executionId,
  nodeId,
  taskId: `task_${executionId}`,
  attemptNo: 1,
  parentExecutionId,
  previousExecutionId: null,
  depth: parentExecutionId ? 1 : 0,
  iterationId: null,
  modelProfile: 'model-a',
  configRevision: 0,
  criteriaVersionId: null,
  status: 'succeeded',
  activity: null,
  waitingOn: null,
  modelCallIds: [],
  error: null,
});

it('keeps unobserved allowed paths while removing only captions repeated at an observed source port', () => {
  const { definition, layout } = researchTeamDraft();
  definition.capabilityLinks.push({
    id: 'other-allowed',
    kind: 'delegate',
    sourceNodeId: 'research',
    targetNodeId: 'respond',
  });
  const projection = projectionWith({
    executions: {
      parent: execution('parent', 'research', null),
      child: execution('child', 'helper', 'parent'),
    },
    executionOrder: ['parent', 'child'],
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunCanvas
        session={sessionStore({ runId: 'run_canvas', definition, projection })}
        definition={definition}
        layout={runCanvasLayout(definition, layout)}
        selectedNodeId={null}
        onSelectNode={() => {}}
      />
    </IntlProvider>,
  );
  const edge = (id: string) => rendered.edges.find((edge) => edge.id === id);
  expect(edge('link:cap1')).toBeUndefined();
  expect(edge('link:other-allowed')).toMatchObject({
    source: 'research',
    target: 'respond',
    sourceHandle: 'delegate',
    label: undefined,
    ariaLabel: 'delegates',
  });
  expect(edge('link:cap3')).toMatchObject({ label: 'delegates' });
  expect(edge('link:cap2')).toMatchObject({ label: 'asks' });
  expect(edge('observed:delegate:research:helper')).toMatchObject({
    label: 'delegates · 1 observed · 0 in progress',
    ariaLabel: 'delegates · 1 observed · 0 in progress',
  });
});

it('keeps captions for two higher callable targets at distinct heights', () => {
  const { definition, layout } = researchTeamDraft();
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunCanvas
        session={sessionStore()}
        definition={definition}
        layout={runCanvasLayout(definition, layout)}
        selectedNodeId={null}
        onSelectNode={() => {}}
      />
    </IntlProvider>,
  );
  if (!rendered.observed) throw new Error('Missing observed edge renderer');
  const labels = [100, 250].map(
    (targetY) =>
      rendered.observed?.({
        id: `observed:${targetY}`,
        source: 'parent',
        target: 'helper',
        sourceX: 280,
        sourceY: 400,
        sourcePosition: Position.Bottom,
        targetX: 600,
        targetY,
        targetPosition: Position.Top,
        label: 'delegates · 1 observed · 0 in progress',
        data: undefined,
        selected: false,
        animated: false,
        selectable: false,
        deletable: false,
      }).props,
  );
  const first = labels[0];
  const second = labels[1];
  if (!first || !second) throw new Error('Missing observed caption');
  expect(Math.abs(first.labelY - second.labelY)).toBeGreaterThanOrEqual(20);
  for (const label of [first, second])
    expect(Math.abs(label.labelY - 400)).toBeGreaterThanOrEqual(40);
});
