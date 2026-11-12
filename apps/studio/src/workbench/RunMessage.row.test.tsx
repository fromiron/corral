// @vitest-environment jsdom
import type { RunEvent } from '@corral/contracts';
import { type ExecutionView, emptyProjection, type RunProjection } from '@corral/core';
import type { RunSessionStore } from '@corral/react';
import { linearCorral } from '@corral/testkit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../packages/react/src/stories/fixtures.tsx';
import { changePreferences, parsePreferences, preferences } from './preferences.ts';
import { resetProcessChoices } from './processChoices.ts';
import { RunMessage } from './RunMessage.tsx';

// The run row in a conversation keeps one fixed set of parts from its start to its end
// (docs/specs/features/composer-flow.md, "튐 없는 본문" rule 3): a head line, a body that only
// grows, and a tail line. A state change changes words inside those lines, never the lines.

const fixture = vi.hoisted(() => ({ store: null as RunSessionStore | null }));
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
  Link: ({ children, ...props }: { children?: ReactNode; 'aria-label'?: string }) => (
    <a href="#link" aria-label={props['aria-label']}>
      {children}
    </a>
  ),
}));

const RUN = 'run_row';
const cleanup: (() => void)[] = [];
Element.prototype.getAnimations ??= () => [];
beforeEach(() => {
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
  changePreferences({ chatDensity: 'basic' });
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  resetProcessChoices();
  preferences.setState(parsePreferences(null));
  vi.unstubAllGlobals();
});

const execution = (executionId: string, patch: Partial<ExecutionView> = {}): ExecutionView => ({
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
  status: 'active',
  activity: null,
  waitingOn: null,
  modelCallIds: [],
  error: null,
  ...patch,
});

function running(): RunProjection {
  const projection = emptyProjection(RUN);
  projection.status = 'running';
  projection.startedAt = '2026-11-13T00:00:00.000Z';
  projection.executions.lead = execution('lead');
  projection.executionOrder = ['lead'];
  projection.toolCalls.read = {
    toolCallId: 'read',
    executionId: 'lead',
    name: 'read_file',
    status: 'requested',
    phase: 'finished',
    reason: null,
  };
  return projection;
}

function answered(projection: RunProjection): RunProjection {
  return {
    ...projection,
    status: 'succeeded',
    endedAt: '2026-11-13T00:00:09.000Z',
    executions: { lead: execution('lead', { status: 'succeeded' }) },
    artifacts: {
      answer: {
        artifactVersionId: 'answer',
        artifactId: 'answer',
        version: 1,
        parentVersionId: null,
        name: 'Answer',
        contract: 'text',
        contentHash: 'a'.repeat(64),
        byteLength: 10,
        authorExecutionId: 'lead',
        modelCallId: null,
        contextSnapshotId: null,
        submitted: true,
        configRevision: 0,
        criteriaVersionId: null,
        inputArtifactVersionIds: [],
      },
    },
    output: { nodeId: 'output', artifactVersionIds: ['answer'] },
  };
}

function failed(projection: RunProjection): RunProjection {
  return {
    ...projection,
    status: 'failed',
    // The answering role (node `writer`) failed: what the head already says.
    statusReason: 'execution_failed: writer',
    endedAt: '2026-11-13T00:00:09.000Z',
    executions: {
      lead: execution('lead', { status: 'failed', error: 'the model request failed: RATE_LIMIT' }),
    },
  };
}

async function show(projection: RunProjection | null, endActions?: ReactNode) {
  fixture.store = sessionStore({
    runId: RUN,
    definition: linearCorral(['writer']),
    projection,
    artifactTexts: { answer: 'The answer body' },
  });
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
        <RunMessage
          runId={RUN}
          sessionId="session_row"
          live
          onOpenArtifact={vi.fn()}
          endActions={endActions}
          runLine={<button type="button">Run #1</button>}
        />
      </IntlProvider>,
    ),
  );
  const set = (next: RunProjection) =>
    act(async () => fixture.store?.setState({ projection: next }));
  return { container, set };
}

/** The row's own parts, in document order; a team role's row is a part inside the process. */
const parts = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-chat-part]')]
    .map((node) => node.dataset.chatPart ?? '')
    .filter((value) => !value.startsWith('role:'));
