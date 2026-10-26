import type { WaitingOn } from '@corral/contracts';
import type { ExecutionView } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { projectionWith, sessionStore } from '../stories/fixtures.tsx';
import { RunView } from './RunView.tsx';

const waits: WaitingOn['kind'][] = ['children', 'message', 'approval', 'user'];
const executions: Record<string, ExecutionView> = Object.fromEntries(
  waits.map((kind, index) => {
    const executionId = `exec_wait_${index}`;
    return [
      executionId,
      {
        executionId,
        nodeId: 'writer',
        taskId: `task_${index}`,
        attemptNo: 1,
        parentExecutionId: null,
        previousExecutionId: null,
        depth: 0,
        iterationId: null,
        modelProfile: 'model-a',
        configRevision: 1,
        criteriaVersionId: null,
        status: kind === 'children' ? 'waiting_children' : 'waiting_message',
        activity: null,
        modelCallIds: [],
        error: null,
        waitingOn: {
          kind,
          targetIds: [`target_${index}`],
          reasonCode: `waiting_${kind}`,
          since: '2026-10-15T00:00:00.000Z',
          deadline: null,
          required: true,
        },
      },
    ];
  }),
);
const meta = {
  title: 'Run/RunView',
  component: RunView,
  decorators: [(Story) => <div className="w-88">{Story()}</div>],
} satisfies Meta<typeof RunView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingReasons: Story = {
  args: {
    session: sessionStore({
      runId: 'run_story',
      definition: linearCorral(['writer']),
      projection: projectionWith({ executions, executionOrder: Object.keys(executions) }),
    }),
    onSteer: () => {},
  },
  play: async ({ canvasElement }) => {
    // Waiting has explicit text, independent of its status color.
    expect(within(canvasElement).getAllByTestId('waiting-on')).toHaveLength(waits.length);
  },
};
export const Disconnected: Story = {
  args: {
    session: sessionStore({
      runId: 'run_story',
      streamError: 'Connection lost; reconnecting from the last committed event.',
      projection: projectionWith({ status: 'paused' }),
    }),
    onSteer: () => {},
  },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Connection lost');
  },
};
