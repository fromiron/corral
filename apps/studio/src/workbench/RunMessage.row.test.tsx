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

it.each([
  [
    'with',
    <button key="retry" type="button">
      Retry request
    </button>,
  ],
  ['without', undefined],
])(
  'a team turn whose answering role failed ends its body with that failure, %s next steps',
  async (_name, endActions) => {
    const projection = failed(running());
    projection.executions.helper = execution('helper', { nodeId: 'reviewer', status: 'succeeded' });
    projection.executionOrder = ['lead', 'helper'];
    const f = await show(projection, endActions);
    const end = f.container.querySelector('[data-testid="turn-end"]');
    expect(end).not.toBeNull();
    expect(part(f.container, 'body')?.lastElementChild).toBe(end);
    expect(end?.textContent).toContain(messages.Failure.provider.RATE_LIMIT);
    // Said once: the log does not list the answering role's failure again.
    expect(f.container.textContent?.split(messages.Failure.provider.RATE_LIMIT)).toHaveLength(2);
    // The answering role is the head's, so the head does not count it among failed steps.
    expect(part(f.container, 'head')?.textContent).not.toContain('failed');
  },
);

const logName = (...values: string[]) =>
  messages.Turn.logToggle.replace('{state}', values.join(' · '));

it('names the head button by its role, state, steps and log, never by its ticking time', async () => {
  const f = await show(running());
  expect(toggle(f.container)?.getAttribute('aria-label')).toBe(
    logName('writer', messages.Status.running, '1 step'),
  );
  expect(toggle(f.container)?.textContent).toMatch(/\d+s/);
  await f.set(failed(running()));
  expect(toggle(f.container)?.getAttribute('aria-label')).toBe(
    logName('writer', messages.Status.failed, '1 step'),
  );
});

// docs/specs/chat-widgets-contract.md §6.3: a failed step is told outside the fold, to assistive
// tech as well, before the log is opened.
it.each([
  ['succeeded', (p: RunProjection) => answered(p)],
  ['paused', (p: RunProjection) => ({ ...p, status: 'paused' as const })],
  ['running', (p: RunProjection) => p],
])('a %s turn with a failed step names the failure on its head button', async (status, as) => {
  const projection = running();
  projection.toolCalls.broken = {
    toolCallId: 'broken',
    executionId: 'lead',
    name: 'run_command',
    status: 'requested',
    phase: 'failed',
    reason: 'exit 1',
  };
  const f = await show(as(projection));
  expect(part(f.container, 'head')?.textContent).toContain('1 failed');
  expect(toggle(f.container)?.getAttribute('aria-label')).toBe(
    logName('writer', messages.Status[status as 'running'], '2 steps', '1 failed'),
  );
});

it('a turn with no failed step has no failure in its head button’s name', async () => {
  const f = await show(answered(running()));
  expect(toggle(f.container)?.getAttribute('aria-label')).not.toContain('failed');
});