const part = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[data-chat-part="${name}"]`);
const toggle = (container: HTMLElement) =>
  part(container, 'head')?.querySelector<HTMLButtonElement>('button[aria-expanded]') ?? null;

it.each([
  ['working to done', () => running(), (p: RunProjection) => answered(p)],
  ['working to failed', () => running(), (p: RunProjection) => failed(p)],
])('keeps the same parts in the same order from %s', async (_name, start, end) => {
  const first = start();
  const f = await show(first);
  expect(parts(f.container)).toEqual(['head', 'body', 'tail']);
  await f.set(end(first));
  expect(parts(f.container)).toEqual(['head', 'body', 'tail']);
});

it('keeps the same parts from before the record is read to the working run', async () => {
  const f = await show(null);
  expect(parts(f.container)).toEqual(['head', 'body', 'tail']);
  // The run's number keeps its place in the head while the record loads.
  expect(part(f.container, 'head')?.textContent).toContain('Run #1');
  await f.set(running());
  expect(parts(f.container)).toEqual(['head', 'body', 'tail']);
  expect(part(f.container, 'head')?.textContent).toContain('Run #1');
});

it('the head and tail say nothing to assistive tech on their own', async () => {
  const f = await show(running());
  expect(part(f.container, 'head')?.getAttribute('aria-live')).toBe('off');
  expect(part(f.container, 'tail')?.getAttribute('aria-live')).toBe('off');
});

it('a closed process stays closed when the run ends', async () => {
  const first = running();
  const f = await show(first);
  // In a conversation the process starts closed; the head is its toggle.
  expect(toggle(f.container)?.getAttribute('aria-expanded')).toBe('false');
  await f.set(answered(first));
  expect(toggle(f.container)?.getAttribute('aria-expanded')).toBe('false');
});

it('a process the person opened stays open when the run ends', async () => {
  const first = running();
  const f = await show(first);
  await act(async () => toggle(f.container)?.click());
  expect(toggle(f.container)?.getAttribute('aria-expanded')).toBe('true');
  await f.set(answered(first));
  expect(toggle(f.container)?.getAttribute('aria-expanded')).toBe('true');
});

it('the detailed density opens the process', async () => {
  changePreferences({ chatDensity: 'detailed' });
  const f = await show(running());
  expect(toggle(f.container)?.getAttribute('aria-expanded')).toBe('true');
});

it('an unfinished turn says its state once in the head and its cause at the end of the body', async () => {
  const f = await show(failed(running()), <button type="button">Retry request</button>);
  expect(f.container.querySelector('[data-testid="run-ended"]')).toBeNull();
  expect(f.container.querySelector('[data-slot="banner"]')).toBeNull();
  const head = part(f.container, 'head');
  const labels = f.container.querySelectorAll(`[data-presence-label="run:${RUN}"]`);
  expect(labels).toHaveLength(1);
  expect(head?.contains(labels[0] ?? null)).toBe(true);
  expect(labels[0]?.textContent).toBe(messages.Status.failed);
  // The run's state word shows nowhere else in the row.
  expect(f.container.textContent?.split(messages.Status.failed)).toHaveLength(2);
  const end = part(f.container, 'body')?.lastElementChild;
  // The failure's cause and what to do next close the body. The reason "writer failed" would
  // repeat the head ("writer · Failed"), so it has no line.
  expect(end?.textContent).not.toContain('writer failed');
  expect(end?.textContent).toContain(messages.Failure.provider.RATE_LIMIT);
  expect(end?.textContent).toContain(messages.Failure.recovery.RATE_LIMIT);
  expect(end?.querySelector('button')?.textContent).toBe('Retry request');
  expect(end?.textContent).not.toContain(messages.Run.reasonPrefix);
  expect(f.container.querySelector('[data-testid="run-made-results"]')).toBeNull();
});

it('names the run once and each team role once, each by its own target', async () => {
  const projection = running();
  projection.executions.helper_a = execution('helper_a', { status: 'failed', error: 'Broke' });
  projection.executions.helper_b = execution('helper_b');
  projection.executionOrder = ['lead', 'helper_a', 'helper_b'];
  const f = await show(projection);
  expect(f.container.querySelectorAll(`[data-presence-label="run:${RUN}"]`)).toHaveLength(1);
  const roles = [...f.container.querySelectorAll<HTMLElement>('[data-chat-part^="role:"]')].map(
    (node) => node.dataset.chatPart,
  );
  expect(roles).toEqual(['role:helper_a', 'role:helper_b']);
  for (const id of ['helper_a', 'helper_b']) {
    const row = part(f.container, `role:${id}`);
    const label = f.container.querySelectorAll(`[data-presence-label="execution:${id}"]`);
    expect(label).toHaveLength(1);
    expect(row?.contains(label[0] ?? null)).toBe(true);
  }
  // A role's failure stays with its row, inside the process.
  expect(part(f.container, 'role:helper_a')?.textContent).toContain('Broke');
  // The head counts it, outside the fold.
  expect(part(f.container, 'head')?.textContent).toContain('1 failed');
});

it('the tail shows only the values the run has, with no dash', async () => {
  const f = await show(running());
  const tail = part(f.container, 'tail');
  expect(tail).not.toBeNull();
  expect(tail?.textContent).toBe('');
  await f.set(answered(running()));
  // The answer shown in the body is not a result to count: a plain answer's tail has no words.
  expect(part(f.container, 'tail')?.textContent).toBe('');
  expect(part(f.container, 'tail')?.querySelector('[data-testid="turn-actions"]')).not.toBeNull();
});

it('counts the results drawn as their own folded blocks', async () => {
  // A cancelled run's partial results each fold under their own line.
  const projection = { ...answered(running()), status: 'cancelled' as const, output: null };
  const f = await show(projection);
  expect(f.container.querySelector('details[data-testid="chat-result"]')).not.toBeNull();
  expect(part(f.container, 'tail')?.textContent).toBe('1 result');
  expect(part(f.container, 'tail')?.textContent).not.toMatch(/—|0 /);
});

it('counts the finished file changes in the tail', async () => {
  const projection = answered(running());
  projection.toolCalls.edit = {
    toolCallId: 'edit',
    executionId: 'lead',
    name: 'edit',
    status: 'requested',
    phase: 'finished',
    reason: null,
  };
  projection.toolCalls.write = {
    toolCallId: 'write',
    executionId: 'lead',
    name: 'write_file',
    status: 'requested',
    phase: 'finished',
    reason: null,
  };
  const f = await show(projection);
  expect(part(f.container, 'tail')?.textContent).toBe('2 changes');
});

it('the one answer’s icon actions sit in the tail, after its values', async () => {
  const projection = answered(running());
  projection.toolCalls.edit = {
    toolCallId: 'edit',
    executionId: 'lead',
    name: 'edit',
    status: 'requested',
    phase: 'finished',
    reason: null,
  };
  const f = await show(projection);
  const tail = part(f.container, 'tail');
  const actions = tail?.querySelector('[data-testid="turn-actions"]');
  expect(tail?.firstElementChild?.textContent).toBe('1 change');
  expect(tail?.lastElementChild).toBe(actions);
  expect(
    actions?.querySelector(`button[aria-label="${messages.MessageBody.copyMessage}"]`),
  ).not.toBeNull();
  expect(actions?.querySelector(`a[aria-label="${messages.Results.openResults}"]`)).not.toBeNull();
  expect(
    f.container.querySelector('[data-testid="chat-result"] [data-testid="turn-actions"]'),
  ).toBeNull();
  expect(f.container.querySelectorAll('[data-testid="turn-actions"]')).toHaveLength(1);
});

it('an interrupted output’s copy sits in the tail', async () => {
  const projection = running();
  const f = await show(projection);
  await act(async () =>
    fixture.store?.setState({
      streams: { call: { text: 'Partial words', next: 1, broken: false, completed: false } },
    }),
  );
  await f.set({ ...projection, status: 'cancelled', endedAt: '2026-11-13T00:00:05.000Z' });
  const tail = part(f.container, 'tail');
  expect(
    tail?.querySelector(
      `[data-testid="turn-actions"] button[aria-label="${messages.MessageBody.copyMessage}"]`,
    ),
  ).not.toBeNull();
  expect(
    f.container.querySelector('[data-testid="live-text"] [data-testid="turn-actions"]'),
  ).toBeNull();
});

it('keeps a waiting approval outside the row, after its tail', async () => {
  const projection = running();
  projection.status = 'awaiting_user';
  projection.approvals.approval = {
    approvalId: 'approval',
    kind: 'user_action',
    subjectVersionIds: [],
    criteriaVersionId: null,
    status: 'pending',
  };
  const f = await show(projection);
  const card = f.container.querySelector('[data-testid="approval-approval"]');
  const tail = part(f.container, 'tail');
  expect(card).not.toBeNull();
  expect(tail?.compareDocumentPosition(card as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  for (const name of ['head', 'body', 'tail'])
    expect(part(f.container, name)?.contains(card)).toBe(false);
});

it('waits for the reply with the kit mark alone, and names the step in progress', async () => {
  const f = await show(running());
  const pending = () => f.container.querySelector<HTMLElement>('[data-testid="reply-pending"]');
  // No step yet: the mark, no words (the head already says the run is running).
  expect(pending()).not.toBeNull();
  expect(part(f.container, 'body')?.contains(pending())).toBe(true);
  const visibleWords = () =>
    [...(pending()?.querySelectorAll('span[aria-hidden="true"]') ?? [])]
      .map((node) => node.textContent)
      .join('');
  expect(visibleWords()).toBe('');
  // A step in progress names itself as the log does, and the log's rows do not end the wait.
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
  expect(visibleWords()).toContain(messages.Turn.tool.read_file);
  expect(pending()?.textContent).not.toContain(messages.Status.running);
  // The first words take its place.
  await act(async () =>
    fixture.store?.setState({
      streams: { call: { text: 'First words', next: 1, broken: false, completed: false } },
    }),
  );
  expect(pending()).toBeNull();
});

it('the working state word shimmers; an ended one does not', async () => {
  const first = running();
  const f = await show(first);
  const word = () => f.container.querySelector(`[data-presence-label="run:${RUN}"]`);
  expect(word()?.classList.contains('shimmer-text')).toBe(true);
  await f.set(failed(first));
  expect(word()?.classList.contains('shimmer-text')).toBe(false);
});

// The session store keeps a complete response's words only while their body can be read
// (api-contract.md, 산출물 본문 수명); this row does not drop what the store still holds.
it('a turn that fails after showing words keeps those the store holds, and its end follows them', async () => {
  const first = running();
  first.modelCalls.call = {
    modelCallId: 'call',
    executionId: 'lead',
    finished: true,
    responseRef: 'response_call',
  } as unknown as RunProjection['modelCalls'][string];
  const f = await show(first);
  await act(async () =>
    fixture.store?.setState({
      streams: {
        call: { text: 'Words seen while working', next: 1, broken: false, completed: true },
      },
    }),
  );
  expect(f.container.querySelector('[data-testid="live-text"]')?.textContent).toContain(
    'Words seen while working',
  );
  await f.set(failed(first));
  const body = part(f.container, 'body');
  const kept = f.container.querySelector('[data-testid="live-text"]');
  expect(kept?.textContent).toContain('Words seen while working');
  // A complete response is not marked as cut off.
  expect(kept?.textContent).not.toContain(messages.MessageBody.interrupted);
  const end = f.container.querySelector('[data-testid="turn-end"]');
  expect(body?.lastElementChild).toBe(end);
  expect(kept?.compareDocumentPosition(end as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

it('an interrupted output is marked as cut off under its words', async () => {
  const projection = running();
  const f = await show(projection);
  await act(async () =>
    fixture.store?.setState({
      streams: { call: { text: 'Partial words', next: 1, broken: false, completed: false } },
    }),
  );
  await f.set({ ...projection, status: 'cancelled', endedAt: '2026-11-13T00:00:05.000Z' });
  expect(f.container.querySelector('[data-testid="live-text"]')?.textContent).toContain(
    messages.MessageBody.interrupted,
  );
});

it.each([
  ['cancel_confirmed', null],
  ['internal_error', messages.RunReasons.internal_error],
  ['execution_failed: reviewer', 'reviewer failed'],
  ['backend_restarted', messages.RunReasons.backend_restarted],
])('the end says the reason %s only when the head does not', async (code, shown) => {
  const f = await show({ ...failed(running()), statusReason: code });
  const end = f.container.querySelector('[data-testid="turn-end"]');
  if (shown) expect(end?.textContent).toContain(shown);
  else expect(end?.textContent).not.toContain(messages.RunReasons.cancel_confirmed);
  // The cause and what to do next stay either way.
  expect(end?.textContent).toContain(messages.Failure.provider.RATE_LIMIT);
});

it('a process the person opened stays open when its row mounts again', async () => {
  const f = await show(running());
  await act(async () => toggle(f.container)?.click());
  expect(toggle(f.container)?.getAttribute('aria-expanded')).toBe('true');
  // The timeline unmounts the row off screen and mounts it again.
  for (const dispose of cleanup.splice(0)) act(dispose);
  const again = await show(running());
  expect(toggle(again.container)?.getAttribute('aria-expanded')).toBe('true');
  // Closing it is remembered the same way.
  await act(async () => toggle(again.container)?.click());
  for (const dispose of cleanup.splice(0)) act(dispose);
  const third = await show(running());
  expect(toggle(third.container)?.getAttribute('aria-expanded')).toBe('false');
});
