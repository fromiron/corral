import { emptyProjection, type RunProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionTree, RunView } from '../src/components/RunView.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';

const execution = (
  executionId: string,
  nodeId: string,
  extra: Partial<RunProjection['executions'][string]> = {},
): RunProjection['executions'][string] => ({
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
  ...extra,
});

/** A lead whose helper failed once and succeeded on retry, and a second helper still running. */
function projection(): RunProjection {
  const executions = {
    exec_lead: execution('exec_lead', 'research', {
      status: 'waiting_children',
      waitingOn: {
        kind: 'children',
        targetIds: ['exec_retry', 'exec_other'],
        reasonCode: 'awaiting_delegated_tasks',
        since: '2026-10-15T00:00:00.000Z',
        deadline: null,
        required: true,
      },
    }),
    exec_first: execution('exec_first', 'writer', {
      parentExecutionId: 'exec_lead',
      depth: 1,
      status: 'failed',
      error: 'Tool timed out',
    }),
    exec_retry: execution('exec_retry', 'writer', {
      parentExecutionId: 'exec_lead',
      previousExecutionId: 'exec_first',
      attemptNo: 2,
      depth: 1,
    }),
    exec_other: execution('exec_other', 'writer', {
      parentExecutionId: 'exec_lead',
      depth: 1,
      status: 'waiting_approval',
    }),
  };
  return {
    ...emptyProjection('run_tree'),
    status: 'running',
    executions,
    executionOrder: ['exec_lead', 'exec_first', 'exec_retry', 'exec_other'],
  };
}

