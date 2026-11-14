// @vitest-environment jsdom
import { type Receipt, RunEvent } from '@corral/contracts';
import {
  type ApprovalView,
  type ExecutionView,
  emptyProjection,
  type RunProjection,
  type RunSummary,
} from '@corral/core';
import type { RunSessionStore } from '@corral/react';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../../packages/react/src/stories/fixtures.tsx';
import { ChatView } from '../ChatView.tsx';
import { RunMessage } from '../RunMessage.tsx';
import { RunResponseArea } from '../RunResponseArea.tsx';
import {
  createPendingTrayStore,
  PendingTray,
  PendingTrayContext,
  revealPendingTray,
  usePendingTray,
} from './PendingTray.tsx';

// The conversation's needed-now tray (composer-flow.md "지금 필요한 것", workbench.md): what the
// session's runs wait on, answered at the end of the timeline, in one place only.

const fixture = vi.hoisted(() => ({ stores: {} as Record<string, RunSessionStore> }));
vi.mock('../../services.tsx', () => ({
  useServices: () => ({
    runFor: (runId: string) => fixture.stores[runId],
    retainRun: () => () => {},
  }),
}));
vi.mock('../useCorralChat.ts', () => ({
  useCorralRun: (runId: string) => ({
    store: fixture.stores[runId],
    state: useStore(fixture.stores[runId] as RunSessionStore),
    conversationTurn: null,
    bodyMetadataCurrent: true,
  }),
}));
vi.mock('../../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: boolean) => useState(initial),
}));
vi.mock('../../pages/GettingStarted.tsx', () => ({ markRunReviewed() {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#link">{children}</a>,
}));

const observers: {
  callback: IntersectionObserverCallback;
  target: Element | null;
  options: IntersectionObserverInit | undefined;
}[] = [];
const resizers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        resizers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.entry = { callback, target: null, options };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      unobserve() {}
      disconnect() {
        observers.splice(observers.indexOf(this.entry), 1);
      }
    },
  );
  Element.prototype.getAnimations ??= () => [];
  fixture.stores = {};
  resizers.splice(0);
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SESSION = 'session_chat';

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

const question = (runId: string, requestId: string, executionId: string, runSeq: number) =>
  RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `event_${requestId}`,
    runId,
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

const questionBody = (prompt: string) =>
  JSON.stringify({ key: 'layout', questions: [{ id: 'layout', kind: 'text', prompt }] });

const decision = (approvalId: string, change: Partial<ApprovalView> = {}): ApprovalView => ({
  approvalId,
  kind: 'user_action',
  subjectVersionIds: [],
  criteriaVersionId: null,
  status: 'pending',
  ...change,
});

/** A run of the session waiting on the given approvals and questions (prompt texts). */
function waitingRun(
  runId: string,
  { approvals = [], questions = [] }: { approvals?: ApprovalView[]; questions?: string[] } = {},
) {
  const projection: RunProjection = emptyProjection(runId);
  projection.status = approvals.length || questions.length ? 'awaiting_user' : 'running';
  projection.startedAt = '2026-11-09T00:00:00.000Z';
  const events: RunEvent[] = [];
  const artifactTexts: Record<string, string> = {};
  questions.forEach((prompt, index) => {
    const executionId = `exec_${runId}_${index}`;
    projection.executions[executionId] = execution(executionId);
    projection.executionOrder.push(executionId);
    const requestId = `q_${runId}_${index}`;
    events.push(question(runId, requestId, executionId, index + 1));
    artifactTexts[`body_${requestId}`] = questionBody(prompt);
  });
  for (const approval of approvals) projection.approvals[approval.approvalId] = approval;
  const store = sessionStore({ runId, projection, events, artifactTexts });
  fixture.stores[runId] = store;
  return store;
}

/** Decisions sent through a store: each waits until the test settles its receipt. */
function decisions(store: RunSessionStore) {
  const sent: {
    approvalId: string;
    decision: 'approve' | 'reject';
    settle(error?: string): Promise<void>;
  }[] = [];
  store.setState({
    resolveApproval: vi.fn(
      (approvalId: string, choice: 'approve' | 'reject') =>
        new Promise<Receipt>((resolve) => {
          sent.push({
            approvalId,
            decision: choice,
            settle: (error) =>
              act(async () => {
                if (!error) closeApproval(store, approvalId, choice);
                resolve(
                  (error
                    ? { error: { code: 'CONFLICT', message: error } }
                    : { commandId: 'command' }) as unknown as Receipt,
                );
                await new Promise((done) => setTimeout(done, 30));
              }),
          });
        }),
    ),
  });
  return sent;
}

/** The run closes a decided approval, as its event does; the run goes on when nothing waits. */
function closeApproval(store: RunSessionStore, approvalId: string, choice: 'approve' | 'reject') {
  const projection = store.getState().projection;
  if (!projection) throw new Error('missing projection');
  const approval = projection.approvals[approvalId];
  if (!approval) throw new Error(`missing ${approvalId}`);
  const approvals = {
    ...projection.approvals,
    [approvalId]: { ...approval, status: choice === 'approve' ? 'approved' : 'rejected' },
  } as RunProjection['approvals'];
  const waiting = Object.values(approvals).some((item) => item.status === 'pending');
  store.setState({
    projection: { ...projection, approvals, status: waiting ? 'awaiting_user' : 'running' },
  });
}

const summary = (
  runId: string,
  status: RunSummary['status'] = 'awaiting_user',
  sessionId = SESSION,
): RunSummary => ({
  runId,
  status,
  sessionId,
  corralId: 'team',
  projectId: 'project',
  startedAt: '2026-11-09T00:00:00.000Z',
});

function VisibleProbe() {
  const { visible, waiting } = usePendingTray();
  return <output data-testid="tray-probe">{`${visible}:${waiting}`}</output>;
}

/** The session conversation with its runs' rows, the tray, and optionally the run record. */
async function show(runIds: string[], { record = false }: { record?: boolean } = {}) {
  const tray = createPendingTrayStore();
  const respond = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <PendingTrayContext.Provider value={{ store: tray, respond }}>
          <ChatView
            sessionId={SESSION}
            items={runIds.map((runId) => ({
              id: `entry_${runId}`,
              content: (
                <RunMessage
                  runId={runId}
                  sessionId={SESSION}
                  live
                  onOpenArtifact={vi.fn()}
                  runLine={<button type="button">{runId}</button>}
                />
              ),
            }))}
            tray={
              <PendingTray
                sessionId={SESSION}
                runs={runIds.map((runId) => summary(runId))}
                onOpenArtifact={vi.fn()}
              />
            }
            composer={<textarea aria-label="Request" />}
          />
          {record ? (
            // The run record beside the conversation, as the session's run view draws it.
            <aside data-testid="run-record">
              <RunResponseArea
                session={fixture.stores[runIds[0] ?? ''] as RunSessionStore}
                onOpenArtifact={vi.fn()}
                onRespond={respond}
              />
            </aside>
          ) : null}
          <VisibleProbe />
        </PendingTrayContext.Provider>
        <input aria-label="Elsewhere" />
      </IntlProvider>,
    ),
  );
  await settleFrames();
  return { container, tray, respond };
}

