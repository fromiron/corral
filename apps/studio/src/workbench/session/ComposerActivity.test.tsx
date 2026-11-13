// @vitest-environment jsdom
import { type RunEvent, WorkPlan } from '@corral/contracts';
import { emptyProjection, type RunProjection, type RunSummary } from '@corral/core';
import type { RunSessionStore } from '@corral/react';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../../packages/react/src/stories/fixtures.tsx';
import { type ContextCall, presentContext } from '../widgets/selectors.ts';
import type { ChatWidgetModel } from '../widgets/useChatWidgets.tsx';
import { ComposerActivity } from './ComposerActivity.tsx';
import { createPendingTrayStore, PendingTrayContext } from './pendingTrayState.ts';
import { SessionConnectionContext } from './SessionConnection.tsx';
import { stubViewport } from './viewport.testing.ts';

// The composer's activity bar (features/composer-flow.md "활동 바", chat-widgets-contract
// "컴포저"): one line that says what nothing on screen already says, folding out upward into the
// roles, the Todo, the context and the run controls.

const fixture = vi.hoisted(() => ({
  model: null as ChatWidgetModel | null,
  store: null as RunSessionStore | null,
}));
vi.mock('../widgets/useChatWidgets.tsx', () => ({ useChatWidget: () => fixture.model }));
vi.mock('../../services.tsx', () => ({
  useServices: () => ({ runFor: () => fixture.store, retainRun: () => () => {} }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    search,
    'data-testid': testId,
  }: {
    children: ReactNode;
    className?: string;
    search?: object | ((previous: object) => object);
    'data-testid'?: string;
  }) => (
    <a
      href="#run"
      className={className}
      data-testid={testId}
      // The address the link would open, from an empty one.
      data-search={JSON.stringify(typeof search === 'function' ? search({}) : (search ?? {}))}
      // The same, from this run's address at a past point with a result open.
      data-search-from-past={JSON.stringify(
        typeof search === 'function'
          ? search({ run: 'run_plan', atSeq: 1, result: 'result_1' })
          : (search ?? {}),
      )}
    >
      {children}
    </a>
  ),
}));

