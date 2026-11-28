// @vitest-environment jsdom
import type { ArtifactVersionView, RunProjection, RunSummary, WorkSession } from '@corral/core';
import { emptyProjection } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { SessionSearch } from '../panels/routes.ts';
import { listedRunPresence } from '../sessionList.ts';
import { ArtifactsPanel, ChecksPanel, RunPanel } from './SessionPanels.tsx';

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  folder: { binding: null } as Record<string, unknown>,
}));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../../pages/FilesViews.tsx', () => ({ useBinding: () => fixture.folder }));
vi.mock('../../pages/changes/ReviewPage.tsx', () => ({
  Checks: ({ folderFailed }: { folderFailed?: string | null }) =>
    folderFailed ? <p>folder {folderFailed}</p> : null,
}));
// The run record has its own tests; here it shows the line the panel puts above its header.
vi.mock('../../pages/run/RunPage.tsx', () => ({
  RunDetail: ({
    runId,
    lead,
    conversationOperable,
  }: {
    runId: string;
    lead?: ReactNode;
    conversationOperable?: boolean;
  }) => (
    <section data-testid="run-header" data-run={runId} data-operable={String(conversationOperable)}>
      {lead}
      <h2 data-run-title tabIndex={-1}>
        {runId}
      </h2>
    </section>
  ),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  fixture.folder = { binding: null };
});

it('tells Checks when the folder link could not be read', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.services = { workspaces: {} };
  fixture.folder = { binding: undefined, failed: 'offline' };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChecksPanel
          session={{ sessionId: 'session', projectId: 'project' } as WorkSession}
          onAttach={() => {}}
        />
      </IntlProvider>,
    ),
  );
  expect(container.textContent).toContain('folder offline');
});

const version = (id: string, artifactId: string): ArtifactVersionView => ({
  artifactVersionId: id,
  artifactId,
  name: artifactId,
  version: 1,
  parentVersionId: null,
  contract: 'draft',
  contentHash: `hash-${id}`,
  byteLength: 10,
  authorExecutionId: 'exec_write',
  modelCallId: null,
  contextSnapshotId: null,
  submitted: true,
  configRevision: 0,
  criteriaVersionId: null,
  inputArtifactVersionIds: [],
});

it('lists a partial result the run no longer keeps as a row that cannot be opened', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // A failed run keeps each step's last submission (here the one its fork carried); the
  // other version it made was released when it ended (api-contract.md, 산출물 본문 수명).
  const projection: RunProjection = {
    ...emptyProjection('run_a'),
    status: 'failed',
    artifacts: { kept: version('kept', 'draft'), gone: version('gone', 'notes') },
    forkedFrom: {
      runId: 'run_0',
      nodeId: 'write',
      carried: [{ nodeId: 'write', artifactVersionIds: ['kept'] }],
    },
  };
  fixture.services = {
    transport: {
      getSnapshot: async () => ({ projection }),
      getRunDefinition: async () => ({ nodes: [] }),
    },
  };
  const runs = [{ runId: 'run_a', status: 'failed' } as RunSummary];
  const onOpen = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ArtifactsPanel runs={runs} onOpen={onOpen} onOpenRun={() => {}} />
      </IntlProvider>,
    ),
  );
  await act(async () => {});
  const rows = [...container.querySelectorAll('section[aria-label] li')];
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('notes v1'),
    expect.stringContaining('draft v1'),
  ]);
  const [gone, kept] = rows;
  // The released one says so and offers nothing to open.
  expect(gone?.querySelector('button')).toBeNull();
  expect(gone?.textContent).toContain('Text no longer kept');
  // The kept one opens as before.
  const open = kept?.querySelector('button');
  expect(open?.getAttribute('aria-label')).toBe('Partial results draft v1 · Run #1');
  // The row already names its run (Run #1); no raw run id shows as a tooltip.
  expect(open?.hasAttribute('title')).toBe(false);
  expect(kept?.innerHTML).not.toContain('run_a');
  expect(kept?.textContent).not.toContain('Text no longer kept');
  await act(async () => open?.click());
  expect(onOpen).toHaveBeenCalledWith('run_a', 'kept');
});

const summary = (runId: string, status: RunSummary['status']): RunSummary => ({
  runId,
  status,
  corralId: 'team',
  projectId: 'project',
  sessionId: 'session',
  startedAt: '2026-11-16T00:00:00Z',
});

