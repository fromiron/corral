// @vitest-environment jsdom
import { type EventOf, RunEvent } from '@corral/contracts';
import { applyEvent, emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunTimeChart } from './RunTimeChart.tsx';

const RUN = 'run_time';
const START = Date.parse('2026-10-15T00:00:00.000Z');

function event<K extends RunEvent['type']>(
  seq: number,
  type: K,
  payload: EventOf<K>['payload'],
  ms: number,
): EventOf<K> {
  return RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `evt_${seq}`,
    runId: RUN,
    runSeq: seq,
    recordedAt: new Date(START + ms).toISOString(),
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type,
    payload,
  }) as EventOf<K>;
}

const created = (
  seq: number,
  executionId: string,
  nodeId: string,
  ms: number,
  extra: { parent?: string; attempt?: number; previous?: string } = {},
) =>
  event(
    seq,
    'execution.created',
    {
      executionId,
      nodeId,
      taskId: `task_${nodeId}`,
      attemptNo: extra.attempt ?? 1,
      previousExecutionId: extra.previous,
      parentExecutionId: extra.parent ?? null,
      depth: extra.parent ? 1 : 0,
      iterationId: null,
      modelProfile: 'model-a',
    },
    ms,
  );

const settled = (seq: number, executionId: string, outcome: 'succeeded' | 'failed', ms: number) =>
  event(seq, 'execution.settled', { executionId, outcome, terminationMode: 'normal' }, ms);

/** A lead delegates to a writer that fails once and is retried; the lead is still open. */
function fixture() {
  const events = [
    created(1, 'exec_lead', 'lead', 0),
    created(2, 'exec_w1', 'writer', 1000, { parent: 'exec_lead' }),
    settled(3, 'exec_w1', 'failed', 4000),
    created(4, 'exec_w2', 'writer', 5000, { parent: 'exec_lead', attempt: 2, previous: 'exec_w1' }),
    settled(5, 'exec_w2', 'succeeded', 9000),
    event(
      6,
      'artifact.version_created',
      {
        artifactId: 'artifact_draft',
        artifactVersionId: 'draft_v1',
        name: 'draft',
        version: 1,
        parentVersionId: null,
        authorExecutionId: 'exec_w2',
        contract: 'text',
        contentHash: 'a'.repeat(64),
        byteLength: 10,
        modelCallId: null,
        contextSnapshotId: null,
      },
      9000,
    ),
    // The lead reads the writer's draft: work handed back along the lanes.
    event(
      7,
      'artifact.read',
      { requestedRef: 'draft', resolvedVersionId: 'draft_v1', consumerExecutionId: 'exec_lead' },
      9000,
    ),
    // The lead is still working: it waits on its writer's result.
    event(
      8,
      'execution.state_changed',
      {
        executionId: 'exec_lead',
        from: 'queued',
        to: 'waiting_children',
        activity: null,
        waitingOn: null,
      },
      9000,
    ),
  ] as RunEvent[];
  const projection = events.reduce(applyEvent, emptyProjection(RUN));
  return { events, projection, definition: linearCorral(['lead', 'writer']) };
}

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
});

function show(selected?: string, ended = false) {
  const { events, projection: observed, definition } = fixture();
  const projection = ended ? { ...observed, status: 'succeeded' as const } : observed;
  const onSelect = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunTimeChart
          events={events}
          projection={projection}
          definition={definition}
          selected={selected}
          onSelect={onSelect}
        />
      </IntlProvider>,
    ),
  );
  roots.push(() => {
    root.unmount();
    container.remove();
  });
  return { container, onSelect };
}

it('draws one lane per agent node with each attempt as its own span', () => {
  const { container } = show();
  const lanes = [...container.querySelectorAll('ul[aria-label]')].map((lane) =>
    lane.getAttribute('aria-label'),
  );
  expect(lanes).toEqual(['lead', 'writer']);
  const writer = container.querySelector('ul[aria-label="writer"]');
  expect(writer?.querySelectorAll('[data-execution-id]')).toHaveLength(2);
});

