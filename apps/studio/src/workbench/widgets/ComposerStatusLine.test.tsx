// @vitest-environment jsdom
import { WorkPlan } from '@corral/contracts';
import { act, type ReactNode, useId } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ComposerDock, ComposerPlan } from './ChatWidgets.tsx';
import type { ChatWidgetModel } from './useChatWidgets.tsx';

const fixture = vi.hoisted(() => ({ model: null as ChatWidgetModel | null }));
vi.mock('./useChatWidgets.tsx', () => ({ useChatWidget: () => fixture.model }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    search,
  }: {
    children: ReactNode;
    className?: string;
    search?: object | ((previous: object) => object);
  }) => (
    <a
      href="#run"
      className={className}
      // The address the link would open, from an empty one.
      data-search={JSON.stringify(typeof search === 'function' ? search({}) : (search ?? {}))}
    >
      {children}
    </a>
  ),
}));

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
    live: true,
    viewed: null,
    readState: 'ready',
    chips: [],
    tools: [{ id: 'tool_1', name: 'read_file', tone: 'running' }],
    action: noAction,
    failedExecutionId: null,
    activity: { text: 'read_file', elapsedMs: 10, frozen: false, runId: 'run_plan' },
    plan: {
      open: false,
      setOpen: vi.fn(),
      status: planStatus(),
      selectedKey: 'exec_plan',
      selectedChoice: choice,
      choices: [choice],
      multiple: false,
      auto: true,
      runStatus: 'running',
      retry: vi.fn(),
      follow: vi.fn(),
      choose: vi.fn(),
      ...plan,
    },
    ...change,
  } as unknown as ChatWidgetModel;
}

async function mount(initial: ChatWidgetModel) {
  fixture.model = initial;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  function Harness() {
    const planId = useId();
    return (
      <>
        <ComposerDock
          planId={planId}
          lead={<span data-testid="lead">Queue</span>}
          note={<span data-testid="note">Applies to a new request only: references</span>}
          summary={<button type="button">Overview</button>}
          plan={<ComposerPlan id={planId} />}
        />
        <div data-testid="queue">Queued request</div>
        <div data-testid="input-surface">
          <textarea aria-label="Request" />
        </div>
      </>
    );
  }
  const paint = () =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Harness />
        </IntlProvider>,
      ),
    );
  await paint();
  return {
    container,
    line: () => container.querySelector<HTMLElement>('[data-testid="composer-status-pills"]'),
    toggle: () => container.querySelector<HTMLButtonElement>('[data-testid="work-plan-toggle"]'),
    rows: () => container.querySelectorAll('[data-plan-item]'),
    update: async (next: ChatWidgetModel) => {
      fixture.model = next;
      await paint();
    },
  };
}

it('keeps the plan count, current step, activity, note and overview in one line', async () => {
  const view = await mount(model());
  const line = view.line();
  if (!line) throw new Error('missing status line');
  expect(line.querySelector('[data-testid="lead"]')).not.toBeNull();
  expect(line.querySelector('[data-testid="note"]')).not.toBeNull();
  expect(line.textContent).toContain('Overview');
  const toggle = view.toggle();
  expect(line.contains(toggle)).toBe(true);
  expect(toggle?.textContent).toContain(messages.Widgets.planHeading);
  expect(toggle?.textContent).toContain('1/7 done');
  // Collapsed, the line names the step in progress.
  expect(toggle?.textContent).toContain('Plan item 2');
  expect(line.querySelector('[data-testid="composer-activity"]')?.textContent).toBe('read_file');
  // The top bar's pill owns the in-progress state; the line does not repeat it.
  expect(line.textContent).not.toContain(messages.Status.running);
  expect(line.querySelector('a')).toBeNull();
});