async function showRunPanel(
  runs: RunSummary[],
  active: RunSummary | null,
  search: SessionSearch,
  /** The conversation beside the panel can be operated; by default it is covered (maximized). */
  operable = false,
  /** The run going has a tab of its own in the strip. */
  activeTabbed = false,
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.services = { transport: { getRunDefinition: async () => null } };
  const setSearch = vi.fn();
  const onOpenRun = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  // A run tab holds one run, the one the address names.
  const render = (
    next: SessionSearch,
    listedRuns: RunSummary[] = runs,
    going: RunSummary | null = active,
  ) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <RunPanel
            runId={next.run ?? ''}
            runs={listedRuns}
            active={going}
            entries={[]}
            search={next}
            setSearch={setSearch}
            operable={operable}
            activeTabbed={activeTabbed}
            onOpenRun={onOpenRun}
          />
        </IntlProvider>,
      ),
    );
  await render(search);
  return {
    container,
    setSearch,
    onOpenRun,
    render,
    line: () => container.querySelector('[data-testid="run-active-elsewhere"]'),
  };
}

const past = summary('run_past', 'succeeded');
const going = summary('run_going', 'running');
const stateWord = (run: RunSummary) =>
  messages.Presence.state[
    listedRunPresence(run).labelKey.split('.')[1] as keyof typeof messages.Presence.state
  ];

const results = async (
  byRun: Record<string, RunProjection>,
  runs: RunSummary[],
  nodes: { id: string; label: string }[] = [],
) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.services = {
    transport: {
      getSnapshot: async (runId: string) => ({ projection: byRun[runId] }),
      getRunDefinition: async () => ({ nodes }),
    },
  };
  const onOpen = vi.fn();
  const onOpenRun = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ArtifactsPanel runs={runs} onOpen={onOpen} onOpenRun={onOpenRun} />
      </IntlProvider>,
    ),
  );
  await act(async () => {});
  return { container, onOpen, onOpenRun };
};

it('opens a run from its group heading, the way to a run whose results are no longer kept', async () => {
  const released: RunProjection = {
    ...emptyProjection('run_1'),
    status: 'succeeded',
    artifacts: { old: { ...version('old', 'draft'), bodyAvailable: false } },
    output: { nodeId: 'write', artifactVersionIds: ['old'] },
  };
  const { container, onOpen, onOpenRun } = await results({ run_1: released }, [
    { runId: 'run_1', status: 'succeeded' } as RunSummary,
  ]);
  const group = container.querySelector('section[aria-label="Run #1"]');
  expect(group?.querySelector('li button')).toBeNull();
  const heading = group?.querySelector<HTMLButtonElement>('h2 button');
  expect(heading?.textContent).toBe('Run #1');
  await act(async () => heading?.click());
  expect(onOpenRun).toHaveBeenCalledWith('run_1');
  expect(onOpen).not.toHaveBeenCalled();
});

it('does not offer to open a final result an earlier run no longer keeps', async () => {
  // A later run of the session succeeded, so the earlier run's final text was released
  // (api-contract.md, 산출물 본문 수명).
  const earlier: RunProjection = {
    ...emptyProjection('run_1'),
    status: 'succeeded',
    artifacts: { old: { ...version('old', 'draft'), bodyAvailable: false } },
    output: { nodeId: 'write', artifactVersionIds: ['old'] },
  };
  const later: RunProjection = {
    ...emptyProjection('run_2'),
    status: 'succeeded',
    artifacts: { now: version('now', 'draft') },
    output: { nodeId: 'write', artifactVersionIds: ['now'] },
  };
  const { container, onOpen } = await results({ run_1: earlier, run_2: later }, [
    { runId: 'run_1', status: 'succeeded' } as RunSummary,
    { runId: 'run_2', status: 'succeeded' } as RunSummary,
  ]);
  const rows = [...container.querySelectorAll('li')];
  expect(rows).toHaveLength(2);
  const [current, released] = rows;
  expect(current?.querySelector('button')).not.toBeNull();
  expect(current?.textContent).not.toContain('Text no longer kept');
  expect(released?.querySelector('button')).toBeNull();
  expect(released?.textContent).toContain('Text no longer kept');
  expect(onOpen).not.toHaveBeenCalled();
});