it('the head button’s name stays the same while the time runs', async () => {
  // Only the clock the head's time reads; animation frames and timeouts stay real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-13T00:00:02.000Z'));
  try {
    const f = await show(running());
    const name = toggle(f.container)?.getAttribute('aria-label');
    const time = toggle(f.container)?.textContent;
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(toggle(f.container)?.textContent).not.toBe(time);
    expect(toggle(f.container)?.getAttribute('aria-label')).toBe(name);
  } finally {
    vi.useRealTimers();
  }
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

/** Another version made by another role, beside the answer. */
function withArtifact(projection: RunProjection, id: string, name: string, executionId: string) {
  const answer = projection.artifacts.answer;
  if (!answer) throw new Error('no answer');
  projection.executions[executionId] ??= execution(executionId, {
    nodeId: 'writer',
    status: 'succeeded',
  });
  if (!projection.executionOrder.includes(executionId)) projection.executionOrder.push(executionId);
  projection.artifacts[id] = {
    ...answer,
    artifactVersionId: id,
    artifactId: id,
    name,
    authorExecutionId: executionId,
  };
  return projection;
}

/** A recorded review of the answer, which the conversation folds as its own block. */
function reviewed(projection: RunProjection, id: string) {
  projection.reviews[id] = {
    stale: false,
    newCriteriaVersionId: null,
    reviewVersionId: id,
    targetVersionId: 'answer',
    criteriaVersionId: 'criteria',
    verdict: 'pass',
    issues: [],
  };
  return projection;
}

const summaries = (container: HTMLElement) =>
  [...container.querySelectorAll('details[data-testid="chat-result"] > summary')].map(
    // The line's values are spaced by the layout, not by spaces.
    (node) => (node.textContent ?? '').replace(/\s*·\s*/g, ' · '),
  );

// The kind of the results is said once in the row (features/presence.md, "한 화면에 한 번").
it('names the kind of several partial results once, over their blocks', async () => {
  const projection = { ...answered(running()), status: 'failed' as const, output: null };
  withArtifact(projection, 'review', 'review', 'helper');
  withArtifact(projection, 'draft', 'draft', 'helper_2');
  const f = await show(projection);
  const group = f.container.querySelector<HTMLElement>('ul[aria-labelledby]');
  const label = group?.getAttribute('aria-labelledby');
  expect(label && f.container.querySelector(`[id="${label}"]`)?.textContent).toBe(
    messages.Results.partial,
  );
  expect(f.container.textContent?.split(messages.Results.partial)).toHaveLength(2);
  expect(summaries(f.container)).toHaveLength(3);
  for (const line of summaries(f.container)) {
    expect(line).not.toContain(messages.Results.partial);
    expect(line).toMatch(/^\w+ v1 · writer #\d$/);
  }
  // The blocks are in the named list, its name above them.
  expect(group?.querySelectorAll('details[data-testid="chat-result"]')).toHaveLength(3);
  expect(group?.previousElementSibling?.id).toBe(label);
});

const kindLabel = (container: HTMLElement) =>
  container.querySelector('ul[aria-labelledby]')?.previousElementSibling ?? null;

it.each([
  [
    'partial',
    () => ({ ...answered(running()), status: 'cancelled' as const, output: null }),
    'Partial result',
  ],
  ['final', () => reviewed(answered(running()), 'answer'), 'Result'],
])('one %s result block stands under its kind’s name too', async (_kind, projection, name) => {
  const f = await show(projection());
  const list = f.container.querySelector('ul[aria-labelledby]');
  expect(kindLabel(f.container)?.textContent).toBe(name);
  expect(kindLabel(f.container)?.id).toBe(list?.getAttribute('aria-labelledby'));
  expect(summaries(f.container)).toEqual(['Answer v1 · writer #1']);
});

it('a row whose answer is in its body has no kind name', async () => {
  const f = await show(answered(running()));
  expect(f.container.querySelector('ul[aria-labelledby]')).toBeNull();
  expect(f.container.textContent).not.toContain(messages.Desktop.result);
});

it('a block’s look comes from the row’s data alone, whether or not it was seen working', async () => {
  const done = reviewed(answered(running()), 'answer');
  const seen = await show({ ...done, status: 'running', endedAt: null });
  await seen.set(done);
  const seenLook = {
    name: kindLabel(seen.container)?.textContent,
    lines: summaries(seen.container),
  };
  for (const dispose of cleanup.splice(0)) act(dispose);
  const fresh = await show(done);
  expect({
    name: kindLabel(fresh.container)?.textContent,
    lines: summaries(fresh.container),
  }).toEqual(seenLook);
});

it('a working run’s result blocks keep their place and their line as more arrive', async () => {
  // The first block comes with its kind's name; the second changes only that name's number, so
  // it neither pushes the first block down nor changes its line.
  const first = reviewed(answered(running()), 'answer');
  const working = { ...first, status: 'running' as const, endedAt: null };
  const f = await show(working);
  const label = () => kindLabel(f.container);
  const before = { label: label(), line: summaries(f.container)[0] };
  expect(before.label?.textContent).toBe('Result');
  expect(before.line).toBe('Answer v1 · writer #1');
  const more = reviewed(
    withArtifact(structuredClone(working), 'second', 'Second', 'helper'),
    'second',
  );
  more.output = { nodeId: 'output', artifactVersionIds: ['answer', 'second'] };
  await f.set(more);
  expect(label()).toBe(before.label);
  expect(summaries(f.container)[0]).toBe(before.line);
  expect(summaries(f.container)).toHaveLength(2);
  expect(label()?.textContent).toBe('Results');
  // It ends with them: the name stays as it was.
  await f.set({ ...more, status: 'succeeded', endedAt: '2026-11-13T00:00:09.000Z' });
  expect(label()).toBe(before.label);
  expect(f.container.textContent?.split('Results')).toHaveLength(2);
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
  // Not changes: a write that failed, one still running, and a command (whatever it did).
  projection.toolCalls.failedWrite = {
    toolCallId: 'failedWrite',
    executionId: 'lead',
    name: 'write_file',
    status: 'requested',
    phase: 'failed',
    reason: 'denied',
  };
  projection.toolCalls.runningEdit = {
    toolCallId: 'runningEdit',
    executionId: 'lead',
    name: 'edit',
    status: 'requested',
    phase: 'running',
    reason: null,
  };
  projection.toolCalls.command = {
    toolCallId: 'command',
    executionId: 'lead',
    name: 'run_command',
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

it('leaves a waiting approval out of the row: the needed-now tray draws and answers it', async () => {
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
  // Neither in its three parts nor after them (composer-flow.md "튐 없는 본문" rule 2).
  expect(f.container.querySelector('[data-approval], [data-testid^="approval-"]')).toBeNull();
  const decisions = [...f.container.querySelectorAll('button')].filter((button) =>
    [messages.Approvals.approveAs.user_action, messages.Approvals.rejectAs.user_action].includes(
      button.textContent ?? '',
    ),
  );
  expect(decisions).toHaveLength(0);
  // The row is its three parts alone: nothing stands after the block that holds them.
  const parts = part(f.container, 'body')?.parentElement;
  expect(parts?.contains(part(f.container, 'head'))).toBe(true);
  expect(parts?.contains(part(f.container, 'tail'))).toBe(true);
  expect(parts?.parentElement?.children).toHaveLength(1);
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
  // A model request in progress has no name worth reading: still the mark alone.
  const request = {
    type: 'model.request_prepared',
    runSeq: 1,
    actor: { kind: 'agent', id: 'lead' },
    payload: { executionId: 'lead', modelCallId: 'call_model', directiveIds: [] },
  };
  await act(async () => fixture.store?.setState({ events: [request] as unknown as RunEvent[] }));
  expect(f.container.querySelector('[data-testid="turn-process"]')?.textContent).toContain(
    messages.Turn.request.replace('{no}', '1'),
  );
  expect(pending()).not.toBeNull();
  expect(visibleWords()).toBe('');
  // A tool in progress names itself as the log does, and the log's rows do not end the wait.
  await act(async () =>
    fixture.store?.setState({
      events: [
        request,
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
