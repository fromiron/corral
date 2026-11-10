import type { RunEvent } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Timeline } from '../src/components/Timeline.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';

beforeAll(() => {
  // The virtual list measures its scroll box; give it a size in jsdom.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 600,
    right: 800,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  });
});
afterAll(() => vi.restoreAllMocks());

const execution = (
  executionId: string,
  nodeId: string,
  attemptNo = 1,
): RunProjection['executions'][string] => ({
  executionId,
  nodeId,
  taskId: 'task_write',
  attemptNo,
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
});

function event(
  runSeq: number,
  executionId: string,
  seconds: number,
  causes: string[] = [],
): RunEvent {
  return {
    schemaVersion: '0.1',
    eventId: `evt_${runSeq}`,
    runId: 'run_events',
    runSeq,
    recordedAt: new Date(Date.UTC(2026, 10, 7, 0, 0, seconds)).toISOString(),
    causedByEventIds: causes,
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
}

function renderEvents(fill = false, onOpenExecution?: (id: string) => void, headed = true) {
  const { definition } = researchTeamDraft();
  const writer = definition.nodes.find((node) => node.id === 'write')?.label ?? 'write';
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <Timeline
        fill={fill}
        headed={headed}
        {...(onOpenExecution ? { onOpenExecution } : {})}
        session={sessionStore({
          runId: 'run_events',
          definition,
          projection: projectionWith({
            startedAt: '2026-11-07T00:00:00.000Z',
            executions: {
              exec_a: execution('exec_a', 'write'),
              exec_b: execution('exec_b', 'write', 2),
            },
            executionOrder: ['exec_a', 'exec_b'],
          }),
          events: [event(1, 'exec_a', 0), event(2, 'exec_b', 65, ['evt_1'])],
        })}
      />
    </IntlProvider>,
  );
  return writer;
}

it('shows elapsed time per row and opens details only for a chosen event', async () => {
  renderEvents();
  expect(screen.queryByTestId('timeline-selected')).toBeNull();
  const rows = screen.getAllByTestId('timeline-row');
  expect(rows[0]?.textContent).toContain('+0:00');
  expect(rows[1]?.textContent).toContain('+1:05');
  await act(async () => fireEvent.click(within(rows[1] as HTMLElement).getByRole('button')));
  const detail = screen.getByTestId('timeline-selected');
  // Only what the row lacks: the recorded payload, not the kind again.
  expect(detail.textContent).toContain('"toolCallId": "tool_2"');
  expect(detail.textContent).not.toContain('tool.requested');
});

it('filters executions by agent name and attempt rather than by identifier', async () => {
  const writer = renderEvents();
  await act(async () => fireEvent.click(screen.getByRole('combobox', { name: 'Execution' })));
  const options = screen.getAllByRole('option').map((option) => option.textContent ?? '');
  expect(options.some((option) => option.includes(`${writer} · attempt 2`))).toBe(true);
  expect(options.some((option) => option.includes('exec_'))).toBe(false);
});

it('names every column above the list', () => {
  renderEvents(true);
  const columns = screen.getByTestId('timeline-columns');
  expect([...columns.children].map((cell) => cell.textContent)).toEqual([
    '#',
    'Elapsed',
    'Actor',
    'Event',
    'Kind',
  ]);
});

it('gives the list the full width until an event is chosen', async () => {
  renderEvents(true);
  const section = screen.getByRole('region', { name: 'Events' });
  expect(section.className).not.toContain('grid-cols-');
  const row = screen.getAllByTestId('timeline-row')[0] as HTMLElement;
  await act(async () => fireEvent.click(within(row).getByRole('button')));
  expect(section.className).toContain('grid-cols-');
});

it('inside its tab, names nothing the tab says and counts only while a filter is on', async () => {
  const user = userEvent.setup();
  const writer = renderEvents(true, undefined, false);
  // The Events tab already reads "Events 2": no heading, no "2 events of 2".
  expect(screen.queryByRole('heading')).toBeNull();
  expect(screen.queryByTestId('timeline-count')).toBeNull();
  expect(screen.getByRole('region', { name: 'Events' })).toBeInTheDocument();
  await user.click(screen.getByRole('combobox', { name: 'Execution' }));
  await user.click(screen.getByRole('option', { name: `${writer} · attempt 2` }));
  expect(screen.getByTestId('timeline-count').textContent).toBe('1 event of 2');
});

it('marks each actor with its own icon', () => {
  renderEvents(true);
  const icon = (row: HTMLElement) =>
    row.querySelector('[data-actor-icon]')?.getAttribute('data-actor-icon');
  // Both fixture events are recorded by agents.
  for (const row of screen.getAllByTestId('timeline-row')) expect(icon(row)).toBe('agent');
});

it('follows a cause to its event even when the filters hide it', async () => {
  const user = userEvent.setup();
  const writer = renderEvents(true);
  await user.click(screen.getByRole('combobox', { name: 'Execution' }));
  await user.click(screen.getByRole('option', { name: `${writer} · attempt 2` }));
  const rows = screen.getAllByTestId('timeline-row');
  expect(rows).toHaveLength(1);
  await act(async () => fireEvent.click(within(rows[0] as HTMLElement).getByRole('button')));
  const cause = within(screen.getByTestId('timeline-selected')).getByRole('button', { name: /#1/ });
  await act(async () => fireEvent.click(cause));
  // The filter is cleared and the cause is now the chosen row.
  const chosen = screen
    .getAllByTestId('timeline-row')
    .find((row) => within(row).getByRole('button').getAttribute('aria-pressed') === 'true');
  expect(chosen?.dataset.seq).toBe('1');
});

it('opens the execution an event belongs to', async () => {
  const open = vi.fn();
  renderEvents(true, open);
  const rows = screen.getAllByTestId('timeline-row');
  await act(async () => fireEvent.click(within(rows[1] as HTMLElement).getByRole('button')));
  const detail = screen.getByTestId('timeline-selected');
  await act(async () =>
    fireEvent.click(within(detail).getByRole('button', { name: 'Open execution' })),
  );
  expect(open).toHaveBeenCalledWith('exec_b');
});