const cleanup: (() => void)[] = [];
let viewport: ReturnType<typeof stubViewport>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Reduced motion: the line's words swap at once, with nothing left fading out.
  vi.stubGlobal('matchMedia', (query: string) => ({
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
  viewport = stubViewport();
  Element.prototype.getAnimations ??= () => [];
  // jsdom lays nothing out: a row brought into view only says so.
  Element.prototype.scrollIntoView = () => {};
  fixture.store = null;
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

function planStatus(): ChatWidgetModel['plan']['status'] {
  const plan = WorkPlan.parse({
    scope: 'execution',
    executionId: 'exec_plan',
    attemptNo: 1,
    revision: 1,
    criteriaVersionId: 'criteria_plan',
    items: Array.from({ length: 7 }, (_, index) => ({
      id: `item_${index + 1}`,
      title: `Plan item ${index + 1}`,
      status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending',
    })),
  });
  return { state: 'ready', plan, total: 7, completed: 1, planFinished: false, runFinished: false };
}

const noAction = {
  visible: false,
  needsUser: false,
  hasFailure: false,
  completedWithFailures: false,
  count: 0,
  summary: 'none',
  unclearCauses: [],
};

const unmeasured = presentContext({ calls: [], compactions: [], selectedExecutionId: null });

function model(change: Partial<ChatWidgetModel> = {}, plan: Partial<ChatWidgetModel['plan']> = {}) {
  const choice = {
    key: 'exec_plan',
    label: 'Assistant',
    live: true,
    lastTeam: false,
    status: 'active',
    attemptNo: 1,
  };
  return {
    sessionId: 'session_plan',
    runId: 'run_plan',
    runNumber: 1,
    live: false,
    viewed: null,
    readState: 'ready',
    chips: [],
    tools: [],
    results: [],
    action: noAction,
    failedExecutionId: null,
    activity: null,
    context: unmeasured,
    plan: {
      open: false,
      setOpen: vi.fn(),
      status: planStatus(),
      selectedKey: 'exec_plan',
      selectedChoice: choice,
      choices: [choice],
      multiple: false,
      auto: true,
      runStatus: 'succeeded',
      retry: vi.fn(),
      follow: vi.fn(),
      choose: vi.fn(),
      ...plan,
    },
    ...change,
  } as unknown as ChatWidgetModel;
}

const ownRun: RunSummary = {
  runId: 'run_plan',
  status: 'running',
  corralId: 'team',
  projectId: 'project',
  sessionId: 'session_plan',
  startedAt: '2026-11-13T00:00:00.000Z',
};

/** The session's running run: one assistant reading a file. */
function runningProjection(): RunProjection {
  const projection = emptyProjection('run_plan');
  projection.status = 'running';
  projection.startedAt = '2026-11-13T00:00:00.000Z';
  projection.executionOrder = ['exec_plan'];
  projection.executions.exec_plan = {
    executionId: 'exec_plan',
    nodeId: 'assistant',
    taskId: 'task_plan',
    status: 'active',
    attemptNo: 1,
    modelCallIds: [],
  } as unknown as RunProjection['executions'][string];
  projection.toolCalls.call_1 = {
    toolCallId: 'call_1',
    executionId: 'exec_plan',
    name: 'read_file',
    status: 'started',
  } as unknown as RunProjection['toolCalls'][string];
  return projection;
}

async function mount(
  initial: ChatWidgetModel,
  {
    ownActive = null,
    rowShown = false,
    lost = false,
    timeline = null,
    onViewRun,
    revealRun,
    target = null,
    targets = [],
    floating = false,
  }: {
    /** The composer floats over the timeline's bottom edge. */
    floating?: boolean;
    ownActive?: RunSummary | null;
    /** The join target, and the executions that take an instruction now. */
    target?: string | null;
    targets?: { id: string }[];
    rowShown?: boolean;
    lost?: boolean;
    /** More of the conversation: role rows, a run's item. */
    timeline?: ReactNode;
    onViewRun?: (runId: string) => void;
    revealRun?: (runId: string | null) => boolean;
  } = {},
) {
  fixture.model = initial;
  const tray = createPendingTrayStore();
  const respond = vi.fn();
  const retry = vi.fn();
  const onJoin = vi.fn();
  const onStop = vi.fn();
  const onPause = vi.fn();
  const onResume = vi.fn();
  let conversation: ReactNode = timeline;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  const paint = (connectionLost: boolean) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <SessionConnectionContext.Provider value={{ lost: connectionLost, retry }}>
            <PendingTrayContext.Provider value={{ store: tray, respond }}>
              <div data-chat-view>
                <div data-testid="chat-timeline">
                  {/* The run row's head, when the conversation shows it. */}
                  {rowShown ? (
                    <div data-chat-item>
                      <span data-chat-part="head">
                        <span data-presence-label={`run:${initial.runId}`}>run row</span>
                      </span>
                    </div>
                  ) : null}
                  {conversation}
                </div>
                <div
                  data-testid="chat-composer"
                  {...(floating ? { 'data-composer-surface': 'floating' } : {})}
                >
                  <ComposerActivity
                    sessionId="session_plan"
                    ownActive={ownActive}
                    target={target}
                    targets={targets as never}
                    onJoin={onJoin}
                    onStop={onStop}
                    onPause={onPause}
                    onResume={onResume}
                    viewingOther={false}
                    {...(onViewRun ? { onViewRun } : {})}
                    {...(revealRun ? { revealRun } : {})}
                  />
                  <div data-testid="input-surface">
                    <textarea aria-label="Request" />
                  </div>
                </div>
              </div>
            </PendingTrayContext.Provider>
          </SessionConnectionContext.Provider>
        </IntlProvider>,
      ),
    );
  await paint(lost);
  const bar = () => container.querySelector<HTMLElement>('[data-testid="activity-bar"]');
  return {
    container,
    tray,
    respond,
    retry,
    onJoin,
    onStop,
    onPause,
    onResume,
    bar,
    /** The closed line: the bar without its panel. */
    line: () => bar()?.querySelector<HTMLElement>('[data-activity-bar] > div'),
    toggle: () => bar()?.querySelector<HTMLButtonElement>('[data-activity-toggle]'),
    panel: () => bar()?.querySelector<HTMLElement>('section[aria-label="Activity details"]'),
    rows: () => container.querySelectorAll('[data-plan-item]'),
    /** Paints again with the same model, as a store change would. */
    repaint: () => paint(lost),
    /** The conversation's rows change: rows mount or leave. */
    setTimeline: (next: ReactNode) => {
      conversation = next;
      return paint(lost);
    },
    update: async (next: ChatWidgetModel, connectionLost = lost) => {
      fixture.model = next;
      await paint(connectionLost);
    },
  };
}

/** What a person sees: the text outside screen-reader-only elements and closed panels. */
function visibleText(element: Element | null | undefined) {
  if (!element) return '';
  const copy = element.cloneNode(true) as HTMLElement;
  for (const node of copy.querySelectorAll('.sr-only, [hidden]')) node.remove();
  return copy.textContent ?? '';
}

// The container widths (rem) below which a `@max-<size>/composer-surface:hidden` part leaves the
// line, as Tailwind sizes them; 0 for a part that never leaves.
const SIZES: Record<string, number> = { sm: 24, md: 28, lg: 32, xl: 36, '2xl': 42 };
const leavesBelow = (element: Element | null | undefined) => {
  const size = element?.className.match(/@max-(\w+)\/composer-surface:hidden/)?.[1];
  return size ? (SIZES[size] ?? Number.NaN) : 0;
};
const byText = (root: Element | null | undefined, text: string) =>
  [...(root?.querySelectorAll('span') ?? [])].find((span) => span.textContent === text);

it("says an ended run's state, place, plan count, step and changes on one line, Overview at its end", async () => {
  const view = await mount(
    model(
      {
        chips: ['changes'],
        changeFiles: 2,
        changeLines: 6,
        changesLabel: 'fixed',
        viewed: { latest: true, number: 1, total: 1 },
      },
      { selectedChoice: { key: 'exec_plan', label: 'Assistant', live: true } as never },
    ),
  );
  const line = view.line();
  const text = visibleText(line);
  expect(text).toContain(messages.Presence.state.succeeded);
  expect(text).toContain(messages.Widgets.lastRun);
  expect(text).toContain('1/7 done');
  // Collapsed, the line names the step in progress.
  expect(text).toContain('Plan item 2');
  expect(text).toContain('2 changes');
  // Its run's number stays with its turn.
  expect(text).not.toContain('Run #1');
  // Overview opens from the line's right end, after the words and before the toggle.
  const overview = line?.querySelector('[data-testid="session-summary-trigger"]');
  expect(overview).not.toBeNull();
  expect(
    (overview?.compareDocumentPosition(view.toggle() as Node) ?? 0) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // One line height, whatever it says.
  expect(line?.classList.contains('h-8')).toBe(true);
});

it('names an older run by its place among the session runs', async () => {
  const view = await mount(model({ viewed: { latest: false, number: 1, total: 2 } }));
  expect(visibleText(view.line())).toContain('Run #1 of 2');
});

it('counts one change and one line in the singular', async () => {
  const view = await mount(
    model({ chips: ['changes'], changeFiles: 1, changeLines: 1, changesLabel: 'fixed' }),
  );
  const chip = view.line()?.querySelector('[data-testid="run-changes-chip"]');
  expect(chip?.textContent).toContain('1 change');
  expect(chip?.textContent).toContain('1 line');
  expect(chip?.textContent).not.toMatch(/1 changes|1 lines/);
});

// chat-widgets-contract: the plan count and the change summary are not cut at wide widths; when
// the line is short the current step's words go first, then the change summary's line count.
it('keeps the plan count and change count whole; the step gives way first, then the line count', async () => {
  const view = await mount(
    model({ chips: ['changes'], changeFiles: 2, changeLines: 6, changesLabel: 'fixed' }),
  );
  const line = view.line();
  const count = line?.querySelector('[data-testid="activity-plan"]');
  const step = line?.querySelector('[data-testid="activity-step"]');
  const chip = line?.querySelector('[data-testid="run-changes-chip"]');
  const changes = byText(chip, '2 changes');
  const lines = byText(chip, '6 lines');
  if (!count || !step || !chip || !changes || !lines) throw new Error('missing part');
  for (const whole of [count, changes, lines]) {
    expect(whole.classList.contains('whitespace-nowrap')).toBe(true);
    expect(whole.classList.contains('truncate')).toBe(false);
  }
  // The counts never shrink or leave; the changes chip does not shrink at all.
  expect(count.classList.contains('shrink-0')).toBe(true);
  expect(chip.classList.contains('shrink-0')).toBe(true);
  expect(leavesBelow(count)).toBe(0);
  expect(leavesBelow(changes)).toBe(0);
  // The step is the part that shrinks, and it leaves before the line count does.
  expect(step.classList.contains('truncate')).toBe(true);
  expect(leavesBelow(lines)).toBeGreaterThan(0);
  expect(leavesBelow(step)).toBeGreaterThan(leavesBelow(lines));
  // At 390 px the line is about 24rem wide: the step and the line count are gone by then.
  expect(leavesBelow(lines)).toBeGreaterThan(24);
});

it('reads the plan Todo only in the open panel, once, above the line and outside the input', async () => {
  const view = await mount(model());
  const toggle = view.toggle();
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  // Closed, the panel is hidden: no plan row is on screen.
  const region = view.container.querySelector(`[id="${toggle?.getAttribute('aria-controls')}"]`);
  expect(region?.hasAttribute('hidden')).toBe(true);
  expect([...view.rows()].filter((row) => !row.closest('[hidden]'))).toHaveLength(0);
  await act(async () => toggle?.click());
  expect(view.toggle()?.getAttribute('aria-expanded')).toBe('true');
  expect(region?.hasAttribute('hidden')).toBe(false);
  expect(view.container.querySelectorAll('[data-testid="composer-work-plan"]')).toHaveLength(1);
  expect(view.container.querySelectorAll('ol')).toHaveLength(1);
  const plan = view.container.querySelector('[data-testid="composer-work-plan"]');
  expect(region?.contains(plan as Node)).toBe(true);
  expect(plan?.querySelectorAll('[data-plan-item]')).toHaveLength(5);
  // The panel opens upward: above the line in reading order of the screen, after it in the
  // document so focus reaches the line first.
  expect(
    view.bar()?.querySelector('[data-activity-bar]')?.classList.contains('flex-col-reverse'),
  ).toBe(true);
  // The line no longer repeats the open step.
  expect(visibleText(view.line())).not.toContain('Plan item 2');
  // Never inside the input.
  const surface = view.container.querySelector('[data-testid="input-surface"]');
  expect(surface?.querySelectorAll('[data-plan-item]')).toHaveLength(0);
  // Read only: no checkbox completes an item.
  expect(view.container.querySelector('input[type="checkbox"], [role="checkbox"]')).toBeNull();
  // Escape folds it back and returns focus to the toggle.
  plan?.querySelector<HTMLElement>('button, [tabindex]')?.focus();
  await act(async () => {
    (document.activeElement ?? plan)?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  expect(view.toggle()?.getAttribute('aria-expanded')).toBe('false');
});

it('marks the step in progress as the current step, with the kit plan rows', async () => {
  const view = await mount(model());
  await act(async () => view.toggle()?.click());
  const rows = [...view.rows()];
  expect(rows).toHaveLength(5);
  // chat-widgets-contract §4.1: the Todo uses the AgentSteering plan rows.
  expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([
    null,
    'step',
    null,
    null,
    null,
  ]);
  expect(rows.map((row) => row.getAttribute('data-status'))).toEqual([
    'done',
    'active',
    'pending',
    'pending',
    'pending',
  ]);
  // Each row still says its state to assistive tech.
  expect(rows[1]?.textContent).toContain(messages.Widgets.in_progress);
});

it.each(['succeeded', 'failed', 'cancelled', 'interrupted'] as const)(
  'says a %s run state once: on the line only while its run row is off screen',
  async (runStatus) => {
    const word = messages.Presence.state[runStatus];
    const shown = await mount(model({}, { runStatus }), { rowShown: true });
    expect(visibleText(shown.line())).not.toContain(word);
    expect(shown.line()?.querySelector('[data-presence-label]')).toBeNull();
    // Scrolled away, the bar says it, once.
    await viewport.scroll(() => false);
    const states = shown.line()?.querySelectorAll(`[data-presence-label="run:run_plan"]`) ?? [];
    expect(states).toHaveLength(1);
    expect(states[0]?.textContent).toBe(word);
  },
);

it('gives each end state its own mark, so a failure never looks like a success', async () => {
  const view = await mount(model({}, { runStatus: 'succeeded' }));
  const mark = () => view.line()?.querySelector('svg');
  const glyph = () => view.bar()?.querySelector('[data-activity-bar]')?.getAttribute('data-state');
  const shapes: Record<string, string> = {};
  const glyphs: Record<string, string | null | undefined> = {};
  for (const runStatus of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
    await view.update(model({}, { runStatus }));
    glyphs[runStatus] = glyph();
    // The drawn shape differs, not only its color.
    shapes[runStatus] = mark()?.innerHTML ?? '';
  }
  // The kit glyphs of features/presence.md: an interrupted run is marked as a failure.
  expect(glyphs).toEqual({
    succeeded: 'done',
    failed: 'failed',
    cancelled: 'stopped',
    interrupted: 'failed',
  });
  expect(new Set([shapes.succeeded, shapes.failed, shapes.cancelled]).size).toBe(3);
  expect(shapes.interrupted).toBe(shapes.failed);
  // A run whose record cannot be read is told as a problem, never as done.
  await view.update(model({ readState: 'error' }, { runStatus: 'succeeded' }));
  expect(view.bar()?.dataset.line).toBe('disconnected');
  expect(view.bar()?.querySelector('[data-activity-bar]')?.getAttribute('data-state')).toBe(
    'failed',
  );
  expect(visibleText(view.line())).toContain(messages.Activity.recordLost);
  expect(visibleText(view.line())).not.toContain(messages.Presence.state.succeeded);
});

it('tells a lost connection on the bar alone, with Retry, before anything else', async () => {
  const view = await mount(model(), { lost: true });
  expect(view.bar()?.dataset.line).toBe('disconnected');
  const text = visibleText(view.line());
  expect(text).toContain(messages.Activity.connectionLost);
  // What follows may be stale: no plan count or state beside it.
  expect(text).not.toContain('1/7 done');
  // Said at once to assistive tech, from the composer, after the timeline and before the input.
  const alerts = view.container.querySelectorAll('[role="alert"]');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toBe(messages.Activity.connectionLost);
  const timeline = view.container.querySelector('[data-testid="chat-timeline"]');
  expect(timeline?.contains(alerts[0] as Node)).toBe(false);
  expect(
    view.container.querySelector('[data-testid="chat-composer"]')?.contains(alerts[0] as Node),
  ).toBe(true);
  expect(
    (alerts[0]?.compareDocumentPosition(view.container.querySelector('textarea') as Node) ?? 0) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const retry = [...(view.line()?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === messages.Activity.retry,
  );
  await act(async () => retry?.click());
  expect(view.retry).toHaveBeenCalledTimes(1);
  // Connected again, the line says the run, and nothing is alerted.
  await view.update(model(), false);
  expect(view.bar()?.dataset.line).toBe('summary');
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('');
});

const readRequested = {
  type: 'tool.requested',
  actor: { kind: 'agent', id: 'exec_plan' },
  payload: {
    executionId: 'exec_plan',
    toolCallId: 'call_1',
    name: 'read_file',
    validatedArgs: { path: 'src/session.ts' },
  },
} as unknown as RunEvent;

it("says a live run's tool as the work log names it, and its state only off screen", async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: runningProjection(),
    events: [readRequested],
  });
  const view = await mount(model({ live: true }, { runStatus: 'running' }), {
    ownActive: ownRun,
    rowShown: true,
  });
  expect(view.bar()?.dataset.live).toBe('');
  // The run row on screen already says Working; the line says what the role does, with what it
  // works on, as the work log's row names it.
  const text = visibleText(view.line());
  expect(text).toContain(`${messages.Turn.tool.read_file} · src/session.ts`);
  expect(text).not.toContain('read_file');
  expect(text).not.toContain(messages.Presence.state.working);
  // The open panel has its run controls.
  await act(async () => view.toggle()?.click());
  const controls = view.panel()?.querySelector('[aria-label="Run controls"]');
  expect(controls?.textContent).toContain(messages.Activity.pause);
  expect(controls?.textContent).toContain(messages.Activity.stop);
});

it('says nothing of a bare tool name, or of a call whose approval card tells it', async () => {
  // No target: a tool name alone is not an activity, and the line keeps no orphan dot.
  fixture.store = sessionStore({ runId: 'run_plan', projection: runningProjection() });
  const view = await mount(model({ live: true }, { runStatus: 'running' }), {
    ownActive: ownRun,
    rowShown: true,
  });
  expect(visibleText(view.line())).not.toContain(messages.Turn.tool.read_file);
  expect(view.line()?.textContent).not.toContain('·');
  // A call waiting on its approval: its card says it.
  const projection = runningProjection();
  projection.approvals.approval_1 = {
    approvalId: 'approval_1',
    kind: 'tool',
    status: 'pending',
    tool: { toolCallId: 'call_1', executionId: 'exec_plan', purpose: 'tool' },
  } as unknown as RunProjection['approvals'][string];
  await act(async () => fixture.store?.setState({ projection, events: [readRequested] }));
  expect(visibleText(view.line())).not.toContain('src/session.ts');
});

it('names a waiting role by its presence detail, not by the tool it waits in', async () => {
  const projection = runningProjection();
  projection.executions.exec_plan = {
    ...projection.executions.exec_plan,
    status: 'waiting_children',
  } as RunProjection['executions'][string];
  projection.toolCalls.call_1 = {
    ...projection.toolCalls.call_1,
    name: 'await_tasks',
  } as RunProjection['toolCalls'][string];
  fixture.store = sessionStore({ runId: 'run_plan', projection });
  const view = await mount(model({ live: true }, { runStatus: 'running' }), {
    ownActive: ownRun,
    rowShown: true,
  });
  // Folded, the line says what the role does.
  expect(visibleText(view.line())).toContain(messages.Presence.detail.waiting_agents);
  await act(async () => view.toggle()?.click());
  const row = view.panel()?.querySelector('[data-activity-role="exec_plan"]');
  expect(row?.textContent).toContain(messages.Presence.detail.waiting_agents);
  // Open, its row says it: the line does not say it again.
  expect(visibleText(view.line())).not.toContain(messages.Presence.detail.waiting_agents);
  expect(row?.textContent).not.toMatch(new RegExp(`\\b${messages.Turn.tool.await_tasks}\\b`));
});

it('opens the failed steps of the exact run for a failure no card answers', async () => {
  const failure = { ...noAction, visible: true, hasFailure: true, count: 1, summary: 'failure' };
  const view = await mount(
    model(
      {
        action: failure as ChatWidgetModel['action'],
        failedExecutionId: 'exec_failed',
        viewed: { latest: false, number: 1, total: 2 },
      },
      { runStatus: 'failed' },
    ),
  );
  const line = view.line();
  expect(visibleText(line)).toContain(messages.Widgets.actionFailure);
  const link = line?.querySelector('a:not([data-testid="run-changes-chip"])');
  expect(link?.textContent).toBe(messages.Widgets.actionOpenFailure);
  expect(JSON.parse(link?.getAttribute('data-search') ?? '{}')).toMatchObject({
    execution: 'exec_failed',
  });
  expect(JSON.parse(link?.getAttribute('data-search') ?? '{}')).not.toHaveProperty('respond');
  // The step is shown as it is now: a past point or an open result would hide it.
  const fromPast = JSON.parse(link?.getAttribute('data-search-from-past') ?? '{}');
  expect(fromPast).toMatchObject({ run: 'run_plan', execution: 'exec_failed' });
  expect(fromPast).not.toHaveProperty('atSeq');
  expect(fromPast).not.toHaveProperty('result');
  // An unconfirmed outcome is not something to answer either: its link opens the run.
  await view.update(
    model({
      action: {
        ...noAction,
        visible: true,
        count: 1,
        summary: 'unclear',
        unclearCauses: ['effect'],
      } as ChatWidgetModel['action'],
    }),
  );
  const unclear = view.line()?.querySelector('a:not([data-testid="run-changes-chip"])');
  expect(unclear?.textContent).toBe(messages.Widgets.actionOpenRun);
  expect(JSON.parse(unclear?.getAttribute('data-search') ?? '{}')).not.toHaveProperty('respond');
});

it("leaves a failure to its turn's card while that card is the latest turn", async () => {
  const failure = { ...noAction, visible: true, hasFailure: true, count: 1, summary: 'failure' };
  const view = await mount(
    model(
      {
        action: failure as ChatWidgetModel['action'],
        viewed: { latest: true, number: 2, total: 2 },
      },
      { runStatus: 'failed' },
    ),
  );
  const text = visibleText(view.line());
  expect(text).not.toContain(messages.Widgets.actionFailure);
  expect(view.line()?.querySelector('a:not([data-testid="run-changes-chip"])')).toBeNull();
  // The ended run keeps its one state on the line.
  expect(text).toContain(messages.Presence.state.failed);
});

it.each([true, false])(
  'leaves the failed-steps notice of a completed run to its turn (latest=%s)',
  async (latest) => {
    const failure = { ...noAction, visible: true, hasFailure: true, count: 1, summary: 'failure' };
    const view = await mount(
      model({
        action: { ...failure, completedWithFailures: true } as ChatWidgetModel['action'],
        failedExecutionId: 'exec_failed',
        viewed: { latest, number: 1, total: latest ? 1 : 2 },
      }),
    );
    // Only the polite announcement still says it; nothing on screen repeats the turn's line.
    expect(visibleText(view.container)).not.toContain(messages.Widgets.actionCompletedWithFailures);
    expect(visibleText(view.container)).not.toContain(messages.Widgets.actionFailure);
  },
);

it('leaves a waiting approval to its card while the card is on screen, and still announces it', async () => {
  const approval = { ...noAction, visible: true, needsUser: true, count: 1, summary: 'approval' };
  const view = await mount(
    model(
      { live: true, action: approval as ChatWidgetModel['action'] },
      {
        runStatus: 'awaiting_user',
      },
    ),
  );
  view.tray.setState({ waiting: 1 });
  await act(async () => view.tray.setState({ placement: 'in-view' }));
  expect(view.bar()?.dataset.line).not.toBe('waiting');
  expect(visibleText(view.line())).not.toContain(messages.Widgets.actionApproval);
  // The screen reader still hears that an approval is needed.
  const live = view.bar()?.querySelector('[aria-live="polite"]');
  expect(live?.classList.contains('sr-only')).toBe(true);
  expect(live?.textContent).toContain(messages.Widgets.actionApproval);
  // Scrolled away, the bar says it waits, with the way to it.
  await act(async () => view.tray.setState({ placement: 'out-of-view' }));
  expect(view.bar()?.dataset.line).toBe('waiting');
});

it('reads line, panel, and input from top to bottom on screen, the line first for focus', async () => {
  const view = await mount(model());
  const order = [view.line(), view.container.querySelector('[data-testid="input-surface"]')];
  expect(order.every(Boolean)).toBe(true);
  expect(
    (order[0]?.compareDocumentPosition(order[1] as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // The panel follows the line in the document (focus reaches the line first) and is drawn
  // above it by the reversed column.
  const panel = view.container.querySelector(
    `[id="${view.toggle()?.getAttribute('aria-controls')}"]`,
  );
  expect(
    (view.line()?.compareDocumentPosition(panel as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

function call(
  coverage: ContextCall['coverage'],
  completeness: ContextCall['completeness'],
): ContextCall {
  return {
    modelCallId: 'call_1',
    executionId: 'exec_1',
    recordedAt: '2026-10-19T00:00:00.000Z',
    coverage,
    completeness,
    messageTokens: 50_000,
    usedTokens: coverage === 'request' ? 710 : null,
    parts: [],
    windowTokens: coverage === 'request' ? 1000 : null,
    providerInput: null,
    providerCacheRead: null,
    providerOutput: null,
  };
}

const usage = {
  outputTokens: 9000,
  requests: 4,
  unknown: 0,
  perCall: [100, 200],
  input: { tokens: 50_000, cached: null, cacheShare: null, cacheUnreported: 0 },
  inputUnreported: 0,
};

async function hover(element: Element) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseenter'));
    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1200)));
}

it('shows an about N% pill at the right end when the whole request was measured', async () => {
  const context = presentContext({
    calls: [call('request', 'complete')],
    compactions: [],
    selectedExecutionId: 'exec_1',
  });
  expect(context.percent).toBe(71);
  const view = await mount(model({ context, usage } as Partial<ChatWidgetModel>));
  const pill = view
    .line()
    ?.querySelector<HTMLButtonElement>('[data-testid="composer-context-occupancy"]');
  expect(pill, view.line()?.textContent ?? '').toBeTruthy();
  expect(pill?.textContent).toContain('about 71%');
  expect(pill?.getAttribute('aria-label')).toBe('Context about 71%');
  await hover(pill as Element);
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Context about 71%');
  await act(async () => pill?.click());
  expect(document.querySelector('[data-testid="context-inspector"]')).not.toBeNull();
  // The open panel has the context detail too.
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await act(async () => view.toggle()?.click());
  expect(view.panel()?.querySelector('[data-testid="activity-context"]')?.textContent).toContain(
    '71%',
  );
});

it('shows no occupancy percentage for messages-only context or cumulative usage', async () => {
  const messagesOnly = presentContext({
    calls: [call('messages', 'complete')],
    compactions: [],
    selectedExecutionId: 'exec_1',
  });
  expect(messagesOnly.percent).toBeNull();
  for (const context of [messagesOnly, unmeasured]) {
    const view = await mount(model({ context, usage } as Partial<ChatWidgetModel>));
    const line = view.line();
    expect(line?.querySelector('[data-testid="composer-context-occupancy"]')).toBeNull();
    expect(line?.textContent).not.toMatch(/about \d+%|\d+%/);
  }
});

it('keeps its one line with no run, saying nothing', async () => {
  const view = await mount(model({ runId: null } as Partial<ChatWidgetModel>));
  expect(view.bar()?.dataset.line).toBe('none');
  expect(view.line()?.classList.contains('h-8')).toBe(true);
  expect(visibleText(view.line())).toBe('');
  expect(view.toggle()).toBeNull();
  expect(view.line()?.textContent).not.toContain('Overview');
});

/** A running run whose executions are given by id: node and status, in run order. */
function teamProjection(executions: Record<string, { node: string; status: string }>) {
  const projection = runningProjection();
  projection.executionOrder = Object.keys(executions);
  projection.executions = {};
  projection.toolCalls = {};
  for (const [id, { node, status }] of Object.entries(executions))
    projection.executions[id] = {
      executionId: id,
      nodeId: node,
      taskId: `task_${id}`,
      status,
      attemptNo: 1,
      modelCallIds: [],
    } as unknown as RunProjection['executions'][string];
  return projection;
}

const live = () => model({ live: true }, { runStatus: 'running' });

it('names the bar itself: one group, "Activity"', async () => {
  fixture.store = sessionStore({ runId: 'run_plan', projection: runningProjection() });
  const view = await mount(live(), { ownActive: ownRun });
  const group = view.bar()?.querySelector('[role="group"]');
  expect(group?.getAttribute('aria-label')).toBe(messages.Activity.bar);
  // The panel it opens has its own name.
  expect(view.panel()).not.toBeNull();
});

it('does not say again on the line what an open panel row says', async () => {
  // One assistant paused, its run row scrolled away: the line says it is paused.
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({ exec_plan: { node: 'assistant', status: 'paused' } }),
  });
  const view = await mount(live(), { ownActive: ownRun });
  const said = () =>
    view.line()?.querySelectorAll('[data-presence-label="execution:exec_plan"]').length ?? 0;
  expect(said()).toBe(1);
  // Open, its row in the panel says it: the line does not.
  await act(async () => view.toggle()?.click());
  const row = view.panel()?.querySelector('[data-activity-role="exec_plan"]');
  expect(row?.querySelectorAll('[data-presence-label="execution:exec_plan"]')).toHaveLength(1);
  expect(said()).toBe(0);
  // Folded again, the line says it again.
  await act(async () => view.toggle()?.click());
  expect(said()).toBe(1);
});

it("writes no state on a working role's row: its spinner says it; other states are written", async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'waiting_children' },
      exec_writer: { node: 'writer', status: 'active' },
      exec_review: { node: 'review', status: 'waiting_approval' },
    }),
  });
  const view = await mount(live(), { ownActive: ownRun });
  await act(async () => view.toggle()?.click());
  const row = (id: string) => view.panel()?.querySelector(`[data-activity-role="${id}"]`);
  // Name and what it does; the state stays in its name for a screen reader.
  expect(visibleText(row('exec_lead'))).not.toContain(messages.Presence.state.working);
  expect(visibleText(row('exec_lead'))).toContain(messages.Presence.detail.waiting_agents);
  expect(visibleText(row('exec_writer'))).not.toContain(messages.Presence.state.working);
  expect(row('exec_writer')?.textContent).toContain(messages.Presence.state.working);
  expect(row('exec_writer')?.querySelector('[data-presence-label]')).toBeNull();
  // Waiting for the person is written.
  expect(
    row('exec_review')?.querySelector('[data-presence-label="execution:exec_review"]')?.textContent,
  ).toBe(messages.Presence.state.awaiting_user);
});