const settleFrames = () => act(async () => new Promise((done) => setTimeout(done, 40)));

const trayOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-pending-tray]');

/** Buttons whose text is exactly one of the given labels. */
const buttons = (root: ParentNode | null | undefined, ...labels: string[]) =>
  [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter((button) =>
    labels.includes(button.textContent?.trim() ?? ''),
  );

/** What a person sees: the text outside screen-reader-only elements. */
function visibleText(element: Element | null) {
  const copy = element?.cloneNode(true) as HTMLElement | undefined;
  for (const node of copy?.querySelectorAll('.sr-only') ?? []) node.remove();
  return copy?.textContent ?? '';
}

/** A run limit: the pause that only asks whether the run goes on. */
const roundLimit = { kind: 'loop_iterations', used: 3, max: 3 } as const;

const approve = messages.Approvals.approveAs.user_action;
const reject = messages.Approvals.rejectAs.user_action;

it('shows a waiting approval and a waiting question in one tray, after the last item', async () => {
  waitingRun('run_a', {
    approvals: [decision('approval_1')],
    questions: ['Which layout should I keep?'],
  });
  const { container } = await show(['run_a']);
  const trays = container.querySelectorAll('[data-pending-tray]');
  expect(trays).toHaveLength(1);
  const tray = trays[0] as HTMLElement;
  // Both requests, each answerable here.
  expect(tray.querySelector('[data-testid="approval-approval_1"]')).not.toBeNull();
  const form = tray.querySelector(`form[aria-label^="${messages.Harness.userQuestions}"]`);
  expect(form?.textContent).toContain('Which layout should I keep?');
  expect(form?.querySelector('input')).not.toBeNull();
  expect(buttons(tray, approve)).toHaveLength(1);
  // At the end of the timeline, inside its scrolling area, after the list of items.
  const timeline = container.querySelector('[data-testid="chat-timeline"]');
  const list = container.querySelector('[data-chat-window]');
  expect(timeline?.contains(tray)).toBe(true);
  expect(list?.compareDocumentPosition(tray)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(tray.parentElement?.lastElementChild).toBe(tray);
  // Not in the run's row: the row neither answers nor shows the cards.
  const row = container.querySelector('[data-chat-item="entry_run_a"]');
  expect(row?.querySelector('[data-approval], form, input, [data-pending-tray]')).toBeNull();
  expect(buttons(row, approve, reject)).toHaveLength(0);
  // Named for assistive tech, with no visible title line saying the state again: the row's head
  // says it once.
  expect(tray.getAttribute('aria-label')).toBe(messages.Sessions.neededNow);
  expect(tray.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
  expect(visibleText(tray)).not.toContain(messages.Approvals.heading);
  expect(visibleText(container).match(/Waiting for you(?!r)/g)).toHaveLength(1);
});

it('keeps one way to answer a request with the run record open beside the conversation', async () => {
  waitingRun('run_a', {
    approvals: [decision('approval_1')],
    questions: ['Which layout should I keep?'],
  });
  const { container, respond } = await show(['run_a'], { record: true });
  // The decision's buttons and the question's answer field: once on the screen, in the tray.
  expect(buttons(container, approve)).toHaveLength(1);
  expect(buttons(container, reject)).toHaveLength(1);
  expect(container.querySelectorAll('form')).toHaveLength(1);
  const tray = trayOf(container);
  expect(tray?.contains(buttons(container, approve)[0] as Node)).toBe(true);
  // The record reads what waits and sends the person to the tray.
  const record = container.querySelector('[data-testid="run-record"]');
  expect(record?.textContent).toContain(messages.Approvals.kind.user_action);
  expect(record?.textContent).toContain('Which layout should I keep?');
  expect(record?.querySelector('form, input, textarea, select')).toBeNull();
  expect(buttons(record, approve, reject, messages.Harness.sendAnswer)).toHaveLength(0);
  const go = record?.querySelector<HTMLButtonElement>('[data-testid="respond-in-conversation"]');
  expect(go?.textContent).toBe('Respond · 2');
  await act(async () => go?.click());
  expect(respond).toHaveBeenCalledTimes(1);
});

it('folds an answered approval into one line in its place', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_1'), decision('approval_2', { kind: 'final_output' })],
  });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const tray = trayOf(container);
  const first = tray?.querySelector('[data-testid="approval-approval_1"]');
  const top = [...(tray?.querySelectorAll('[data-approval], [data-testid^="approved-"]') ?? [])];
  expect(top[0]).toBe(first);
  await act(async () => buttons(first, approve)[0]?.click());
  await sent[0]?.settle();
  // The card's place holds one line: an icon and what was approved.
  expect(tray?.querySelector('[data-testid="approval-approval_1"]')).toBeNull();
  const line = tray?.querySelector('[data-testid="approved-approval_1"]');
  expect(line?.textContent).toBe(`${messages.Approvals.kind.user_action} approved`);
  expect(line?.querySelectorAll('svg')).toHaveLength(1);
  expect(line?.querySelector('button')).toBeNull();
  const after = [...(tray?.querySelectorAll('[data-approval], [data-testid^="approved-"]') ?? [])];
  expect(after[0]).toBe(line);
  expect(after[1]?.getAttribute('data-approval')).toBe('approval_2');
  // As in every response area, the line leaves with the area once nothing waits.
  await act(async () =>
    buttons(
      tray?.querySelector('[data-approval="approval_2"]'),
      messages.Approvals.approveAs.final_output,
    )[0]?.click(),
  );
  await sent[1]?.settle();
  expect(trayOf(container)).toBeNull();
});

it('never brings back the lines of an earlier wait when the run waits again', async () => {
  // Approved in an earlier wait, before this screen read the run.
  const store = waitingRun('run_a', {
    approvals: [
      decision('approval_0', { status: 'approved' }),
      decision('approval_1'),
      decision('approval_2', { kind: 'final_output' }),
    ],
  });
  // Its history: approval_0 asked and approved, then the two now waiting asked.
  const recorded = (runSeq: number, type: string, payload: Record<string, unknown>) =>
    RunEvent.parse({
      schemaVersion: '0.1',
      eventId: `event_history_${runSeq}`,
      runId: 'run_a',
      runSeq,
      recordedAt: '2026-11-09T00:00:00.000Z',
      actor: { kind: 'runtime', id: 'runtime' },
      causedByEventIds: [],
      type,
      payload,
    });
  const asked = (approvalId: string, kind: string) => ({
    approvalId,
    kind,
    subjectVersionIds: [],
    criteriaVersionId: null,
  });
  store.setState({
    events: [
      recorded(1, 'approval.requested', asked('approval_0', 'user_action')),
      recorded(2, 'approval.resolved', {
        approvalId: 'approval_0',
        decision: 'approve',
        actor: 'person',
        subjectVersionIds: [],
      }),
      recorded(3, 'approval.requested', asked('approval_1', 'user_action')),
      recorded(4, 'approval.requested', asked('approval_2', 'final_output')),
    ],
  });
  const sent = decisions(store);
  const { container } = await show(['run_a'], { record: true });
  const lines = (root: Element | null | undefined) =>
    [...(root?.querySelectorAll('[data-testid^="approved-"]') ?? [])].map((line) =>
      line.getAttribute('data-testid'),
    );
  const record = () => container.querySelector('[data-testid="run-record"]');
  expect(lines(trayOf(container))).toEqual([]);
  expect(lines(record())).toEqual([]);
  // Approved while the run still waits on another: its line stands in its place.
  await act(async () => buttons(trayOf(container), approve)[0]?.click());
  await sent[0]?.settle();
  expect(lines(trayOf(container))).toEqual(['approved-approval_1']);
  expect(lines(record())).toEqual(['approved-approval_1']);
  // The run goes on: the lines leave.
  await act(async () =>
    buttons(trayOf(container), messages.Approvals.approveAs.final_output)[0]?.click(),
  );
  await sent[1]?.settle();
  expect(trayOf(container)).toBeNull();
  // It waits again: only the new card, here and in the record that stayed open.
  const projection = store.getState().projection as RunProjection;
  await act(async () =>
    store.setState({
      projection: {
        ...projection,
        status: 'awaiting_user',
        approvals: { ...projection.approvals, approval_3: decision('approval_3') },
      },
    }),
  );
  expect(trayOf(container)?.querySelector('[data-approval="approval_3"]')).not.toBeNull();
  expect(lines(trayOf(container))).toEqual([]);
  expect(lines(record())).toEqual([]);
});

