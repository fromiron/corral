// @vitest-environment jsdom
import { type EventOf, RunEvent } from '@corral/contracts';
import { applyEvent, emptyProjection } from '@corral/core';
import { ExecutionToolRows, executionToolEntries } from '@corral/react';
import { linearCorral } from '@corral/testkit';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunPlanCard, RunPlanStrip } from './RunActivity.tsx';

const RUN = 'run_activity';
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

/** A lead delegates to a writer that fails once and is retried; the retry reads a source. */
function fixture() {
  const events = [
    created(1, 'exec_lead', 'lead', 0),
    created(2, 'exec_w1', 'writer', 1000, { parent: 'exec_lead' }),
    event(
      3,
      'execution.settled',
      { executionId: 'exec_w1', outcome: 'failed', terminationMode: 'normal' },
      4000,
    ),
    created(4, 'exec_w2', 'writer', 5000, { parent: 'exec_lead', attempt: 2, previous: 'exec_w1' }),
    event(
      5,
      'tool.requested',
      {
        executionId: 'exec_w2',
        toolCallId: 'call_1',
        name: 'read_source',
        validatedArgs: { path: 'a.md' },
      },
      5500,
    ),
    event(
      6,
      'tool.allowed',
      { executionId: 'exec_w2', toolCallId: 'call_1', policyVersion: 'p1' },
      5600,
    ),
    event(
      7,
      'tool.started',
      { executionId: 'exec_w2', toolCallId: 'call_1', effectId: 'eff_1' },
      5700,
    ),
    event(
      8,
      'tool.finished',
      { executionId: 'exec_w2', toolCallId: 'call_1', resultRef: null, error: null },
      6200,
    ),
    event(
      9,
      'execution.settled',
      { executionId: 'exec_w2', outcome: 'succeeded', terminationMode: 'normal' },
      9000,
    ),
  ] as RunEvent[];
  const projection = events.reduce(applyEvent, emptyProjection(RUN));
  return { events, projection, definition: linearCorral(['lead', 'writer']) };
}

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  vi.unstubAllGlobals();
});

function show(node: React.ReactNode) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </IntlProvider>,
    ),
  );
  roots.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

it('shows no card without a work plan', () => {
  const { projection } = fixture();
  const container = show(<RunPlanCard projection={projection} plan={null} />);
  expect(container.textContent).toBe('');
});

/** One finished (or failed) call of `name` by the writer's retry, from request to end. */
function call(seq: number, id: string, name: string, ms: number, error: string | null = null) {
  return [
    event(
      seq,
      'tool.requested',
      { executionId: 'exec_w2', toolCallId: id, name, validatedArgs: {} },
      ms,
    ),
    event(
      seq + 1,
      'tool.allowed',
      { executionId: 'exec_w2', toolCallId: id, policyVersion: 'p1' },
      ms,
    ),
    event(
      seq + 2,
      'tool.started',
      { executionId: 'exec_w2', toolCallId: id, effectId: `eff_${id}` },
      ms,
    ),
    event(
      seq + 3,
      'tool.finished',
      { executionId: 'exec_w2', toolCallId: id, resultRef: null, error },
      ms + 100,
    ),
  ] as RunEvent[];
}

/** The writer's retry's own calls, as the run record's tool rows list them. */
const toolsOf = (events: RunEvent[]) => executionToolEntries(events).get('exec_w2') ?? [];

function repeated(failed: boolean) {
  const base = fixture();
  const settled = base.events.at(-1) as RunEvent;
  const events = [
    ...base.events.slice(0, -1),
    event(
      19,
      'execution.state_changed',
      { executionId: 'exec_w2', from: 'queued', to: 'active', activity: 'tool', waitingOn: null },
      6250,
    ),
    ...call(20, 'call_2', 'read_source', 6300),
    ...call(30, 'call_3', 'read_source', 6600, failed ? 'not found' : null),
    ...call(40, 'call_4', 'write_draft', 7000),
    ...call(50, 'call_5', 'read_source', 7400),
    settled,
  ].map((item, index) => ({ ...item, runSeq: index + 1, eventId: `evt_${index + 1}` }) as RunEvent);
  const projection = events.reduce(applyEvent, emptyProjection(RUN));
  return { events, projection, definition: base.definition };
}