it('with the panel open, the waiting line leaves its state to the role row that writes it', async () => {
  // The lead asks the person while two roles work, its question's card scrolled away.
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'waiting_approval' },
      exec_research: { node: 'research', status: 'active' },
      exec_writer: { node: 'writer', status: 'active' },
    }),
  });
  const approval = { ...noAction, visible: true, needsUser: true, count: 1, summary: 'approval' };
  const view = await mount(
    model(
      { live: true, action: approval as ChatWidgetModel['action'] },
      { runStatus: 'awaiting_user' },
    ),
    { ownActive: ownRun },
  );
  view.tray.setState({ waiting: 1 });
  await act(async () => view.tray.setState({ placement: 'out-of-view' }));
  expect(view.bar()?.dataset.line).toBe('waiting');
  // Folded, the line says the run waits for the person.
  expect(visibleText(view.line())).toContain(messages.Presence.state.awaiting_user);
  await act(async () => view.toggle()?.click());
  const words = visibleText(view.bar()).split(messages.Presence.state.awaiting_user).length - 1;
  expect(words).toBe(1);
  expect(visibleText(view.panel())).toContain(messages.Presence.state.awaiting_user);
});

it('tells executions of one role apart as the send menu does, and lists only live ones', async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'active' },
      exec_w1: { node: 'writer', status: 'succeeded' },
      exec_w2: { node: 'writer', status: 'active' },
      exec_w3: { node: 'writer', status: 'active' },
    }),
  });
  const view = await mount(live(), { ownActive: ownRun, rowShown: true });
  await act(async () => view.toggle()?.click());
  const rows = [...(view.panel()?.querySelectorAll('[data-activity-role]') ?? [])];
  // The ended round is not a row.
  expect(rows.map((row) => row.getAttribute('data-activity-role'))).toEqual([
    'exec_lead',
    'exec_w2',
    'exec_w3',
  ]);
  const name = (id: string) => view.panel()?.querySelector(`[data-activity-role="${id}"]`);
  expect(name('exec_w2')?.textContent).toContain('writer · #3');
  expect(name('exec_w3')?.textContent).toContain('writer · #4');
  expect(name('exec_lead')?.textContent).not.toContain('#');
  // The buttons say which one.
  const views = [...(name('exec_w3')?.querySelectorAll('button') ?? [])].map((button) =>
    button.getAttribute('aria-label'),
  );
  expect(views).toContain('View writer · #4');
});