function renderTree(selectedExecutionId: string | null = null) {
  const onSteer = vi.fn();
  const session = sessionStore({
    runId: 'run_tree',
    definition: linearCorral(['research', 'writer']),
    projection: projection(),
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ExecutionTree
        session={session}
        onSteer={onSteer}
        selectedExecutionId={selectedExecutionId}
      />
    </IntlProvider>,
  );
  return onSteer;
}

describe('execution card tree', () => {
  it('roots the tree at the run and keeps each attempt as its own card under its parent', () => {
    renderTree();
    const tree = screen.getByRole('tree');
    const lead = within(tree)
      .getAllByRole('treeitem')
      .find((item) => item.getAttribute('aria-label')?.startsWith('research'));
    expect(lead).toBeDefined();
    for (const id of ['exec_first', 'exec_retry', 'exec_other'])
      expect(within(lead as HTMLElement).getByTestId(`execution-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId('execution-exec_first')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('execution-exec_retry')).toHaveAttribute('data-status', 'done');
  });

  it('selecting a card chooses that execution and marks it selected', () => {
    const onSteer = renderTree('exec_retry');
    expect(
      screen
        .getAllByRole('treeitem')
        .filter((item) => item.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^writer · exec_first/ }));
    expect(onSteer).toHaveBeenCalledWith('exec_first');
  });

  it('keeps the run root unselectable and the waiting links inside their card', () => {
    renderTree();
    expect(screen.queryByRole('button', { name: /^run_tree/ })).toBeNull();
    const links = within(screen.getByTestId('execution-exec_lead'))
      .getByTestId('waiting-on')
      .querySelectorAll('a');
    expect([...links].map((a) => a.getAttribute('href'))).toEqual([
      '#execution-exec_retry',
      '#execution-exec_other',
    ]);
  });

  it('lists failures and waits in the header without sending a decision', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /1 failed/ }));
    const list = screen.getByRole('dialog');
    await vi.waitFor(() => expect(within(list).getByText('Tool timed out')).toBeVisible());
    expect(within(list).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: /1 needs you/ })).toBeInTheDocument();
  });

  it('shows no estimated cost in the tree', () => {
    renderTree();
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });
});

/** A stress fixture for rendering; it does not change the runtime's iteration limit. */
function loopSession(rounds = 100) {
  const definition = linearCorral(['lead', 'writer', 'reviewer', 'outside']);
  definition.nodes = definition.nodes.map((node) =>
    node.type === 'agent' && ['writer', 'reviewer'].includes(node.id)
      ? { ...node, loopId: 'review_loop' }
      : node,
  );
  definition.nodes.push({ id: 'review_loop', type: 'loop', label: 'Revision', maxIterations: 10 });
  const projected = emptyProjection('run_loops');
  projected.status = 'running';
  projected.executions.exec_lead = execution('exec_lead', 'lead');
  projected.executions.exec_outside = execution('exec_outside', 'outside', {
    parentExecutionId: 'exec_lead',
  });
  projected.executionOrder = ['exec_lead', 'exec_outside'];
  for (let no = 1; no <= rounds; no++) {
    const iterationId = `iteration_${no}`;
    projected.iterations[iterationId] = {
      iterationId,
      loopNodeId: 'review_loop',
      no,
      criteriaVersionId: 'criteria',
      outcome: no === rounds ? null : 'revise',
    };
    const writerId = `exec_write_${no}`;
    const reviewerId = `exec_review_${no}`;
    projected.executions[writerId] = execution(writerId, 'writer', {
      iterationId,
      parentExecutionId: 'exec_lead',
      status: no === rounds ? 'active' : 'succeeded',
    });
    projected.executions[reviewerId] = execution(reviewerId, 'reviewer', {
      iterationId,
      parentExecutionId: writerId,
    });
    projected.executionOrder.push(writerId, reviewerId);
  }
  return sessionStore({ runId: projected.runId, definition, projection: projected });
}

function renderLoopTree(selectedExecutionId: string | null = null) {
  const session = loopSession();
  const onSteer = vi.fn();
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ExecutionTree
        session={session}
        onSteer={onSteer}
        selectedExecutionId={selectedExecutionId}
      />
    </IntlProvider>,
  );
  return { session, onSteer, ...view };
}

describe('bounded loop execution tree', () => {
  it('renders one loop group and only the latest round even after 100 observed rounds', () => {
    const { container } = renderLoopTree();
    const group = screen.getByTestId('loop-group-review_loop');
    expect(group).toHaveTextContent('Revision Loop');
    expect(group).toHaveTextContent('100 observed rounds · max 10');
    expect(screen.getByTestId('execution-exec_write_100')).toBeInTheDocument();
    expect(screen.queryByTestId('execution-exec_write_1')).toBeNull();
    expect(container.querySelectorAll('[data-execution-id]')).toHaveLength(4);
    expect(screen.getAllByRole('treeitem')).toHaveLength(6);
    expect(screen.getByText('4 executions', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('1 running', { exact: true })).toBeInTheDocument();
    expect(within(group).getByRole('combobox', { name: 'Round for Revision' })).toBeInTheDocument();
  });

  it('preserves non-loop siblings and exact parent relationships inside the selected round', () => {
    renderLoopTree();
    const parent = screen.getByTestId('execution-exec_lead').closest('[role="treeitem"]');
    if (!(parent instanceof HTMLElement)) throw new Error('lead treeitem');
    expect(within(parent).getByTestId('loop-group-review_loop')).toBeInTheDocument();
    expect(within(parent).getByTestId('execution-exec_outside')).toBeInTheDocument();
    const writer = screen.getByTestId('execution-exec_write_100').closest('[role="treeitem"]');
    if (!(writer instanceof HTMLElement)) throw new Error('writer treeitem');
    expect(within(writer).getByTestId('execution-exec_review_100')).toBeInTheDocument();
  });

  it('reveals an explicitly selected older execution without changing current loop status', () => {
    const { onSteer } = renderLoopTree('exec_review_2');
    expect(screen.getByTestId('execution-exec_review_2')).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByTestId('execution-exec_review_100')).toBeNull();
    expect(screen.getByTestId('loop-group-review_loop')).toHaveTextContent('Current: round 100');
    fireEvent.click(screen.getByRole('button', { name: /^reviewer · exec_review_2/ }));
    expect(onSteer).toHaveBeenCalledWith('exec_review_2');
  });

  it('changes the inspected round without dispatching a command or replacing current state', async () => {
    const { session, onSteer } = renderLoopTree();
    const original = session.getState().projection;
    await userEvent.click(screen.getByRole('combobox', { name: 'Round for Revision' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Round 99' }));
    expect(await screen.findByTestId('execution-exec_write_99')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('execution-exec_write_100')).toBeNull());
    expect(onSteer).not.toHaveBeenCalled();
    expect(session.getState().projection).toBe(original);
  });

  it('inherits round membership for delegated children with no iteration field', () => {
    const session = loopSession(3);
    const projected = session.getState().projection;
    if (!projected) throw new Error('projection fixture');
    for (let no = 1; no <= 3; no++) {
      const id = `exec_helper_${no}`;
      projected.executions[id] = execution(id, 'helper', { parentExecutionId: `exec_write_${no}` });
      projected.executionOrder.push(id);
    }
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ExecutionTree session={session} onSteer={vi.fn()} />
      </IntlProvider>,
    );
    expect(screen.getByTestId('execution-exec_helper_3')).toBeInTheDocument();
    expect(screen.queryByTestId('execution-exec_helper_1')).toBeNull();
    expect(screen.queryByTestId('execution-exec_helper_2')).toBeNull();
  });

  it('preserves one loop’s inspected round when a link selects another loop', async () => {
    const { session, onSteer, rerender } = renderLoopTree();
    const definition = session.getState().definition;
    const projected = session.getState().projection;
    if (!definition || !projected) throw new Error('two-loop fixture');
    act(() =>
      session.setState({
        definition: {
          ...definition,
          nodes: [
            ...definition.nodes,
            { id: 'second_loop', type: 'loop', label: 'Second', maxIterations: 3 },
          ],
        },
        projection: {
          ...projected,
          iterations: {
            ...projected.iterations,
            second_1: {
              iterationId: 'second_1',
              loopNodeId: 'second_loop',
              no: 1,
              criteriaVersionId: 'criteria',
              outcome: 'revise',
            },
            second_2: {
              iterationId: 'second_2',
              loopNodeId: 'second_loop',
              no: 2,
              criteriaVersionId: 'criteria',
              outcome: null,
            },
          },
          executions: {
            ...projected.executions,
            second_exec_1: execution('second_exec_1', 'second_worker', { iterationId: 'second_1' }),
            second_exec_2: execution('second_exec_2', 'second_worker', { iterationId: 'second_2' }),
          },
          executionOrder: [...projected.executionOrder, 'second_exec_1', 'second_exec_2'],
        },
      }),
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Round for Revision' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Round 99' }));
    expect(await screen.findByTestId('execution-exec_write_99')).toBeInTheDocument();
    rerender(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ExecutionTree session={session} onSteer={onSteer} selectedExecutionId="second_exec_1" />
      </IntlProvider>,
    );
    expect(screen.getByTestId('execution-exec_write_99')).toBeInTheDocument();
    expect(await screen.findByTestId('execution-second_exec_1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('reports an unavailable inspected round instead of substituting a different round', async () => {
    const { session } = renderLoopTree();
    await userEvent.click(screen.getByRole('combobox', { name: 'Round for Revision' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Round 99' }));
    expect(await screen.findByTestId('execution-exec_write_99')).toBeInTheDocument();
    const projected = session.getState().projection;
    if (!projected) throw new Error('projection fixture');
    const iterations = { ...projected.iterations };
    delete iterations.iteration_99;
    act(() =>
      session.setState({
        projection: {
          ...projected,
          iterations,
          executions: {
            ...projected.executions,
            delegated_99: execution('delegated_99', 'helper', {
              parentExecutionId: 'exec_write_99',
            }),
          },
          executionOrder: [...projected.executionOrder, 'delegated_99'],
        },
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('This round is unavailable');
    await waitFor(() => expect(screen.queryByTestId('execution-exec_write_99')).toBeNull());
    expect(screen.queryByTestId('execution-exec_write_100')).toBeNull();
    expect(screen.queryByTestId('execution-delegated_99')).toBeNull();
  });

  it('keeps prior-round inspection to metadata even with cached response text', () => {
    const session = loopSession(3);
    const projected = session.getState().projection;
    if (!projected?.executions.exec_write_2) throw new Error('prior round fixture');
    projected.executions.exec_write_2.modelCallIds = ['call_old'];
    projected.executions.exec_write_2.error = 'Recorded prior error';
    projected.executions.helper_old = execution('helper_old', 'helper', {
      parentExecutionId: 'exec_write_2',
      modelCallIds: ['call_helper_old'],
    });
    projected.executionOrder.push('helper_old');
    session.setState({
      streams: {
        call_old: { text: 'Cached prior writer body', next: 1, broken: false, completed: true },
        call_helper_old: {
          text: 'Cached prior helper body',
          next: 1,
          broken: false,
          completed: true,
        },
      },
    });
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ExecutionTree session={session} onSteer={vi.fn()} selectedExecutionId="helper_old" />
      </IntlProvider>,
    );
    expect(screen.getByTestId('execution-helper_old')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Recorded prior error')).toBeInTheDocument();
    expect(screen.queryByText('Cached prior writer body')).toBeNull();
    expect(screen.queryByText('Cached prior helper body')).toBeNull();
  });
});

it('keeps the editor RunView bounded for 100 observed loop rounds', () => {
  const session = loopSession();
  const { container } = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunView session={session} onSteer={vi.fn()} />
    </IntlProvider>,
  );
  expect(screen.getByTestId('loop-group-review_loop')).toHaveTextContent('100 observed rounds');
  expect(container.querySelectorAll('[data-execution-id]')).toHaveLength(4);
  expect(screen.getByTestId('execution-exec_write_100')).toBeInTheDocument();
  expect(screen.queryByTestId('execution-exec_write_1')).toBeNull();
});