it('keeps every line of a wait whose requests overlapped, as long as something waited throughout', async () => {
  const store = waitingRun('run_a', { approvals: [decision('a1'), decision('a2')] });
  const recorded = (runSeq: number, type: string, payload: Record<string, unknown>) =>
    RunEvent.parse({
      schemaVersion: '0.1',
      eventId: `event_overlap_${runSeq}`,
      runId: 'run_a',
      runSeq,
      recordedAt: '2026-11-09T00:00:00.000Z',
      actor: { kind: 'runtime', id: 'runtime' },
      causedByEventIds: [],
      type,
      payload,
    });
  const asked = (runSeq: number, approvalId: string) =>
    recorded(runSeq, 'approval.requested', {
      approvalId,
      kind: 'user_action',
      subjectVersionIds: [],
      criteriaVersionId: null,
    });
  const resolved = (runSeq: number, approvalId: string) =>
    recorded(runSeq, 'approval.resolved', {
      approvalId,
      decision: 'approve',
      actor: 'person',
      subjectVersionIds: [],
    });
  const advance = (event: RunEvent, approvals: Record<string, ApprovalView>) => {
    const { events, projection } = store.getState();
    if (!projection) throw new Error('missing projection');
    store.setState({
      events: [...events, event],
      projection: { ...projection, approvals: { ...projection.approvals, ...approvals } },
    });
  };
  store.setState({ events: [asked(1, 'a1'), asked(2, 'a2')] });
  const { container } = await show(['run_a']);
  const lines = () =>
    [...(trayOf(container)?.querySelectorAll('[data-testid^="approved-"]') ?? [])].map((line) =>
      line.getAttribute('data-testid'),
    );
  // a1 approved while a2 waits; a3 asked while a2 still waits; then a2 approved while a3 waits.
  await act(async () => advance(resolved(3, 'a1'), { a1: decision('a1', { status: 'approved' }) }));
  expect(lines()).toEqual(['approved-a1']);
  await act(async () => advance(asked(4, 'a3'), { a3: decision('a3') }));
  expect(lines()).toEqual(['approved-a1']);
  await act(async () => advance(resolved(5, 'a2'), { a2: decision('a2', { status: 'approved' }) }));
  // The run never waited on nothing in between: both lines stand.
  expect(lines()).toEqual(['approved-a1', 'approved-a2']);
});

it('never brings back an answered question’s line when the run waits again', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_1')],
    questions: ['Which layout should I keep?'],
  });
  const sent = decisions(store);
  const { container } = await show(['run_a'], { record: true });
  await act(async () => recordAnswer(store, 'q_run_a_0', [{ questionId: 'layout', text: 'Wide' }]));
  const answered = () => container.querySelectorAll('[data-testid="answered-q_run_a_0"]');
  // Folded, in the tray and in the record, while the approval still waits.
  expect(answered()).toHaveLength(2);
  await act(async () => buttons(trayOf(container), approve)[0]?.click());
  await sent[0]?.settle();
  expect(answered()).toHaveLength(0);
  const projection = store.getState().projection as RunProjection;
  await act(async () =>
    store.setState({
      projection: {
        ...projection,
        status: 'awaiting_user',
        approvals: { ...projection.approvals, approval_2: decision('approval_2') },
      },
    }),
  );
  expect(trayOf(container)?.querySelector('[data-approval="approval_2"]')).not.toBeNull();
  expect(answered()).toHaveLength(0);
});

it('decides only by its buttons: Enter and Escape decide nothing', async () => {
  const store = waitingRun('run_a', { approvals: [decision('approval_1')] });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const tray = trayOf(container) as HTMLElement;
  const card = tray.querySelector<HTMLElement>('[data-approval]') as HTMLElement;
  const request = container.querySelector('textarea') as HTMLTextAreaElement;
  for (const target of [tray, card, request, card.querySelector('p') as HTMLElement]) {
    target.focus();
    for (const key of ['Enter', 'Escape'])
      await act(async () => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
        target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      });
  }
  expect(sent).toHaveLength(0);
  expect(store.getState().resolveApproval).not.toHaveBeenCalled();
  expect(tray.querySelector('[data-approval="approval_1"]')).not.toBeNull();
});

it('sends a decision once until its receipt comes back', async () => {
  const store = waitingRun('run_a', { approvals: [decision('approval_1')] });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const card = trayOf(container)?.querySelector('[data-approval]');
  await act(async () => buttons(card, approve)[0]?.click());
  // Waiting for the receipt: no answer can be sent again.
  for (const button of card?.querySelectorAll('button[data-approval-action]') ?? [])
    expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    buttons(card, approve)[0]?.click();
    buttons(card, reject)[0]?.click();
  });
  expect(store.getState().resolveApproval).toHaveBeenCalledTimes(1);
  expect(sent).toHaveLength(1);
  await sent[0]?.settle();
  expect(trayOf(container)).toBeNull();
});

it('says why a decision was refused, in its card, and lets it be answered again', async () => {
  const store = waitingRun('run_a', { approvals: [decision('approval_1')] });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const card = () => trayOf(container)?.querySelector('[data-approval="approval_1"]');
  await act(async () => buttons(card(), approve)[0]?.click());
  await sent[0]?.settle('The approval was already resolved.');
  const alert = card()?.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('Not applied: The approval was already resolved.');
  expect(buttons(card(), approve)[0]?.disabled).toBe(false);
  await act(async () => buttons(card(), approve)[0]?.click());
  expect(store.getState().resolveApproval).toHaveBeenCalledTimes(2);
});