it('renders the plan Todo only when the line is expanded, and only once', async () => {
  const view = await mount(model());
  const toggle = view.toggle();
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(view.rows()).toHaveLength(0);
  const region = view.container.querySelector(`[id="${toggle?.getAttribute('aria-controls')}"]`);
  expect(region).not.toBeNull();
  expect(region?.hasAttribute('hidden')).toBe(true);
  await act(async () => toggle?.click());
  expect(fixture.model?.plan.setOpen).toHaveBeenCalledWith(true);

  await view.update(model({}, { open: true }));
  expect(view.toggle()?.getAttribute('aria-expanded')).toBe('true');
  expect(view.rows()).toHaveLength(5);
  expect(view.container.querySelectorAll('[data-testid="composer-work-plan"]')).toHaveLength(1);
  expect(view.container.querySelectorAll('ol')).toHaveLength(1);
  // The Todo sits right under its line, outside the input, and the line no longer repeats
  // the open step.
  const surface = view.container.querySelector('[data-testid="input-surface"]');
  expect(surface?.querySelectorAll('[data-plan-item]')).toHaveLength(0);
  const plan = view.container.querySelector('[data-testid="composer-work-plan"]');
  expect(plan?.id).toBe(view.toggle()?.getAttribute('aria-controls'));
  expect(plan?.querySelectorAll('[data-plan-item]')).toHaveLength(5);
  expect(view.toggle()?.textContent).not.toContain('Plan item 2');
  // Read only: no checkbox completes an item.
  expect(view.container.querySelector('input[type="checkbox"], [role="checkbox"]')).toBeNull();
});

it.each(['running', 'pausing', 'paused', 'awaiting_user'] as const)(
  'a %s run puts no state word on the line; the top bar says it',
  async (runStatus) => {
    const view = await mount(
      model(
        runStatus === 'awaiting_user'
          ? {
              action: {
                ...noAction,
                visible: true,
                needsUser: true,
                count: 1,
                summary: 'question',
              },
            }
          : {},
        { runStatus },
      ),
    );
    const line = view.line()?.textContent ?? '';
    for (const state of ['running', 'pausing', 'paused', 'awaiting_user'] as const)
      expect(line).not.toContain(messages.Status[state]);
    expect(view.line()?.querySelector('a')).toBeNull();
  },
);

