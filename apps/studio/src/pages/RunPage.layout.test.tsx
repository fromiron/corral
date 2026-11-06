// @vitest-environment jsdom
import { RunEvent } from '@corral/contracts';
import type { CorralRecord, RuntimeTransport } from '@corral/core';
import { applyEvent, emptyProjection } from '@corral/core';
import { createRunSession, type RunCanvasLayout } from '@corral/react';
import { linearCorral } from '@corral/testkit';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ChatWidgetProvider, useChatWidget } from '../workbench/widgets/useChatWidgets.tsx';
import { RunDetail, type RunDetailSearch } from './RunPage.tsx';

const fixture = vi.hoisted(() => ({ services: {}, replays: 0, pending: 0 }));
vi.mock('@corral/core', async (original) => {
  const module = await original<typeof import('@corral/core')>();
  return {
    ...module,
    // How many questions or approvals wait for the person; the record itself is not needed here.
    pendingInteractions: () => Array.from({ length: fixture.pending }, () => ({})),
  };
});
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ runRoute: {} }));
vi.mock('../workbench/RunStatusCards.tsx', () => ({ RunStatusCards: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useNavigate: () => () => {},
}));
vi.mock('@corral/react', async (original) => {
  const module = await original<typeof import('@corral/react')>();
  return {
    ...module,
    reconstructRunHistory: (...args: Parameters<typeof module.reconstructRunHistory>) => {
      fixture.replays++;
      return module.reconstructRunHistory(...args);
    },
    RunResults: () => <output data-testid="results">Results</output>,
    RunFlowView: () => <output data-testid="run-flow">Work flow</output>,
    ApprovalPanel: ({ onOpenArtifact }: { onOpenArtifact: (id: string) => void }) => (
      <button type="button" onClick={() => onOpenArtifact('artv_evidence')}>
        Approval evidence
      </button>
    ),
    RunCanvas: ({ layout }: { layout: RunCanvasLayout }) => (
      <output data-testid="layout">{JSON.stringify(layout)}</output>
    ),
  };
});

// jsdom does not scroll; focusing a waiting decision asks it to.
Element.prototype.scrollIntoView ??= () => {};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fixture.pending = 0;
});

async function mount(
  corralId: string,
  record: CorralRecord | null,
  search: RunDetailSearch = { view: 'run' },
  request?: string,
) {
  // jsdom has no layout; pointer and resize behavior is checked in the browser.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const definition = linearCorral(['worker'], corralId);
  const projection = {
    ...emptyProjection('run_layout'),
    corralId,
    status: 'succeeded' as const,
    startedAt: '2026-10-26T09:05:00.000Z',
    endedAt: '2026-10-26T09:06:30.000Z',
  };
  const transport = {
    listRuns: async () => [],
    getSnapshot: async () => ({ projection, seq: 0 }),
  } as unknown as RuntimeTransport;
  const run = createRunSession(transport);
  run.setState({ runId: projection.runId, definition, projection, open: async () => {} });
  const repository = {
    list: vi.fn(async () => (record ? [{ corralId }] : [])),
    get: vi.fn(async () => record),
  };
  fixture.services = { runFor: () => run, retainRun: () => () => {}, transport, repository };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const navigations: { patch: RunDetailSearch; options: { replace?: boolean } | undefined }[] = [];
  function Screen() {
    const [selection, setSelection] = useState(search);
    return (
      <RunDetail
        runId={projection.runId}
        {...(request ? { request } : {})}
        search={selection}
        setSearch={(patch, options) => {
          navigations.push({ patch, options });
          setSelection((current) => ({ ...current, ...patch }));
        }}
      />
    );
  }
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Screen />
      </IntlProvider>,
    ),
  );
  return { repository, container, run, navigations };
}

it('an inline handoff run lays out its graph without fetching an unsaved Corral', async () => {
  const { repository, container } = await mount('inline_team', null);
  expect(repository.get).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="layout"]')?.textContent).toContain(
    '"source":"auto"',
  );
});

it('a saved Corral keeps its layout even when its id has the auto prefix', async () => {
  const nodes = Object.fromEntries(
    linearCorral(['worker']).nodes.map((node, i) => [node.id, { x: 10 + i, y: 20 + i }]),
  );
  const { repository, container } = await mount('auto_saved', {
    layout: { nodes },
  } as CorralRecord);
  expect(repository.get).toHaveBeenCalledWith('auto_saved');
  expect(container.querySelector('[data-testid="layout"]')?.textContent).toBe(
    JSON.stringify({ source: 'saved', nodes }),
  );
});

