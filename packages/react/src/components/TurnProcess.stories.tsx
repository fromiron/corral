import { type EventPayload, type RunEvent, RunEvent as RunEventSchema } from '@corral/contracts';
import { type ExecutionView, emptyProjection, type RunProjection } from '@corral/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { TurnProcess } from '../../../../apps/studio/src/workbench/TurnProcess.tsx';

const runId = 'run_process_story';
const started = Date.now() - 8_000;
const at = (second: number) => new Date(started + second * 1_000).toISOString();

function event<T extends RunEvent['type']>(
  type: T,
  payload: EventPayload<T>,
  seq: number,
): RunEvent {
  return RunEventSchema.parse({
    schemaVersion: '0.1',
    eventId: `event_${seq}`,
    runId,
    runSeq: seq,
    recordedAt: at(seq),
    actor: { kind: 'agent', id: 'assistant' },
    causedByEventIds: [],
    type,
    payload,
  });
}

function execution(id: string, changes: Partial<ExecutionView> = {}): ExecutionView {
  return {
    executionId: id,
    nodeId: id === 'exec_lead' ? 'assistant' : 'researcher',
    taskId: `task_${id}`,
    attemptNo: 1,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
    configRevision: 0,
    criteriaVersionId: null,
    status: 'active',
    activity: 'model',
    waitingOn: null,
    modelCallIds: id === 'exec_lead' ? ['call_1'] : [],
    error: null,
    ...changes,
  };
}

function projection(): RunProjection {
  const value = emptyProjection(runId);
  value.status = 'running';
  value.startedAt = at(0);
  value.executionOrder = ['exec_lead'];
  value.executions.exec_lead = execution('exec_lead');
  value.modelProfiles = {
    'model-a': { profile: 'model-a', provider: null, modelId: 'Example model', auth: 'mock' },
  };
  value.modelCalls.call_1 = {
    modelCallId: 'call_1',
    executionId: 'exec_lead',
    contextSnapshotId: 'context_1',
    profile: 'model-a',
    configRevision: 0,
    directiveIds: [],
    inputArtifactVersionIds: ['artv_brief'],
    finished: false,
    responseRef: null,
    usage: null,
    rawUsage: null,
    certainty: null,
  };
  value.effects.effect_model = {
    effectId: 'effect_model',
    kind: 'model_request',
    scope: 'exec_lead',
    epoch: 1,
    dispatched: true,
    reservationId: 'call_1',
    status: 'admitted',
    outcome: null,
  };
  value.artifacts.artv_brief = {
    artifactVersionId: 'artv_brief',
    artifactId: 'artifact_brief',
    version: 1,
    parentVersionId: null,
    name: 'Research brief',
    contract: 'text',
    contentHash: 'a'.repeat(64),
    byteLength: 20,
    authorExecutionId: 'exec_lead',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
  };
  return value;
}

const requested = event(
  'model.request_prepared',
  {
    executionId: 'exec_lead',
    modelCallId: 'call_1',
    contextSnapshotId: 'context_1',
    profile: 'model-a',
    configRevision: 0,
    directiveIds: [],
    inputArtifactVersionIds: ['artv_brief'],
  },
  1,
);

const toolEvents: RunEvent[] = [
  requested,
  event(
    'tool.requested',
    {
      executionId: 'exec_lead',
      toolCallId: 'tool_read',
      name: 'read_document',
      validatedArgs: { path: 'source-guide.md' },
    },
    2,
  ),
  event(
    'tool.allowed',
    { executionId: 'exec_lead', toolCallId: 'tool_read', policyVersion: '1' },
    3,
  ),
  event(
    'tool.started',
    { executionId: 'exec_lead', toolCallId: 'tool_read', effectId: 'effect_read' },
    4,
  ),
  event(
    'tool.finished',
    { executionId: 'exec_lead', toolCallId: 'tool_read', resultRef: 'artv_notes', error: null },
    5,
  ),
];