it('hands focus to the next card’s main action, then to the request box', async () => {
  const first = waitingRun('run_a', { approvals: [decision('approval_1')] });
  const second = waitingRun('run_b', {
    approvals: [decision('approval_2', { kind: 'final_output' })],
  });
  const sentA = decisions(first);
  const sentB = decisions(second);
  const { container } = await show(['run_a', 'run_b']);
  const decide = buttons(trayOf(container)?.querySelector('[data-approval="approval_1"]'), approve);
  decide[0]?.focus();
  await act(async () => decide[0]?.click());
  await sentA[0]?.settle();
  await settleFrames();
  // The next card waits in another run's area of the same tray.
  const next = trayOf(container)?.querySelector<HTMLButtonElement>(
    '[data-approval="approval_2"] [data-approval-action="primary"]',
  );
  expect(document.activeElement).toBe(next);
  await act(async () => next?.click());
  await sentB[0]?.settle();
  await settleFrames();
  expect(document.activeElement).toBe(container.querySelector('textarea'));
});

it('leaves focus the person moved elsewhere where it is', async () => {
  const store = waitingRun('run_a', { approvals: [decision('approval_1')] });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const decide = buttons(trayOf(container), approve)[0];
  decide?.focus();
  await act(async () => decide?.click());
  const elsewhere = container.querySelector<HTMLInputElement>('input[aria-label="Elsewhere"]');
  elsewhere?.focus();
  await sent[0]?.settle();
  await settleFrames();
  expect(document.activeElement).toBe(elsewhere);
});

it('leaves focus moved elsewhere after a continue decision, while more waits and once all is done', async () => {
  const store = waitingRun('run_a', {
    approvals: [
      decision('approval_limit', { limit: roundLimit }),
      decision('approval_more', { limit: { kind: 'spawns', used: 4, max: 4 } }),
    ],
  });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const elsewhere = container.querySelector<HTMLInputElement>('input[aria-label="Elsewhere"]');
  const stack = () => trayOf(container)?.querySelector('[data-continue-decisions]');
  const go = () => buttons(stack(), messages.Approvals.limit.approve);
  // Another decision still waits: the stack stays, and focus stays where the person put it.
  go()[0]?.focus();
  await act(async () => go()[0]?.click());
  elsewhere?.focus();
  await sent[0]?.settle();
  await settleFrames();
  expect(stack()).not.toBeNull();
  expect(document.activeElement).toBe(elsewhere);
  // The last one: the stack leaves with the tray, and focus still stays.
  const last = go().find((button) => !button.disabled);
  last?.focus();
  await act(async () => last?.click());
  elsewhere?.focus();
  await sent[1]?.settle();
  await settleFrames();
  expect(trayOf(container)).toBeNull();
  expect(document.activeElement).toBe(elsewhere);
});

it('leaves focus moved elsewhere after an answer is sent', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_1')],
    questions: ['Which layout should I keep?'],
  });
  let receipt: (value: Receipt) => void = () => {};
  store.setState({
    sendCommand: vi.fn(() => new Promise<Receipt>((resolve) => (receipt = resolve))),
  });
  const { container } = await show(['run_a']);
  const form = trayOf(container)?.querySelector('form') as HTMLFormElement;
  await typeInto(form.querySelector('input') as HTMLInputElement, 'Wide');
  const send = buttons(form, messages.Harness.sendAnswer)[0];
  send?.focus();
  await act(async () => send?.click());
  const elsewhere = container.querySelector<HTMLInputElement>('input[aria-label="Elsewhere"]');
  elsewhere?.focus();
  await act(async () => receipt({ commandId: 'command' } as unknown as Receipt));
  await settleFrames();
  expect(document.activeElement).toBe(elsewhere);
});

it('takes no place while nothing waits, and joins the end when something does', async () => {
  const store = waitingRun('run_a');
  const { container } = await show(['run_a']);
  const list = container.querySelector('[data-chat-window]');
  expect(trayOf(container)).toBeNull();
  // Nothing is drawn after the list, not even an empty frame.
  expect(list?.nextElementSibling).toBeNull();
  const projection = store.getState().projection as RunProjection;
  await act(async () =>
    store.setState({
      projection: {
        ...projection,
        status: 'awaiting_user',
        approvals: { approval_1: decision('approval_1') },
      },
    }),
  );
  expect(list?.nextElementSibling).toBe(trayOf(container));
  expect(trayOf(container)?.querySelector('[data-approval="approval_1"]')).not.toBeNull();
});

it('lists several runs in the conversation’s order, each run’s questions before its approvals', async () => {
  waitingRun('run_a', { approvals: [decision('approval_a')] });
  waitingRun('run_b', {
    approvals: [decision('approval_b')],
    questions: ['Which layout should I keep?'],
  });
  const { container } = await show(['run_a', 'run_b']);
  const tray = trayOf(container);
  const areas = [...(tray?.querySelectorAll('[data-run-response]') ?? [])].map((area) =>
    area.getAttribute('data-run-response'),
  );
  expect(areas).toEqual(['run_a', 'run_b']);
  const second = tray?.querySelector('[data-run-response="run_b"]');
  const form = second?.querySelector('form');
  const card = second?.querySelector('[data-approval="approval_b"]');
  expect(form && card && form.compareDocumentPosition(card)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

it('asks continue or stop in the kit’s decision stack, confirming only from the receipt', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_limit', { limit: roundLimit })],
  });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const tray = trayOf(container);
  const stack = tray?.querySelector('[data-continue-decisions]');
  expect(
    stack?.querySelector(`[aria-label="${messages.Approvals.continueRegion}"]`),
  ).not.toBeNull();
  expect(stack?.textContent).toContain('Round limit reached (3 of 3)');
  // Not drawn a second time as an approval card.
  expect(tray?.querySelector('[data-approval]')).toBeNull();
  const go = () => buttons(stack, messages.Approvals.limit.approve)[0];
  const stop = () => buttons(stack, messages.Approvals.limit.reject)[0];
  go()?.focus();
  await act(async () => go()?.click());
  // Sent, no receipt yet: no confirmation, and neither answer can be sent again.
  expect(stack?.querySelector('[role="status"]')).toBeNull();
  expect(go()?.disabled).toBe(true);
  expect(stop()?.disabled).toBe(true);
  await act(async () => go()?.click());
  expect(store.getState().resolveApproval).toHaveBeenCalledTimes(1);
  // Refused: why, in its place, and the answers come back.
  await sent[0]?.settle('The loop already moved on.');
  expect(stack?.querySelector('[role="alert"]')?.textContent).toContain(
    'Not applied: The loop already moved on.',
  );
  expect(go()?.disabled).toBe(false);
  go()?.focus();
  await act(async () => go()?.click());
  await sent[1]?.settle();
  await settleFrames();
  // The run closed the request: its row left with the tray, and focus went to the request box.
  expect(trayOf(container)).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('textarea'));
});