it('marks the step in progress as the current step, with the kit plan rows', async () => {
  const view = await mount(model({}, { open: true }));
  const rows = [...view.rows()];
  expect(rows).toHaveLength(5);
  // chat-widgets-contract §4.1: the plan above the input uses the AgentSteering plan rows.
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

it('leaves a live run that needs the person to the notice, and keeps one status for an ended run', async () => {
  const waiting = model({
    action: { ...noAction, visible: true, needsUser: true, count: 1, summary: 'question' },
  } as Partial<ChatWidgetModel>);
  const view = await mount(waiting);
  expect(view.line()?.querySelector('a')).toBeNull();
  expect(view.line()?.textContent).not.toContain(messages.Status.running);
  expect(view.container.querySelector('[data-testid="action-required"]')?.textContent).toContain(
    messages.Widgets.actionQuestion,
  );
  expect(view.line()?.querySelector('[data-testid="composer-activity"]')).toBeNull();

  await view.update(model({ live: false }, { runStatus: 'succeeded' }));
  const links = view.line()?.querySelectorAll('a') ?? [];
  expect(links).toHaveLength(1);
  expect(links[0]?.textContent).toContain(messages.Status.succeeded);
});

it("names the waiting question in the notice and links to its run's response area", async () => {
  const view = await mount(
    model(
      {
        action: { ...noAction, visible: true, needsUser: true, count: 2, summary: 'question' },
        questionNotice: 'Question: Which layout should I keep? · 2 waiting',
      } as Partial<ChatWidgetModel>,
      { runStatus: 'awaiting_user' },
    ),
  );
  const banner = view.container.querySelector('[data-testid="action-required"]');
  expect(banner?.textContent).toContain('Question: Which layout should I keep? · 2 waiting');
  expect(banner?.textContent).not.toContain(messages.Widgets.actionQuestion);
  expect(banner?.querySelector('a')?.textContent).toBe(messages.Widgets.actionOpen);
  // It asks the run page to open that response area, not just the run.
  expect(JSON.parse(banner?.querySelector('a')?.dataset.search ?? '{}')).toMatchObject({
    panel: 'run',
    view: 'run',
    respond: true,
  });
  // No inline answer: the notice only leads to the run.
  expect(banner?.querySelectorAll('input, textarea, select, form')).toHaveLength(0);
  // An approval waiting beside it keeps the generic wording.
  await view.update(
    model(
      {
        action: { ...noAction, visible: true, needsUser: true, count: 2, summary: 'mixed' },
        questionNotice: 'Question: Which layout should I keep?',
      } as Partial<ChatWidgetModel>,
      { runStatus: 'awaiting_user' },
    ),
  );
  expect(
    view.container.querySelector('[data-testid="action-required"]')?.textContent,
  ).not.toContain('Which layout');
  // A failed step is not something to answer: its link opens the step, not the response area.
  await view.update(
    model(
      {
        action: { ...noAction, visible: true, needsUser: false, count: 1, summary: 'mixed' },
        failedExecutionId: 'exec_failed',
      } as Partial<ChatWidgetModel>,
      { runStatus: 'failed' },
    ),
  );
  const failure = view.container.querySelector('[data-testid="action-required"] a');
  expect(failure?.textContent).toBe(messages.Widgets.actionOpenFailure);
  expect(JSON.parse(failure?.getAttribute('data-search') ?? '{}')).toMatchObject({
    execution: 'exec_failed',
  });
  expect(JSON.parse(failure?.getAttribute('data-search') ?? '{}')).not.toHaveProperty('respond');
  // An unconfirmed outcome is not something to answer either: its link opens the run and says so.
  await view.update(
    model(
      {
        action: {
          ...noAction,
          visible: true,
          needsUser: false,
          count: 1,
          summary: 'unclear',
          unclearCauses: ['effect'],
        },
      } as Partial<ChatWidgetModel>,
      { runStatus: 'succeeded' },
    ),
  );
  const unclear = view.container.querySelector('[data-testid="action-required"] a');
  expect(unclear?.textContent).toBe(messages.Widgets.actionOpenRun);
  expect(unclear?.textContent).not.toBe(messages.Widgets.actionOpen);
  expect(JSON.parse(unclear?.getAttribute('data-search') ?? '{}')).not.toHaveProperty('respond');
});

it('keeps the notice for a live waiting run while another result is open', async () => {
  // The line leaves a live run's state to the top bar's pill; the notice still shows its need
  // while the person reads another result.
  const view = await mount(
    model(
      {
        results: [{ id: 'artv_earlier', label: 'Earlier report v1' }],
        action: { ...noAction, visible: true, needsUser: true, count: 1, summary: 'question' },
        questionNotice: 'Question: Keep the measured context?',
      } as Partial<ChatWidgetModel>,
      { runStatus: 'awaiting_user' },
    ),
  );
  expect(view.line()?.textContent).not.toContain(messages.Status.awaiting_user);
  const banner = view.container.querySelector('[data-testid="action-required"]');
  expect(banner?.textContent).toContain('Question: Keep the measured context?');
  expect(banner?.querySelector('a')).not.toBeNull();
});

it('keeps the lead and note without a run', async () => {
  const view = await mount(model({ runId: null } as Partial<ChatWidgetModel>));
  expect(view.line()?.querySelector('[data-testid="lead"]')).not.toBeNull();
  expect(view.toggle()).toBeNull();
  expect(view.line()?.textContent).not.toContain('Overview');
});

it('says an ended run is the last run without its number, which its turn already links', async () => {
  const view = await mount(
    model({ live: false, viewed: { latest: true, number: 1, total: 1 } }, { runStatus: 'failed' }),
  );
  const state = view.line()?.querySelector('a');
  expect(state?.textContent).toBe(`${messages.Status.failed}${messages.Widgets.lastRun}`);
  expect(state?.textContent).not.toContain('Run #1');
  // An older run still names its place among the session's runs.
  await view.update(
    model({ live: false, viewed: { latest: false, number: 1, total: 2 } }, { runStatus: 'failed' }),
  );
  expect(view.line()?.querySelector('a')?.textContent).toContain('Run #1 of 2');
});

it('gives each end state its own mark, so a failure never looks like a success', async () => {
  const view = await mount(model({ live: false }, { runStatus: 'succeeded' }));
  const mark = () => view.line()?.querySelector('a svg');
  const seen = new Set<string>();
  for (const runStatus of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
    await view.update(model({ live: false }, { runStatus }));
    expect(view.line()?.querySelector('a')?.textContent).toContain(messages.Status[runStatus]);
    expect(mark()?.getAttribute('data-state')).toBe(runStatus);
    // The drawn shape differs, not only its color.
    seen.add(mark()?.innerHTML ?? '');
  }
  expect(seen.size).toBe(4);
  // A run whose state cannot be read is marked as a problem, never as done.
  await view.update(model({ live: false, readState: 'error' }, { runStatus: 'succeeded' }));
  expect(mark()?.getAttribute('data-state')).toBe('failed');
});

it('reads status line, plan, notice, queue and input from top to bottom', async () => {
  const view = await mount(
    model(
      {
        action: { ...noAction, visible: true, needsUser: true, count: 1, summary: 'question' },
      } as Partial<ChatWidgetModel>,
      { open: true, runStatus: 'awaiting_user' },
    ),
  );
  const order = [
    view.line(),
    view.container.querySelector('[data-testid="composer-work-plan"]'),
    view.container.querySelector('[data-testid="action-required"]'),
    view.container.querySelector('[data-testid="queue"]'),
    view.container.querySelector('[data-testid="input-surface"]'),
  ];
  expect(order.every(Boolean)).toBe(true);
  for (const [index, node] of order.entries()) {
    const next = order[index + 1];
    if (node && next)
      expect(node.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

const failure = {
  ...noAction,
  visible: true,
  hasFailure: true,
  count: 1,
  summary: 'failure',
} as ChatWidgetModel['action'];

it("leaves a failure to its turn's card when that card is the latest turn", async () => {
  const view = await mount(
    model(
      { live: false, action: failure, viewed: { latest: true, number: 2, total: 2 } },
      {
        runStatus: 'failed',
      },
    ),
  );
  expect(view.container.querySelector('[data-testid="action-required"]')).toBeNull();
  // The ended run still keeps its one state on the line.
  expect(view.line()?.querySelector('a')?.textContent).toContain(messages.Status.failed);
});

it('keeps the failed-steps notice for a run that completed, whose card has no way to them', async () => {
  const view = await mount(
    model(
      {
        live: false,
        action: { ...failure, completedWithFailures: true },
        failedExecutionId: 'exec_failed',
        viewed: { latest: true, number: 1, total: 1 },
      },
      { runStatus: 'succeeded' },
    ),
  );
  const banner = view.container.querySelector('[data-testid="action-required"]');
  expect(banner?.textContent).toContain(messages.Widgets.actionOpenFailure);
});

it('keeps a failure notice while another run or result is on screen', async () => {
  const view = await mount(
    model(
      { live: false, action: failure, viewed: { latest: false, number: 1, total: 2 } },
      {
        runStatus: 'failed',
      },
    ),
  );
  const banner = view.container.querySelector('[data-testid="action-required"]');
  expect(banner?.textContent).toContain(messages.Widgets.actionFailure);
  expect(banner?.querySelector('a')).not.toBeNull();
  // A question on the latest live turn keeps the notice: it carries the only action.
  await view.update(
    model({
      action: { ...noAction, visible: true, needsUser: true, count: 1, summary: 'question' },
    } as Partial<ChatWidgetModel>),
  );
  expect(view.container.querySelector('[data-testid="action-required"]')).not.toBeNull();
});
