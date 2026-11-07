// @vitest-environment jsdom
import { WorkPlan } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { OverviewWidgets } from './OverviewWidgets.tsx';
import { actionRequired, usageSummary } from './selectors.ts';
import type { ChatWidgetModel } from './useChatWidgets.tsx';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children, ...props }: { children: ReactNode }) => (
    <a href="#link" {...(props as object)}>
      {children}
    </a>
  ),
}));
const disposals: (() => Promise<void>)[] = [];
Element.prototype.getAnimations ??= () => [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

function model(patch: Partial<ChatWidgetModel> = {}): ChatWidgetModel {
  const projection = emptyProjection('run_overview');
  projection.status = 'succeeded';
  projection.budget.spent = 930;
  projection.budget.modelCalls = 4;
  projection.budget.unknownOutstanding = 256;
  return {
    sessionId: 'session',
    runId: 'run_overview',
    live: false,
    viewed: { latest: true, number: 1, total: 1 },
    simulated: false,
    readState: 'ready',
    retryRead: vi.fn(),
    context: {
      kind: 'request',
      tokens: 711_800,
      percent: 71,
      barPercent: 71,
      freeTokens: 288_200,
      windowTokens: 1_000_000,
      awaitingRefresh: false,
      providerInput: null,
      providerCacheRead: null,
      providerOutput: null,
      parts: [{ category: 'messages', tokens: 659_900 }],
      unmeasuredExecutions: 0,
      executionId: 'exec',
      modelCallId: 'call',
      recordedAt: null,
      roleLabel: null,
      modelLabel: null,
      coverage: 'request',
      completeness: 'complete',
      method: null,
      omissions: [],
      reserveTokens: null,
      measurementStage: null,
    },
    reserveTokens: null,
    chips: ['context', 'changes'],
    changesLabel: 'fixed',
    changeFiles: 12,
    changeLines: 3616,
    changeAdditions: 2589,
    changeDeletions: 1027,
    agents: null,
    tools: [],
    results: [{ id: 'artv_1', label: 'draft v1' }],
    environment: null,
    usage: usageSummary(projection, { maxOutputTokens: 64_000, maxModelCalls: 40 }),
    cost: null,
    action: actionRequired({
      pendingApprovals: 0,
      pendingQuestions: 0,
      failedEffects: 0,
      unclearEffects: 0,
    }),
    agentRows: [],
    plan: { choices: [], choose: vi.fn() },
    ...patch,
  } as unknown as ChatWidgetModel;
}

async function render(value: ChatWidgetModel) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <OverviewWidgets model={value} />
      </IntlProvider>,
    ),
  );
  return container;
}

const widgets = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-overview-widget]')].map(
    (node) => node.dataset.overviewWidget,
  );

it('shows the run in kit widgets whose details open in place', async () => {
  const container = await render(model());
  expect(widgets(container)).toEqual(['results', 'changes', 'context', 'usage']);
  const usage = container.querySelector<HTMLElement>('[data-overview-widget="usage"]');
  expect(usage?.querySelector('[data-slot="card"]')).not.toBeNull();
  expect(usage?.textContent).toContain('930');
  expect(usage?.textContent).toContain('4 of 40 model calls');
  expect(usage?.textContent).toContain('256 unconfirmed tokens held');
  expect(container.querySelector('[data-overview-widget="context"]')?.textContent).toContain('71%');
  const changes = container.querySelector('[data-overview-widget="changes"]');
  expect(changes?.textContent).toContain('+2,589');
  expect(changes?.textContent).toContain('−1,027');
  const resultButton = container.querySelector<HTMLButtonElement>(
    '[data-overview-widget="results"] button[aria-label="draft v1"]',
  );
  expect(resultButton).not.toBeNull();
  await act(async () => resultButton?.click());
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      search: {
        panel: 'run',
        run: 'run_overview',
        view: 'results',
        result: 'artv_1',
      },
    }),
  );
  // Changes opens this run's diff; nothing changes the presented run or the next request.
  await act(async () =>
    changes?.querySelector<HTMLButtonElement>('button[aria-label="Open the changes"]')?.click(),
  );
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ search: { scope: 'run', runId: 'run_overview' } }),
  );
  // The widget is the popover's trigger, so focus returns to it on close.
  const trigger = usage?.querySelector<HTMLElement>('[role="button"]');
  expect(trigger?.querySelector('[data-slot="card"]')).not.toBeNull();
  expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  await act(async () => trigger?.click());
  expect(document.querySelector('[data-testid="usage-detail"]')?.textContent).toContain('930');
  expect(trigger?.getAttribute('aria-expanded')).toBe('true');
});