it('gives the focus back to a continue answer refused or not confirmed, unless it was moved', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_limit', { limit: roundLimit })],
  });
  const settles: { resolve(value: Receipt): void; reject(error: Error): void }[] = [];
  store.setState({
    resolveApproval: vi.fn(
      () =>
        new Promise<Receipt>((resolve, reject) => {
          settles.push({ resolve, reject });
        }),
    ),
  });
  const { container } = await show(['run_a']);
  const stack = () => trayOf(container)?.querySelector('[data-continue-decisions]');
  const go = () => buttons(stack(), messages.Approvals.limit.approve)[0];
  // While the answer is on its way its buttons are disabled, and the browser drops the focus
  // (jsdom keeps it on a disabled button: it goes through an element that then leaves).
  const press = async () => {
    go()?.focus();
    await act(async () => go()?.click());
    const passing = document.body.appendChild(document.createElement('button'));
    passing.focus();
    passing.remove();
    expect(document.activeElement).toBe(document.body);
  };
  await press();
  await act(async () =>
    settles[0]?.resolve({
      error: { code: 'CONFLICT', message: 'The loop already moved on.' },
    } as unknown as Receipt),
  );
  await settleFrames();
  expect(document.activeElement).toBe(go());
  await press();
  await act(async () => settles[1]?.reject(new Error('connection lost')));
  await settleFrames();
  expect(document.activeElement).toBe(go());
  // Moved elsewhere while it was on its way: left there.
  await press();
  const elsewhere = container.querySelector<HTMLInputElement>('input[aria-label="Elsewhere"]');
  elsewhere?.focus();
  await act(async () =>
    settles[2]?.resolve({
      error: { code: 'CONFLICT', message: 'Again.' },
    } as unknown as Receipt),
  );
  await settleFrames();
  expect(document.activeElement).toBe(elsewhere);
});

it('gives the focus back to the answer pressed, and a refused answer hands nothing on later', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_limit', { limit: roundLimit })],
  });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const stack = () => trayOf(container)?.querySelector('[data-continue-decisions]');
  const stop = () => buttons(stack(), messages.Approvals.limit.reject)[0];
  const drop = () => {
    const passing = document.body.appendChild(document.createElement('button'));
    passing.focus();
    passing.remove();
  };
  stop()?.focus();
  await act(async () => stop()?.click());
  drop();
  await sent[0]?.settle('The loop already moved on.');
  await settleFrames();
  // Back on Stop, the answer pressed, not on the first.
  expect(document.activeElement).toBe(stop());
  // The person puts the focus down; the run then closes the request on its own: nothing was
  // answered from the card this time, so the focus is not carried to the request box.
  drop();
  await act(async () => closeApproval(store, 'approval_limit', 'approve'));
  await settleFrames();
  expect(trayOf(container)).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

it('shows the receipt’s confirmation while the request is still open', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_limit', { limit: roundLimit })],
  });
  store.setState({
    resolveApproval: vi.fn(async () => ({ commandId: 'command' }) as unknown as Receipt),
  });
  const { container } = await show(['run_a']);
  const stack = trayOf(container)?.querySelector('[data-continue-decisions]');
  await act(async () => buttons(stack, messages.Approvals.limit.approve)[0]?.click());
  await settleFrames();
  expect(stack?.querySelector('[role="status"]')?.textContent).toContain(
    'Round limit reached (3 of 3)',
  );
});

it('comes into view and takes focus when asked to respond, once', async () => {
  const store = waitingRun('run_a', { approvals: [decision('approval_1')] });
  const { container, tray } = await show(['run_a']);
  expect(document.activeElement).not.toBe(trayOf(container));
  await act(async () => revealPendingTray(tray, SESSION));
  await settleFrames();
  expect(document.activeElement).toBe(trayOf(container));
  // Used once: the request is gone, so the tray coming back soon after takes no focus.
  expect(tray.getState().reveal).toBeNull();
  container.querySelector('textarea')?.focus();
  await act(async () => closeApproval(store, 'approval_1', 'approve'));
  expect(trayOf(container)).toBeNull();
  const projection = store.getState().projection as RunProjection;
  await act(async () =>
    store.setState({
      projection: {
        ...projection,
        status: 'awaiting_user',
        approvals: { ...projection.approvals, approval_2: decision('approval_2') },
      },
    }),
  );
  await settleFrames();
  expect(trayOf(container)).not.toBeNull();
  expect(document.activeElement).toBe(container.querySelector('textarea'));
});

/**
 * Two conversations shown in turn on one session screen: the same tray store, a ChatView and a
 * PendingTray for whichever conversation is open, as the session page keys them.
 */
async function conversations(runsOf: Record<string, string[]>) {
  const tray = createPendingTrayStore();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const open = (sessionId: string) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <PendingTrayContext.Provider value={{ store: tray }}>
            <ChatView
              key={sessionId}
              sessionId={sessionId}
              items={[{ id: `entry_${sessionId}`, content: <p>{sessionId}</p> }]}
              tray={
                <PendingTray
                  sessionId={sessionId}
                  runs={(runsOf[sessionId] ?? []).map((runId) =>
                    summary(runId, 'awaiting_user', sessionId),
                  )}
                  onOpenArtifact={vi.fn()}
                />
              }
              composer={<textarea aria-label="Request" />}
            />
            <VisibleProbe />
          </PendingTrayContext.Provider>
        </IntlProvider>,
      ),
    );
  return { tray, container, open };
}

it('counts what waits in the conversation now open, after switching from another', async () => {
  waitingRun('run_one', { approvals: [decision('approval_1')] });
  waitingRun('run_two', { approvals: [decision('approval_2')], questions: ['Which layout?'] });
  const view = await conversations({ session_one: ['run_one'], session_two: ['run_two'] });
  await view.open('session_one');
  await settleFrames();
  expect(view.tray.getState().waiting).toBe(1);
  await view.open('session_two');
  await settleFrames();
  // The tray that left clears nothing the new one wrote.
  expect(view.tray.getState().waiting).toBe(2);
  expect(view.container.querySelector('[data-testid="tray-probe"]')?.textContent).toBe('false:2');
});

it('keeps a request to respond for its own conversation', async () => {
  waitingRun('run_two', { approvals: [decision('approval_2')] });
  const view = await conversations({ session_one: [], session_two: ['run_two'] });
  await view.open('session_one');
  // Respond in the first conversation, where nothing waits; then the person opens the second.
  await act(async () => revealPendingTray(view.tray, 'session_one'));
  await view.open('session_two');
  await settleFrames();
  const tray = trayOf(view.container);
  expect(tray).not.toBeNull();
  expect(document.activeElement).not.toBe(tray);
});

/** Lays out the timeline and the tray where a browser would, for measuring at mount. */
function layOut(trayTop: number) {
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, height, left: 0, right: 600, width: 600 }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('[data-testid="chat-timeline"]')) return rect(0, 400);
    if (this.matches('[data-pending-tray]')) return rect(trayTop, 120);
    return rect(0, 0);
  });
}

