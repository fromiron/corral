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
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#run" className={className}>
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
        />
        <div data-testid="input-surface">
          <ComposerPlan id={planId} />
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
  // The Todo sits with the input, and the line no longer repeats the open step.
  const surface = view.container.querySelector('[data-testid="input-surface"]');
  expect(surface?.querySelectorAll('[data-plan-item]')).toHaveLength(5);
  expect(view.toggle()?.textContent).not.toContain('Plan item 2');
  // Read only: no checkbox completes an item.
  expect(view.container.querySelector('input[type="checkbox"], [role="checkbox"]')).toBeNull();
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

it('keeps the lead and note without a run', async () => {
  const view = await mount(model({ runId: null } as Partial<ChatWidgetModel>));
  expect(view.line()?.querySelector('[data-testid="lead"]')).not.toBeNull();
  expect(view.toggle()).toBeNull();
  expect(view.line()?.textContent).not.toContain('Overview');
});
