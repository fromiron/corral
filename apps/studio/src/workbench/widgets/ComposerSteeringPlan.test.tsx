// @vitest-environment jsdom
import { WorkPlan } from '@corral/contracts';
import { type ExecutionView, emptyProjection } from '@corral/core';
import { ExecutionSteering } from '@corral/react';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../../packages/react/src/stories/fixtures.tsx';
import { ComposerPlan } from './ChatWidgets.tsx';
import type { ChatWidgetModel } from './useChatWidgets.tsx';

const fixture = vi.hoisted(() => ({ model: null as ChatWidgetModel | null }));
vi.mock('./useChatWidgets.tsx', () => ({ useChatWidget: () => fixture.model }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#run">{children}</a>,
}));

const disposals: (() => void)[] = [];
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
  for (const dispose of disposals.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

function planStatus(revision = 1): ChatWidgetModel['plan']['status'] {
  const plan = WorkPlan.parse({
    scope: 'execution',
    executionId: 'exec_plan',
    attemptNo: 1,
    revision,
    criteriaVersionId: 'criteria_plan',
    items: Array.from({ length: 7 }, (_, index) => ({
      id: `item_${index + 1}`,
      title: `Plan item ${index + 1}${revision > 1 && index === 6 ? ' updated' : ''}`,
      status: index === 0 ? 'in_progress' : 'pending',
    })),
  });
  return { state: 'ready', plan, total: 7, completed: 0, planFinished: false, runFinished: false };
}

async function mount(open = true) {
  const projection = emptyProjection('run_plan');
  projection.status = 'running';
  projection.executions.exec_plan = {
    executionId: 'exec_plan',
    nodeId: 'assistant',
    taskId: 'task_plan',
    attemptNo: 1,
    parentExecutionId: null,
    previousExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
    configRevision: 0,
    criteriaVersionId: 'criteria_plan',
    status: 'active',
    activity: 'model',
    waitingOn: null,
    modelCallIds: [],
    error: null,
  } satisfies ExecutionView;
  const ref = {
    scope: 'execution' as const,
    executionId: 'exec_plan',
    attemptNo: 1,
    revision: 1,
    criteriaVersionId: 'criteria_plan',
    bodyRef: 'body_plan',
    bodyHash: 'a'.repeat(64),
  };
  projection.workPlans = { exec_plan: ref };
  const loadArtifact = vi.fn(async () => {});
  const session = sessionStore({ runId: 'run_plan', projection, loadArtifact });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(() => {
    root.unmount();
    container.remove();
  });
  let variant: 'steering' | 'composer' = 'steering';
  let paint = () => {};
  const setOpen = vi.fn((value: boolean) => {
    if (!fixture.model) throw new Error('missing widget model');
    fixture.model = { ...fixture.model, plan: { ...fixture.model.plan, open: value } };
    paint();
  });
  const choice = {
    key: 'exec_plan',
    label: 'Assistant',
    live: true,
    lastTeam: false,
    status: 'active',
    attemptNo: 1,
    ref,
  };
  fixture.model = {
    sessionId: 'session_plan',
    runId: 'run_plan',
    live: true,
    action: { visible: false },
    activity: { text: 'working', elapsedMs: 10, frozen: false, runId: 'run_plan' },
    plan: {
      open,
      setOpen,
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
    },
  } as unknown as ChatWidgetModel;

  function Harness({ variant }: { variant: 'steering' | 'composer' }) {
    const [showAllKey, setShowAllKey] = useState<string | null>(null);
    const plan = (
      <ComposerPlan variant={variant} showAllKey={showAllKey} onShowAllKeyChange={setShowAllKey} />
    );
    const compose = <textarea aria-label="Request" defaultValue="Keep this draft and cursor" />;
    return variant === 'steering' ? (
      <ExecutionSteering
        session={session}
        target={{ executionId: 'exec_plan', nodeLabel: 'Assistant', finished: false }}
        planSlot={plan}
        compose={compose}
      />
    ) : (
      <div>
        {plan}
        {compose}
      </div>
    );
  }
  paint = () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Harness variant={variant} />
      </IntlProvider>,
    );
  await act(async () => paint());
  const button = (text: string) => {
    const found = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  return {
    container,
    loadArtifact,
    setOpen,
    button,
    rows: () => container.querySelectorAll('[data-plan-item]'),
    update: async (changes: Partial<ChatWidgetModel['plan']>) => {
      if (!fixture.model) throw new Error('missing widget model');
      fixture.model = { ...fixture.model, plan: { ...fixture.model.plan, ...changes } };
      await act(async () => paint());
    },
    move: async (next: typeof variant) => {
      variant = next;
      await act(async () => paint());
    },
  };
}

it('composes five kit plan rows with Show all and no second plan loader or activity line', async () => {
  const view = await mount();
  expect(view.rows()).toHaveLength(5);
  expect(view.container.querySelectorAll('textarea')).toHaveLength(1);
  expect(view.container.querySelector('[data-testid="run-activity"]')).toBeNull();
  expect(view.loadArtifact).not.toHaveBeenCalled();
  await act(async () => view.button('Show all 7').click());
  expect(view.rows()).toHaveLength(7);
  await act(async () => view.button('Show less').click());
  expect(view.rows()).toHaveLength(5);
});

it('keeps manual collapse and the same draft textarea across plan revisions', async () => {
  const view = await mount();
  const textarea = view.container.querySelector('textarea');
  if (!textarea) throw new Error('missing input');
  textarea.focus();
  textarea.setSelectionRange(5, 10);
  await view.update({ status: planStatus(2) });
  expect(view.container.querySelector('textarea')).toBe(textarea);
  expect(textarea.value).toBe('Keep this draft and cursor');
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([5, 10]);
  await act(async () => view.button('Work plan').click());
  expect(view.setOpen).toHaveBeenLastCalledWith(false);
  expect(view.rows()).toHaveLength(0);
  await view.update({ status: planStatus(3) });
  expect(view.rows()).toHaveLength(0);
  expect(
    view.container.querySelector('[data-testid="work-plan-toggle"]')?.getAttribute('aria-expanded'),
  ).toBe('false');
  expect(view.container.querySelector('textarea')).toBe(textarea);
  expect(textarea.value).toBe('Keep this draft and cursor');
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([5, 10]);
});

it('respects externally supplied closed and open preferences and preserves Show all across composer modes', async () => {
  const view = await mount(false);
  expect(view.rows()).toHaveLength(0);
  await view.update({ open: true });
  expect(view.rows()).toHaveLength(5);
  await act(async () => view.button('Show all 7').click());
  expect(view.rows()).toHaveLength(7);
  await view.move('composer');
  expect(view.rows()).toHaveLength(7);
  await view.move('steering');
  expect(view.rows()).toHaveLength(7);
  await view.update({ open: false, runStatus: 'succeeded' });
  expect(view.rows()).toHaveLength(0);
  await view.update({ open: true });
  expect(view.rows()).toHaveLength(7);
});

it.each(['paused', 'waiting_approval', 'unknown'])(
  'keeps the plan visible without active motion for a %s owner in a running Run',
  async (status) => {
    const view = await mount();
    expect(view.container.querySelectorAll('[data-plan-item] .shimmer-text')).toHaveLength(1);
    const selectedChoice = fixture.model?.plan.selectedChoice;
    if (!selectedChoice) throw new Error('missing plan owner');
    await view.update({
      runStatus: 'running',
      selectedChoice: {
        ...selectedChoice,
        status,
        ...(status === 'unknown'
          ? { key: 'team', label: 'Team', ref: { ...selectedChoice.ref, scope: 'team' as const } }
          : {}),
      },
    });
    expect(view.rows()).toHaveLength(5);
    expect(view.container.querySelectorAll('[data-plan-item] .shimmer-text')).toHaveLength(0);
  },
);