it('is neither in nor out of view until its observer reports, wherever it stood when added', async () => {
  waitingRun('run_a', { approvals: [decision('approval_1')] });
  // Added below the view, as a card arriving at the end is before the conversation follows it
  // there: not yet out of view, so no notice comes and goes.
  layOut(900);
  const { container, tray } = await show(['run_a']);
  expect(tray.getState().placement).toBe('unknown');
  const observed = observers.find((entry) => entry.target === trayOf(container));
  await act(async () =>
    observed?.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(tray.getState().placement).toBe('out-of-view');
});

it('tells whether the tray is on screen and how much waits in it', async () => {
  waitingRun('run_a', {
    approvals: [decision('approval_1')],
    questions: ['Which layout should I keep?'],
  });
  const { container } = await show(['run_a']);
  const probe = () => container.querySelector('[data-testid="tray-probe"]')?.textContent;
  expect(probe()).toBe('false:2');
  const observed = observers.find((entry) => entry.target === trayOf(container));
  expect(observed).toBeDefined();
  // One observer for the tray.
  expect(observers.filter((entry) => entry.target === trayOf(container))).toHaveLength(1);
  await act(async () =>
    observed?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(probe()).toBe('true:2');
  await act(async () =>
    observed?.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(probe()).toBe('false:2');
});

/** What the tray's current observer reports. */
async function report(container: HTMLElement, entry: Partial<IntersectionObserverEntry>) {
  const observed = observers.find((item) => item.target === trayOf(container));
  if (!observed) throw new Error('no observer for the tray');
  await act(async () =>
    observed.callback([entry as IntersectionObserverEntry], {} as IntersectionObserver),
  );
}

const box = (height: number) => ({ top: 0, bottom: height, height, width: 600 }) as DOMRectReadOnly;

it('is neither in nor out of view while the conversation is hidden behind another view', async () => {
  waitingRun('run_a', { approvals: [decision('approval_1')] });
  const { container, tray } = await show(['run_a']);
  await report(container, {
    isIntersecting: true,
    boundingClientRect: box(120),
    rootBounds: box(400),
  });
  expect(tray.getState().placement).toBe('in-view');
  // Another view in front: the hidden conversation has no size, and its tray intersects nothing.
  await report(container, {
    isIntersecting: false,
    boundingClientRect: box(0),
    rootBounds: box(0),
  });
  expect(tray.getState().placement).toBe('unknown');
  await report(container, { isIntersecting: false, boundingClientRect: box(0), rootBounds: null });
  expect(tray.getState().placement).toBe('unknown');
  // Shown and measured again.
  await report(container, {
    isIntersecting: false,
    boundingClientRect: box(120),
    rootBounds: box(400),
  });
  expect(tray.getState().placement).toBe('out-of-view');
});

it('measures the conversation afresh when it is shown again', async () => {
  waitingRun('run_a', { approvals: [decision('approval_1')] });
  const { container } = await show(['run_a']);
  const timeline = container.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  if (!timeline) throw new Error('missing timeline');
  const resizer = resizers.find((item) => item.targets.includes(timeline));
  expect(resizer).toBeDefined();
  const before = observers.find((item) => item.target === trayOf(container));
  // The conversation comes back into view with a size: a new observer reports where the tray is.
  vi.spyOn(timeline, 'clientHeight', 'get').mockReturnValue(400);
  await act(async () => resizer?.callback([], {} as ResizeObserver));
  const after = observers.find((item) => item.target === trayOf(container));
  expect(after).toBeDefined();
  expect(after).not.toBe(before);
});

it('goes back to neither when it leaves, and stays so when it comes back until measured', async () => {
  const store = waitingRun('run_a', { approvals: [decision('approval_1')] });
  const { container, tray } = await show(['run_a']);
  await report(container, { isIntersecting: false });
  expect(tray.getState().placement).toBe('out-of-view');
  await act(async () => closeApproval(store, 'approval_1', 'approve'));
  expect(trayOf(container)).toBeNull();
  expect(tray.getState().placement).toBe('unknown');
  // The run waits again: the tray is back, not yet measured.
  await act(async () => {
    const projection = store.getState().projection;
    if (!projection) throw new Error('missing projection');
    store.setState({
      projection: {
        ...projection,
        status: 'awaiting_user',
        approvals: { ...projection.approvals, approval_2: decision('approval_2') },
      },
    });
  });
  expect(trayOf(container)).not.toBeNull();
  expect(tray.getState().placement).toBe('unknown');
});

it('does not come into view or take focus for a request to respond older than its window', async () => {
  waitingRun('run_a', { approvals: [decision('approval_1')] });
  let now = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { container, tray } = await show(['run_a']);
  const input = container.ownerDocument.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Request"]',
  );
  input?.focus();
  // Asked more than 5s ago (a link followed long after it was made): the tray does not take it.
  await act(async () => tray.setState({ reveal: { sessionId: SESSION, at: now - 5_001 } }));
  await settleFrames();
  expect(document.activeElement).toBe(input);
  now += 100;
  // One made inside the window does.
  await act(async () => tray.setState({ reveal: { sessionId: SESSION, at: now - 4_900 } }));
  await settleFrames();
  expect(document.activeElement).toBe(trayOf(container));
});

/** Types into a controlled field as a person does. */
async function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The run's record of an answer: its event, and the answer body it points to. */
function recordAnswer(
  store: RunSessionStore,
  requestId: string,
  answers: { questionId: string; optionIds?: string[]; text?: string }[],
) {
  const { events, artifactTexts } = store.getState();
  const asked = events.find(
    (event) => event.type === 'user_input.requested' && event.payload.requestId === requestId,
  );
  if (asked?.type !== 'user_input.requested') throw new Error(`missing ${requestId}`);
  const answered = RunEvent.parse({
    ...asked,
    eventId: `event_answer_${requestId}`,
    runSeq: events.length + 1,
    type: 'user_input.answered',
    payload: {
      requestId,
      executionId: asked.payload.executionId,
      attemptNo: asked.payload.attemptNo,
      answerRef: `answer_${requestId}`,
      answerHash: 'c'.repeat(64),
    },
  });
  store.setState({
    events: [...events, answered],
    artifactTexts: {
      ...artifactTexts,
      [`answer_${requestId}`]: JSON.stringify({ status: 'answered', answers }),
    },
  });
}

/** A run whose definition has the given agent roles (`id:Label`, `id:Label:callable`). */
function withRoles(store: RunSessionStore, ...roles: string[]) {
  store.setState({
    definition: {
      nodes: roles.map((role) => {
        const [id, label, invocation = 'scheduled'] = role.split(':');
        return { id, label, type: 'agent', invocation };
      }),
    } as unknown as ReturnType<RunSessionStore['getState']>['definition'],
  });
}

it('draws a question in the same card as an approval: head, body, answers at the end', async () => {
  waitingRun('run_a', {
    approvals: [decision('approval_1')],
    questions: ['Which layout should I keep?'],
  });
  const { container } = await show(['run_a']);
  const tray = trayOf(container);
  const approval = tray?.querySelector<HTMLElement>('[data-approval="approval_1"]');
  const question = tray?.querySelector<HTMLElement>('[data-question]');
  if (!approval || !question) throw new Error('missing cards');
  // One frame: the kit card, with the same surface, edge, corners and padding; no tinted fill or
  // coloured edge that reads as a warning.
  expect(question.className).toBe(approval.className);
  for (const element of [question, ...question.querySelectorAll<HTMLElement>('*')])
    expect(String(element.className)).not.toMatch(/\b(?:bg|border)-(?:warning|danger|info)\b/);
  // The same head row: the waiting icon and the title. The question's own words are its title.
  const head = (card: Element) => card.querySelector<HTMLElement>('[data-request-head]');
  expect(head(question)?.className).toBe(head(approval)?.className);
  expect(head(question)?.querySelector('p')?.textContent).toBe('Which layout should I keep?');
  expect(head(question)?.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1);
  // The first attempt goes unsaid; a lone conversation run names nobody.
  expect(visibleText(question)).not.toContain('Attempt');
  expect(question.querySelector('[data-request-owner]')).toBeNull();
  // The card says what is asked and who asks; the execution id stays in the run record.
  expect(question.textContent).not.toMatch(/exec_/);
  expect(question.querySelector('details')).toBeNull();
  expect(question.querySelector('[aria-label="Copy execution ID"]')).toBeNull();
  // The same foot row, with the answer as the main action at its end, never full width.
  const foot = (card: Element) => card.querySelector<HTMLElement>('[data-request-foot]');
  expect(foot(question)?.className).toBe(foot(approval)?.className);
  const send = buttons(foot(question), messages.Harness.sendAnswer)[0];
  expect(send?.disabled).toBe(true);
  await typeInto(question.querySelector('input') as HTMLInputElement, 'A table');
  expect(send?.disabled).toBe(false);
  expect(send?.className).toBe(buttons(foot(approval), approve)[0]?.className);
  expect(send?.className).not.toMatch(/\bw-full\b/);
});

it('names the attempt under the title only after the first', async () => {
  const store = waitingRun('run_a', { questions: ['Which layout should I keep?'] });
  const { events, projection } = store.getState();
  const asked = events[0];
  if (!projection || asked?.type !== 'user_input.requested') throw new Error('missing question');
  const executionId = asked.payload.executionId;
  store.setState({
    events: [{ ...asked, payload: { ...asked.payload, attemptNo: 2 } }],
    projection: {
      ...projection,
      executions: {
        ...projection.executions,
        [executionId]: { ...(projection.executions[executionId] as ExecutionView), attemptNo: 2 },
      },
    },
  });
  const { container } = await show(['run_a']);
  const owner = trayOf(container)?.querySelector('[data-question] [data-request-owner]');
  expect(owner?.textContent).toBe('Attempt 2');
});

it('folds an answered question into one line in its place while its run still waits', async () => {
  const log = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level),
  );
  const store = waitingRun('run_a', {
    approvals: [decision('approval_1')],
    questions: ['Which format should the report use?'],
  });
  store.setState({
    artifactTexts: {
      body_q_run_a_0: JSON.stringify({
        key: 'format',
        questions: [
          {
            id: 'format',
            kind: 'single',
            prompt: 'Which format should the report use?',
            options: [
              { id: 'table', label: 'A table' },
              { id: 'list', label: 'A list' },
            ],
          },
        ],
      }),
    },
  });
  const { container } = await show(['run_a']);
  const tray = trayOf(container);
  expect(tray?.querySelector('[data-question]')).not.toBeNull();
  await act(async () =>
    recordAnswer(store, 'q_run_a_0', [{ questionId: 'format', optionIds: ['table'] }]),
  );
  // The card's place holds one line: an icon and what was answered.
  expect(tray?.querySelector('[data-question]')).toBeNull();
  const line = tray?.querySelector('[data-testid="answered-q_run_a_0"]');
  expect(line?.textContent).toBe('Answered: A table');
  expect(line?.querySelectorAll('svg')).toHaveLength(1);
  expect(line?.querySelector('button, input')).toBeNull();
  // As a decided approval's line: in the card's place, before what still waits.
  const waiting = tray?.querySelector('[data-approval="approval_1"]');
  expect(line && waiting && line.compareDocumentPosition(waiting)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  // Nothing of the answer went to the console.
  for (const spy of log)
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('A table');
  // Once nothing waits, the line leaves with the area.
  await act(async () => closeApproval(store, 'approval_1', 'approve'));
  expect(trayOf(container)).toBeNull();
});

it('cuts a long written answer to one line', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_1')],
    questions: ['Which layout should I keep?'],
  });
  const { container } = await show(['run_a']);
  const long = `${'Keep the compact layout '.repeat(30)}\nand the second line`;
  await act(async () => recordAnswer(store, 'q_run_a_0', [{ questionId: 'layout', text: long }]));
  const line = trayOf(container)?.querySelector('[data-testid="answered-q_run_a_0"]');
  const words = line?.querySelector('span');
  expect(words?.className).toContain('truncate');
  expect(words?.textContent?.startsWith('Answered: Keep the compact layout')).toBe(true);
  expect(words?.textContent).not.toContain('second line');
  expect(words?.textContent?.length).toBeLessThanOrEqual('Answered: '.length + 200);
});

