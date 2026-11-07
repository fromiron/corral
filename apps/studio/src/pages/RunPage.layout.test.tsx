// @vitest-environment jsdom
import { RunEvent } from '@corral/contracts';
import type { CorralRecord, RuntimeTransport } from '@corral/core';
import { applyEvent, emptyProjection } from '@corral/core';
import { createRunSession, type RunCanvasLayout } from '@corral/react';
import { linearCorral } from '@corral/testkit';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
vi.mock('../workbench/RunStatusCards.tsx', () => ({
  RunStatusCards: () => (
    <details data-testid="status-card">
      <summary>Context</summary>Scope detail
    </details>
  ),
}));
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
    ArtifactViewer: ({ versionId }: { versionId: string }) => (
      <output data-testid="artifact">{versionId}</output>
    ),
    ReinsPanel: ({ target }: { target: { executionId: string } | null }) => (
      <section data-testid="reins-probe">
        <span>{target?.executionId ?? 'Missing target'}</span>
        <textarea aria-label="Instruction" />
      </section>
    ),
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
beforeEach(() => {
  // Browser cases cover measured layout; jsdom needs a visible viewport for lazy views.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});
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
  holdNavigation = false,
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
  let changeSearch: (patch: RunDetailSearch) => void = () => {};
  function Screen() {
    const [selection, setSelection] = useState(search);
    changeSearch = (patch) => setSelection((current) => ({ ...current, ...patch }));
    return (
      <RunDetail
        runId={projection.runId}
        {...(request ? { request } : {})}
        search={selection}
        setSearch={(patch, options) => {
          navigations.push({ patch, options });
          if (!holdNavigation) setSelection((current) => ({ ...current, ...patch }));
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
  return {
    repository,
    container,
    run,
    navigations,
    navigate: (patch: RunDetailSearch) => act(async () => changeSearch(patch)),
  };
}

it('workspace opens the graph first and keeps the empty inspector closed even on wide screens', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container } = await mount('inline_team', null, {});
  const selected = container.querySelector('[aria-label="Execution views"] [aria-selected="true"]');
  expect(selected?.textContent).toContain('Graph');
  expect(container.querySelector('[data-testid="layout"]')?.closest('[hidden]')).toBeNull();
  expect(container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(true);
  expect(container.querySelector('[data-testid="run-dock"]')).toBeNull();
});

it('normalizes a legacy cursor once while a parent update precedes the route commit', async () => {
  const { navigations, navigate } = await mount('inline_team', null, { atSeq: 1 }, undefined, true);
  expect(navigations).toHaveLength(1);
  // The remembered view can update before the asynchronous router commits the URL.
  await navigate({});
  expect(navigations).toHaveLength(1);
  await navigate({ atSeq: undefined });
  await navigate({ atSeq: 1 });
  expect(navigations).toHaveLength(2);
});

it.each([
  { result: 'artv_result' },
  { artifact: 'artv_evidence' },
  { view: 'results' },
] as RunDetailSearch[])(
  'workspace reads an explicit document in the centre without stacking it in the inspector: %j',
  async (search) => {
    const { container } = await mount('inline_team', null, search);
    const document = container.querySelector('[data-testid="results"], [data-testid="artifact"]');
    expect(document?.closest('[data-testid="run-column"]')).not.toBeNull();
    expect(document?.closest('[data-testid="run-side"]')).toBeNull();
    expect(document?.closest('[hidden]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(true);
  },
);

it('workspace preserves the mounted graph and the selected view while opening and closing a result', async () => {
  const { container, navigate } = await mount('inline_team', null, {});
  const graph = container.querySelector('[data-testid="layout"]');
  expect(graph).not.toBeNull();
  await navigate({ result: 'artv_result' });
  expect(graph?.closest('[hidden]')).not.toBeNull();
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Back to work'))
      ?.click();
  });
  expect(container.querySelector('[data-testid="layout"]')).toBe(graph);
  expect(graph?.closest('[hidden]')).toBeNull();
  expect(
    container.querySelector('[aria-label="Execution views"] [aria-selected="true"]')?.textContent,
  ).toContain('Graph');
});

it('workspace preserves expanded inspector details across documents and detail tabs', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, navigate } = await mount('inline_team', null, { execution: 'worker' });
  const details = container.querySelector<HTMLDetailsElement>('[data-testid="status-card"]');
  expect(details).not.toBeNull();
  if (details) details.open = true;
  await navigate({ result: 'artv_result' });
  expect(details?.isConnected).toBe(true);
  await navigate({ result: undefined });
  expect(container.querySelector('[data-testid="status-card"]')).toBe(details);
  expect(details?.open).toBe(true);
  const tab = async (name: string) => {
    const button = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
      el.textContent?.includes(name),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(button?.getAttribute('aria-selected')).toBe('true');
  };
  await tab('Calls');
  expect(details?.isConnected).toBe(true);
  await tab('Overview');
  expect(container.querySelector('[data-testid="status-card"]')).toBe(details);
  expect(details?.open).toBe(true);
});

it('workspace changes inspected executions without silently retargeting an instruction draft', async () => {
  const { container, run, navigate } = await mount('inline_team', null, {
    execution: 'exec_writer',
  });
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        status: 'running',
        executionOrder: ['exec_writer', 'exec_reviewer'],
        executions: Object.fromEntries(
          ['exec_writer', 'exec_reviewer'].map((id) => [
            id,
            {
              executionId: id,
              nodeId: 'worker',
              taskId: id,
              status: 'active',
              attemptNo: 1,
              modelProfile: 'default',
            },
          ]),
        ) as never,
      },
    }),
  );
  expect(container.querySelector('[data-testid="reins-probe"]')).toBeNull();
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent === 'Give instruction')
      ?.click(),
  );
  const draft = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="reins-probe"] textarea',
  );
  expect(draft).not.toBeNull();
  if (draft) draft.value = 'Writer only';
  await navigate({ execution: 'exec_reviewer' });
  expect(container.querySelector('[data-testid="reins-probe"]')?.textContent).toBe('exec_writer');
  await navigate({ result: 'artv_result' });
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Back to work'))
      ?.click(),
  );
  expect(container.querySelector('[data-testid="reins-probe"] textarea')).toBe(draft);
  expect(draft?.value).toBe('Writer only');
});

