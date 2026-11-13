// @vitest-environment jsdom
import type { RunEvent } from '@corral/contracts';
import { emptyProjection, type RunProjection } from '@corral/core';
import { createRunSession, type RunSessionStore } from '@corral/react';
import { Menu, MenuPopup, MenuTrigger } from '@corral/react/design-kit';
import { linearCorral } from '@corral/testkit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { ChatDensityMenu, ChatView } from './ChatView.tsx';
import { parsePreferences, preferences } from './preferences.ts';
import { RunMessage } from './RunMessage.tsx';
import { PendingTray } from './session/PendingTray.tsx';

const fixture = vi.hoisted(() => ({ store: null as RunSessionStore | null, read: vi.fn() }));
vi.mock('./useCorralChat.ts', () => ({
  useCorralRun: (runId: string, live: boolean, details: boolean) => {
    fixture.read(runId, live, details);
    return { store: fixture.store, state: useStore(fixture.store as RunSessionStore) };
  },
}));
// The conversation's needed-now tray follows the same run.
vi.mock('../services.tsx', () => ({
  useServices: () => ({ runFor: () => fixture.store, retainRun: () => () => {} }),
}));
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: boolean) => useState(initial),
}));
vi.mock('../pages/GettingStarted.tsx', () => ({ markRunReviewed() {} }));
vi.mock('./MessageBranch.tsx', () => ({ MessageBranch: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#run">{children}</a>,
}));
vi.mock('@corral/react', async (original) => ({
  ...(await original<typeof import('@corral/react')>()),
  ExecutionTranscript: () => <p data-testid="density-transcript">Full transcript</p>,
}));
const disposals: (() => Promise<void>)[] = [];
Element.prototype.getAnimations ??= () => [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  preferences.setState(parsePreferences(null));
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function render(status: 'running' | 'succeeded' = 'running', locale: 'en' | 'ko' = 'en') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const projection = emptyProjection('run_density');
  projection.status = status;
  const failed: RunProjection['executions'][string] = {
    executionId: 'exec',
    nodeId: 'writer',
    taskId: 'task',
    attemptNo: 1,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'test',
    configRevision: 0,
    criteriaVersionId: null,
    status: 'failed',
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: 'Execution failed visibly',
  };
  projection.executions.exec = failed;
  projection.executions.live = { ...failed, executionId: 'live', status: 'active', error: null };
  projection.executionOrder = ['exec', 'live'];
  projection.approvals.approval = {
    approvalId: 'approval',
    kind: 'user_action',
    subjectVersionIds: [],
    criteriaVersionId: null,
    status: 'pending',
  };
  projection.toolCalls.tool = {
    toolCallId: 'tool',
    executionId: 'exec',
    name: 'failed_tool',
    status: 'requested',
    phase: 'failed',
    reason: null,
  };
  projection.artifacts.result = {
    artifactVersionId: 'result',
    artifactId: 'artifact',
    version: 1,
    parentVersionId: null,
    name: 'Preserved result',
    contract: 'text',
    contentHash: 'a'.repeat(64),
    byteLength: 15,
    authorExecutionId: 'exec',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
  };
  projection.output = { nodeId: 'output', artifactVersionIds: ['result'] };
  const events: RunEvent[] = [
    {
      schemaVersion: '0.1',
      eventId: 'event',
      runId: 'run_density',
      runSeq: 1,
      recordedAt: '2026-10-21T00:00:00Z',
      actor: { kind: 'runtime', id: 'runtime' },
      causedByEventIds: [],
      type: 'run.state_changed',
      payload: { from: 'created', to: 'running', reasonCode: 'started' },
    },
  ];
  const sendCommand = vi.fn();
  fixture.store = createRunSession({ sendCommand } as never);
  fixture.store.setState({
    runId: 'run_density',
    definition: linearCorral(['writer']),
    projection,
    events,
    streams: { call: { text: 'Currently drafting', next: 1, broken: false, completed: false } },
    artifactTexts: { result: 'Finished answer' },
    // Already followed: the tray's open() keeps what the run shows.
    open: async () => {},
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale={locale} messages={locale === 'en' ? messages : ko} timeZone="UTC">
        {/* The preference lives in the page menu, outside the conversation it changes. */}
        <Menu>
          <MenuTrigger aria-label="Page menu">…</MenuTrigger>
          <MenuPopup>
            <ChatDensityMenu />
          </MenuPopup>
        </Menu>
        <ChatView
          sessionId="session"
          composer={<textarea aria-label="Draft" defaultValue="Keep this draft" />}
          tray={
            <PendingTray
              sessionId="session"
              runs={[
                {
                  runId: 'run_density',
                  status,
                  corralId: 'team',
                  projectId: 'project',
                  sessionId: 'session',
                  startedAt: '2026-10-21T00:00:00Z',
                },
              ]}
              onOpenArtifact={() => {}}
            />
          }
          items={[
            {
              id: 'entry',
              content: (
                <RunMessage
                  runId="run_density"
                  sessionId="session"
                  live
                  onOpenArtifact={() => {}}
                />
              ),
            },
          ]}
        />
      </IntlProvider>,
    ),
  );
  return { container, projection, events, sendCommand };
}