it('never cuts a character outside the basic plane in half', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_1')],
    questions: ['Which layout should I keep?'],
  });
  const { container } = await show(['run_a']);
  // The 200th character is an emoji, two UTF-16 units: kept whole, and nothing after it.
  const long = `${'a'.repeat(199)}😀 and more after the cut`;
  await act(async () => recordAnswer(store, 'q_run_a_0', [{ questionId: 'layout', text: long }]));
  const words = trayOf(container)?.querySelector('[data-testid="answered-q_run_a_0"] span');
  const text = words?.textContent ?? '';
  expect(text.endsWith(`${'a'.repeat(199)}😀`)).toBe(true);
  expect(text).not.toMatch(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
  );
});

it('names nobody on the cards of a lone run with one role', async () => {
  const lone = waitingRun('run_a', {
    approvals: [decision('approval_a', { nodeId: 'writer' })],
    questions: ['Which layout should I keep?'],
  });
  // A conversation: its assistant, and a helper it may call that has not run.
  withRoles(lone, 'writer:Assistant', 'helper:Helper:callable');
  const { container } = await show(['run_a']);
  // The run's row already says whose it is.
  expect(trayOf(container)?.querySelector('[data-approval]')).not.toBeNull();
  expect(trayOf(container)?.querySelector('[data-request-owner]')).toBeNull();
  // Once the helper has run too, a card says which of them asks.
  const projection = lone.getState().projection as RunProjection;
  await act(async () =>
    lone.setState({
      projection: {
        ...projection,
        executions: {
          ...projection.executions,
          exec_helper: { ...execution('exec_helper'), nodeId: 'helper', status: 'succeeded' },
        },
      },
    }),
  );
  expect(
    trayOf(container)?.querySelector('[data-question] [data-request-owner]')?.textContent,
  ).toBe('Assistant');
});

it('names the role on each card of a run with several roles', async () => {
  const team = waitingRun('run_a', {
    approvals: [decision('approval_a', { nodeId: 'reviewer', kind: 'breakpoint' })],
    questions: ['Which layout should I keep?'],
  });
  withRoles(team, 'writer:Writer', 'reviewer:Reviewer');
  const { container } = await show(['run_a']);
  const owners = [...(trayOf(container)?.querySelectorAll('[data-request-owner]') ?? [])];
  // The question's role from its execution, the approval's from its node; in the same place.
  expect(owners.map((owner) => owner.textContent)).toEqual(['Writer', 'Reviewer']);
  for (const owner of owners)
    expect(owner.closest('[data-request-head]')?.contains(owner)).toBe(true);
});