it('keeps pending attention first and links to the same run without an approval command', async () => {
  const container = await render(
    model({
      live: true,
      action: actionRequired({
        pendingApprovals: 1,
        pendingQuestions: 0,
        failedEffects: 0,
        unclearEffects: 0,
      }),
    }),
  );
  expect(widgets(container)[0]).toBe('attention');
  const attention = container.querySelector('[data-overview-widget="attention"]');
  expect(attention?.textContent).toContain('Approval needed');
  expect(attention?.querySelector('a')).not.toBeNull();
  expect(attention?.textContent).not.toMatch(/Approve|Reject/);
});

it('does not present a partial or unmeasured context as a full-window meter', async () => {
  const base = model();
  const container = await render(
    model({
      context: {
        ...base.context,
        coverage: 'messages',
        completeness: 'partial',
        windowTokens: null,
        percent: null,
        barPercent: null,
      },
    }),
  );
  expect(
    container.querySelector('[data-overview-widget="context"] [role="progressbar"]'),
  ).toBeNull();
  expect(container.querySelector('[data-overview-widget="context"]')?.textContent).not.toContain(
    '0%',
  );
});

it('uses a measured meter and a sparkline only for reported completed-call values', async () => {
  const base = model();
  const container = await render(model({ usage: { ...base.usage!, perCall: [10, 0, 30] } }));
  const meter = container.querySelector('[data-overview-widget="context"] [role="progressbar"]');
  expect(meter?.getAttribute('aria-valuenow')).toBe('71');
  const usage = container.querySelector('[data-overview-widget="usage"]');
  expect(usage?.querySelector('[data-testid="usage-sparkline"] svg')).not.toBeNull();
  expect(usage?.textContent).toContain('10, 0, 30');
});

it('shows agent identity and accurate current status while work is active, then condenses it', async () => {
  const container = await render(
    model({
      live: true,
      chips: ['agents'],
      agents: { total: 2, working: 1, waiting: 1, failed: 0 },
      agentRows: [
        { id: 'reviewer', name: 'Reviewer', status: 'active' },
        { id: 'writer', name: 'Writer', status: 'waiting_message' },
      ],
    }),
  );
  const agent = container.querySelector('[data-overview-widget="agents"]');
  expect(agent?.textContent).toContain('Reviewer');
  expect(agent?.textContent).toContain('Waiting for an answer');
  expect(agent?.textContent).toContain('2 agents, 1 working');
  expect(agent?.textContent).not.toMatch(/Pause|Cancel|Approve/);
  const completed = await render(
    model({
      chips: ['agents'],
      agents: { total: 2, working: 0, waiting: 0, failed: 0 },
      agentRows: [{ id: 'reviewer', name: 'Reviewer', status: 'succeeded' }],
    }),
  );
  expect(completed.querySelector('[data-overview-widget="agents"]')?.textContent).not.toContain(
    'Reviewer',
  );
  expect(widgets(completed)[0]).toBe('results');
});

it('identifies an older selected run without changing its usage or results', async () => {
  const container = await render(model({ viewed: { latest: false, number: 2, total: 3 } }));
  expect(container.querySelector('[data-testid="overview-run-scope"]')?.textContent).toBe(
    'Selected run · Run #2',
  );
  const usage = container.querySelector('[data-overview-widget="usage"]');
  expect(usage?.textContent).toContain('930');
  expect(usage?.textContent).toContain('output tokens');
  expect(container.querySelector('[data-overview-widget="results"]')?.textContent).toContain(
    'draft v1',
  );
});