it.each(['en', 'ko'] as const)(
  'keeps cancelled tool guidance distinct from actual failures (%s)',
  async (locale) => {
    const f = await render('running', locale);
    const text = locale === 'en' ? messages : ko;
    const original = f.projection.toolCalls.tool;
    if (!original || !fixture.store) throw new Error('The tool fixture is missing');
    const projection: RunProjection = {
      ...f.projection,
      status: 'cancelled',
      toolCalls: {
        tool: { ...original, reason: 'Actual failure before cancellation' },
        waiting: {
          ...original,
          toolCallId: 'waiting',
          name: 'await_tasks',
          effectId: 'wait',
          reason: 'scope cancelled',
        },
      },
      effects: {
        wait: {
          effectId: 'wait',
          kind: 'tool',
          scope: 'exec',
          epoch: 0,
          dispatched: true,
          modelCallId: null,
          status: 'settled',
          outcome: 'cancelled',
        },
      },
    };
    await act(async () => fixture.store?.setState({ projection }));
    const labels = [...f.container.querySelectorAll('li > code')];
    const cancelled = labels.find((label) => label.textContent === 'await_tasks')?.closest('li');
    const failed = labels.find((label) => label.textContent === 'failed_tool')?.closest('li');
    expect(cancelled?.textContent).toContain(text.Desktop.toolPhase.cancelled);
    expect(cancelled?.textContent).toContain(text.Failure.cancelled);
    expect(cancelled?.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
    expect(cancelled?.querySelector('details code')?.textContent).toBe('scope cancelled');
    expect(failed?.textContent).toContain(text.Desktop.toolPhase.failed);
    // A failure of unknown cause adds no sentence: its closed Diagnostics hold the reason.
    expect(failed?.querySelectorAll('p')).toHaveLength(0);
    expect(failed?.querySelector('details summary')?.textContent).toBe(text.Failure.diagnostics);
    expect(failed?.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
    expect(failed?.querySelector('details code')?.textContent).toBe(
      'Actual failure before cancellation',
    );
    expect(failed?.textContent).not.toContain(text.Failure.cancelled);
    expect(f.sendCommand).not.toHaveBeenCalled();
  },
);

it('changes only display density while keeping results, the decision and the failure count outside folds', async () => {
  const f = await render();
  expect(f.container.querySelector('[data-testid="live-text"]')).not.toBeNull();
  await act(async () => preferences.setState({ chatDensity: 'results' }));
  expect(f.container.querySelector('[data-testid="live-text"]')).toBeNull();
  const head = () => f.container.querySelector<HTMLElement>('[data-chat-part="head"]');
  const log = () => {
    const id = head()?.querySelector('button[aria-expanded]')?.getAttribute('aria-controls');
    return id ? document.getElementById(id) : null;
  };
  for (const chatDensity of ['results', 'basic', 'detailed'] as const) {
    await act(async () => preferences.setState({ chatDensity }));
    const action = f.container.querySelector('[data-testid="approval-approval"]');
    expect(action).not.toBeNull();
    expect(action?.closest('details')).toBeNull();
    // In the needed-now tray at the timeline's end, whatever the row shows.
    expect(action?.closest('[data-pending-tray]')).not.toBeNull();
    expect(action?.closest('[data-chat-item]')).toBeNull();
    expect(action?.textContent).toContain('Continue with this version');
    // The failed step is counted on the head in every density.
    expect(head()?.textContent).toContain('1 failed');
    expect(f.container.querySelector('[data-testid="chat-result"]')?.textContent).toContain(
      'Finished answer',
    );
    expect(fixture.store?.getState().projection).toBe(f.projection);
    expect(fixture.store?.getState().events).toBe(f.events);
    // Which steps failed, and the lead's failure, are in the log the head opens, in every
    // density: the head is the same in all three.
    const toggle = head()?.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggle).not.toBeNull();
    if (toggle?.getAttribute('aria-expanded') === 'false') await act(async () => toggle.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(log()?.textContent).toContain('failed_tool');
    expect(log()?.querySelector('[data-testid="team-activity"]')?.textContent).toContain(
      'Execution failed visibly',
    );
  }
  // The kit keeps an agent's name in the step label and state in its description.
  const process = f.container.querySelector<HTMLElement>('[data-testid="turn-process"]');
  if (!process) throw new Error('turn process missing');
  expect(process.tagName).not.toBe('DETAILS');
  const trigger = () => process.querySelector<HTMLButtonElement>('button[aria-expanded]');
  // The head names the role and the run's state; the detailed density opens the log.
  expect(trigger()?.textContent).toContain('writer');
  expect(trigger()?.textContent).toContain(messages.Status.running);
  expect(trigger()?.getAttribute('aria-expanded')).toBe('true');
  // Only the running delegate is an active row; the failed lead is not animated as live work.
  const active = [...process.querySelectorAll('.turn-process-row .shimmer-text')].map(
    (node) => node.textContent,
  );
  expect(active).toEqual(['writer…']);
  expect(process.textContent).toContain('Active');
  // Raw transcripts stay in the run pane beside the conversation.
  expect(f.container.querySelector('[data-testid="density-transcript"]')).toBeNull();
  await act(async () => trigger()?.click());
  expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
  expect(f.sendCommand).not.toHaveBeenCalled();
  expect(
    fixture.read.mock.calls.every((call) => call[0] === 'run_density' && call[1] === true),
  ).toBe(true);
});

it('changing the display preference keeps message and composer nodes and their draft', async () => {
  const f = await render();
  const row = f.container.querySelector('[data-chat-item="entry"]');
  const composer = f.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Draft"]');
  expect(composer?.value).toBe('Keep this draft');
  const trigger = f.container.querySelector<HTMLButtonElement>('[aria-label="Page menu"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger?.click());
  // A menu row repeats its label once more to reserve its bold width.
  const detail = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    row.textContent?.startsWith('Conversation detail'),
  );
  expect(detail).toBeDefined();
  await act(async () => detail?.click());
  const results = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent?.startsWith('Results'),
  );
  expect(results).toBeDefined();
  await act(async () => results?.click());
  expect(preferences.getState().chatDensity).toBe('results');
  expect(f.container.querySelector('[data-chat-item="entry"]')).toBe(row);
  expect(f.container.querySelector('textarea[aria-label="Draft"]')).toBe(composer);
  expect(composer?.value).toBe('Keep this draft');
  expect(f.sendCommand).not.toHaveBeenCalled();
});

it('the live reply stays in place between model calls until the run ends', async () => {
  const f = await render();
  const live = () => f.container.querySelector<HTMLElement>('[data-testid="live-text"]');
  const block = live();
  expect(block?.textContent).toContain('Currently drafting');
  const stream = (text: string, completed: boolean) => ({
    text,
    next: 1,
    broken: false,
    completed,
  });
  // The call ends and a tool runs: the last reply stays, no longer marked as being written.
  await act(async () =>
    fixture.store?.setState({ streams: { call: stream('Currently drafting', true) } }),
  );
  expect(live()).toBe(block);
  expect(live()?.textContent).toContain('Currently drafting');
  expect(live()?.textContent).not.toContain('is writing');
  // The next call takes the same place; the process header, not a label, says it works.
  await act(async () =>
    fixture.store?.setState({
      streams: { call: stream('Currently drafting', true), next: stream('Next step', false) },
    }),
  );
  expect(live()).toBe(block);
  expect(live()?.textContent).toContain('Next step');
  expect(live()?.textContent).not.toContain('is writing');
  await act(async () =>
    fixture.store?.setState({ projection: { ...f.projection, status: 'succeeded' } }),
  );
  expect(live()).toBeNull();
});

/** The run succeeds with a result version that first appears now, as a finishing turn does. */
function succeeded(projection: RunProjection): RunProjection {
  const previous = projection.artifacts.result;
  if (!previous) throw new Error('fixture result missing');
  return {
    ...projection,
    status: 'succeeded',
    artifacts: {
      ...projection.artifacts,
      final: { ...previous, artifactVersionId: 'final', version: 2, name: 'Final answer' },
    },
    output: { nodeId: 'output', artifactVersionIds: ['final'] },
  };
}

it('on success the live reply stays until the result text is read, without a loading flash', async () => {
  const f = await render();
  let finish = () => {};
  await act(async () =>
    fixture.store?.setState({
      projection: succeeded(f.projection),
      streams: { call: { text: 'Draft as written', next: 1, broken: false, completed: true } },
      artifactTexts: {},
      loadArtifact: () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    }),
  );
  const live = f.container.querySelector('[data-testid="live-text"]');
  expect(live?.textContent).toContain('Draft as written');
  expect(live?.textContent).not.toContain('is writing');
  expect(f.container.querySelector('[data-testid="chat-result"]')).toBeNull();
  expect(f.container.textContent).not.toContain('Loading…');
  await act(async () => {
    fixture.store?.setState({ artifactTexts: { final: 'Final words' } });
    finish();
  });
  expect(f.container.querySelector('[data-testid="live-text"]')).toBeNull();
  expect(f.container.querySelector('[data-testid="chat-result"]')?.textContent).toContain(
    'Final words',
  );
});

it('a result that cannot be read ends the hand-off and shows the error', async () => {
  const f = await render();
  await act(async () =>
    fixture.store?.setState({
      projection: succeeded(f.projection),
      streams: { call: { text: 'Draft as written', next: 1, broken: false, completed: true } },
      artifactTexts: {},
      loadArtifact: async () => {},
    }),
  );
  expect(f.container.querySelector('[data-testid="live-text"]')).toBeNull();
  expect(f.container.querySelector('[role="alert"]')).not.toBeNull();
});

it('the turn process sits above the reply, closed while working and still closed when done', async () => {
  const f = await render();
  const before = (a: Element | null, b: Element | null) =>
    Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  await act(async () => preferences.setState({ chatDensity: 'basic' }));
  const log = () => f.container.querySelector('[data-testid="turn-process"]');
  const toggle = () => log()?.querySelector('button[aria-expanded]');
  const expandedState = () => toggle()?.getAttribute('aria-expanded');
  // Working: the process is closed above the live reply; the run starting does not open it.
  expect(log()).not.toBeNull();
  expect(expandedState()).toBe('false');
  expect(before(log(), f.container.querySelector('[data-testid="live-text"]'))).toBe(true);
  expect(before(log(), f.container.querySelector('[data-testid="chat-result"]'))).toBe(true);
  const working = log();
  await act(async () =>
    fixture.store?.setState({ projection: { ...f.projection, status: 'succeeded' } }),
  );
  // Finishing keeps the same element, closed, its steps counted on the head, above the answer.
  expect(log()).toBe(working);
  expect(expandedState()).toBe('false');
  expect(toggle()?.textContent).toContain('1 step');
  expect(before(log(), f.container.querySelector('[data-testid="chat-result"]'))).toBe(true);
  // The answer is visible without opening anything.
  expect(f.container.querySelector('[data-testid="chat-result"]')?.closest('details')).toBeNull();
  // The results-only density keeps the same head while the turn works: closed, its steps
  // counted, ready to open. It differs only in hiding the words being written.
  await act(async () =>
    fixture.store?.setState({ projection: { ...f.projection, status: 'running' } }),
  );
  await act(async () => preferences.setState({ chatDensity: 'results' }));
  expect(expandedState()).toBe('false');
  expect(toggle()?.textContent).toContain('1 step');
  expect(f.container.querySelector('[data-testid="live-text"]')).toBeNull();
  expect(f.container.querySelector('[data-presence-label="run:run_density"]')?.textContent).toBe(
    messages.Status.running,
  );
});

it('a turn that finishes without streamed text shows its result only once read', async () => {
  const f = await render();
  let finish = () => {};
  await act(async () =>
    fixture.store?.setState({
      projection: succeeded(f.projection),
      streams: {},
      artifactTexts: {},
      loadArtifact: () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    }),
  );
  expect(f.container.querySelector('[data-testid="chat-result"]')).toBeNull();
  expect(f.container.textContent).not.toContain('Loading…');
  await act(async () => {
    fixture.store?.setState({ artifactTexts: { final: 'Final words' } });
    finish();
  });
  expect(f.container.querySelector('[data-testid="chat-result"]')?.textContent).toContain(
    'Final words',
  );
});

it('a turn opened after it finished still shows that its result is loading', async () => {
  const f = await render('succeeded');
  await act(async () =>
    fixture.store?.setState({
      projection: succeeded(f.projection),
      streams: {},
      artifactTexts: {},
      loadArtifact: () => new Promise<void>(() => {}),
    }),
  );
  expect(f.container.querySelector('[data-testid="chat-result"]')?.textContent).toContain(
    'Loading…',
  );
});

it('a delegate’s streaming text stays out of the lead’s answer', async () => {
  const f = await render();
  await act(async () =>
    fixture.store?.setState({
      projection: {
        ...f.projection,
        modelCalls: {
          ...f.projection.modelCalls,
          child: { modelCallId: 'child', executionId: 'live', finished: false } as never,
        },
      },
      streams: {
        call: { text: 'Lead draft', next: 1, broken: false, completed: true },
        child: { text: 'Delegate notes', next: 1, broken: false, completed: false },
      },
    }),
  );
  const live = f.container.querySelector('[data-testid="live-text"]');
  expect(live?.textContent).toContain('Lead draft');
  expect(live?.textContent).not.toContain('Delegate notes');
});

it('uses safe Markdown during streaming and retains the incomplete prefix after cancellation', async () => {
  const f = await render('running');
  const text = '**Saved prefix**\n\n```ts\nconst value = "<script>safe</script>";\n';
  await act(async () =>
    fixture.store?.setState({ streams: { call: { text, next: 2, broken: false } } }),
  );
  expect(f.container.querySelector('[data-testid="live-text"] strong')?.textContent).toBe(
    'Saved prefix',
  );
  expect(f.container.querySelector('script')).toBeNull();
  await act(async () =>
    fixture.store?.setState({
      projection: { ...f.projection, status: 'cancelled', output: null, artifacts: {} },
    }),
  );
  expect(f.container.querySelector('[data-testid="live-text"]')?.textContent).toContain(
    'Incomplete response',
  );
  expect(f.container.querySelector('[data-testid="live-text"] strong')?.textContent).toBe(
    'Saved prefix',
  );
  expect(f.container.querySelector('[data-testid="chat-result"]')).toBeNull();
});
