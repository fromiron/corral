import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AgentSteering } from '../design-kit/components/agent/agent-steering.tsx';
import { Button, Textarea } from '../design-kit/index.ts';
import { projectionWith, sessionStore } from '../stories/fixtures.tsx';
import { ExecutionSteering } from './ExecutionSteering.tsx';
import { StatusBadge } from './StatusBadge.tsx';

const meta = {
  title: 'Reins/AgentSteering',
  component: AgentSteering,
  decorators: [(Story) => <div className="w-[28rem] max-w-full">{Story()}</div>],
  args: {
    title: 'Review the sources',
    agent: 'Researcher',
    status: 'running',
    statusLabel: 'Working',
    steps: [
      { id: 'read', title: 'Read the supplied material', status: 'done' },
      { id: 'verify', title: 'Verify the references', status: 'active' },
    ],
    queued: [
      {
        id: 'direction',
        text: 'Use primary sources only.',
        status: <StatusBadge status="queued" />,
      },
    ],
    labels: { queued: 'Instructions for this execution' },
    compose: (
      <div className="mt-2.5 grid gap-2 border-t border-border py-2.5 pr-3 pl-3.5">
        <label htmlFor="steering-story-input">Instruction</label>
        <Textarea id="steering-story-input" defaultValue="Keep the findings concise." />
        <Button className="justify-self-end" size="compact" onClick={fn()}>
          Send
        </Button>
      </div>
    ),
  },
} satisfies Meta<typeof AgentSteering>;
export default meta;
type Story = StoryObj<typeof meta>;

export const HostComposer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('textbox')).toHaveLength(1);
    await expect(canvas.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Now' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: /Pause|Remove/ })).toBeNull();
  },
};

export const DeliveryUnknown: Story = {
  args: {
    status: 'waiting',
    statusLabel: 'Waiting for approval',
    queued: [
      {
        id: 'direction',
        text: 'Use primary sources only.',
        status: <StatusBadge status="delivery_unknown" />,
        detail: (
          <span className="text-muted-foreground">Request delivery has not been confirmed.</span>
        ),
      },
    ],
  },
};

export const Dark: Story = {
  decorators: [(Story) => <div className="dark bg-background p-3 text-foreground">{Story()}</div>],
};

export const PausedExecution: Story = {
  render: () => {
    const session = sessionStore({
      runId: 'run_story',
      projection: projectionWith({
        status: 'paused',
        executions: {
          exec_main: { executionId: 'exec_main', status: 'paused', modelProfile: 'model-a' },
        } as never,
      }),
      events: [
        {
          type: 'tool.requested',
          runSeq: 1,
          payload: {
            executionId: 'exec_main',
            toolCallId: 'tool_pending',
            name: 'search_sources',
            validatedArgs: {},
          },
        },
      ] as never,
    });
    return (
      <ExecutionSteering
        session={session}
        target={{ executionId: 'exec_main', nodeLabel: 'Assistant', finished: false }}
        showToolActivity
        compose={meta.args.compose}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tool = canvas.getByRole('button', { name: /^search_sources/ });
    await expect(tool).toHaveTextContent('Paused');
    await expect(tool.closest('[data-status]')).toHaveAttribute('data-status', 'waiting');
    await userEvent.click(tool);
    await expect(canvasElement.querySelector('.shimmer-text')).toBeNull();
    await expect(canvasElement.querySelector('.pulse-soft')).toBeNull();
    await expect(canvas.getAllByRole('textbox')).toHaveLength(1);
  },
};

export const ShortComposer: Story = {
  render: () => {
    const tools = ['spawn_subagents', 'await_tasks', 'read_artifact', 'search_sources'];
    const session = sessionStore({
      runId: 'run_story',
      projection: projectionWith({
        executions: {
          exec_main: { executionId: 'exec_main', status: 'active', modelProfile: 'model-a' },
        } as never,
        directiveOrder: ['dir_1', 'dir_2', 'dir_3'],
        directives: Object.fromEntries(
          [1, 2, 3].map((id) => [
            `dir_${id}`,
            {
              directiveId: `dir_${id}`,
              targetExecutionId: 'exec_main',
              text: `Check source ${id}.`,
              status: 'queued',
            },
          ]),
        ) as never,
      }),
      events: tools.map((name, index) => ({
        type: 'tool.requested',
        runSeq: index + 1,
        payload: {
          executionId: 'exec_main',
          toolCallId: `tool_${index}`,
          name,
          validatedArgs: { instruction: 'Verify the supplied sources and summarize the findings.' },
        },
      })) as never,
    });
    return (
      <div data-testid="short-composer" className="h-[440px] overflow-y-auto">
        <ExecutionSteering
          session={session}
          target={{ executionId: 'exec_main', nodeLabel: 'Assistant', finished: false }}
          showToolActivity
          compose={meta.args.compose}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId('short-composer');
    const send = canvas.getByRole('button', { name: 'Send' });
    await waitFor(() =>
      expect(send.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        host.getBoundingClientRect().bottom,
      ),
    );
    const activity = canvas.getByRole('region', { name: 'Activity' });
    await expect(activity.scrollHeight).toBeGreaterThan(activity.clientHeight);
    activity.focus();
    await expect(activity).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: /^spawn_subagents/ }));
    await waitFor(() =>
      expect(send.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        host.getBoundingClientRect().bottom,
      ),
    );
    activity.scrollTop = activity.scrollHeight;
    await expect(activity.scrollTop).toBeGreaterThan(0);
    await expect(canvas.getAllByRole('textbox')).toHaveLength(1);
    await expect(canvas.getByRole('textbox', { name: 'Instruction' })).toBeVisible();
    await expect(send).toBeVisible();
  },
};
