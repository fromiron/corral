// @vitest-environment jsdom
import { RunEvent } from '@corral/contracts';
import { type ExecutionView, emptyProjection, type RunProjection } from '@corral/core';
import type { RunSessionStore } from '@corral/react';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../packages/react/src/stories/fixtures.tsx';
import { RunMessage } from './RunMessage.tsx';

const fixture = vi.hoisted(() => ({
  store: null as RunSessionStore | null,
  links: [] as unknown[],
}));
vi.mock('./useCorralChat.ts', () => ({
  useCorralRun: () => ({
    store: fixture.store,
    state: useStore(fixture.store as RunSessionStore),
    conversationTurn: null,
    bodyMetadataCurrent: true,
  }),
}));
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: boolean) => useState(initial),
}));
vi.mock('../pages/GettingStarted.tsx', () => ({ markRunReviewed() {} }));
vi.mock('./TurnProcess.tsx', () => ({ TurnProcess: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, search }: { children: ReactNode; search?: unknown }) => {
    fixture.links.push(search);
    return <a href="#run">{children}</a>;
  },
}));

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  fixture.links = [];
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

const execution = (executionId: string): ExecutionView => ({
  executionId,
  nodeId: 'writer',
  taskId: `task_${executionId}`,
  attemptNo: 1,
  parentExecutionId: null,
  previousExecutionId: null,
  depth: 0,
  iterationId: null,
  modelProfile: 'model-a',
  configRevision: 0,
  criteriaVersionId: null,
  status: 'waiting_approval',
  activity: null,
  waitingOn: null,
  modelCallIds: [],
  error: null,
});

const question = (requestId: string, executionId: string, runSeq: number) =>
  RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `event_${requestId}`,
    runId: 'run_chat',
    runSeq,
    recordedAt: '2026-11-09T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type: 'user_input.requested',
    payload: {
      requestId,
      executionId,
      attemptNo: 1,
      bodyRef: `body_${requestId}`,
      schemaHash: 'b'.repeat(64),
      deadline: '2026-11-09T00:01:00.000Z',
    },
  });

const body = (prompt: string) =>
  JSON.stringify({ key: 'layout', questions: [{ id: 'layout', kind: 'text', prompt }] });

async function show() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunMessage runId="run_chat" sessionId="session_chat" live onOpenArtifact={vi.fn()} />
      </IntlProvider>,
    ),
  );
  return container;
}

function waitingRun(): RunProjection {
  const projection = emptyProjection('run_chat');
  projection.status = 'awaiting_user';
  projection.executions.exec_a = execution('exec_a');
  projection.executions.exec_b = execution('exec_b');
  projection.executionOrder = ['exec_a', 'exec_b'];
  return projection;
}

it('names the first waiting question and links to the exact run without answering it', async () => {
  const sendCommand = vi.fn();
  const loadArtifact = vi.fn(async () => {});
  fixture.store = sessionStore({
    runId: 'run_chat',
    projection: waitingRun(),
    events: [question('q_1', 'exec_a', 1)],
    artifactTexts: { body_q_1: body('Which layout should I keep?') },
    sendCommand,
    loadArtifact,
  });
  const container = await show();
  const banner = container.querySelector('[data-testid="run-required-action"]');
  expect(banner?.textContent).toContain('Which layout should I keep?');
  expect(banner?.textContent).not.toContain(messages.Widgets.actionQuestion);
  expect(banner?.textContent).toContain(messages.Widgets.actionOpen);
  // No inline answering: the banner holds a link only.
  expect(banner?.querySelectorAll('input, textarea, select, [role="radio"]')).toHaveLength(0);
  expect(container.querySelector('[role="form"], form')).toBeNull();
  expect(fixture.links).toContainEqual({ panel: 'run', run: 'run_chat', view: 'run' });
  expect(sendCommand).not.toHaveBeenCalled();
});