function withTools(): RunProjection {
  const value = projection();
  value.executionOrder.push('exec_researcher');
  value.executions.exec_lead = execution('exec_lead', {
    status: 'waiting_children',
    activity: null,
    waitingOn: {
      kind: 'children',
      targetIds: ['exec_researcher'],
      reasonCode: 'awaiting_delegated_tasks',
      since: at(5),
      deadline: null,
      required: true,
    },
  });
  value.executions.exec_researcher = execution('exec_researcher', {
    parentExecutionId: 'exec_lead',
    depth: 1,
  });
  const call = value.modelCalls.call_1;
  if (call) value.modelCalls.call_1 = { ...call, finished: true, responseRef: 'response_call_1' };
  value.toolCalls.tool_read = {
    toolCallId: 'tool_read',
    executionId: 'exec_lead',
    name: 'read_document',
    status: 'requested',
    phase: 'finished',
    effectId: 'effect_read',
    reason: null,
    resultRef: 'artv_notes',
  };
  const brief = value.artifacts.artv_brief;
  if (brief)
    value.artifacts.artv_notes = {
      ...brief,
      artifactVersionId: 'artv_notes',
      artifactId: 'artifact_notes',
      name: 'Source notes',
    };
  return value;
}

function pausedProjection(): RunProjection {
  const value = projection();
  value.status = 'paused';
  value.executions.exec_lead = execution('exec_lead', { status: 'paused', activity: null });
  const call = value.modelCalls.call_1;
  if (call) value.modelCalls.call_1 = { ...call, finished: true, responseRef: 'response_call_1' };
  value.toolCalls.tool_read = {
    toolCallId: 'tool_read',
    executionId: 'exec_lead',
    name: 'read_document',
    status: 'requested',
    phase: 'allowed',
    effectId: 'effect_read',
    reason: null,
    resultRef: null,
  };
  return value;
}

const ordinaryResponse = 'This is ordinary assistant output, not private reasoning.';
async function waitForStepMotion(canvasElement: HTMLElement) {
  await waitFor(() => {
    const rows = [...canvasElement.querySelectorAll('.turn-process-row')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const content = row.firstElementChild;
      if (content) expect(getComputedStyle(content).opacity).toBe('1');
    }
  });
}

const meta = {
  title: 'Conversation/ThinkingSteps',
  component: TurnProcess,
  decorators: [(Story) => <div className="w-[36rem] max-w-full">{Story()}</div>],
  args: {
    events: [requested],
    projection: projection(),
    streams: { call_1: { text: ordinaryResponse, next: 1, broken: false } },
    label: (id: string) => (id === 'assistant' ? 'Assistant' : 'Researcher'),
    open: true,
    onOpenChange: fn(),
  },
  render: function ControlledProcess(args) {
    const [open, setOpen] = useState(args.open);
    return <TurnProcess {...args} open={open} onOpenChange={setOpen} />;
  },
  play: async ({ canvasElement }) => waitForStepMotion(canvasElement),
} satisfies Meta<typeof TurnProcess>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RunningFirstRequest: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText(/^Model request 1/)).toBeVisible());
    await waitFor(() => expect(canvas.getByText(/Generating response/)).toBeVisible());
    await expect(canvas.getByText('Research brief')).toBeVisible();
    await expect(canvas.queryByText(ordinaryResponse)).toBeNull();
    const details = canvas.getByRole('button', { name: 'Request details' });
    details.focus();
    await userEvent.keyboard('{Enter}');
    await expect(details).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(canvas.getByText('Reasoning not recorded')).toBeVisible());
    await waitForStepMotion(canvasElement);
  },
};

export const ToolsAndDelegates: Story = {
  args: { projection: withTools(), events: toolEvents },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText(/^Researcher/)).toBeVisible());
    await expect(canvas.getByText('Active')).toBeVisible();
    await expect(canvas.getByText('Source notes')).toBeVisible();
    const details = canvas.getByRole('button', { name: 'Tool details' });
    await userEvent.click(details);
    await expect(details).toHaveAttribute('aria-expanded', 'true');
    const card = canvas.getByRole('button', { name: /^read_document/ });
    await userEvent.click(card);
    await expect(card).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(canvas.getByText('Arguments')).toBeVisible());
    await expect(canvas.queryByText(ordinaryResponse)).toBeNull();
    await waitForStepMotion(canvasElement);
  },
};

export const Paused: Story = {
  args: {
    projection: pausedProjection(),
    events: toolEvents.slice(0, 3),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = canvas.getByRole('button', { name: /Paused/ });
    await expect(header).toBeVisible();
    await expect(header.querySelector('.shimmer-text')).toBeNull();
    await waitFor(() => expect(canvas.getByText(/^Model request 1/)).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'Tool details' }));
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: /^read_document/ })).toBeVisible(),
    );
    await expect(canvasElement.querySelector('.shimmer-text')).toBeNull();
    await waitForStepMotion(canvasElement);
  },
};

export const Dark: Story = {
  args: ToolsAndDelegates.args,
  decorators: [(Story) => <div className="dark bg-background p-3 text-foreground">{Story()}</div>],
};