it('says no state words for a state it does not know, only the name', async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'active' },
      exec_odd: { node: 'odd', status: 'not_a_status' },
    }),
  });
  const view = await mount(live(), { ownActive: ownRun, rowShown: true });
  await act(async () => view.toggle()?.click());
  const text = view.bar()?.textContent ?? '';
  expect(text).toContain('odd');
  expect(text).not.toContain('Presence.');
  expect(text).not.toContain('undefined');
});

it("brings a role's row into the conversation's window and gives it focus, not the run record", async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'active' },
      exec_child: { node: 'researcher', status: 'active' },
    }),
  });
  const onViewRun = vi.fn();
  const asked: (string | null)[] = [];
  // The conversation's window has no row for the role until its run's item is brought in.
  const revealRun = vi.fn((runId: string | null) => {
    asked.push(runId);
    if (runId)
      setTimeout(() => {
        const row = document.createElement('div');
        row.dataset.chatPart = 'role:exec_child';
        row.innerHTML = '<button type="button">researcher</button>';
        document.querySelector('[data-testid="chat-timeline"]')?.append(row);
      }, 30);
    return true;
  });
  const view = await mount(live(), { ownActive: ownRun, onViewRun, revealRun });
  await act(async () => view.toggle()?.click());
  const show = view
    .panel()
    ?.querySelector<HTMLButtonElement>('[data-activity-role="exec_child"] button');
  await act(async () => show?.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(asked).toEqual(['run_plan', null]);
  expect(onViewRun).not.toHaveBeenCalled();
  expect(document.activeElement?.closest('[data-chat-part="role:exec_child"]')).not.toBeNull();
});