it('selects an execution from its span and marks only that span', () => {
  const { container, onSelect } = show('exec_w2');
  const pressed = container.querySelectorAll('[data-execution-id][aria-pressed="true"]');
  expect([...pressed].map((span) => span.getAttribute('data-execution-id'))).toEqual(['exec_w2']);
  const first = container.querySelector<HTMLButtonElement>('[data-execution-id="exec_w1"]');
  act(() => first?.click());
  expect(onSelect).toHaveBeenCalledWith('exec_w1');
});

it('in an ended run, ends an open span at the last record and links observed delegation', () => {
  const { container } = show(undefined, true);
  const lead = container.querySelector('[data-execution-id="exec_lead"]');
  // The lead never settled: its span runs to the last record (9 s), the full window.
  expect(lead?.closest('li')?.getAttribute('style')).toMatch(/left: 0%; width: 100%/);
  const links = [...container.querySelectorAll('[data-handoff]')].map((path) =>
    path.getAttribute('data-handoff'),
  );
  // Delegations leave the lead as each writer starts; the draft returns to the lead when read.
  expect(links).toEqual(['exec_lead>exec_w1', 'exec_lead>exec_w2', 'exec_w2>exec_lead']);
});

it('stacks concurrent executions of one node on their own tracks instead of covering each other', () => {
  const events = [
    created(1, 'exec_lead', 'lead', 0),
    created(2, 'exec_a', 'writer', 1000, { parent: 'exec_lead' }),
    created(3, 'exec_b', 'writer', 1000, { parent: 'exec_lead' }),
    settled(4, 'exec_a', 'succeeded', 5000),
    settled(5, 'exec_b', 'succeeded', 5000),
  ] as RunEvent[];
  const projection = events.reduce(applyEvent, emptyProjection(RUN));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunTimeChart
          events={events}
          projection={projection}
          definition={linearCorral(['lead', 'writer'])}
          selected={undefined}
          onSelect={() => {}}
        />
      </IntlProvider>,
    ),
  );
  roots.push(() => {
    root.unmount();
    container.remove();
  });
  const tops = ['exec_a', 'exec_b'].map(
    (id) => container.querySelector(`[data-execution-id="${id}"]`)?.closest('li')?.style.top ?? '',
  );
  expect(tops[0]).not.toBe('');
  expect(tops[0]).not.toBe(tops[1]);
});

it('names each span by what its execution created and numbers only later attempts', () => {
  const { container } = show();
  const span = (id: string) => container.querySelector(`[data-execution-id="${id}"]`)?.textContent;
  expect(span('exec_w2')).toContain('draft');
  expect(span('exec_w2')).toContain('Attempt 2');
  expect(span('exec_w1')).toContain('writer');
  expect(span('exec_w1')).not.toContain('Attempt');
});

it('a live run marks now and an ended run offers a replay instead', () => {
  const live = show();
  expect(live.container.textContent).toContain('Now');
  expect(live.container.querySelector('button[data-replay]')).toBeNull();
  const ended = show(undefined, true);
  expect(ended.container.querySelector('button[data-replay]')).not.toBeNull();
});

it('a replay draws the recorded spans again from the start without changing the record', () => {
  vi.useFakeTimers();
  try {
    const { container } = show(undefined, true);
    const spans = () =>
      [...container.querySelectorAll('[data-execution-id]')].map((span) =>
        span.getAttribute('data-execution-id'),
      );
    expect(spans()).toEqual(expect.arrayContaining(['exec_lead', 'exec_w1', 'exec_w2']));
    act(() => container.querySelector<HTMLButtonElement>('button[data-replay]')?.click());
    act(() => vi.advanceTimersByTime(50));
    expect(spans()).not.toContain('exec_w2');
    act(() => vi.advanceTimersByTime(10_000));
    expect(spans()).toEqual(expect.arrayContaining(['exec_lead', 'exec_w1', 'exec_w2']));
  } finally {
    vi.useRealTimers();
  }
});