it('adds the count beside the first question and reads a body it does not have yet', async () => {
  const loadArtifact = vi.fn(async () => {});
  fixture.store = sessionStore({
    runId: 'run_chat',
    projection: waitingRun(),
    events: [question('q_1', 'exec_a', 1), question('q_2', 'exec_b', 2)],
    artifactTexts: {},
    loadArtifact,
  });
  const container = await show();
  const banner = () => container.querySelector('[data-testid="run-required-action"]');
  // Until the question text is read, the banner keeps the generic count.
  expect(banner()?.textContent).toContain(messages.Widgets.actionMixed.replace('{count}', '2'));
  expect(loadArtifact).toHaveBeenCalledWith('body_q_1');
  await act(async () =>
    fixture.store?.setState({
      artifactTexts: { body_q_1: body(`Which layout should I keep? ${'x'.repeat(300)}`) },
    }),
  );
  const text = banner()?.textContent ?? '';
  expect(text).toContain('Which layout should I keep?');
  expect(text).toContain('2 waiting');
  // A long question is shortened in the notice; the response area keeps it whole.
  expect(text).not.toContain('x'.repeat(300));
});

it('shows a thinking indicator where the answer will appear until observed output arrives', async () => {
  const projection = emptyProjection('run_chat');
  projection.status = 'running';
  fixture.store = sessionStore({ runId: 'run_chat', projection });
  const container = await show();
  const pending = () => container.querySelector('[data-testid="reply-pending"]');
  expect(pending()).not.toBeNull();
  expect(pending()?.textContent).toContain(messages.Widgets.activityWorking);
  // The composer owns the live region.
  expect(pending()?.getAttribute('aria-live')).toBe('off');

  await act(async () =>
    fixture.store?.setState({
      streams: { call: { text: 'First words', next: 1, broken: false, completed: false } },
    }),
  );
  expect(pending()).toBeNull();
  expect(container.textContent).toContain('First words');
});

it('drops the thinking indicator once the turn shows a tool step', async () => {
  const projection = emptyProjection('run_chat');
  projection.status = 'running';
  projection.executionOrder = ['lead'];
  projection.executions.lead = { ...execution('lead'), status: 'active' };
  fixture.store = sessionStore({ runId: 'run_chat', projection });
  const container = await show();
  const pending = () => container.querySelector('[data-testid="reply-pending"]');
  expect(pending()).not.toBeNull();
  // A step the turn's process lists means work was observed: the indicator gives way to it.
  await act(async () =>
    fixture.store?.setState({
      events: [
        {
          type: 'tool.requested',
          actor: { kind: 'agent', id: 'lead' },
          payload: {
            executionId: 'lead',
            toolCallId: 'call_read',
            name: 'read_file',
            validatedArgs: { path: 'README.md' },
          },
        },
      ] as unknown as RunEvent[],
    }),
  );
  expect(pending()).toBeNull();
});

it('keeps the thinking indicator for a step the turn does not list', async () => {
  const projection = emptyProjection('run_chat');
  projection.status = 'running';
  projection.executionOrder = ['lead'];
  projection.executions.lead = { ...execution('lead'), status: 'active' };
  // A runtime-owned call is not a step of the turn's process.
  fixture.store = sessionStore({
    runId: 'run_chat',
    projection,
    events: [
      {
        type: 'tool.requested',
        actor: { kind: 'runtime', id: 'runtime' },
        payload: {
          executionId: 'lead',
          toolCallId: 'call_runtime',
          name: 'read_file',
          validatedArgs: { path: 'README.md' },
        },
      },
    ] as unknown as RunEvent[],
  });
  const container = await show();
  expect(container.querySelector('[data-testid="reply-pending"]')).not.toBeNull();
});

it.each(['paused', 'awaiting_user', 'succeeded'] as const)(
  'shows no thinking indicator for a %s run',
  async (status) => {
    const projection = emptyProjection('run_chat');
    projection.status = status;
    fixture.store = sessionStore({ runId: 'run_chat', projection });
    const container = await show();
    expect(container.querySelector('[data-testid="reply-pending"]')).toBeNull();
  },
);
