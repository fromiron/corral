// @vitest-environment jsdom
import type { RunEvent } from '@corral/contracts';
import { emptyProjection, type RunProjection } from '@corral/core';
import { createRunSession, type RunSessionStore } from '@corral/react';
import { linearCorral } from '@corral/testkit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ChatView } from './ChatView.tsx';
import { parsePreferences, preferences } from './preferences.ts';
import { RunMessage } from './RunMessage.tsx';

const fixture = vi.hoisted(() => ({ store: null as RunSessionStore | null, read: vi.fn() }));
vi.mock('./useCorralChat.ts', () => ({
  useCorralRun: (runId: string, live: boolean, details: boolean) => {
    fixture.read(runId, live, details);
    return { store: fixture.store, state: fixture.store?.getState() };
  },
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
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  preferences.setState(parsePreferences(null));
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function render() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const projection = emptyProjection('run_density');
  projection.status = 'running';
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
  projection.executionOrder = ['exec'];
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
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatView
          sessionId="session"
          composer={<textarea aria-label="Draft" defaultValue="Keep this draft" />}
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

it('[TC-WBD-007-H] changes only display density while keeping results and required attention outside folds', async () => {
  const f = await render();
  expect(f.container.querySelector('[data-testid="live-text"]')).not.toBeNull();
  await act(async () => preferences.setState({ chatDensity: 'results' }));
  expect(f.container.querySelector('[data-testid="live-text"]')).toBeNull();
  for (const chatDensity of ['results', 'basic', 'detailed'] as const) {
    await act(async () => preferences.setState({ chatDensity }));
    const action = f.container.querySelector('[data-testid="run-required-action"]');
    expect(action).not.toBeNull();
    expect(action?.closest('details')).toBeNull();
    expect(f.container.textContent).toContain('failed_tool');
    expect(f.container.querySelector('[data-testid="team-activity"]')?.textContent).toContain(
      'Execution failed visibly',
    );
    expect(f.container.querySelector('[data-testid="chat-result"]')?.textContent).toContain(
      'Finished answer',
    );
    expect(fixture.store?.getState().projection).toBe(f.projection);
    expect(fixture.store?.getState().events).toBe(f.events);
  }
  const log = f.container.querySelector<HTMLDetailsElement>('.work-log');
  expect(log?.open).toBe(true);
  expect(f.container.querySelector('[data-testid="density-transcript"]')).toBeNull();
  const execution = log?.querySelector('details');
  if (!execution) throw new Error('execution disclosure missing');
  await act(async () => {
    execution.open = true;
    execution.dispatchEvent(new Event('toggle'));
  });
  expect(f.container.querySelector('[data-testid="density-transcript"]')).not.toBeNull();
  expect(f.sendCommand).not.toHaveBeenCalled();
  expect(
    fixture.read.mock.calls.every((call) => call[0] === 'run_density' && call[1] === true),
  ).toBe(true);
});

it('[TC-WBD-007-F] changing the display preference keeps message and composer nodes and their draft', async () => {
  const f = await render();
  const row = f.container.querySelector('[data-chat-item="entry"]');
  const composer = f.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Draft"]');
  expect(composer?.value).toBe('Keep this draft');
  const select = f.container.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Conversation detail"]',
  );
  expect(select).not.toBeNull();
  await act(async () => select?.click());
  const results = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent === 'Results',
  );
  expect(results).toBeDefined();
  await act(async () => results?.focus());
  await act(async () =>
    results?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(preferences.getState().chatDensity).toBe('results');
  expect(f.container.querySelector('[data-chat-item="entry"]')).toBe(row);
  expect(f.container.querySelector('textarea[aria-label="Draft"]')).toBe(composer);
  expect(composer?.value).toBe('Keep this draft');
  expect(f.sendCommand).not.toHaveBeenCalled();
});