it('a removed Corral still displays its run with an automatic layout', async () => {
  const { repository, container } = await mount('removed_corral', null);
  expect(repository.get).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="layout"]')?.textContent).toContain(
    '"source":"auto"',
  );
});

it('heads the run with its team, start and id over the request, then numbers without cost', async () => {
  const { container } = await mount('inline_team', null, {}, 'Summarise the release');
  const header = container.querySelector('[data-testid="run-header"]');
  expect(header?.querySelector('h2')?.textContent).toBe('Summarise the release');
  const meta = header?.querySelector('[data-run-meta]');
  expect(meta?.textContent).toContain('Linear worker');
  expect(meta?.textContent).toContain('9:05');
  expect(meta?.textContent).toContain('run_layout');
  expect(meta?.querySelector('button[aria-label="Copy run ID"]')).not.toBeNull();
  const stats = header?.querySelector('[data-run-stats]');
  expect(stats?.textContent).toContain('0/0 tasks');
  expect(stats?.textContent).toContain('0 tool calls');
  expect(stats?.textContent).toContain('0 model requests');
  expect(stats?.textContent).toContain('1:30');
  expect(header?.textContent).not.toMatch(/\$|cost/i);
  // The run's own facts sit behind one disclosure, not in the heading lines.
  expect(header?.querySelector('button[aria-expanded="false"]')?.textContent).toContain('Details');
  // No per-agent summary card: the activity heads carry each execution's state.
  expect(container.querySelector('[data-testid="run-summary-card"]')).toBeNull();
  const unnamed = await mount('inline_team', null, {});
  expect(unnamed.container.querySelector('[data-testid="run-header"] h2')?.textContent).toBe(
    'Linear worker',
  );
});

it('a completed run opens its run column, headed by the run, with no page tabs', async () => {
  const summary = await mount('inline_team', null, {});
  const column = summary.container.querySelector('[data-testid="run-column"]');
  expect(column).not.toBeNull();
  // The head scrolls with the activity instead of sitting above it.
  expect(column?.querySelector('[data-testid="run-header"]')).not.toBeNull();
  expect(column?.querySelector('[data-testid="run-activity"]')).not.toBeNull();
  const selected = column?.querySelector('[role="tab"][aria-selected="true"]');
  expect(selected?.textContent).toContain('Activity');
  // The tree is no longer its own column: the activity list chooses executions.
  expect(summary.container.querySelector('[role="tree"]')).toBeNull();
  // Run and results are not two pages any more: results live in the side panel.
  expect(summary.container.querySelector('[aria-label="Run page view"]')).toBeNull();
  expect(summary.container.querySelector('[data-testid="results"]')).toBeNull();
});

it('a results address opens the result in the side panel', async () => {
  for (const search of [{ view: 'results' }, { result: 'artv_result' }] as RunDetailSearch[]) {
    const { container } = await mount('inline_team', null, search);
    const panel = container.querySelector<HTMLElement>('[data-testid="run-side"]');
    expect(panel?.hidden).toBe(false);
    expect(panel?.querySelector('[data-testid="results"]')).not.toBeNull();
  }
});

