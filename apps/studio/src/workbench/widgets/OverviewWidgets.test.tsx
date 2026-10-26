// @vitest-environment jsdom
import { emptyProjection } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { OverviewWidgets } from './OverviewWidgets.tsx';
import { usageSummary } from './selectors.ts';
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
  expect(widgets(container)).toEqual(['context', 'usage', 'results', 'changes']);
  const usage = container.querySelector<HTMLElement>('[data-overview-widget="usage"]');
  expect(usage?.querySelector('[data-slot="card"]')).not.toBeNull();
  expect(usage?.textContent).toContain('930');
  expect(usage?.textContent).toContain('4 of 40 calls');
  expect(usage?.textContent).toContain('256 unconfirmed tokens held');
  expect(container.querySelector('[data-overview-widget="context"]')?.textContent).toContain('71%');
  const changes = container.querySelector('[data-overview-widget="changes"]');
  expect(changes?.textContent).toContain('+2,589');
  expect(changes?.textContent).toContain('−1,027');
  expect(container.querySelector('[data-overview-widget="results"] a')?.textContent).toContain(
    'draft v1',
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
  expect(container.textContent).toContain('1 call');
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
  expect(detail).toContain('Input tokens');
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