it('groups results by run and keeps who made each and that its text is gone from being cut', async () => {
  const nodes = [
    { id: 'write', label: 'Assistant' },
    { id: 'inv', label: 'Cause investigation' },
  ];
  const by = (id: string, artifactId: string, executionId: string, kept: boolean) => ({
    ...version(id, artifactId),
    authorExecutionId: executionId,
    ...(kept ? {} : { bodyAvailable: false }),
  });
  const run = (
    runId: string,
    artifacts: RunProjection['artifacts'],
    final: string,
    carried: string[],
  ) =>
    ({
      ...emptyProjection(runId),
      status: 'succeeded',
      artifacts,
      executions: {
        exec_a: { nodeId: 'write' },
        exec_b: { nodeId: 'inv' },
        exec_c: { nodeId: 'inv' },
      },
      executionOrder: ['exec_a', 'exec_b', 'exec_c'],
      output: { nodeId: 'write', artifactVersionIds: [final] },
      forkedFrom: carried.length
        ? {
            runId: 'run_0',
            nodeId: 'write',
            carried: [{ nodeId: 'inv', artifactVersionIds: carried }],
          }
        : null,
    }) as unknown as RunProjection;
  const { container } = await results(
    {
      run_1: run(
        'run_1',
        {
          d1: by('d1', 'draft', 'exec_a', false),
          n1: by('n1', 'notes', 'exec_b', false),
          n2: by('n2', 'findings', 'exec_c', false),
        },
        'd1',
        [],
      ),
      run_2: run(
        'run_2',
        {
          d2: by('d2', 'draft', 'exec_a', true),
          m1: by('m1', 'notes', 'exec_b', false),
          m2: by('m2', 'findings', 'exec_c', true),
        },
        'd2',
        ['m2'],
      ),
    },
    [
      { runId: 'run_1', status: 'succeeded' } as RunSummary,
      { runId: 'run_2', status: 'succeeded' } as RunSummary,
    ],
    nodes,
  );
  // One group a run, newest first, each named once by its heading.
  const groups = [...container.querySelectorAll('section[aria-label]')];
  expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Run #2', 'Run #1']);
  expect(groups.map((group) => group.querySelector('h2')?.textContent)).toEqual([
    'Run #2',
    'Run #1',
  ]);
  const rows = groups.map((group) => [...group.querySelectorAll('li')]);
  // The row does not repeat the run its group names.
  for (const row of rows.flat()) expect(row.textContent).not.toContain('Run #');
  // Every row of a run reads differently, the released ones too.
  for (const list of rows) {
    const texts = list.map((row) => row.textContent);
    expect(new Set(texts).size).toBe(texts.length);
  }
  const released = rows[1]?.find((row) => row.textContent?.includes('notes v1'));
  expect(released?.querySelector('button')).toBeNull();
  // Who made it comes first; the role may shorten but its execution number never does.
  expect(released?.textContent).toContain('Cause investigation');
  const number = [...(released?.querySelectorAll('span') ?? [])].find(
    (span) => span.textContent?.trim().endsWith('execution 2') && !span.querySelector('span'),
  );
  expect(number?.className).toContain('shrink-0');
  // That the text is gone stands at the row's end, where the kind of an open one stands.
  const end = (row: Element | null | undefined) =>
    [...(row?.querySelectorAll('span') ?? [])].at(-1);
  expect(end(released)?.textContent).toBe('Text no longer kept');
  expect(end(released)?.className).toContain('shrink-0');
  const open = rows[0]?.[0]?.querySelector('button');
  expect(end(open)?.textContent).toBe('Final results');
  expect(end(open)?.className).toContain('shrink-0');
  expect(open?.getAttribute('aria-label')).toBe(
    'Final results draft v1 · Run #2 · Assistant · execution 1',
  );
});

