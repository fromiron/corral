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
  // The turn's head and its work log measure their panel.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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

async function show(sessionId: string | null = 'session_chat') {
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
        <RunMessage runId="run_chat" sessionId={sessionId} live onOpenArtifact={vi.fn()} />
      </IntlProvider>,
    ),
  );
  return container;
}

/** What a person sees: the text of each element outside screen-reader-only ones. */
function visibleLines(container: HTMLElement) {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const node of copy.querySelectorAll('.sr-only')) node.remove();
  return [...copy.querySelectorAll('*')].map((node) => node.textContent?.trim() ?? '');
}

function approvalWaiting(): RunProjection {
  const projection = waitingRun();
  projection.statusReason = 'approval_requested: user_action';
  projection.approvals.approval_1 = {
    approvalId: 'approval_1',
    kind: 'user_action',
    subjectVersionIds: ['artv_draft'],
    criteriaVersionId: null,
    status: 'pending',
  };
  return projection;
}

function waitingRun(): RunProjection {
  const projection = emptyProjection('run_chat');
  projection.status = 'awaiting_user';
  projection.executions.exec_a = execution('exec_a');
  projection.executions.exec_b = execution('exec_b');
  projection.executionOrder = ['exec_a', 'exec_b'];
  return projection;
}

it('leaves a waiting question to the composer notice: the turn neither names nor answers it', async () => {
  const sendCommand = vi.fn();
  const loadArtifact = vi.fn(async () => {});
  fixture.store = sessionStore({
    runId: 'run_chat',
    projection: waitingRun(),
    events: [question('q_1', 'exec_a', 1), question('q_2', 'exec_b', 2)],
    artifactTexts: { body_q_1: body('Which layout should I keep?') },
    sendCommand,
    loadArtifact,
  });
  const container = await show();
  // The question's text and Respond show once, in the notice above the composer.
  expect(container.querySelector('[data-testid="run-required-action"]')).toBeNull();
  expect(container.textContent).not.toContain('Which layout should I keep?');
  expect(container.textContent).not.toContain(messages.Widgets.actionQuestion);
  expect(container.textContent).not.toContain(messages.Widgets.actionMixed.replace('{count}', '2'));
  expect(container.textContent).not.toContain(messages.Widgets.actionOpen);
  expect(container.querySelector('[data-slot="banner"]')).toBeNull();
  // No inline answering.
  expect(container.querySelectorAll('input, textarea, select, [role="radio"]')).toHaveLength(0);
  expect(container.querySelector('[role="form"], form')).toBeNull();
  expect(fixture.links).not.toContainEqual({ panel: 'run', run: 'run_chat', view: 'run' });
  expect(sendCommand).not.toHaveBeenCalled();
  // The turn does not read the question's body for a line it no longer shows.
  expect(loadArtifact).not.toHaveBeenCalledWith('body_q_1');
  expect(loadArtifact).not.toHaveBeenCalledWith('body_q_2');
});

it('draws a waiting approval in the turn under no heading of its own', async () => {
  fixture.store = sessionStore({ runId: 'run_chat', projection: approvalWaiting() });
  const container = await show();
  // The card is the decision, with its buttons, in the conversation.
  const card = container.querySelector('[data-testid="approval-approval_1"]');
  expect(card?.textContent).toContain(messages.Approvals.kind.user_action);
  const buttons = [...(card?.querySelectorAll('button') ?? [])].map((button) => button.textContent);
  expect(buttons).toEqual(
    expect.arrayContaining([
      messages.Approvals.rejectAs.user_action,
      messages.Approvals.approveAs.user_action,
    ]),
  );
  // The run row's head says the run waits, once: no visible heading repeats it, and the area
  // keeps its accessible name.
  expect(container.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
  const state = container.querySelectorAll('[data-presence-label="run:run_chat"]');
  expect(state).toHaveLength(1);
  expect(state[0]?.textContent).toBe(messages.Status.awaiting_user);
  const rest = container.cloneNode(true) as HTMLElement;
  for (const node of rest.querySelectorAll('[data-presence-label]')) node.remove();
  expect(visibleLines(rest)).not.toContain(messages.Approvals.heading);
  expect(
    container.querySelector(`section[aria-label="${messages.Approvals.heading}"]`),
  ).not.toBeNull();
});

it('leaves why the run waits to the approval card, with no reason line under it', async () => {
  fixture.store = sessionStore({ runId: 'run_chat', projection: approvalWaiting() });
  const container = await show();
  expect(container.querySelector('[data-testid="approval-approval_1"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="run-reason"]')).toBeNull();
  const visible = visibleLines(container).join('\n');
  expect(visible).not.toContain(messages.Run.reasonPrefix);
  expect(visible).not.toContain('Waiting for your decision');
});

it('keeps the reason line of a paused turn', async () => {
  const projection = waitingRun();
  projection.status = 'paused';
  projection.statusReason = 'needs_user: exec_a';
  fixture.store = sessionStore({ runId: 'run_chat', projection });
  const container = await show();
  const reason = container.querySelector('[data-testid="run-reason"]');
  expect(reason?.textContent).toContain(messages.Run.reasonPrefix);
  // It is in the work log the head opens, with the run's steps, not above the answer.
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-chat-part="head"] button[aria-expanded]',
  );
  const log = document.getElementById(toggle?.getAttribute('aria-controls') ?? '');
  expect(log?.contains(reason)).toBe(true);
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
});

it('keeps the heading and the reason for a run outside a session', async () => {
  fixture.store = sessionStore({ runId: 'run_chat', projection: approvalWaiting() });
  const container = await show(null);
  expect(container.querySelector('h3')?.textContent).toBe(messages.Approvals.heading);
  expect(container.querySelector('[data-testid="run-reason"]')?.textContent).toContain(
    'Waiting for your decision',
  );
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

it('keeps the thinking indicator through a tool step, which it names', async () => {
  const projection = emptyProjection('run_chat');
  projection.status = 'running';
  projection.executionOrder = ['lead'];
  projection.executions.lead = { ...execution('lead'), status: 'active' };
  fixture.store = sessionStore({ runId: 'run_chat', projection });
  const container = await show();
  const pending = () => container.querySelector('[data-testid="reply-pending"]');
  expect(pending()).not.toBeNull();
  // The process is closed, so a step it lists does not end the wait: the wait names the step.
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
  expect(pending()).not.toBeNull();
  expect(pending()?.textContent).toContain(messages.Turn.tool.read_file);
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
