// @vitest-environment jsdom
import { WorkPlan } from '@corral/contracts';
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
  }: { ownActive?: RunSummary | null; rowShown?: boolean; lost?: boolean } = {},
) {
  fixture.model = initial;
  const tray = createPendingTrayStore();
  const respond = vi.fn();
  const retry = vi.fn();
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
                </div>
                <div data-testid="chat-composer">
                  <ComposerActivity
                    sessionId="session_plan"
                    ownActive={ownActive}
                    target={null}
                    targets={[]}
                    onJoin={vi.fn()}
                    onStop={vi.fn()}
                    onPause={vi.fn()}
                    onResume={vi.fn()}
                    viewingOther={false}
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
    bar,
    /** The closed line: the bar without its panel. */
    line: () => bar()?.querySelector<HTMLElement>('[data-activity-bar] > div'),
    toggle: () => bar()?.querySelector<HTMLButtonElement>('[data-activity-toggle]'),
    panel: () => bar()?.querySelector<HTMLElement>('section[aria-label="Activity"]'),
    rows: () => container.querySelectorAll('[data-plan-item]'),
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

it("says a live run's tool as the work log names it, and its state only off screen", async () => {
  fixture.store = sessionStore({ runId: 'run_plan', projection: runningProjection() });
  const view = await mount(model({ live: true }, { runStatus: 'running' }), {
    ownActive: ownRun,
    rowShown: true,
  });
  expect(view.bar()?.dataset.live).toBe('');
  // The run row on screen already says Working; the line says what the role does.
  const text = visibleText(view.line());
  expect(text).toContain(messages.Turn.tool.read_file);
  expect(text).not.toContain('read_file');
  expect(text).not.toContain(messages.Presence.state.working);
  // The open panel has its run controls.
  await act(async () => view.toggle()?.click());
  const controls = view.panel()?.querySelector('[aria-label="Run controls"]');
  expect(controls?.textContent).toContain(messages.Activity.pause);
  expect(controls?.textContent).toContain(messages.Activity.stop);
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