it('opens the run record only for a role the conversation has no row for', async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'active' },
      exec_child: { node: 'researcher', status: 'active' },
    }),
  });
  const onViewRun = vi.fn();
  const view = await mount(live(), { ownActive: ownRun, onViewRun, revealRun: () => false });
  await act(async () => view.toggle()?.click());
  await act(async () =>
    view
      .panel()
      ?.querySelector<HTMLButtonElement>('[data-activity-role="exec_child"] button')
      ?.click(),
  );
  expect(onViewRun).toHaveBeenCalledExactlyOnceWith('run_plan');
});

/** The panel's run controls, by their words. */
const control = (view: { panel: () => HTMLElement | null | undefined }, words: string) =>
  [
    ...(view.panel()?.querySelectorAll<HTMLButtonElement>('[aria-label="Run controls"] button') ??
      []),
  ].find((button) => button.textContent === words);

it.each([
  ['running', { pause: true, resume: null, stop: true }],
  ['paused', { pause: null, resume: true, stop: true }],
  // Pausing: Stop can still be pressed; Pause waits for the pause.
  ['pausing', { pause: false, resume: null, stop: true }],
  ['cancelling', { pause: false, resume: null, stop: false }],
] as const)(
  'offers the run controls a %s run takes, pressable as it allows',
  async (status, want) => {
    const projection = runningProjection();
    projection.status = status;
    fixture.store = sessionStore({ runId: 'run_plan', projection });
    const view = await mount(live(), { ownActive: ownRun, rowShown: true });
    await act(async () => view.toggle()?.click());
    const state = (button: HTMLButtonElement | undefined) => (button ? !button.disabled : null);
    expect({
      pause: state(control(view, messages.Activity.pause)),
      resume: state(control(view, messages.Activity.resume)),
      stop: state(control(view, messages.Activity.stop)),
    }).toEqual(want);
    // Each says what it does.
    await act(async () => control(view, messages.Activity.pause)?.click());
    await act(async () => control(view, messages.Activity.resume)?.click());
    expect(view.onPause).toHaveBeenCalledTimes(want.pause ? 1 : 0);
    expect(view.onResume).toHaveBeenCalledTimes(want.resume ? 1 : 0);
  },
);