it('tells above a past run that another run of the session goes, by its number and state', async () => {
  const view = await showRunPanel([past, going], going, { panel: 'run', run: 'run_past' });
  const line = view.line();
  expect(line).not.toBeNull();
  // Inside the run header, before its title: one line above the header's own.
  expect(line?.closest('[data-testid="run-header"]')).not.toBeNull();
  const title = view.container.querySelector('[data-run-title]') as Node;
  expect(
    (line?.compareDocumentPosition(title) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(line?.textContent).toContain('Run #2');
  expect(line?.textContent).toContain(stateWord(going));
  // One control, named by its words, reached by the keyboard.
  const buttons = line?.querySelectorAll('button') ?? [];
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.textContent).toBe(messages.RunPage.viewActiveRun);
  expect(buttons[0]?.getAttribute('tabindex')).not.toBe('-1');
});

it('opens the active run in its own run tab, as the run menu does', async () => {
  const view = await showRunPanel([past, going], going, {
    panel: 'run',
    run: 'run_past',
    view: 'results',
    result: 'result_1',
    execution: 'exec_1',
    artifact: 'artifact_1',
    atSeq: 4,
  });
  const button = view.line()?.querySelector('button');
  await act(async () => button?.click());
  expect(view.onOpenRun).toHaveBeenCalledExactlyOnceWith('run_going');
  // The past run's own view is not touched: it stays with that run's tab.
  expect(view.setSearch).not.toHaveBeenCalled();
  // Shown in a tab of its own, the active run has no such line (focus goes to that new tab,
  // which the session frame moves: SessionPage.shell.test.tsx).
  await view.render({ panel: 'run', run: 'run_going' });
  expect(view.line()).toBeNull();
});

it.each([
  ['the shown run is the active run', [past, going], going, 'run_going'],
  ['no run is active', [past, summary('run_later', 'failed')], null, 'run_past'],
  // A run still going is not a past run, even when a newer one goes too.
  [
    'the shown run still goes beside a newer one',
    [summary('run_older', 'running'), going],
    going,
    'run_older',
  ],
] as const)('has no line above the header when %s', async (_name, runs, active, shown) => {
  const view = await showRunPanel([...runs], active, { panel: 'run', run: shown });
  const header = view.container.querySelector('[data-testid="run-header"]');
  expect(header?.getAttribute('data-run')).toBe(shown);
  expect(view.line()).toBeNull();
  expect(view.container.textContent).not.toContain(messages.RunPage.viewActiveRun);
});

it('takes the line away when the run going ends while a past run shows', async () => {
  const search: SessionSearch = { panel: 'run', run: 'run_past' };
  const view = await showRunPanel([past, going], going, search);
  expect(view.line()).not.toBeNull();
  // The run list reads the active run ended: no run goes, so nothing is told.
  const ended = { ...going, status: 'succeeded' as const };
  await view.render(search, [past, ended], null);
  expect(view.line()).toBeNull();
  // A run that starts later while the past run still shows is told by its own number.
  const third = summary('run_third', 'running');
  await view.render(search, [past, ended, third], third);
  expect(view.line()?.textContent).toContain('Run #3');
});

it('asks for the same run tab again on a second press before it has opened', async () => {
  const view = await showRunPanel([past, going], going, { panel: 'run', run: 'run_past' });
  const button = view.line()?.querySelector('button');
  await act(async () => {
    button?.click();
    button?.click();
  });
  // The same run both times: opening an open tab selects it (features/session-panel.md).
  expect(view.onOpenRun).toHaveBeenCalledTimes(2);
  expect(view.onOpenRun.mock.calls[0]).toEqual(view.onOpenRun.mock.calls[1]);
});

// execution-monitor.md: beside an operable conversation the run tab does not say what the
// conversation says; over it, the line stands only while the run going has no tab.
it('says nothing of the run going while the conversation beside can be operated', async () => {
  const view = await showRunPanel([past, going], going, { panel: 'run', run: 'run_past' }, true);
  expect(view.line()).toBeNull();
  expect(view.container.textContent).not.toContain(messages.RunPage.viewActiveRun);
  // The record is told the conversation can be operated.
  expect(
    view.container.querySelector('[data-testid="run-header"]')?.getAttribute('data-operable'),
  ).toBe('true');
});

it('over the conversation, tells of the run going only while that run has no tab in the strip', async () => {
  const tabbed = await showRunPanel(
    [past, going],
    going,
    { panel: 'run', run: 'run_past' },
    false,
    true,
  );
  expect(tabbed.line()).toBeNull();
  expect(
    tabbed.container.querySelector('[data-testid="run-header"]')?.getAttribute('data-operable'),
  ).toBe('false');
  const untabbed = await showRunPanel([past, going], going, { panel: 'run', run: 'run_past' });
  expect(untabbed.line()).not.toBeNull();
});