async function openGraph(container: HTMLElement) {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((element) =>
    element.textContent?.includes('Graph'),
  );
  if (!tab) throw new Error('The Graph tab must exist');
  await act(async () => tab.click());
}

it('an inline handoff run lays out its graph without fetching an unsaved Corral', async () => {
  const { repository, container } = await mount('inline_team', null);
  await openGraph(container);
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
  await openGraph(container);
  expect(repository.get).toHaveBeenCalledWith('auto_saved');
  expect(container.querySelector('[data-testid="layout"]')?.textContent).toBe(
    JSON.stringify({ source: 'saved', nodes }),
  );
});

it('a removed Corral still displays its run with an automatic layout', async () => {
  const { repository, container } = await mount('removed_corral', null);
  await openGraph(container);
  expect(repository.get).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="layout"]')?.textContent).toContain(
    '"source":"auto"',
  );
});

it('heads the run with its team, start and id over the request, then numbers without cost', async () => {
  const { container } = await mount('inline_team', null, {}, 'Summarise the release');
  const header = container.querySelector('[data-testid="run-header"]');
  expect(header?.querySelector('h2')?.textContent).toBe('Summarise the release');
  expect(header?.querySelector('[data-run-meta]')).toBeNull();
  await act(async () =>
    [...container.querySelectorAll('button')].find((el) => el.textContent === 'Run info')?.click(),
  );
  const info = container.querySelector('[data-testid="run-facts"]');
  const meta = info?.querySelector('[data-run-meta]');
  expect(meta?.textContent).toContain('Linear worker');
  expect(meta?.textContent).toContain('9:05');
  expect(meta?.textContent).toContain('run_layout');
  expect(meta?.querySelector('button[aria-label="Copy run ID"]')).not.toBeNull();
  const stats = info?.querySelector('[data-run-stats]');
  expect(stats?.textContent).toContain('0/0 tasks');
  expect(stats?.textContent).toContain('0 tool calls');
  expect(stats?.textContent).toContain('0 model requests');
  expect(header?.textContent).toContain('1:30');
  expect(meta?.closest('[hidden]')).toBeNull();
  expect(header?.textContent).not.toMatch(/\$|cost/i);
  // One explicit information entry opens the inspector; diagnostics do not expand the header.
  expect(header?.querySelector('button[aria-expanded]')).toBeNull();
  // No per-agent summary card: the activity heads carry each execution's state.
  expect(container.querySelector('[data-testid="run-summary-card"]')).toBeNull();
  const unnamed = await mount('inline_team', null, {});
  expect(unnamed.container.querySelector('[data-testid="run-header"] h2')?.textContent).toBe(
    'Linear worker',
  );
});

it('a completed run opens its central graph with the header outside the scrollable workspace', async () => {
  const { container } = await mount('inline_team', null, {});
  const column = container.querySelector('[data-testid="run-column"]');
  expect(column?.querySelector('[data-testid="layout"]')).not.toBeNull();
  expect(column?.querySelector('[data-testid="run-header"]')).toBeNull();
  expect(container.querySelector('[data-testid="run-header"]')).not.toBeNull();
  expect(
    column?.querySelector('[aria-label="Execution views"] [aria-selected="true"]')?.textContent,
  ).toContain('Graph');
  expect(container.querySelector('[role="tree"]')).toBeNull();
  expect(container.querySelector('[data-testid="run-side"]')?.hasAttribute('hidden')).toBe(true);
});

