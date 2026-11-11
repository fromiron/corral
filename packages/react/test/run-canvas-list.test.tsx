import type { RunEvent } from '@corral/contracts';
import type { ExecutionView, ModelCallView } from '@corral/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { RunCanvas } from '../src/components/RunCanvas.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';

// The graph view answers its question twice (docs/specs/features/execution-monitor.md): the
// relationship map and a list with one row per agent node. Choosing a row is choosing the node.

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});
afterAll(() => vi.restoreAllMocks());

function execution(id: string, nodeId: string, change: Partial<ExecutionView> = {}): ExecutionView {
  return {
    executionId: id,
    nodeId,
    taskId: `task_${nodeId}`,
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
    ...change,
  };
}

const call = (modelCallId: string, executionId: string): ModelCallView => ({
  modelCallId,
  executionId,
  contextSnapshotId: `ctx_${modelCallId}`,
  profile: 'model-a',
  configRevision: 0,
  directiveIds: [],
  inputArtifactVersionIds: [],
  finished: true,
  usage: {
    inputTokens: 98_765,
    outputTokens: 4_321,
    cachedInputTokens: null,
    reasoningTokens: null,
  },
  rawUsage: null,
  certainty: 'reported',
});

let seq = 0;
const event = (type: string, at: string, payload: Record<string, unknown>) =>
  ({ type, runSeq: ++seq, recordedAt: at, payload }) as unknown as RunEvent;

function setup(initial: 'map' | 'list') {
  const { definition } = researchTeamDraft();
  const projection = projectionWith({
    status: 'succeeded',
    executions: {
      writer_1: execution('writer_1', 'write', { status: 'failed' }),
      writer_2: execution('writer_2', 'write', {
        attemptNo: 2,
        iterationId: 'round_2',
        modelCallIds: ['call_writer'],
      }),
      reviewer: execution('reviewer', 'review', { modelProfile: 'model-b' }),
    },
    executionOrder: ['writer_1', 'writer_2', 'reviewer'],
    nodeExecutions: { write: ['writer_1', 'writer_2'], review: ['reviewer'] },
    iterations: {
      round_2: {
        iterationId: 'round_2',
        loopNodeId: 'review_loop',
        no: 2,
        criteriaVersionId: 'criteria',
        parentIterationId: null,
        outcome: null,
      },
    },
    modelCalls: { call_writer: call('call_writer', 'writer_2') },
    modelProfiles: {
      'model-a': {
        profile: 'model-a',
        provider: 'openai',
        modelId: 'gpt-list',
        auth: 'api_key',
      } as never,
    },
  });
  const created = (id: string, nodeId: string, attemptNo: number, iterationId: string | null) => ({
    executionId: id,
    nodeId,
    taskId: `task_${nodeId}`,
    attemptNo,
    iterationId,
  });
  const events = [
    event('execution.created', '2026-11-10T09:00:00.000Z', created('writer_1', 'write', 1, null)),
    event('execution.settled', '2026-11-10T09:00:20.000Z', {
      executionId: 'writer_1',
      outcome: 'failed',
    }),
    event(
      'execution.created',
      '2026-11-10T09:01:00.000Z',
      created('writer_2', 'write', 2, 'round_2'),
    ),
    event('execution.created', '2026-11-10T09:01:30.000Z', created('reviewer', 'review', 1, null)),
    event('execution.settled', '2026-11-10T09:02:05.000Z', {
      executionId: 'writer_2',
      outcome: 'succeeded',
    }),
    event('execution.settled', '2026-11-10T09:02:10.000Z', {
      executionId: 'reviewer',
      outcome: 'succeeded',
    }),
  ];
  const session = sessionStore({ runId: 'run_list', definition, projection, events });
  const onSelect = vi.fn();
  let show: (display: 'map' | 'list') => void = () => {};
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    const [display, setDisplay] = useState(initial);
    show = setDisplay;
    return (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunCanvas
          session={session}
          definition={definition}
          display={display}
          selectedNodeId={selected}
          onSelectNode={(id) => {
            setSelected(id);
            onSelect(id);
          }}
          renderNodePreview={(id) => <p>Preview {id}</p>}
        />
      </IntlProvider>
    );
  }
  render(<Harness />);
  return { onSelect, show: (display: 'map' | 'list') => act(async () => show(display)) };
}

const list = () => screen.getByRole('table', { name: 'Agents' });
const row = (nodeId: string) => {
  const found = list().querySelector<HTMLElement>(`[data-agent-row="${nodeId}"]`);
  if (!found) throw new Error(`Missing row ${nodeId}`);
  return found;
};

it('lists each observed agent once with its model, status, current round and attempt, and observed time', () => {
  setup('list');
  const rows = within(list()).getAllByRole('row').slice(1);
  expect(rows.map((item) => item.getAttribute('data-agent-row'))).toEqual(['write', 'review']);
  const writer = row('write');
  expect(writer).toHaveTextContent('작성');
  expect(writer).toHaveTextContent('gpt-list');
  expect(writer).toHaveTextContent('Done');
  expect(writer).toHaveTextContent('Round 2');
  expect(writer).toHaveTextContent('Attempt 2');
  // The current attempt ran from 09:01:00 to 09:02:05.
  expect(writer).toHaveTextContent('1:05');
  const reviewer = row('review');
  expect(reviewer).toHaveTextContent('검토');
  expect(reviewer).toHaveTextContent('Attempt 1');
  expect(reviewer).not.toHaveTextContent('Round');
  expect(reviewer).toHaveTextContent('0:40');
});

it('shows no usage or cost in the list', () => {
  setup('list');
  const text = list().textContent ?? '';
  expect(text).not.toMatch(/4,?321|98,?765/);
  expect(text).not.toMatch(/token|cost|\$/i);
  expect(
    within(list())
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent),
  ).toEqual(['Agent', 'Model', 'Status', 'Current', 'Elapsed']);
});

it('choosing a row opens the same quick view and reports the same selection as its node', async () => {
  const { onSelect, show } = setup('list');
  const choose = within(row('write')).getByRole('button', { name: /작성/ });
  await act(async () => fireEvent.click(choose));
  expect(await screen.findByText('Preview write')).toBeInTheDocument();
  expect(choose).toHaveAttribute('aria-pressed', 'true');
  expect(onSelect.mock.calls.map((args) => args[0])).toEqual(['write']);
  await show('map');
  const node = document.querySelector<HTMLElement>('[data-agent-id="write"] button');
  expect(node).toHaveAttribute('aria-pressed', 'true');
  await act(async () => fireEvent.click(node as HTMLElement));
  expect(await screen.findByText('Preview write')).toBeInTheDocument();
  expect(onSelect.mock.calls.map((args) => args[0])).toEqual(['write', 'write']);
});

it('keeps the relationship map mounted while the list is shown', async () => {
  const { show } = setup('map');
  const pane = document.querySelector('[data-graph-pane]');
  expect(pane).not.toBeNull();
  await show('list');
  expect(list()).toBeVisible();
  expect(document.querySelector('[data-graph-pane]')).toBe(pane);
  expect(pane?.closest('[hidden]')).not.toBeNull();
  await show('map');
  expect(document.querySelector('[data-graph-pane]')).toBe(pane);
  expect(pane?.closest('[hidden]')).toBeNull();
  expect(screen.queryByRole('table', { name: 'Agents' })).toBeNull();
});
