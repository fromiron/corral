import type { RunEvent } from '@corral/contracts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { projectionWith, sessionStore } from '../stories/fixtures.tsx';
import { Timeline } from './Timeline.tsx';

/** A long run: user, runtime and agent events over three executions. */
function events(count: number, from = 1): RunEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const runSeq = from + i;
    const executionId = `exec_000${(runSeq % 3) + 1}`;
    const base = {
      schemaVersion: '0.1',
      eventId: `evt_${runSeq}`,
      runId: 'run_story',
      runSeq,
      recordedAt: '2026-10-15T00:00:00.000Z',
      causedByEventIds: [],
    };
    if (runSeq % 10 === 0) {
      return {
        ...base,
        actor: { kind: 'user', id: 'local_user' },
        type: 'directive.accepted',
        executionId,
        payload: { directiveId: `dir_${runSeq}`, targetExecutionId: executionId, text: 'Steer' },
      } as RunEvent;
    }
    return {
      ...base,
      actor: { kind: 'agent', id: executionId },
      type: 'tool.requested',
      executionId,
      payload: {
        executionId,
        toolCallId: `tool_${runSeq}`,
        name: 'write_artifact',
        validatedArgs: {},
      },
    } as RunEvent;
  });
}

const meta = {
  title: 'Run/Timeline',
  component: Timeline,
  decorators: [(Story) => <div className="w-[36rem]">{Story()}</div>],
} satisfies Meta<typeof Timeline>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { session: sessionStore({ runId: 'run_story' }) } };

const long = sessionStore({
  runId: 'run_story',
  projection: projectionWith({}),
  events: events(10_000),
});

export const TenThousandEvents: Story = {
  args: { session: long },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('timeline-count')).toHaveTextContent('10,000 events of 10,000');
    // Only the rows in view are in the DOM.
    const rows = () => canvas.getAllByTestId('timeline-row');
    expect(rows().length).toBeGreaterThan(5);
    expect(rows().length).toBeLessThan(60);

    // Scroll into the middle, pick an event, then let 500 more arrive.
    const scroller = canvas.getByTestId('timeline-scroll');
    scroller.scrollTop = 140_000;
    await waitFor(() => expect(rows()[0]?.dataset.seq).not.toBe('1'));
    const row = rows()[4];
    if (!row) throw new Error('no row');
    await userEvent.click(within(row).getByRole('button'));
    const picked = row.dataset.seq;
    const top = scroller.scrollTop;
    long.setState({ events: [...long.getState().events, ...events(500, 10_001)] });
    await waitFor(() =>
      expect(canvas.getByTestId('timeline-count')).toHaveTextContent('10,500 events'),
    );
    expect(scroller.scrollTop).toBe(top);
    const still = rows().find((r) => r.dataset.seq === picked);
    expect(still && within(still).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    expect(canvas.getByTestId('timeline-selected')).toHaveTextContent(`#${picked}`);
    expect(rows().length).toBeLessThan(60);

    // Filters: only what the reader asked for.
    await userEvent.selectOptions(canvas.getByLabelText('Actor'), 'user');
    await waitFor(() =>
      expect(canvas.getByTestId('timeline-count')).toHaveTextContent('1,050 events'),
    );
    for (const r of rows()) expect(r).toHaveTextContent('directive.accepted');
    await userEvent.selectOptions(canvas.getByLabelText('Execution'), 'exec_0001');
    for (const r of rows()) expect(r).toHaveTextContent('exec_0001');
  },
};
