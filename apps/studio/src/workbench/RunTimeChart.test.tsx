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
  ] as RunEvent[];
  const projection = events.reduce(applyEvent, emptyProjection(RUN));
  return { events, projection, definition: linearCorral(['lead', 'writer']) };
}

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
});

function show(selected?: string) {
  const { events, projection, definition } = fixture();
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

it('ends an open span at the last record and links observed delegation', () => {
  const { container } = show();
  const lead = container.querySelector('[data-execution-id="exec_lead"]');
  // The lead never settled: its span runs to the last record (9 s), the full window.
  expect(lead?.closest('li')?.getAttribute('style')).toMatch(/left: 0%; width: 100%/);
  const links = [...container.querySelectorAll('[data-handoff]')].map((path) =>
    path.getAttribute('data-handoff'),
  );
  expect(links).toEqual(['exec_lead>exec_w1', 'exec_lead>exec_w2']);
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
