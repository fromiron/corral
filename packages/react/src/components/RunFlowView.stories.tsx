import { type EventOf, RunEvent } from '@corral/contracts';
import { applyEvent, emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { sessionStore } from '../stories/fixtures.tsx';
import { loopFlowFixture } from '../stories/loopFlowFixture.ts';
import { RunFlowView } from './RunFlowView.tsx';

const definition = linearCorral(['research', 'writer']);
definition.nodes.push({
  id: 'gate',
  type: 'decision',
  label: 'Research approval',
  mode: 'approval',
  rule: 'human_approval',
  inputBindings: [{ kind: 'run_input', name: 'brief' }],
});
definition.controlEdges.push(
  { id: 'approve', source: 'gate', sourcePort: 'approve', target: 'writer', targetPort: 'in' },
  { id: 'reject', source: 'gate', sourcePort: 'reject', target: 'research', targetPort: 'in' },
);

function event<K extends RunEvent['type']>(
  seq: number,
  type: K,
  payload: EventOf<K>['payload'],
): EventOf<K> {
  return RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `event_${seq}`,
    runId: 'run_flow_story',
    runSeq: seq,
    recordedAt: `2026-11-06T10:00:${String(seq).padStart(2, '0')}.000Z`,
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type,
    payload,
  }) as EventOf<K>;
}
const execution = (seq: number, id: string, nodeId: string) =>
  event(seq, 'execution.created', {
    executionId: id,
    nodeId,
    taskId: `task_${id}`,
    attemptNo: 1,
    parentExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
  });
const artifact = (seq: number, id: string, name: string, authorExecutionId: string) =>
  event(seq, 'artifact.version_created', {
    artifactId: `artifact_${id}`,
    artifactVersionId: id,
    name,
    version: 1,
    parentVersionId: null,
    authorExecutionId,
    contract: 'text',
    contentHash: 'a'.repeat(64),
    byteLength: 100,
    modelCallId: null,
    contextSnapshotId: null,
  });

function fixture(running = false) {
  const events: RunEvent[] = [
    execution(1, 'exec_research', 'research'),
    artifact(2, 'notes', 'Research notes', 'exec_research'),
  ];
  if (!running)
    events.push(
      event(3, 'workflow.branch_selected', {
        nodeId: 'gate',
        mode: 'approval',
        iterationId: null,
        configRevision: 0,
        selectedPort: 'approve',
        targetNodeId: 'writer',
        targetPort: 'in',
        reasonCode: 'human_approval',
        evidenceRefs: [
          { kind: 'approval', id: 'approval_research' },
          { kind: 'artifact', id: 'notes' },
        ],
        executionRefs: [{ executionId: 'exec_research', attemptNo: 1 }],
      }),
    );
  events.push(execution(events.length + 1, 'exec_writer', 'writer'));
  events.push(
    event(events.length + 1, 'artifact.read', {
      requestedRef: 'notes',
      resolvedVersionId: 'notes',
      consumerExecutionId: 'exec_writer',
    }),
  );
  events.push(
    event(events.length + 1, 'model.request_prepared', {
      executionId: 'exec_writer',
      modelCallId: 'call_writer',
      contextSnapshotId: 'context_writer',
      profile: 'model-a',
      configRevision: 0,
      directiveIds: [],
      inputArtifactVersionIds: ['notes'],
    }),
  );
  if (!running) {
    events.push(artifact(events.length + 1, 'report', 'Final report', 'exec_writer'));
    events.push(
      event(events.length + 1, 'output.finalized', {
        nodeId: 'output',
        artifactVersionIds: ['report'],
        approvalId: null,
      }),
    );
  }
  const projection = events.reduce(applyEvent, emptyProjection('run_flow_story'));
  projection.status = running ? 'running' : 'succeeded';
  for (const value of Object.values(projection.executions)) value.status = 'succeeded';
  if (running && projection.executions.exec_writer) {
    projection.executions.exec_writer.status = 'active';
    projection.executions.exec_writer.activity = 'model';
  }
  if (!running)
    projection.approvals.approval_research = {
      approvalId: 'approval_research',
      kind: 'user_action',
      subjectVersionIds: ['notes'],
      criteriaVersionId: null,
      status: 'approved',
    };
  return sessionStore({ runId: projection.runId, definition, projection, events });
}

const meta = {
  title: 'Run/WorkFlow',
  component: RunFlowView,
  decorators: [(Story) => <div className="w-[960px] max-w-full">{Story()}</div>],
  args: { session: fixture(), definition, onSelectExecution: fn(), onOpenArtifact: fn() },
} satisfies Meta<typeof RunFlowView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RecordedFlow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Included in model input')).toBeVisible();
    await expect(canvas.getByText('Approval · Research notes')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Open Final report' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Open Research notes' })).toBeNull();
    await expect(
      canvas.getByTestId('decision-detail').querySelector('[data-selected="true"]'),
    ).toHaveTextContent('Approve');
  },
};

export const LiveWork: Story = {
  args: { session: fixture(true) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: 'writer – Generating response' }),
    ).toHaveAttribute('data-status', 'working');
    await expect(canvas.getByText('No recorded branch')).toBeVisible();
  },
};

export const Narrow: Story = {
  decorators: [(Story) => <div className="w-[320px] max-w-full">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Approval · Research notes')).toBeVisible();
    const flow = canvas.getByTestId('run-flow');
    await expect(flow.scrollWidth).toBeLessThanOrEqual(flow.clientWidth);
  },
};

export const Dark: Story = {
  decorators: [(Story) => <div className="dark bg-background p-3 text-foreground">{Story()}</div>],
};

const loopFixture = loopFlowFixture(100);
export const HundredRounds: Story = {
  args: { session: loopFixture.session, definition: loopFixture.definition },
  parameters: {
    docs: {
      description: {
        story:
          'Synthetic 100-round metadata stress fixture; runtime repetition bounds remain unchanged.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByTestId('run-flow-loop')).toHaveLength(1);
    await expect(canvas.getAllByTestId('decision-detail')).toHaveLength(1);
    await expect(canvas.getByRole('combobox', { name: 'Round for Review' })).toBeVisible();
    await expect(
      within(canvas.getByRole('region', { name: 'Created results' })).queryByText('Draft round 1'),
    ).toBeNull();
  },
};

const realisticLoop = loopFlowFixture(3);
export const LoopRounds: Story = {
  args: { session: realisticLoop.session, definition: realisticLoop.definition },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByTestId('run-flow-loop')).toHaveLength(1);
    await expect(canvas.getByText('3 observed rounds · max 3')).toBeVisible();
    await expect(canvas.getByText('Exit Review')).toBeVisible();
  },
};
