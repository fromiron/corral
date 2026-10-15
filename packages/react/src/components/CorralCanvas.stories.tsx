import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  agentToOutputDraft,
  projectionWith,
  researchTeamDraft,
  StudioFrame,
  sessionStore,
} from '../stories/fixtures.tsx';
import { CorralCanvas } from './CorralCanvas.tsx';

const meta = {
  title: 'Canvas/CorralCanvas',
  component: CorralCanvas,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CorralCanvas>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => (
    <StudioFrame>
      <div className="h-96 w-full">
        <CorralCanvas />
      </div>
    </StudioFrame>
  ),
};

export const AgentToOutput: Story = {
  render: () => (
    <StudioFrame draft={agentToOutputDraft()}>
      <div className="h-96 w-full">
        <CorralCanvas />
      </div>
    </StudioFrame>
  ),
};

export const AgentRunning: Story = {
  render: () => {
    const session = sessionStore({
      runId: 'run_story',
      projection: projectionWith({
        nodeExecutions: { agent_1: ['exec_0001'] },
        executionOrder: ['exec_0001'],
        executions: {
          exec_0001: {
            executionId: 'exec_0001',
            nodeId: 'agent_1',
            taskId: 'task_0001',
            attemptNo: 1,
            parentExecutionId: null,
            depth: 0,
            iterationId: null,
            modelProfile: 'model-a',
            status: 'active',
            activity: 'model',
            modelCallIds: ['call_0001'],
            error: null,
          },
        },
      }),
    });
    return (
      <StudioFrame draft={agentToOutputDraft()} session={session}>
        <div className="h-96 w-full">
          <CorralCanvas />
        </div>
      </StudioFrame>
    );
  },
};

export const ResearchTeamWithLoop: Story = {
  render: () => (
    <StudioFrame draft={researchTeamDraft()}>
      <div className="h-[36rem] w-full">
        <CorralCanvas />
      </div>
    </StudioFrame>
  ),
};
