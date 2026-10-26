import { emptyProjection, type RunProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/components/RunView.tsx';
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

/** Two Loop rounds of the writer, and a researcher waiting for its two helpers. */
function projection(): RunProjection {
  const base = emptyProjection('run_view');
  const executions = {
    exec_w1: execution('exec_w1', 'writer', { iterationId: 'iter_1' }),
    exec_w2: execution('exec_w2', 'writer', { iterationId: 'iter_2', status: 'active' }),
    exec_r: execution('exec_r', 'research', {
      status: 'waiting_children',
      waitingOn: {
        kind: 'children',
        targetIds: ['exec_h1', 'exec_h2'],
        reasonCode: 'awaiting_delegated_tasks',
        since: '2026-10-15T00:00:00.000Z',
        deadline: null,
        required: true,
      },
    }),
    exec_h1: execution('exec_h1', 'research', { parentExecutionId: 'exec_r', depth: 1 }),
    exec_h2: execution('exec_h2', 'research', {
      parentExecutionId: 'exec_r',
      depth: 1,
      status: 'active',
    }),
  };
  return {
    ...base,
    status: 'running',
    executions,
    executionOrder: ['exec_w1', 'exec_w2', 'exec_r', 'exec_h1', 'exec_h2'],
    nodeExecutions: { writer: ['exec_w1', 'exec_w2'], research: ['exec_r', 'exec_h1', 'exec_h2'] },
    iterations: {
      iter_1: {
        iterationId: 'iter_1',
        loopNodeId: 'loop',
        no: 1,
        criteriaVersionId: 'c',
        outcome: 'revise',
      },
      iter_2: {
        iterationId: 'iter_2',
        loopNodeId: 'loop',
        no: 2,
        criteriaVersionId: 'c',
        outcome: null,
      },
    },
    loopIterations: { loop: ['iter_1', 'iter_2'] },
  };
}

function renderView() {
  const session = sessionStore({
    runId: 'run_view',
    definition: linearCorral(['research', 'writer']),
    projection: projection(),
  });
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunView session={session} onSteer={vi.fn()} />
    </IntlProvider>,
  );
}

describe('RunView execution tree', () => {
  it('shows each Loop round of a node as its own execution', () => {
    renderView();
    const first = screen.getByTestId('execution-exec_w1');
    const second = screen.getByTestId('execution-exec_w2');
    expect(first).toHaveTextContent('Round 1');
    expect(second).toHaveTextContent('Round 2');
    expect(second).not.toBe(first);
  });

  it('names what a waiting execution waits for, linking the real children', () => {
    renderView();
    const parent = screen.getByTestId('execution-exec_r');
    const reason = within(parent).getByTestId('waiting-on');
    expect(reason).toHaveTextContent('Waiting for 2 delegated tasks');
    const links = within(reason).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#execution-exec_h1',
      '#execution-exec_h2',
    ]);
    // Each link points at a row that exists, nested under the waiting parent.
    for (const link of links) {
      const target = document.getElementById(link.getAttribute('href')?.slice(1) ?? '');
      expect(target).not.toBeNull();
      expect(parent.contains(target)).toBe(true);
    }
  });

  it('shows what an active execution is writing while its request streams', () => {
    const p = projection();
    const active = p.executions.exec_w2;
    if (!active) throw new Error('fixture');
    active.modelCallIds = ['call_live'];
    p.modelCalls.call_live = {
      modelCallId: 'call_live',
      executionId: 'exec_w2',
      contextSnapshotId: 'ctx',
      profile: 'model-a',
      configRevision: 0,
      directiveIds: [],
      inputArtifactVersionIds: [],
      finished: false,
      rawUsage: null,
      usage: null,
      certainty: null,
    };
    const session = sessionStore({
      runId: 'run_view',
      definition: linearCorral(['research', 'writer']),
      projection: p,
      streams: { call_live: { text: 'Partial answer', next: 1, broken: false } },
    });
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunView session={session} onSteer={vi.fn()} />
      </IntlProvider>,
    );
    expect(
      within(screen.getByTestId('execution-exec_w2')).getByTestId('live-text'),
    ).toHaveTextContent('Partial answer');
    expect(within(screen.getByTestId('execution-exec_w1')).queryByTestId('live-text')).toBeNull();
  });

  it('exposes the run status for people and tests', () => {
    renderView();
    expect(screen.getByTestId('run-status')).toHaveTextContent('Running');
  });
});
