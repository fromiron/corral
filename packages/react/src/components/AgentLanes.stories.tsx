import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { AgentLanes } from '../design-kit/index.ts';

const start = Date.parse('2026-10-15T00:00:00.000Z');
const meta = {
  title: 'Run/AgentLanes',
  component: AgentLanes,
  args: {
    startAt: start,
    now: start + 60_000,
    size: 'compact',
    onSelectTask: fn(),
    agents: [
      {
        id: 'research',
        name: 'Researcher',
        tasks: [
          {
            id: 'exec_research',
            label: 'Review sources',
            status: 'running',
            statusLabel: 'Running',
            startedAt: start,
            endedAt: start + 60_000,
          },
        ],
      },
    ],
  },
} satisfies Meta<typeof AgentLanes>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The recorded-run mode uses the same tinted live span as the source kit. */
export const Running: Story = {
  play: async ({ canvasElement, args, userEvent }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: /Researcher: Review sources/ }),
    );
    await expect(args.onSelectTask).toHaveBeenCalledWith('exec_research');
  },
};

export const Dark: Story = {
  decorators: [(Story) => <div className="dark bg-background p-3">{Story()}</div>],
};