const task = (seq: number, taskId: string, nodeId: string, ms: number) =>
  event(
    seq,
    'task.created',
    { taskId, nodeId, roleId: 'role', contract: 'text', dependsOnTaskIds: [] },
    ms,
  );
const assigned = (
  seq: number,
  taskId: string,
  executionId: string,
  attemptNo: number,
  ms: number,
) => event(seq, 'task.attempt_assigned', { taskId, executionId, attemptNo }, ms);

/** Three tasks: the writer's finished after a retry, the lead's is open, a review never started. */
function taskFixture(ended: boolean) {
  const events = [
    task(1, 'task_lead', 'lead', 0),
    task(2, 'task_writer', 'writer', 0),
    task(3, 'task_review', 'review', 0),
    created(4, 'exec_lead', 'lead', 0),
    assigned(5, 'task_lead', 'exec_lead', 1, 0),
    created(6, 'exec_w1', 'writer', 1000, { parent: 'exec_lead' }),
    assigned(7, 'task_writer', 'exec_w1', 1, 1000),
    settled(8, 'exec_w1', 'failed', 4000),
    created(9, 'exec_w2', 'writer', 5000, { parent: 'exec_lead', attempt: 2, previous: 'exec_w1' }),
    assigned(10, 'task_writer', 'exec_w2', 2, 5000),
    event(11, 'task.submitted', { taskId: 'task_writer', artifactVersionIds: ['draft_v1'] }, 8000),
    event(12, 'task.completed', { taskId: 'task_writer', completionEvidence: 'accepted' }, 9000),
    settled(13, 'exec_w2', 'succeeded', 9000),
  ] as RunEvent[];
  const observed = events.reduce(applyEvent, emptyProjection(RUN));
  const projection = {
    ...observed,
    status: ended ? ('succeeded' as const) : observed.status,
    artifacts: {
      ...observed.artifacts,
      draft_v1: { name: 'draft' } as (typeof observed.artifacts)[string],
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunTimeChart
          events={events}
          projection={projection}
          definition={linearCorral(['lead', 'writer', 'review'])}
          selected={undefined}
          onSelect={() => {}}
        />
      </IntlProvider>,
    ),
  );
  roots.push(() => {
    root.unmount();
    container.remove();
  });
  const byTask = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) =>
    tab.textContent?.includes('By task'),
  );
  act(() => byTask?.click());
  return container;
}

it('switches to a timeline per task drawn from its actual record, with no plan marks', () => {
  const container = taskFixture(true);
  const rows = [...container.querySelectorAll<HTMLElement>('[data-task-id]')];
  expect(rows.map((row) => row.dataset.taskId)).toEqual([
    'task_lead',
    'task_writer',
    'task_review',
  ]);
  const writer = rows[1]?.getAttribute('aria-label') ?? '';
  // Named by its node and what it submitted; it ran from its first attempt to its completion.
  expect(writer).toContain('writer · draft');
  expect(writer).toContain('0:08');
  expect(rows[1]?.dataset.status).toBe('done');
  // Never assigned: waiting, with no interval.
  expect(rows[2]?.dataset.status).toBe('queued');
  expect(rows[2]?.getAttribute('aria-label')).not.toMatch(/\d:\d\d/);
  // Nothing was planned, so nothing claims a plan, an ETA or a verdict.
  const board = container.querySelector('[data-task-id]')?.closest('[role="list"]');
  expect(board?.textContent).not.toMatch(/ETA|On plan|Over plan|ahead/);
  expect(board?.querySelector('.border-dashed')).toBeNull();
});

it('a live run keeps an unfinished task open', () => {
  const container = taskFixture(false);
  const lead = container.querySelector<HTMLElement>('[data-task-id="task_lead"]');
  expect(lead?.dataset.status).toBe('running');
});
