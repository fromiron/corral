// @vitest-environment jsdom

import type { Receipt } from '@corral/contracts';
import {
  emptyProjection,
  type RunProjection,
  type RunSummary,
  toolPermissionPlan,
} from '@corral/core';
import type { RunSessionState, RunSessionStore } from '@corral/react';
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

async function mainArea(
  projection = waitingOnApproval(),
  artifactTexts: Record<string, string> = {},
  more: Partial<RunSessionState> = {},
) {
  fixture.store = sessionStore({ runId: 'run_team', projection, artifactTexts, ...more });
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

/** One real animation frame: what is drawn now is painted. */
const frame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

it('says the run waits once (the run row) and shows the decision once (the card)', async () => {
  const container = await mainArea();
  const visible = visibleText(container);
  // "Waiting for you", not the start of "Waiting for your decision": once, on the run row's head.
  expect(count(visible, /Waiting for you(?!r)/g)).toBe(1);
  const state = container.querySelectorAll('[data-presence-label="run:run_team"]');
  expect(state).toHaveLength(1);
  expect(state[0]?.closest('[data-chat-part="head"]')).not.toBeNull();
  expect(state[0]?.textContent).toBe(messages.Presence.state.awaiting_user);
  // The activity bar keeps its mark and repeats neither the state nor the decision while the
  // row and the card are on screen.
  const line = visibleText(bar(container) as HTMLElement);
  expect(line).not.toContain(messages.Presence.state.awaiting_user);
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
  // The composer adds no notice beside it: its line names no request and offers no decision.
  expect(bar(container)?.dataset.line).toBe('summary');
  expect(decisions(container)).toEqual([]);
});

/** The decision buttons on the activity bar's line, by what they say in full. */
const decisions = (container: HTMLElement) =>
  [...(bar(container)?.querySelectorAll('button') ?? [])].flatMap((button) => {
    const label = button.getAttribute('aria-label') ?? '';
    return label.includes(' · ') ? [label] : [];
  });
// Only what a person can reach: nothing inert (a closed panel, the buttons' measuring copy).
const lineButton = (container: HTMLElement, words: string) =>
  [...(bar(container)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent === words && !button.closest('[inert]'),
  );

// The line decides only what it says in full: a call it names whole, a step it names. Anything
// else is decided on its card, which View opens.
it.each([
  ['decision', { kind: 'user_action' }, messages.Approvals.kind.user_action],
  ['final output', { kind: 'final_output' }, messages.Approvals.kind.final_output],
  ['check verdict', { kind: 'check' }, messages.Approvals.kind.check],
  [
    'run limit',
    { kind: 'user_action', limit: { kind: 'loop_iterations', used: 3, max: 3 } },
    messages.Approvals.kind.user_action,
  ],
  [
    'route',
    {
      kind: 'route',
      routes: [
        { id: 'route_a', label: 'Publish' },
        { id: 'route_b', label: 'Revise' },
      ],
    },
    messages.Approvals.kind.route,
  ],
  ['language server change', { kind: 'check', tool: tool('lsp') }, messages.Approvals.lspHeading],
  ['check command', { kind: 'check', tool: tool('check') }, messages.Approvals.checkHeading],
] as const)(
  'says a waiting %s off screen and leaves it to its card: View only',
  async (_name, approval, words) => {
    const projection = waitingOnApproval();
    projection.approvals.approval_1 = {
      ...projection.approvals.approval_1,
      ...approval,
    } as RunProjection['approvals'][string];
    const container = await mainArea(projection);
    // The tray scrolled away; the run row with it.
    await viewport.scroll(() => false);
    const line = bar(container);
    expect(line?.dataset.line).toBe('waiting');
    const text = visibleText(line as HTMLElement);
    if (!('limit' in approval)) expect(text).toContain(words);
    // The run row is off screen too, so the bar says the state, once.
    expect(count(text, /Waiting for you(?!r)/g)).toBe(1);
    expect(lineButton(container, messages.Activity.view)).toBeDefined();
    expect(decisions(container)).toEqual([]);
  },
);

it('says no state on the waiting line while the run row on screen says it', async () => {
  const container = await mainArea();
  // The tray is off screen; the run row's state is still on it.
  await viewport.scroll((element) => element.matches('[data-presence-label]'));
  const line = bar(container);
  expect(line?.dataset.line).toBe('waiting');
  expect(visibleText(line as HTMLElement)).not.toMatch(/Waiting for you(?!r)/);
});

it('names a paused step by its name, not its id, and decides it there', async () => {
  const projection = waitingOnApproval();
  projection.approvals.approval_1 = {
    ...projection.approvals.approval_1,
    kind: 'breakpoint',
    nodeId: 'step_draft',
  } as RunProjection['approvals'][string];
  const definition = {
    nodes: [{ id: 'step_draft', label: 'Draft' }],
  } as unknown as RunSessionState['definition'];
  const container = await mainArea(projection, {}, { definition });
  await viewport.scroll(() => false);
  const text = visibleText(bar(container) as HTMLElement);
  const paused = messages.Approvals.kind.breakpoint.replace('{step}', 'Draft');
  expect(text).toContain(paused);
  expect(text).not.toContain('step_draft');
  expect(decisions(container)).toEqual([
    `${messages.Approvals.rejectAs.breakpoint} · ${paused}`,
    `${messages.Approvals.approveAs.breakpoint} · ${paused}`,
  ]);
});

it('leaves a paused step it cannot name to its card', async () => {
  const projection = waitingOnApproval();
  projection.approvals.approval_1 = {
    ...projection.approvals.approval_1,
    kind: 'breakpoint',
    nodeId: 'step_draft',
  } as RunProjection['approvals'][string];
  const container = await mainArea(projection);
  await viewport.scroll(() => false);
  expect(visibleText(bar(container) as HTMLElement)).not.toContain('step_draft');
  expect(decisions(container)).toEqual([]);
});

// A waiting command, as its card reads it from its body.
const commandPlan = (text: string) =>
  toolPermissionPlan(
    { snapshotHash: 'c'.repeat(64), policyRevision: 1 },
    {
      name: 'run_command',
      source: 'corral',
      schemaHash: 'd'.repeat(64),
      exposure: 'direct',
      sideEffect: 'external',
    },
    {
      operationId: 'command_1',
      hostId: 'local',
      sessionId: 'session_team',
      workspaceBindingId: 'binding_1',
      worktreeId: 'worktree_1',
      rootIdentity: 'a'.repeat(64),
      tree: 'b'.repeat(40),
      shellId: 'bash',
      command: text,
      executable: 'bash',
      argv: ['-lc', text],
      cwd: '.',
      environmentHash: 'c'.repeat(64),
      timeoutMs: 120000,
      mode: 'foreground',
      launchFingerprint: 'e'.repeat(64),
      fingerprint: 'd'.repeat(64),
      request: { command: text },
    },
  );
const command = commandPlan('echo tray-ok');

/** A waiting call (`call_1` unless named), its approval naming the plan's fingerprint. */
function waitingOnCommand(plan = command, id = 'approval_1', call = 'call_1', body = 'body_1') {
  const projection = waitingOnApproval();
  delete projection.approvals.approval_1;
  projection.approvals[id] = {
    ...waitingOnApproval().approvals.approval_1,
    approvalId: id,
    tool: { ...tool('tool'), toolCallId: call, bodyRef: body, fingerprint: plan.fingerprint },
  } as RunProjection['approvals'][string];
  return projection;
}

const called = `${messages.Turn.tool.run_command} · echo tray-ok`;

it('names a waiting call off screen as its card does, and decides it there with View beside', async () => {
  const container = await mainArea(waitingOnCommand(), { body_1: JSON.stringify(command) });
  const resolve = vi.spyOn(
    fixture.store?.getState() as ReturnType<RunSessionStore['getState']>,
    'resolveApproval',
  );
  const card = container.querySelector('[data-testid="approval-approval_1"]');
  expect(card?.textContent).toContain('echo tray-ok');
  await viewport.scroll(() => false);
  const line = bar(container);
  expect(line?.dataset.line).toBe('waiting');
  // The card's own words for the call: its tool, then what it runs.
  expect(visibleText(line as HTMLElement)).toContain(called);
  expect(lineButton(container, messages.Activity.view)).toBeDefined();
  // Each decision names in full what it decides.
  expect(decisions(container)).toEqual([
    `${messages.Approvals.rejectTool} · ${called}`,
    `${messages.Approvals.approveTool} · ${called}`,
  ]);
  // Never shown whole as a tooltip: the whole is on the card View opens.
  expect(line?.querySelector('[title*="echo"]')).toBeNull();
  // Enter and Escape on the bar decide nothing: only the buttons do.
  const toggle = line?.querySelector<HTMLElement>('[data-activity-toggle]');
  for (const key of ['Enter', 'Escape'])
    await act(async () => {
      toggle?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  expect(resolve).not.toHaveBeenCalled();
  await act(async () => lineButton(container, messages.Approvals.approveTool)?.click());
  expect(resolve).toHaveBeenCalledExactlyOnceWith('approval_1', 'approve');
  // Back on screen, the card says it again and the bar lets it go.
  await viewport.scroll(() => true);
  expect(bar(container)?.dataset.line).toBe('summary');
});

it('denies with Deny', async () => {
  const container = await mainArea(waitingOnCommand(), { body_1: JSON.stringify(command) });
  const resolve = vi.spyOn(
    fixture.store?.getState() as ReturnType<RunSessionStore['getState']>,
    'resolveApproval',
  );
  await viewport.scroll(() => false);
  await act(async () => lineButton(container, messages.Approvals.rejectTool)?.click());
  expect(resolve).toHaveBeenCalledExactlyOnceWith('approval_1', 'reject');
});

it('sends one decision however fast it is pressed, and takes none while it is sent', async () => {
  const container = await mainArea(waitingOnCommand(), { body_1: JSON.stringify(command) });
  let answer: (receipt: Receipt) => void = () => {};
  const resolve = vi
    .spyOn(fixture.store?.getState() as ReturnType<RunSessionStore['getState']>, 'resolveApproval')
    .mockImplementation(() => new Promise<Receipt>((done) => (answer = done)));
  await viewport.scroll(() => false);
  const approve = lineButton(container, messages.Approvals.approveTool);
  const deny = lineButton(container, messages.Approvals.rejectTool);
  // Two presses before the page draws again.
  await act(async () => {
    approve?.click();
    deny?.click();
  });
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(lineButton(container, messages.Approvals.approveTool)?.disabled).toBe(true);
  expect(lineButton(container, messages.Approvals.rejectTool)?.disabled).toBe(true);
  await act(async () => lineButton(container, messages.Approvals.rejectTool)?.click());
  expect(resolve).toHaveBeenCalledTimes(1);
  await act(async () => answer({} as Receipt));
});

it('says a decision the run refused, as its card does, and leaves only View', async () => {
  const container = await mainArea(waitingOnCommand(), { body_1: JSON.stringify(command) });
  vi.spyOn(
    fixture.store?.getState() as ReturnType<RunSessionStore['getState']>,
    'resolveApproval',
  ).mockResolvedValue({ error: { message: 'The request changed' } } as Receipt);
  await viewport.scroll(() => false);
  await act(async () => lineButton(container, messages.Approvals.approveTool)?.click());
  const line = bar(container) as HTMLElement;
  expect(visibleText(line)).toContain(
    messages.Approvals.refused.replace('{message}', 'The request changed'),
  );
  expect(decisions(container)).toEqual([]);
  expect(lineButton(container, messages.Activity.view)).toBeDefined();
});

it('keeps the decisions on the line with the panel open, where a role row writes its state', async () => {
  // The writer waits on its call; its row in the open panel says so, and the line does not say
  // it again, but still decides the call.
  const projection = waitingOnCommand();
  projection.executionOrder = ['exec_lead', 'exec_writer'];
  for (const [id, node, status] of [
    ['exec_lead', 'lead', 'waiting_children'],
    ['exec_writer', 'writer', 'waiting_approval'],
  ] as const)
    projection.executions[id] = {
      executionId: id,
      nodeId: node,
      taskId: `task_${id}`,
      status,
      attemptNo: 1,
      modelCallIds: [],
    } as unknown as RunProjection['executions'][string];
  const container = await mainArea(projection, { body_1: JSON.stringify(command) });
  await viewport.scroll(() => false);
  expect(decisions(container)).toHaveLength(2);
  const toggle = bar(container)?.querySelector<HTMLElement>('[data-activity-toggle]');
  await act(async () => toggle?.click());
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  // The state is the row's alone now.
  const line = bar(container)?.querySelector('[data-activity-bar] > div') as HTMLElement;
  expect(visibleText(line)).not.toContain(messages.Presence.state.awaiting_user);
  expect(decisions(container)).toEqual([
    `${messages.Approvals.rejectTool} · writer: ${called}`,
    `${messages.Approvals.approveTool} · writer: ${called}`,
  ]);
});

it('leaves the next approval its own buttons after a refusal of the one before', async () => {
  const second = commandPlan('echo second');
  const container = await mainArea(waitingOnCommand(), {
    body_1: JSON.stringify(command),
    body_2: JSON.stringify(second),
  });
  const store = fixture.store as RunSessionStore;
  vi.spyOn(store.getState(), 'resolveApproval').mockResolvedValue({
    error: { message: 'The request changed' },
  } as Receipt);
  await viewport.scroll(() => false);
  await act(async () => lineButton(container, messages.Approvals.approveTool)?.click());
  expect(decisions(container)).toEqual([]);
  const next = waitingOnCommand(second, 'approval_2', 'call_2', 'body_2');
  await act(async () => store.setState({ projection: next }));
  await viewport.scroll(() => false);
  expect(decisions(container)).toEqual([
    `${messages.Approvals.rejectTool} · ${messages.Turn.tool.run_command} · echo second`,
    `${messages.Approvals.approveTool} · ${messages.Turn.tool.run_command} · echo second`,
  ]);
});

it('does not call a decision whose answer was lost a refusal: the line still decides it', async () => {
  const container = await mainArea(waitingOnCommand(), { body_1: JSON.stringify(command) });
  const resolve = vi
    .spyOn(fixture.store?.getState() as ReturnType<RunSessionStore['getState']>, 'resolveApproval')
    .mockRejectedValue(new Error('Failed to fetch'));
  await viewport.scroll(() => false);
  await act(async () => lineButton(container, messages.Approvals.approveTool)?.click());
  const words = visibleText(bar(container) as HTMLElement);
  expect(words).not.toContain(messages.Approvals.refused.replace('{message}', ''));
  expect(words).not.toContain('Failed to fetch');
  // The store keeps the command and checks it again under its first id on the next press.
  expect(lineButton(container, messages.Approvals.approveTool)?.disabled).toBe(false);
  await act(async () => lineButton(container, messages.Approvals.approveTool)?.click());
  expect(resolve).toHaveBeenCalledTimes(2);
});

it.each([
  ['of several lines', 'echo one\necho two'],
  ['longer than its line', `echo ${'x'.repeat(90)}`],
])('leaves a command %s to its card: View only', async (_name, text) => {
  const plan = commandPlan(text);
  const container = await mainArea(waitingOnCommand(plan), { body_1: JSON.stringify(plan) });
  await viewport.scroll(() => false);
  expect(bar(container)?.dataset.line).toBe('waiting');
  expect(lineButton(container, messages.Activity.view)).toBeDefined();
  expect(decisions(container)).toEqual([]);
});

it('leaves a call with nothing to name but its tool to its card', async () => {
  const plan = toolPermissionPlan(
    { snapshotHash: 'c'.repeat(64), policyRevision: 1 },
    {
      name: 'mcp_lookup',
      source: 'mcp',
      schemaHash: 'd'.repeat(64),
      exposure: 'direct',
      sideEffect: 'external',
    },
    { query: 'weather' },
  );
  const container = await mainArea(waitingOnCommand(plan), { body_1: JSON.stringify(plan) });
  await viewport.scroll(() => false);
  expect(bar(container)?.dataset.line).toBe('waiting');
  expect(decisions(container)).toEqual([]);
});

it('leaves a waiting call it cannot name to its card: View only', async () => {
  // The body is not read yet: nothing says what would be allowed.
  const container = await mainArea(waitingOnCommand());
  await viewport.scroll(() => false);
  const line = bar(container);
  expect(line?.dataset.line).toBe('waiting');
  expect(lineButton(container, messages.Activity.view)).toBeDefined();
  expect(decisions(container)).toEqual([]);
});

it('does not name a call by a body made for another call', async () => {
  // The body read is a plan for another command: its fingerprint is not the approval's.
  const other = commandPlan('rm -rf build');
  const container = await mainArea(waitingOnCommand(), { body_1: JSON.stringify(other) });
  await viewport.scroll(() => false);
  expect(visibleText(bar(container) as HTMLElement)).not.toContain('rm -rf build');
  expect(decisions(container)).toEqual([]);
});

it('takes no press for a while when the next approval comes to the same place', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const second = commandPlan('echo second');
    const container = await mainArea(waitingOnCommand(), {
      body_1: JSON.stringify(command),
      body_2: JSON.stringify(second),
    });
    const resolve = vi.spyOn(
      fixture.store?.getState() as ReturnType<RunSessionStore['getState']>,
      'resolveApproval',
    );
    await viewport.scroll(() => false);
    await act(async () => lineButton(container, messages.Approvals.approveTool)?.click());
    expect(resolve).toHaveBeenCalledExactlyOnceWith('approval_1', 'approve');
    // The first is decided; the next waits where it was.
    const next = waitingOnCommand(second, 'approval_2', 'call_2', 'body_2');
    await act(async () => fixture.store?.setState({ projection: next }));
    await viewport.scroll(() => false);
    expect(visibleText(bar(container) as HTMLElement)).toContain('echo second');
    const approve = () => lineButton(container, messages.Approvals.approveTool);
    expect(approve()?.disabled).toBe(true);
    await act(async () => approve()?.click());
    expect(resolve).toHaveBeenCalledTimes(1);
    await frame();
    await act(async () => vi.advanceTimersByTime(599));
    expect(approve()?.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(approve()?.disabled).toBe(false);
    await act(async () => approve()?.click());
    expect(resolve).toHaveBeenLastCalledWith('approval_2', 'approve');
  } finally {
    vi.useRealTimers();
  }
});

it('holds the next approval from when its buttons appear, and the View that comes first', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const second = commandPlan('echo second');
    const container = await mainArea(waitingOnCommand(), { body_1: JSON.stringify(command) });
    const store = fixture.store as RunSessionStore;
    const resolve = vi.spyOn(store.getState(), 'resolveApproval');
    await viewport.scroll(() => false);
    await act(async () => lineButton(container, messages.Approvals.approveTool)?.click());
    // The next comes before its body is read: its line has View alone, in the same place.
    const next = waitingOnCommand(second, 'approval_2', 'call_2', 'body_2');
    await act(async () => store.setState({ projection: next }));
    await viewport.scroll(() => false);
    const view = () => lineButton(container, messages.Activity.view);
    const approve = () => lineButton(container, messages.Approvals.approveTool);
    expect(approve()).toBeUndefined();
    expect(view()?.disabled).toBe(true);
    await frame();
    await act(async () => vi.advanceTimersByTime(600));
    expect(view()?.disabled).toBe(false);
    // The body comes late: its buttons wait from when they appear, not from when the line changed.
    await act(async () => vi.advanceTimersByTime(300));
    await act(async () =>
      store.setState({
        artifactTexts: { ...store.getState().artifactTexts, body_2: JSON.stringify(second) },
      }),
    );
    expect(approve()?.disabled).toBe(true);
    await act(async () => approve()?.click());
    expect(resolve).toHaveBeenCalledTimes(1);
    await frame();
    await act(async () => vi.advanceTimersByTime(599));
    expect(approve()?.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(approve()?.disabled).toBe(false);
    await act(async () => approve()?.click());
    expect(resolve).toHaveBeenLastCalledWith('approval_2', 'approve');
  } finally {
    vi.useRealTimers();
  }
});

it('takes the first approval at once when it is drawn with its buttons', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const container = await mainArea(waitingOnCommand(), { body_1: JSON.stringify(command) });
    await viewport.scroll(() => false);
    await act(async () => vi.advanceTimersByTime(1));
    expect(lineButton(container, messages.Approvals.approveTool)?.disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('holds the first approval too when its buttons come late where View was, by the clock', async () => {
  // These tests run with reduced motion: the hold is the clock's, not an animation's.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const container = await mainArea(waitingOnCommand());
    const store = fixture.store as RunSessionStore;
    const resolve = vi.spyOn(store.getState(), 'resolveApproval');
    await viewport.scroll(() => false);
    // View alone first: nothing was there before it, so it takes a press.
    await frame();
    await act(async () => vi.advanceTimersByTime(900));
    expect(lineButton(container, messages.Activity.view)?.disabled).toBe(false);
    await act(async () => store.setState({ artifactTexts: { body_1: JSON.stringify(command) } }));
    const approve = () => lineButton(container, messages.Approvals.approveTool);
    expect(approve()?.disabled).toBe(true);
    await act(async () => approve()?.click());
    expect(resolve).not.toHaveBeenCalled();
    await frame();
    await act(async () => vi.advanceTimersByTime(599));
    expect(approve()?.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(approve()?.disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('holds the first approval when its buttons come where View was drawn, before any timer runs', async () => {
  // View alone is painted, then the buttons come before a timer could run: no timer marks it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const container = await mainArea(waitingOnCommand());
    const store = fixture.store as RunSessionStore;
    const resolve = vi.spyOn(store.getState(), 'resolveApproval');
    await viewport.scroll(() => false);
    expect(lineButton(container, messages.Activity.view)).toBeDefined();
    await frame();
    await act(async () => store.setState({ artifactTexts: { body_1: JSON.stringify(command) } }));
    // A render on the way clears any timer set before it; the hold stays.
    await act(async () => store.setState({ artifactTexts: { ...store.getState().artifactTexts } }));
    const approve = () => lineButton(container, messages.Approvals.approveTool);
    expect(approve()?.disabled).toBe(true);
    await act(async () => approve()?.click());
    expect(resolve).not.toHaveBeenCalled();
    await frame();
    await act(async () => vi.advanceTimersByTime(599));
    expect(approve()?.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(approve()?.disabled).toBe(false);
    await act(async () => approve()?.click());
    expect(resolve).toHaveBeenCalledExactlyOnceWith('approval_1', 'approve');
  } finally {
    vi.useRealTimers();
  }
});

it('holds the one approval left where a count line’s View was', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const second = commandPlan('echo second');
    const both = waitingOnCommand();
    both.approvals.approval_2 = waitingOnCommand(second, 'approval_2', 'call_2', 'body_2').approvals
      .approval_2 as RunProjection['approvals'][string];
    const container = await mainArea(both, {
      body_1: JSON.stringify(command),
      body_2: JSON.stringify(second),
    });
    const store = fixture.store as RunSessionStore;
    const resolve = vi.spyOn(store.getState(), 'resolveApproval');
    await viewport.scroll(() => false);
    // Two wait: the line counts them and has View alone.
    expect(visibleText(bar(container) as HTMLElement)).toContain(
      messages.Activity.waiting.replace('{count}', '2'),
    );
    expect(decisions(container)).toEqual([]);
    await frame();
    await act(async () => vi.advanceTimersByTime(900));
    // One is decided elsewhere; the other's buttons come where View was.
    const left = waitingOnCommand(second, 'approval_2', 'call_2', 'body_2');
    await act(async () => store.setState({ projection: left }));
    await viewport.scroll(() => false);
    const approve = () => lineButton(container, messages.Approvals.approveTool);
    expect(approve()?.disabled).toBe(true);
    await act(async () => approve()?.click());
    expect(resolve).not.toHaveBeenCalled();
    await frame();
    await act(async () => vi.advanceTimersByTime(600));
    expect(approve()?.disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