it('a results address opens the result in the central document workspace', async () => {
  for (const search of [{ view: 'results' }, { result: 'artv_result' }] as RunDetailSearch[]) {
    const { container } = await mount('inline_team', null, search);
    expect(container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(true);
    const document = container.querySelector('[data-testid="run-document"]');
    expect(document?.querySelector('[data-testid="results"]')).not.toBeNull();
    expect(document?.closest('[hidden]')).toBeNull();
  }
});

it('shows the selected inspector beside the workspace only when the container fits both', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  const wide = await mount('inline_team', null, { execution: 'worker' });
  expect(wide.container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(false);
  expect(wide.container.querySelector<HTMLElement>('[data-testid="run-column"]')?.hidden).toBe(
    false,
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(999);
  const narrow = await mount('inline_team', null, { execution: 'worker' });
  expect(narrow.container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(
    false,
  );
  expect(narrow.container.querySelector<HTMLElement>('[data-testid="run-column"]')?.hidden).toBe(
    true,
  );
});

it('primary views retain the graph when switching and keep the active view on a repeat press', async () => {
  const { container } = await mount('inline_team', null);
  const tabs = () => [
    ...container.querySelectorAll<HTMLElement>('[aria-label="Execution views"] [role="tab"]'),
  ];
  const tab = async (name: string) => {
    const button = tabs().find((el) => el.textContent?.includes(name));
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  expect(tabs().map((el) => el.textContent)).toEqual([
    expect.stringContaining('Graph'),
    expect.stringContaining('Work flow'),
    expect.stringContaining('Timeline'),
    expect.stringContaining('Events 0'),
  ]);
  const graph = container.querySelector('[data-testid="layout"]');
  await tab('Work flow');
  expect(container.querySelector('[data-testid="run-activity"]')?.closest('[hidden]')).toBeNull();
  await tab('Graph');
  expect(container.querySelector('[data-testid="layout"]')).toBe(graph);
  await tab('Graph');
  expect(graph?.closest('[hidden]')).toBeNull();
  expect(
    tabs()
      .find((el) => el.textContent?.includes('Graph'))
      ?.getAttribute('aria-selected'),
  ).toBe('true');
});

it('keeps the timeline view selection across primary workspace switches', async () => {
  const { container } = await mount('inline_team', null);
  const tab = async (name: string) => {
    const button = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
      el.textContent?.includes(name),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  await tab('Timeline');
  await tab('By task');
  const taskTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
    el.textContent?.includes('By task'),
  );
  expect(taskTab?.getAttribute('aria-selected')).toBe('true');
  await tab('Work flow');
  await tab('Timeline');
  expect(taskTab?.isConnected).toBe(true);
  expect(taskTab?.getAttribute('aria-selected')).toBe('true');
  await tab('Timeline');
  await tab('Timeline');
  expect(taskTab?.isConnected).toBe(true);
  expect(taskTab?.getAttribute('aria-selected')).toBe('true');
});

it('event count updates keep the current tab and mounted filter controls', async () => {
  const { container, run } = await mount('inline_team', null);
  const tab = [
    ...container.querySelectorAll<HTMLElement>('[aria-label="Execution views"] [role="tab"]'),
  ].find((el) => el.textContent?.startsWith('Events'));
  await act(async () => tab?.click());
  const panel = container.querySelector('[data-run-workspace-view="events"]');
  const filter = panel?.querySelector('[role="combobox"]');
  expect(filter).not.toBeNull();
  const event = RunEvent.parse({
    schemaVersion: '0.1',
    eventId: 'evt_new',
    runId: 'run_layout',
    runSeq: 1,
    recordedAt: '2026-10-26T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type: 'run.state_changed',
    payload: { from: 'created', to: 'running', reasonCode: 'started' },
  });
  await act(async () => run.setState({ events: [event] }));
  expect(tab?.textContent).toContain('Events 1');
  expect(tab?.getAttribute('aria-selected')).toBe('true');
  expect(panel?.querySelector('[role="combobox"]')).toBe(filter);
});

it('the right panel shows what needs the person only while something waits', async () => {
  const idle = await mount('inline_team', null, { execution: 'worker' });
  const idlePanel = idle.container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(idlePanel?.hidden).toBe(false);
  expect(idlePanel?.querySelector('[data-testid="run-needs-you"]')).toBeNull();
  expect(idlePanel?.textContent).not.toContain('Nothing needs you');
});

it('pending decisions stay reachable and replace the inspector rather than stacking with details', async () => {
  fixture.pending = 1;
  const { container } = await mount('inline_team', null);
  const panel = () => container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(panel()?.hidden).toBe(true);
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Needs your input'))
      ?.click(),
  );
  expect(panel()?.hidden).toBe(false);
  expect(panel()?.querySelector('[data-testid="run-needs-you"]')).not.toBeNull();
  expect(panel()?.querySelector('[role="tablist"]')?.closest('[hidden]')).not.toBeNull();
  expect(container.querySelector<HTMLElement>('[data-testid="run-column"]')?.hidden).toBe(true);
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Approval evidence'))
      ?.click(),
  );
  expect(panel()?.hidden).toBe(true);
  expect(
    container.querySelector('[data-testid="run-document"] [data-testid="artifact"]')?.textContent,
  ).toBe('artv_evidence');
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Back to work'))
      ?.click(),
  );
  expect(panel()?.hidden).toBe(false);
  expect(panel()?.querySelector('[data-testid="run-needs-you"]')?.closest('[hidden]')).toBeNull();
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
  await act(async () =>
    [...live.container.querySelectorAll('button')]
      .find((el) => el.textContent === 'Run info')
      ?.click(),
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