it('takes no second run command while one is being sent', async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: runningProjection(),
    pendingCommandIds: ['cmd_1'],
  });
  const view = await mount(live(), { ownActive: ownRun, rowShown: true });
  await act(async () => view.toggle()?.click());
  expect(control(view, messages.Activity.pause)?.disabled).toBe(true);
  expect(control(view, messages.Activity.stop)?.disabled).toBe(true);
  await act(async () => fixture.store?.setState({ pendingCommandIds: [] }));
  expect(control(view, messages.Activity.stop)?.disabled).toBe(false);
});

it('marks the join target and offers Join only to an execution that takes an instruction', async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'active' },
      exec_writer: { node: 'writer', status: 'active' },
      exec_review: { node: 'review', status: 'active' },
    }),
  });
  const view = await mount(live(), {
    ownActive: ownRun,
    rowShown: true,
    target: 'exec_writer',
    targets: [{ id: 'exec_lead' }, { id: 'exec_writer' }],
  });
  await act(async () => view.toggle()?.click());
  const row = (id: string) => view.panel()?.querySelector(`[data-activity-role="${id}"]`);
  expect(row('exec_writer')?.textContent).toContain(messages.Activity.joinTarget);
  expect(row('exec_lead')?.textContent).not.toContain(messages.Activity.joinTarget);
  const join = (id: string) =>
    [...(row(id)?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === messages.Activity.join,
    );
  // The target needs no Join; the reviewer takes no instruction now.
  expect(join('exec_writer')).toBeUndefined();
  expect(join('exec_review')).toBeUndefined();
  await act(async () => join('exec_lead')?.click());
  expect(view.onJoin).toHaveBeenCalledExactlyOnceWith('exec_lead');
});