it('names a run without limits and hides widgets with nothing to say', async () => {
  const projection = emptyProjection('run_overview');
  projection.status = 'succeeded';
  projection.budget.spent = 120;
  projection.budget.modelCalls = 1;
  projection.usageLimits = 'none';
  const container = await render(
    model({
      chips: [],
      results: [],
      usage: usageSummary(projection, { maxOutputTokens: 64_000, maxModelCalls: 40 }),
    }),
  );
  expect(widgets(container)).toEqual(['usage']);
  expect(container.textContent).toContain('1 model call');
  expect(container.textContent).not.toContain(' of 40');
});

it('a run that cannot be read offers a retry for the same run', async () => {
  const retryRead = vi.fn();
  const container = await render(model({ readState: 'error', retryRead }));
  expect(widgets(container)).toEqual([]);
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
  await act(async () => retry?.click());
  expect(retryRead).toHaveBeenCalledTimes(1);
});

it('without a run, Overview renders nothing so its column stays hidden', async () => {
  const container = await render(model({ runId: null, chips: [], results: [], usage: null }));
  expect(container.innerHTML).toBe('');
});

it('the usage detail states reported input and cached input and names unreported calls', async () => {
  const base = model();
  const container = await render(
    model({
      usage: {
        ...base.usage!,
        input: { tokens: 3_500, cached: 1_500, cacheShare: 0.5, cacheUnreported: 2 },
      },
    }),
  );
  const trigger = container.querySelector<HTMLElement>(
    '[data-overview-widget="usage"] [role="button"]',
  );
  await act(async () => trigger?.click());
  const detail = document.querySelector('[data-testid="usage-detail"]')?.textContent ?? '';
  expect(detail).toContain('Reported input tokens');
  expect(detail).toContain('3,500');
  expect(detail).toContain('Cached input');
  expect(detail).toContain('1,500 (50%)');
  expect(detail).toContain('2 calls did not report cached input');
});

it('the usage detail never shows an unreported cache as zero', async () => {
  const base = model();
  const container = await render(
    model({
      usage: {
        ...base.usage!,
        input: { tokens: 300, cached: null, cacheShare: null, cacheUnreported: 3 },
      },
    }),
  );
  const trigger = container.querySelector<HTMLElement>(
    '[data-overview-widget="usage"] [role="button"]',
  );
  await act(async () => trigger?.click());
  const detail = document.querySelector('[data-testid="usage-detail"]')?.textContent ?? '';
  expect(detail).toContain('Cached input');
  expect(detail).toContain('Not reported');
  expect(detail).not.toContain('0%');
});

it('names missing input reports rather than presenting the known-only sum as complete', async () => {
  const base = model();
  if (!base.usage) throw new Error('usage fixture missing');
  const container = await render(
    model({
      usage: {
        ...base.usage,
        input: { tokens: 100, cached: null, cacheShare: null, cacheUnreported: 1 },
        inputUnreported: 1,
      },
    }),
  );
  await act(async () =>
    container.querySelector<HTMLElement>('[data-overview-widget="usage"] [role="button"]')?.click(),
  );
  const detail = document.querySelector('[data-testid="usage-detail"]')?.textContent ?? '';
  expect(detail).toContain('100');
  expect(detail).toContain('1 completed call did not report input tokens');
});

it('keeps the selected plan in its composer instead of repeating its items in Overview', async () => {
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
  const container = await render(
    model({
      live: true,
      environment: 'simulated',
      chips: ['context', 'environment'],
      plan: {
        choices: [],
        choose: vi.fn(),
        status: {
          state: 'ready',
          plan,
          total: 7,
          completed: 1,
          planFinished: false,
          runFinished: false,
        },
      },
    } as unknown as Partial<ChatWidgetModel>),
  );
  expect(widgets(container)).toEqual(['results', 'context', 'usage']);
  expect(container.querySelector('[data-testid="overview-plan"]')).toBeNull();
  expect(container.textContent).not.toContain('Plan item');
  expect(container.querySelector('[data-overview-widget="results"]')?.textContent).toContain(
    'draft v1',
  );
  expect(container.querySelector('[data-testid="environment-chip"]')).toBeNull();
});
