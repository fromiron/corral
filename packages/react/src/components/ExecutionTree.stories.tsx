import type { ExecutionView, IterationView } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { projectionWith, sessionStore } from '../stories/fixtures.tsx';
import { ExecutionTree } from './RunView.tsx';

const execution = (
  executionId: string,
  nodeId: string,
  changes: Partial<ExecutionView> = {},
): ExecutionView => ({
  executionId,
  nodeId,
  taskId: `task_${executionId}`,
  attemptNo: 1,
  parentExecutionId: null,
  previousExecutionId: null,
  depth: 0,
  iterationId: null,
  modelProfile: 'model-a',
  configRevision: 0,
  criteriaVersionId: null,
  status: 'succeeded',
  activity: null,
  waitingOn: null,
  modelCallIds: [],
  error: null,
  ...changes,
});

const executions = {
  exec_lead: execution('exec_lead', 'research', {
    status: 'waiting_children',
    waitingOn: {
      kind: 'children',
      targetIds: ['exec_retry', 'exec_review'],
      reasonCode: 'awaiting_delegated_tasks',
      since: '2026-10-15T00:00:00.000Z',
      deadline: null,
      required: true,
    },
  }),
  exec_failed: execution('exec_failed', 'writer', {
    parentExecutionId: 'exec_lead',
    depth: 1,
    status: 'failed',
    error: 'Tool timed out',
  }),
  exec_retry: execution('exec_retry', 'writer', {
    parentExecutionId: 'exec_lead',
    previousExecutionId: 'exec_failed',
    attemptNo: 2,
    depth: 1,
  }),
  exec_review: execution('exec_review', 'reviewer', {
    parentExecutionId: 'exec_lead',
    depth: 1,
    status: 'waiting_approval',
  }),
};

const meta = {
  title: 'Run/ExecutionTree',
  component: ExecutionTree,
  args: {
    session: sessionStore({
      runId: 'run_story',
      definition: linearCorral(['research', 'writer', 'reviewer']),
      projection: projectionWith({ executions, executionOrder: Object.keys(executions) }),
    }),
    onSteer: fn(),
    now: Date.parse('2026-10-15T00:00:10.000Z'),
    compact: true,
  },
  render: function SelectableTree(args) {
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <ExecutionTree
        {...args}
        selectedExecutionId={selected}
        onSteer={(id) => {
          setSelected(id);
          args.onSteer(id);
        }}
      />
    );
  },
} satisfies Meta<typeof ExecutionTree>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectReadableNames(canvasElement: HTMLElement) {
  for (const [id, name] of [
    ['exec_lead', 'research'],
    ['exec_review', 'reviewer'],
  ]) {
    const label = within(canvasElement)
      .getByTestId(`execution-${id}`)
      .querySelector(`[title="${name}"]`);
    if (!(label instanceof HTMLElement)) throw new Error(`Missing execution name: ${name}`);
    await waitFor(() => expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth));
  }
}

/** The actual execution adapter, including retry identity and waiting targets. */
export const SelectAndFold: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const retry = canvas.getByRole('button', { name: /^writer · exec_retry/ });
    await userEvent.click(retry);
    await expect(args.onSteer).toHaveBeenLastCalledWith('exec_retry');
    await expect(retry).toHaveAttribute('aria-pressed', 'true');

    // The card's real button also works with keyboard activation.
    const failed = canvas.getByRole('button', { name: /^writer · exec_failed/ });
    failed.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onSteer).toHaveBeenLastCalledWith('exec_failed');

    await userEvent.click(
      canvas.getByRole('button', { name: 'Fold the executions under research' }),
    );
    await waitFor(() => expect(canvas.queryByTestId('execution-exec_retry')).toBeNull());
    await userEvent.click(canvas.getByRole('button', { name: 'Show 3 executions under research' }));
    await waitFor(() => expect(canvas.getByTestId('execution-exec_retry')).toBeVisible());
    await expect(canvas.getByRole('link', { name: 'exec_review' })).toHaveAttribute(
      'href',
      '#execution-exec_review',
    );
    await expectReadableNames(canvasElement);
  },
};

/** RunPage gives the tree an 18rem panel, including its padding. */
export const Narrow: Story = {
  decorators: [(Story) => <div className="w-72 max-w-full p-3">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const tree = within(canvasElement).getByRole('tree');
    await waitFor(() => expect(tree.scrollWidth).toBeLessThanOrEqual(tree.clientWidth));
    await expectReadableNames(canvasElement);
    await expect(
      within(canvasElement).getByRole('button', { name: /^reviewer · exec_review/ }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  decorators: [(Story) => <div className="dark bg-background p-3">{Story()}</div>],
  play: async ({ canvasElement }) => expectReadableNames(canvasElement),
};

const loopDefinition = linearCorral(['writer', 'reviewer']);
loopDefinition.nodes = loopDefinition.nodes.map((node) =>
  node.type === 'agent' ? { ...node, parentId: 'revision' } : node,
);
loopDefinition.nodes.push({ id: 'revision', type: 'loop', label: 'Revision', maxIterations: 5 });
const rounds = [1, 2, 3];
const loopExecutions = Object.fromEntries(
  rounds.flatMap((no): [string, ExecutionView][] => [
    [
      `write_${no}`,
      execution(`write_${no}`, 'writer', {
        iterationId: `round_${no}`,
        status: no === 3 ? 'active' : 'succeeded',
      }),
    ],
    [
      `review_${no}`,
      execution(`review_${no}`, 'reviewer', {
        iterationId: `round_${no}`,
        parentExecutionId: `write_${no}`,
        status: no === 3 ? 'queued' : 'succeeded',
      }),
    ],
  ]),
);

/** One loop keeps its current status while another recorded round is inspected. */
export const LoopRounds: Story = {
  decorators: [(Story) => <div className="w-72 max-w-full p-3">{Story()}</div>],
  args: {
    session: sessionStore({
      runId: 'run_story',
      definition: loopDefinition,
      projection: projectionWith({
        status: 'running',
        executions: loopExecutions,
        executionOrder: Object.keys(loopExecutions),
        iterations: Object.fromEntries(
          rounds.map((no): [string, IterationView] => [
            `round_${no}`,
            {
              iterationId: `round_${no}`,
              loopNodeId: 'revision',
              no,
              criteriaVersionId: 'criteria',
              outcome: no === 3 ? null : 'revise',
            },
          ]),
        ),
      }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('loop-group-revision')).toHaveTextContent('3 observed rounds');
    await expect(canvas.getByTestId('execution-write_3')).toBeVisible();
    await expect(canvas.queryByTestId('execution-write_1')).toBeNull();
    const picker = canvas.getByRole('combobox', { name: 'Round for Revision' });
    await userEvent.click(picker);
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Round 2' }));
    await waitFor(() => expect(canvas.getByTestId('execution-write_2')).toBeVisible());
    await waitFor(() => expect(picker).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(within(document.body).queryByRole('listbox')).toBeNull());
    await waitFor(() =>
      expect(document.querySelectorAll('[data-base-ui-focus-guard][tabindex="0"]')).toHaveLength(0),
    );
    await expect(canvas.getByTestId('loop-group-revision')).toHaveTextContent('Current: round 3');
    await expect(args.onSteer).not.toHaveBeenCalled();
    const tree = canvas.getByRole('tree');
    await waitFor(() => expect(tree.scrollWidth).toBeLessThanOrEqual(tree.clientWidth));
  },
};
