// @vitest-environment jsdom
import { emptyProjection, type RunProjection, type RunSummary } from '@corral/core';
import type { RunSessionStore } from '@corral/react';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../packages/react/src/stories/fixtures.tsx';
import { RunMessage } from './RunMessage.tsx';
import { ComposerActivity } from './session/ComposerActivity.tsx';
import { PendingTray } from './session/PendingTray.tsx';
import { createPendingTrayStore, PendingTrayContext } from './session/pendingTrayState.ts';
import { stubViewport } from './session/viewport.testing.ts';
import { topbarLayout } from './topbarTier.ts';
import { actionRequired, presentContext } from './widgets/selectors.ts';
import type { ChatWidgetModel } from './widgets/useChatWidgets.tsx';

// The main area of a session conversation whose team run waits on one approval: the run's turn,
// the needed-now tray at the timeline's end with the approval card, and the composer's activity
// bar. The top bar has no run state (composer-flow.md "화면 틀").

const fixture = vi.hoisted(() => ({
  store: null as RunSessionStore | null,
  model: null as ChatWidgetModel | null,
}));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ runFor: () => fixture.store, retainRun: () => () => {} }),
}));
vi.mock('./TopbarSlot.tsx', async (original) => ({
  ...(await original<typeof import('./TopbarSlot.tsx')>()),
  // The widest bar: the pill says its state and the run's number in words.
  useTopbarLayout: () => topbarLayout(0),
}));
vi.mock('./useCorralChat.ts', () => ({
  useCorralRun: () => ({
    store: fixture.store,
    state: useStore(fixture.store as RunSessionStore),
    conversationTurn: null,
    bodyMetadataCurrent: true,
  }),
}));
vi.mock('./widgets/useChatWidgets.tsx', () => ({ useChatWidget: () => fixture.model }));
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: boolean) => useState(initial),
}));
vi.mock('../pages/GettingStarted.tsx', () => ({ markRunReviewed() {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#run">{children}</a>,
}));

const cleanup: (() => void)[] = [];
let viewport: ReturnType<typeof stubViewport>;
beforeEach(() => {
  viewport = stubViewport();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    // Reduced motion: the activity bar's words swap at once, with nothing left fading out.
    matches: query.includes('reduced-motion'),
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
  Element.prototype.getAnimations ??= () => [];
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

function waitingOnApproval(): RunProjection {
  const projection = emptyProjection('run_team');
  projection.status = 'awaiting_user';
  projection.startedAt = '2026-11-09T00:00:00.000Z';
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

/** The composer's model while only that approval waits, as useChatWidgets derives it. */
function waitingModel(): ChatWidgetModel {
  return {
    sessionId: 'session_team',
    runId: 'run_team',
    runNumber: 1,
    live: true,
    viewed: null,
    readState: 'ready',
    chips: [],
    tools: [],
    action: actionRequired({
      pendingApprovals: 1,
      pendingQuestions: 0,
      failedEffects: 0,
      unclearEffects: 0,
      runStatus: 'awaiting_user',
    }),
    questionNotice: null,
    context: presentContext({ calls: [], compactions: [], selectedExecutionId: null }),
    failedExecutionId: null,
    plan: {
      open: false,
      setOpen: vi.fn(),
      status: { state: 'hidden' },
      selectedKey: null,
      selectedChoice: null,
      choices: [],
      multiple: false,
      auto: true,
      runStatus: 'awaiting_user',
      retry: vi.fn(),
      follow: vi.fn(),
      choose: vi.fn(),
    },
  } as unknown as ChatWidgetModel;
}

const runs: RunSummary[] = [
  {
    runId: 'run_team',
    status: 'awaiting_user',
    corralId: 'team',
    projectId: 'project',
    sessionId: 'session_team',
    startedAt: '2026-11-09T00:00:00.000Z',
  },
];

async function mainArea(projection = waitingOnApproval()) {
  fixture.store = sessionStore({ runId: 'run_team', projection });
  fixture.model = waitingModel();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  const tray = createPendingTrayStore();
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <PendingTrayContext.Provider value={{ store: tray }}>
          <div data-chat-view>
            <div data-testid="chat-timeline">
              <RunMessage
                runId="run_team"
                sessionId="session_team"
                live
                onOpenArtifact={vi.fn()}
                runLine={<button type="button">Run #1</button>}
              />
              <PendingTray sessionId="session_team" runs={runs} onOpenArtifact={vi.fn()} />
            </div>
            <div data-testid="chat-composer">
              <ComposerActivity
                sessionId="session_team"
                ownActive={runs[0] ?? null}
                target={null}
                targets={[]}
                onJoin={vi.fn()}
                onStop={vi.fn()}
                onPause={vi.fn()}
                onResume={vi.fn()}
                viewingOther={false}
              />
            </div>
          </div>
        </PendingTrayContext.Provider>
      </IntlProvider>,
    ),
  );
  return container;
}

const bar = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="activity-bar"]');

/** What a person sees: the text outside screen-reader-only elements. */
function visibleText(container: HTMLElement) {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const node of copy.querySelectorAll('.sr-only')) node.remove();
  return copy.textContent ?? '';
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

it('says the run waits once (the run row) and shows the decision once (the card)', async () => {
  const container = await mainArea();
  const visible = visibleText(container);
  // "Waiting for you", not the start of "Waiting for your decision": once, on the run row's head.
  expect(count(visible, /Waiting for you(?!r)/g)).toBe(1);
  const state = container.querySelectorAll('[data-presence-label="run:run_team"]');
  expect(state).toHaveLength(1);
  expect(state[0]?.closest('[data-chat-part="head"]')).not.toBeNull();
  expect(state[0]?.textContent).toBe(messages.Status.awaiting_user);
  // The activity bar keeps its mark and repeats neither the state nor the decision while the
  // row and the card are on screen.
  const line = visibleText(bar(container) as HTMLElement);
  expect(line).not.toContain(messages.Status.awaiting_user);
  expect(line).not.toContain(messages.Approvals.approveAs.user_action);
  expect(bar(container)?.dataset.line).toBe('summary');
  // The decision: its card's title and its two buttons, each once.
  expect(count(visible, new RegExp(messages.Approvals.kind.user_action, 'g'))).toBe(1);
  expect(count(visible, new RegExp(messages.Approvals.approveAs.user_action, 'g'))).toBe(1);
  expect(count(visible, new RegExp(messages.Approvals.rejectAs.user_action, 'g'))).toBe(1);
  // Nothing else restates it: no reason line, no notice and no second way to decide.
  expect(visible).not.toContain('Waiting for your decision');
  expect(visible).not.toContain(messages.Widgets.actionApproval);
  expect(visible).not.toContain(messages.Widgets.actionOpen);
  // A screen reader still hears that an approval is needed.
  const announced = [...container.querySelectorAll('[aria-live="polite"]')].map(
    (node) => node.textContent ?? '',
  );
  expect(announced.some((text) => text.includes(messages.Widgets.actionApproval))).toBe(true);
});

const tool = (purpose: 'tool' | 'lsp' | 'check') => ({
  purpose,
  executionId: 'exec_writer',
  attemptNo: 1,
  toolCallId: 'call_1',
  bodyRef: 'body_1',
  fingerprint: 'a'.repeat(64),
  deadline: '2026-11-09T00:05:00.000Z',
  ...(purpose === 'tool' ? {} : { effectId: 'effect_1', targetTree: 'b'.repeat(40) }),
});

// Every approval a run can wait on is decided in the conversation's needed-now tray, so the
// composer's notice may leave for each: the card is drawn in the conversation, outside the run's
// turn, with native buttons the keyboard reaches. A continue-or-stop pause is the kit's decision
// stack.
it.each([
  ['final output', { kind: 'final_output' }],
  ['run limit', { kind: 'user_action', limit: { kind: 'loop_iterations', used: 3, max: 3 } }],
  ['decision', { kind: 'user_action' }],
  [
    'route',
    {
      kind: 'route',
      routes: [
        { id: 'route_a', label: 'Publish' },
        { id: 'route_b', label: 'Revise' },
      ],
    },
  ],
  ['check verdict', { kind: 'check' }],
  ['breakpoint', { kind: 'breakpoint', nodeId: 'writer' }],
  ['tool permission', { kind: 'user_action', tool: tool('tool') }],
  ['language server change', { kind: 'check', tool: tool('lsp') }],
  ['check command', { kind: 'check', tool: tool('check') }],
] as const)('draws a waiting %s approval in the conversation turn', async (_name, approval) => {
  const projection = waitingOnApproval();
  projection.approvals.approval_1 = {
    ...projection.approvals.approval_1,
    ...approval,
  } as RunProjection['approvals'][string];
  const container = await mainArea(projection);
  const card =
    'limit' in approval
      ? container.querySelector('[data-continue-decisions]')
      : container.querySelector('[data-testid="approval-approval_1"]');
  expect(card).not.toBeNull();
  expect(card?.closest('[data-pending-tray]')).not.toBeNull();
  expect(card?.closest('[data-chat-part]')).toBeNull();
  expect(container.querySelectorAll('[data-approval], [data-continue-decisions]')).toHaveLength(1);
  const buttons = [...(card?.querySelectorAll('button') ?? [])];
  expect(buttons.length).toBeGreaterThanOrEqual(2);
  // Native buttons in the tab order; the decline is always available.
  for (const button of buttons) expect(button.tabIndex).toBe(0);
  expect(buttons.some((button) => !button.disabled)).toBe(true);
  // The composer adds no notice beside it.
  expect(container.querySelector('[data-testid="action-required"]')).toBeNull();
});

it('says what waits and decides it from the activity bar once the card is off screen', async () => {
  const container = await mainArea();
  const resolve = vi.spyOn(
    fixture.store?.getState() as ReturnType<RunSessionStore['getState']>,
    'resolveApproval',
  );
  // The tray scrolled away; the run row with it.
  await viewport.scroll(() => false);
  const line = bar(container);
  expect(line?.dataset.line).toBe('waiting');
  const text = visibleText(line as HTMLElement);
  expect(text).toContain(messages.Approvals.kind.user_action);
  // The run row is off screen too, so the bar says the state, once.
  expect(count(text, /Waiting for you(?!r)/g)).toBe(1);
  const approve = [...(line?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === messages.Approvals.approveAs.user_action,
  );
  const deny = [...(line?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === messages.Approvals.rejectAs.user_action,
  );
  expect(approve).toBeDefined();
  expect(deny).toBeDefined();
  // Enter and Escape on the bar decide nothing: only the buttons do.
  const toggle = line?.querySelector<HTMLElement>('[data-activity-toggle]');
  for (const key of ['Enter', 'Escape'])
    await act(async () => {
      toggle?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  expect(resolve).not.toHaveBeenCalled();
  await act(async () => approve?.click());
  expect(resolve).toHaveBeenCalledExactlyOnceWith('approval_1', 'approve');
  // Back on screen, the card says it again and the bar lets it go.
  await viewport.scroll(() => true);
  expect(bar(container)?.dataset.line).toBe('summary');
});
