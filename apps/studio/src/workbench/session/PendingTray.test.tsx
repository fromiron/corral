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

const observers: { callback: IntersectionObserverCallback; target: Element | null }[] = [];
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
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      entry: { callback: IntersectionObserverCallback; target: Element | null };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, target: null };
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
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
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

const summary = (runId: string, status: RunSummary['status'] = 'awaiting_user'): RunSummary => ({
  runId,
  status,
  corralId: 'team',
  projectId: 'project',
  sessionId: SESSION,
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
  const form = tray.querySelector(`form[aria-label="${messages.Harness.userQuestions}"]`);
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
    approvals: [decision('approval_loop', { kind: 'loop_cap', loopStop: 'stalled' })],
  });
  const sent = decisions(store);
  const { container } = await show(['run_a']);
  const tray = trayOf(container);
  const stack = tray?.querySelector('[data-continue-decisions]');
  expect(
    stack?.querySelector(`[aria-label="${messages.Approvals.continueRegion}"]`),
  ).not.toBeNull();
  expect(stack?.textContent).toContain(messages.Approvals.kind.loop_stalled);
  // Not drawn a second time as an approval card.
  expect(tray?.querySelector('[data-approval]')).toBeNull();
  const go = () => buttons(stack, messages.Approvals.approveAs.loop_stalled)[0];
  const stop = () => buttons(stack, messages.Approvals.rejectAs.loop_stalled)[0];
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

it('shows the receipt’s confirmation while the request is still open', async () => {
  const store = waitingRun('run_a', {
    approvals: [decision('approval_loop', { kind: 'loop_cap', loopStop: 'stalled' })],
  });
  store.setState({
    resolveApproval: vi.fn(async () => ({ commandId: 'command' }) as unknown as Receipt),
  });
  const { container } = await show(['run_a']);
  const stack = trayOf(container)?.querySelector('[data-continue-decisions]');
  await act(async () => buttons(stack, messages.Approvals.approveAs.loop_stalled)[0]?.click());
  await settleFrames();
  expect(stack?.querySelector('[role="status"]')?.textContent).toContain(
    `${messages.Approvals.kind.loop_stalled} approved`,
  );
});

it('comes into view and takes focus when asked to respond', async () => {
  waitingRun('run_a', { approvals: [decision('approval_1')] });
  const { container, tray } = await show(['run_a']);
  expect(document.activeElement).not.toBe(trayOf(container));
  await act(async () => revealPendingTray(tray));
  await settleFrames();
  expect(document.activeElement).toBe(trayOf(container));
  // Once: a later render does not take focus again.
  container.querySelector('textarea')?.focus();
  await act(async () => tray.setState({ visible: false }));
  await settleFrames();
  expect(document.activeElement).toBe(container.querySelector('textarea'));
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