it("says a role's activity alone on the line, not its state beside it", async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: runningProjection(),
    events: [readRequested],
  });
  // The run row is off screen: the role's line has the activity, which says it works.
  const view = await mount(live(), { ownActive: ownRun });
  const text = visibleText(view.line());
  expect(text).toContain(`${messages.Turn.tool.read_file} · src/session.ts`);
  expect(text).not.toContain(messages.Presence.state.working);
});

it("does not repeat a role's state in its panel row while the role's own row says it", async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'active' },
      exec_child: { node: 'researcher', status: 'active' },
    }),
  });
  const view = await mount(live(), {
    ownActive: ownRun,
    rowShown: true,
    timeline: (
      <div data-chat-part="role:exec_child">
        <span data-presence-label="execution:exec_child">{messages.Presence.state.working}</span>
      </div>
    ),
  });
  await act(async () => view.toggle()?.click());
  const row = view.panel()?.querySelector('[data-activity-role="exec_child"]');
  expect(visibleText(row)).not.toContain(messages.Presence.state.working);
  // Still named for a screen reader.
  expect(row?.textContent).toContain(messages.Presence.state.working);
});

it('says which ended run it is only of an ended run', async () => {
  fixture.store = sessionStore({ runId: 'run_plan', projection: runningProjection() });
  const view = await mount(
    model({ live: true, viewed: { latest: true, number: 1, total: 1 } }, { runStatus: 'running' }),
    { ownActive: ownRun },
  );
  expect(visibleText(view.line())).not.toContain(messages.Widgets.lastRun);
});