it('names the run, and its role, on each card while several runs wait', async () => {
  const a = waitingRun('run_a', { questions: ['Which layout should I keep?'] });
  withRoles(a, 'writer:Assistant');
  const b = waitingRun('run_b', {
    approvals: [decision('approval_b'), decision('approval_limit', { limit: roundLimit })],
  });
  const { container } = await show(['run_a', 'run_b']);
  const tray = trayOf(container);
  expect(tray?.querySelector('[data-run-response="run_a"] [data-request-owner]')?.textContent).toBe(
    'Run #1 · Assistant',
  );
  expect(
    tray?.querySelector('[data-approval="approval_b"] [data-request-owner]')?.textContent,
  ).toBe('Run #2');
  // A continue-or-stop decision is the run's: its run leads its facts.
  expect(
    tray?.querySelector('[data-run-response="run_b"] [data-continue-decisions]')?.textContent,
  ).toContain('Run #2');
  // Once one run is left, it names nobody again.
  await act(async () => {
    closeApproval(b, 'approval_b', 'approve');
    closeApproval(b, 'approval_limit', 'approve');
  });
  expect(trayOf(container)?.querySelector('[data-question]')).not.toBeNull();
  expect(trayOf(container)?.querySelector('[data-request-owner]')).toBeNull();
});

it('names each run’s area by its run while several wait, and each card by its title', async () => {
  waitingRun('run_a', { approvals: [decision('approval_a')] });
  waitingRun('run_b', {
    approvals: [decision('approval_b', { kind: 'final_output' })],
    questions: ['Which layout should I keep?'],
  });
  const { container } = await show(['run_a', 'run_b']);
  const tray = trayOf(container) as HTMLElement;
  const areas = [...tray.querySelectorAll('[data-testid="run-needs-you"]')];
  expect(areas.map((area) => area.getAttribute('aria-label'))).toEqual([
    'Run #1 · Waiting for you',
    'Run #2 · Waiting for you',
  ]);
  // Inside, nothing says the area's name again.
  for (const area of areas)
    for (const named of area.querySelectorAll('[aria-label]'))
      expect(named.getAttribute('aria-label')).not.toBe(messages.Presence.state.awaiting_user);
  // Each card is named by its own title; the screen's words stay as they were.
  const name = (card: Element | null) =>
    document.getElementById(card?.getAttribute('aria-labelledby') ?? '')?.textContent;
  expect(name(tray.querySelector('[data-approval="approval_a"]'))).toBe(
    messages.Approvals.kind.user_action,
  );
  expect(name(tray.querySelector('[data-approval="approval_b"]'))).toBe(
    messages.Approvals.kind.final_output,
  );
  expect(tray.querySelector('form')?.getAttribute('aria-label')).toBe(
    'Run #2 · Waiting for you: Which layout should I keep?',
  );
  expect(visibleText(tray)).not.toContain('Run #1 · Waiting for you');
});

it('names each run’s continue-or-stop stack by its run when several stand at their limits', async () => {
  waitingRun('run_a', { approvals: [decision('limit_a', { limit: roundLimit })] });
  waitingRun('run_b', { approvals: [decision('limit_b', { limit: roundLimit })] });
  const { container } = await show(['run_a', 'run_b']);
  const named = [
    ...(trayOf(container)?.querySelectorAll('section[aria-label], [role="region"][aria-label]') ??
      []),
  ].map((element) => element.getAttribute('aria-label'));
  expect(named).toEqual(
    expect.arrayContaining([
      `Run #1 · ${messages.Approvals.continueRegion}`,
      `Run #2 · ${messages.Approvals.continueRegion}`,
    ]),
  );
  // No two landmarks in the tray share a name.
  expect(new Set(named).size).toBe(named.length);
});

it('hands focus from a decided approval to an extension’s request waiting beside it', async () => {
  const store = waitingRun('run_a', { approvals: [decision('approval_1')] });
  const projection = store.getState().projection as RunProjection;
  const executionId = 'exec_extension';
  projection.executions[executionId] = execution(executionId);
  projection.executionOrder.push(executionId);
  store.setState({
    projection: { ...projection },
    events: [
      RunEvent.parse({
        schemaVersion: '0.1',
        eventId: 'event_extension',
        runId: 'run_a',
        runSeq: 1,
        recordedAt: '2026-11-09T00:00:00.000Z',
        actor: { kind: 'runtime', id: 'runtime' },
        causedByEventIds: [],
        type: 'extension.ui_requested',
        payload: {
          requestId: 'extension_1',
          executionId,
          attemptNo: 1,
          kind: 'input',
          bodyRef: 'body_extension_1',
          bodyHash: 'b'.repeat(64),
          deadline: '2099-11-09T00:01:00.000Z',
        },
      }),
    ],
    artifactTexts: {
      body_extension_1: JSON.stringify({
        kind: 'input',
        title: 'Name the build',
        placeholder: 'nightly',
        timeoutMs: 60_000,
      }),
    },
  });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const tray = trayOf(container);
  const field = tray?.querySelector<HTMLInputElement>('[data-extension="extension_1"] input');
  expect(field).toBeTruthy();
  const allow = tray?.querySelector<HTMLButtonElement>(
    '[data-approval="approval_1"] [data-approval-action="primary"]',
  );
  allow?.focus();
  await act(async () => allow?.click());
  await sent[0]?.settle();
  await settleFrames();
  // Not the request box: the request still waiting in the tray is next.
  expect(document.activeElement).toBe(field);
});

it('names a lone run’s area by the wait alone', async () => {
  waitingRun('run_a', { approvals: [decision('approval_a')] });
  const { container } = await show(['run_a']);
  expect(
    trayOf(container)?.querySelector('[data-testid="run-needs-you"]')?.getAttribute('aria-label'),
  ).toBe(messages.Presence.state.awaiting_user);
});

it('measures again when the composer grows, so a covered tray reads as out of view', async () => {
  waitingRun('run_a', { approvals: [decision('approval_1')] });
  const { container } = await show(['run_a']);
  const probe = () => container.querySelector('[data-testid="tray-probe"]')?.textContent;
  const watching = () => observers.filter((entry) => entry.target === trayOf(container));
  const first = watching()[0];
  await act(async () =>
    first?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(probe()).toBe('true:1');
  // The composer takes more lines and now lies over the tray.
  const composer = container.querySelector<HTMLElement>('[data-testid="chat-composer"]');
  if (!composer) throw new Error('missing composer');
  composer.dataset.composerSurface = 'floating';
  Object.defineProperty(composer, 'offsetHeight', { configurable: true, value: 240 });
  await act(async () => {
    for (const resizer of resizers)
      if (resizer.targets.includes(composer)) resizer.callback([], {} as ResizeObserver);
  });
  // Still one observer, a new one, leaving the new height out.
  expect(watching()).toHaveLength(1);
  expect(watching()[0]).not.toBe(first);
  expect(watching()[0]?.options?.rootMargin).toBe('0px 0px -240px 0px');
  await act(async () =>
    watching()[0]?.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(probe()).toBe('false:1');
});