it('folds consecutive calls of the same tool into one row, folded unless one failed', () => {
  for (const failed of [false, true]) {
    const { events } = repeated(failed);
    const container = show(<ExecutionToolRows tools={toolsOf(events)} />);
    const entry = container;
    const folds = [...entry.querySelectorAll('[data-tool-repeat]')];
    // read_source ×3, then write_draft, then a lone read_source: only the run of three folds.
    expect(folds).toHaveLength(1);
    expect(folds[0]?.textContent).toContain('read_source ×3');
    expect(folds[0]?.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe(
      String(failed),
    );
    expect(entry.textContent).toContain('write_draft');
    act(() => container.remove());
  }
});

it('folds a repeated tool once its running call settles', () => {
  const { events, projection } = repeated(false);
  // Up to the third read_source's start: that call is still running.
  const cut = events.findIndex(
    (item) => item.type === 'tool.finished' && item.payload.toolCallId === 'call_3',
  );
  const running = events.slice(0, cut);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(() => {
    root.unmount();
    container.remove();
  });
  const render = (list: RunEvent[]) =>
    act(() =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ExecutionToolRows tools={toolsOf(list)} />
        </IntlProvider>,
      ),
    );
  const expanded = () =>
    container.querySelector('[data-tool-repeat] [aria-expanded]')?.getAttribute('aria-expanded');
  render(running);
  expect(expanded()).toBe('true');
  render(events);
  expect(projection.toolCalls.call_3?.phase).toBe('finished');
  expect(expanded()).toBe('false');
});

it('summarizes a work plan by its items and completed count', () => {
  const { projection } = fixture();
  const container = show(
    <RunPlanCard
      projection={projection}
      plan={{
        items: [
          { id: 'a', title: 'Read the brief', status: 'completed' },
          { id: 'b', title: 'Draft the summary', status: 'in_progress' },
          { id: 'c', title: 'Check the sources', status: 'pending' },
        ],
      }}
    />,
  );
  expect(container.textContent).toContain('1/3 done');
  expect(container.textContent).toContain('Draft the summary');
  expect(container.querySelector('[data-summary-node]')).toBeNull();
});

it('folds the work plan into one line with progress and the current step until opened', () => {
  const { projection } = fixture();
  const container = show(
    <RunPlanStrip
      projection={projection}
      plan={{
        items: [
          { id: 'a', title: 'Read the brief', status: 'completed' },
          { id: 'b', title: 'Draft the summary', status: 'in_progress' },
          { id: 'c', title: 'Check the sources', status: 'pending' },
        ],
      }}
      planCount={1}
      allPlans={<p>every plan</p>}
    />,
  );
  const toggle = container.querySelector('button[aria-expanded]');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(toggle?.textContent).toContain('1/3 done');
  expect(toggle?.textContent).toContain('Draft the summary');
  expect(container.textContent).not.toContain('Check the sources');
  act(() => (toggle as HTMLButtonElement).click());
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  expect(container.textContent).toContain('Check the sources');
  expect(container.textContent).not.toContain('every plan');
});

it('opens every plan when several were recorded, and shows nothing without one', () => {
  const { projection } = fixture();
  const several = show(
    <RunPlanStrip projection={projection} plan={null} planCount={2} allPlans={<p>every plan</p>} />,
  );
  const toggle = several.querySelector('button[aria-expanded]') as HTMLButtonElement;
  expect(toggle.textContent).toContain('2');
  act(() => toggle.click());
  expect(several.textContent).toContain('every plan');
  const none = show(
    <RunPlanStrip projection={projection} plan={null} planCount={0} allPlans={<p>every plan</p>} />,
  );
  expect(none.textContent).toBe('');
});