it('follows what the conversation shows: rows that mount, rows that leave, never under the composer', async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({ exec_plan: { node: 'assistant', status: 'active' } }),
  });
  const options: (IntersectionObserverInit | undefined)[] = [];
  const Base = globalThis.IntersectionObserver;
  vi.stubGlobal(
    'IntersectionObserver',
    class extends Base {
      constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
        super(callback, init);
        options.push(init);
      }
    },
  );
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.composerSurface === 'floating' ? 96 : 0;
    },
  });
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  try {
    const view = await mount(live(), { ownActive: ownRun, floating: true });
    // The floating composer's height is left out at the timeline's bottom edge.
    expect(options.at(-1)?.rootMargin).toBe('0px 0px -96px 0px');
    const said = () =>
      view.line()?.querySelectorAll('[data-presence-label="execution:exec_plan"]').length ?? 0;
    expect(said()).toBe(1);
    // Its row mounts on screen: the line lets the state go.
    await view.setTimeline(
      <div data-chat-part="role:exec_plan">
        <span data-presence-label="execution:exec_plan">{messages.Presence.state.working}</span>
      </div>,
    );
    expect(said()).toBe(0);
    // The row leaves the conversation: the line says it again.
    await view.setTimeline(null);
    expect(said()).toBe(1);
    // Leaving, the bar stops watching.
    act(() => {
      for (const dispose of cleanup.splice(0)) dispose();
    });
    expect(disconnect).toHaveBeenCalled();
  } finally {
    if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
    disconnect.mockRestore();
  }
});

it("goes to a role's own row on screen and opens nothing", async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'active' },
      exec_child: { node: 'researcher', status: 'active' },
    }),
  });
  const onViewRun = vi.fn();
  const scrolled: Element[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  const view = await mount(live(), {
    ownActive: ownRun,
    rowShown: true,
    onViewRun,
    revealRun: () => false,
    timeline: (
      <div data-chat-part="role:exec_child">
        <button type="button">researcher</button>
      </div>
    ),
  });
  await act(async () => view.toggle()?.click());
  await act(async () =>
    view
      .panel()
      ?.querySelector<HTMLButtonElement>('[data-activity-role="exec_child"] button')
      ?.click(),
  );
  expect(scrolled.map((element) => element.getAttribute('data-chat-part'))).toEqual([
    'role:exec_child',
  ]);
  expect(onViewRun).not.toHaveBeenCalled();
  expect(document.activeElement?.closest('[data-chat-part="role:exec_child"]')).not.toBeNull();
});

it("does not take the run's row for a helper whose own row is not in the window", async () => {
  fixture.store = sessionStore({
    runId: 'run_plan',
    projection: teamProjection({
      exec_lead: { node: 'lead', status: 'active' },
      exec_other: { node: 'writer', status: 'active' },
      exec_child: { node: 'researcher', status: 'active' },
    }),
  });
  const onViewRun = vi.fn();
  const scrolled: Element[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  const view = await mount(live(), {
    ownActive: ownRun,
    rowShown: true,
    onViewRun,
    revealRun: () => false,
    // The conversation draws its roles' rows; this one's is not among them.
    timeline: <div data-chat-part="role:exec_other">writer</div>,
  });
  await act(async () => view.toggle()?.click());
  await act(async () =>
    view
      .panel()
      ?.querySelector<HTMLButtonElement>('[data-activity-role="exec_child"] button')
      ?.click(),
  );
  expect(scrolled).toEqual([]);
  expect(onViewRun).toHaveBeenCalledExactlyOnceWith('run_plan');
});