it('shows the column and the panel side by side once the container holds 640 + 360 px', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  const wide = await mount('inline_team', null, {});
  expect(wide.container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(false);
  expect(wide.container.querySelector<HTMLElement>('[data-testid="run-column"]')?.hidden).toBe(
    false,
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(999);
  const narrow = await mount('inline_team', null, {});
  expect(narrow.container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(
    true,
  );
});

it('secondary views switch under the summary and keep the graph mounted', async () => {
  const { container } = await mount('inline_team', null);
  const tab = async (name: string) => {
    const button = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
      el.textContent?.includes(name),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  await tab('Work flow');
  expect(container.querySelector('[data-testid="run-flow"]')).not.toBeNull();
  await tab('Graph');
  const graph = container.querySelector('[data-testid="layout"]');
  expect(graph).not.toBeNull();
  await tab('Activity');
  await tab('Graph');
  expect(container.querySelector('[data-testid="layout"]')).toBe(graph);
});

it('the right panel shows what needs the person only while something waits', async () => {
  const idle = await mount('inline_team', null, { execution: 'worker' });
  const idlePanel = idle.container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(idlePanel?.hidden).toBe(false);
  expect(idlePanel?.querySelector('[data-testid="run-needs-you"]')).toBeNull();
  expect(idlePanel?.textContent).not.toContain('Nothing needs you');
});

it('the right panel leads with what needs the person and opens execution details', async () => {
  fixture.pending = 1;
  const { container } = await mount('inline_team', null);
  const panel = () => container.querySelector<HTMLElement>('[data-testid="run-side"]');
  // jsdom has no container width: the narrow layout keeps the panel closed until asked. It stays
  // mounted so a Reins draft or graph position survives the switch.
  expect(panel()?.hidden).toBe(true);
  const needs = container.querySelector('[data-testid="run-needs-you"]');
  expect(needs?.closest('[data-testid="run-column"]')).not.toBeNull();
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Approval evidence'))
      ?.click(),
  );
  expect(panel()?.hidden).toBe(false);
  expect(panel()?.querySelector('[data-testid="run-needs-you"]')).not.toBeNull();
  expect(panel()?.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Details');
  // On a narrow container the opened panel takes the column's place.
  expect(container.querySelector<HTMLElement>('[data-testid="run-column"]')?.hidden).toBe(true);
});

it('normalizes an old cursor URL and follows current state without replaying or disabling controls', async () => {
  const { container, run, navigations } = await mount('inline_team', null, { atSeq: 0 });
  expect(container.querySelector('[data-testid="run-status"]')?.textContent).toBe('Succeeded');
  expect(container.querySelector('fieldset[disabled]')).toBeNull();
  expect(container.querySelector('[data-testid="history-mode"]')).toBeNull();
  expect(navigations.at(-1)).toEqual({ patch: { atSeq: undefined }, options: { replace: true } });
  const event = RunEvent.parse({
    schemaVersion: '0.1',
    eventId: 'evt_future',
    runId: 'run_layout',
    runSeq: 1,
    recordedAt: '2026-10-26T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type: 'run.state_changed',
    payload: { from: 'created', to: 'running', reasonCode: 'started' },
  });
  const live = applyEvent(emptyProjection('run_layout'), event);
  await act(async () => run.setState({ projection: live, events: [event] }));
  const replays = fixture.replays;
  await act(async () => {
    for (let i = 0; i < 100; i++)
      run.setState({
        streams: {
          future: { text: String(i), completed: false, broken: false, next: i },
        },
      });
  });
  expect(fixture.replays).toBe(replays);
  expect(container.querySelector('[data-testid="run-status"]')?.textContent).toBe('Running');
  expect(run.getState().projection).toBe(live);
  expect(container.querySelector('fieldset[disabled]')).toBeNull();
  expect(container.querySelector('[aria-label="View time"]')).toBeNull();
});

it('ended requests are not shown in flight', async () => {
  const live = await mount('inline_team', null);
  const projection = live.run.getState().projection;
  if (!projection) throw new Error('missing fixture');
  await act(async () =>
    live.run.setState({
      projection: {
        ...projection,
        status: 'cancelled',
        modelCalls: { pending: { finished: false } as never },
      },
    }),
  );
  expect(live.container.textContent).not.toContain('in flight');
  expect(live.container.textContent).toContain('termination unconfirmed');
});

it('does not list a cancelled tool as a failed step or choose it as the failure destination', async () => {
  const { container, run } = await mount('inline_team', null, { execution: 'worker' });
  const projection = emptyProjection('run_layout');
  projection.status = 'cancelled';
  for (const id of ['stopped', 'failed']) {
    projection.toolCalls[id] = {
      toolCallId: id,
      executionId: 'worker',
      name: 'await_tasks',
      status: 'requested',
      phase: 'failed',
      effectId: id,
      reason: id === 'stopped' ? 'scope cancelled' : 'tool failed',
    };
    projection.effects[id] = {
      effectId: id,
      kind: 'tool',
      scope: 'worker',
      epoch: 1,
      dispatched: true,
      reservationId: null,
      status: 'settled',
      outcome: id === 'stopped' ? 'cancelled' : 'failed',
    };
  }
  await act(async () => run.setState({ projection }));
  expect.soft(container.querySelector('[data-testid="failed-step-stopped"]')).toBeNull();
  expect(container.querySelector('[data-testid="failed-step-failed"]')).not.toBeNull();

  const stopped = projection.toolCalls.stopped;
  if (!stopped) throw new Error('The cancelled tool fixture is missing');
  stopped.executionId = 'cancelled-execution';
  const widgetRoot = createRoot(document.createElement('div'));
  let destination: string | null | undefined;
  function Probe() {
    destination = useChatWidget()?.failedExecutionId;
    return null;
  }
  cleanup.push(async () => {
    await act(async () => widgetRoot.unmount());
  });
  await act(async () =>
    widgetRoot.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatWidgetProvider
          sessionId="session"
          presentationRunId="run_layout"
          runIds={['run_layout']}
          live={false}
        >
          <Probe />
        </ChatWidgetProvider>
      </IntlProvider>,
    ),
  );
  expect(destination).toBe('worker');
});
