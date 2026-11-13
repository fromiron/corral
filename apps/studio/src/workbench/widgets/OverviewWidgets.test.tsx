// @vitest-environment jsdom
import { WorkPlan } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { ContextDetail } from './ChatWidgets.tsx';
import { OverviewPopover, OverviewWidgets } from './OverviewWidgets.tsx';
import { actionRequired, usageSummary } from './selectors.ts';
import type { ChatWidgetModel } from './useChatWidgets.tsx';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({
    children,
    search,
    ...props
  }: {
    children: ReactNode;
    search?: object | ((previous: object) => object);
  }) => (
    <a
      href="#link"
      // The address the link would open, from an empty one.
      data-search={JSON.stringify(typeof search === 'function' ? search({}) : (search ?? {}))}
      {...(props as object)}
    >
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
  for (const [id, outputTokens] of [
    ['a', 500],
    ['b', 300],
    ['c', 130],
    ['d', null],
  ] as const)
    projection.modelCalls[id] = {
      modelCallId: id,
      executionId: 'exec',
      finished: true,
      usage: outputTokens === null ? null : { outputTokens },
    } as never;
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
    usage: usageSummary(projection),
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

async function render(
  value: ChatWidgetModel,
  view: (model: ChatWidgetModel) => ReactNode = (model) => <OverviewWidgets model={model} />,
  locale: 'en' | 'ko' = 'en',
) {
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
      <IntlProvider locale={locale} messages={locale === 'ko' ? ko : messages} timeZone="UTC">
        {view(value)}
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
  expect(usage?.textContent).toContain('4 model calls');
  expect(usage?.textContent).toContain('1 request did not report usage');
  expect(usage?.textContent).not.toMatch(/limit|held|budget/i);
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
  // The whole card is the kit's clickable card; it opens its detail in the same place.
  const trigger = usage?.querySelector<HTMLElement>('button[aria-label="Open Usage details"]');
  expect(trigger?.closest('[data-slot="card"]')).not.toBeNull();
  await act(async () => trigger?.click());
  expect(container.querySelector('[data-testid="usage-detail"]')?.textContent).toContain('930');
});

const press = (key: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true }),
    );
  });
const openButton = (root: ParentNode, name: string) =>
  root.querySelector<HTMLButtonElement>(`button[aria-label="Open ${name} details"]`);

it('a detail takes the widgets’ place, and Back or Escape returns to the widget that opened it', async () => {
  const container = await render(model());
  await act(async () => openButton(container, 'Usage')?.click());
  // One surface: the widgets give way to the detail instead of sitting beside it.
  expect(widgets(container)).toEqual([]);
  expect(container.querySelector('[data-testid="usage-detail"]')?.textContent).toContain('930');
  const back = container.querySelector<HTMLButtonElement>('button[aria-label="Back to Overview"]');
  expect(back).not.toBeNull();
  expect(document.activeElement).toBe(back);
  await act(async () => back?.click());
  expect(container.querySelector('[data-testid="usage-detail"]')).toBeNull();
  expect(widgets(container)).toEqual(['results', 'changes', 'context', 'usage']);
  expect(document.activeElement).toBe(openButton(container, 'Usage'));

  await act(async () => openButton(container, 'Context')?.click());
  expect(container.querySelector('[data-testid="context-inspector"]')).not.toBeNull();
  await press('Escape');
  expect(container.querySelector('[data-testid="context-inspector"]')).toBeNull();
  expect(document.activeElement).toBe(openButton(container, 'Context'));
});

/** Text a sighted reader sees: screen-reader-only words left out. */
const visible = (node: Element | null | undefined) => {
  const copy = node?.cloneNode(true) as Element | undefined;
  for (const hidden of copy?.querySelectorAll('.sr-only') ?? []) hidden.remove();
  return copy?.textContent ?? '';
};

it('the context detail says each measurement once and states only what is measured', async () => {
  const base = model();
  const container = await render(
    model({
      reserveTokens: 16_384,
      context: {
        ...base.context,
        kind: 'highest',
        tokens: 2_399,
        windowTokens: 128_000,
        percent: null,
        barPercent: null,
        coverage: 'request',
        completeness: 'partial',
        measurementStage: 'assembled',
        providerInput: 2_000,
        providerCacheRead: null,
        providerOutput: 44,
        parts: [
          { category: 'messages', tokens: 457 },
          { category: 'system_prompt', tokens: 0 },
        ],
      },
    } as Partial<ChatWidgetModel>),
  );
  await act(async () => openButton(container, 'Context')?.click());
  const detail = container.querySelector('[data-testid="context-inspector"]');
  expect(visible(detail)).toContain('Partial measurement');
  const rows = [...(detail?.querySelectorAll('li') ?? [])];
  const row = (label: string) => rows.find((item) => item.textContent?.startsWith(label));
  // A measured zero stays a zero; an unmeasured part is a dash named "Not measured".
  expect(visible(row('System prompt'))).toBe('System prompt0');
  expect(visible(row('Skills'))).toBe('Skills—');
  expect(row('Skills')?.textContent).toContain('Not measured');
  expect(visible(detail)).not.toContain('Not measured');
  expect(visible(detail)).toContain('16,384 reserved for output');
  expect(visible(detail)).not.toContain('separate from input usage');
  expect(visible(detail)).not.toContain('Request assembled');
  expect(visible(detail)).not.toContain('The highest known ratio');
  expect(visible(detail)).not.toContain('stay separate from this estimate');
  // An unreported provider number is a dash, never 0.
  expect(visible(detail)).toContain('Input 2,000 · cached — · output 44');
});

it('before any measured request the context detail states its state once, with no waiting sentence', async () => {
  const base = model();
  const container = await render(
    model({
      context: {
        ...base.context,
        kind: 'empty',
        tokens: null,
        percent: null,
        barPercent: null,
        freeTokens: null,
        windowTokens: null,
        parts: [],
        unmeasuredExecutions: 0,
        coverage: null,
        completeness: 'unmeasured',
        measurementStage: null,
      },
    } as Partial<ChatWidgetModel>),
  );
  await act(async () => openButton(container, 'Context')?.click());
  const detail = container.querySelector('[data-testid="context-inspector"]');
  // The badge already says nothing is measured, so no sentence says usage will appear later.
  expect(visible(detail)).toContain(messages.Widgets.measurementPending);
  expect(visible(detail)).not.toMatch(/appears after|No measured request/);
  // Nor is an empty note box left behind.
  expect(detail?.querySelector('.bg-subtle.rounded-lg')).toBeNull();
});

it('before any measured request the Korean context detail says 측정 전 once', async () => {
  const base = model();
  const container = await render(
    model({
      context: {
        ...base.context,
        kind: 'empty',
        tokens: null,
        percent: null,
        barPercent: null,
        freeTokens: null,
        windowTokens: null,
        parts: [],
        unmeasuredExecutions: 0,
        coverage: null,
        completeness: 'unmeasured',
        measurementStage: null,
      },
    } as Partial<ChatWidgetModel>),
    undefined,
    'ko',
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="컨텍스트 자세히 보기"]')
      ?.click(),
  );
  const detail = container.querySelector('[data-testid="context-inspector"]');
  expect(detail).not.toBeNull();
  // The heading names the context and its badge the state; no line under them says both again.
  const text = visible(detail);
  expect(text.split(ko.Widgets.measurementPending)).toHaveLength(2);
  expect(text).not.toContain(ko.Widgets.contextPending);
});

it('in the Overview popover Escape first leaves the detail, then closes the popover', async () => {
  const container = await render(model(), (value) => <OverviewPopover model={value} />);
  const trigger = container.querySelector<HTMLElement>('[data-testid="session-summary-trigger"]');
  await act(async () => trigger?.click());
  const popup = () => document.querySelector<HTMLElement>('[data-testid="session-summary-popup"]');
  expect(popup()).not.toBeNull();
  await act(async () => openButton(popup() as HTMLElement, 'Context')?.click());
  // The detail opens inside the Overview popup, not as a second popup beside it.
  expect(document.querySelectorAll('[data-slot="popover-popup"]')).toHaveLength(1);
  expect(popup()?.querySelector('[data-testid="context-inspector"]')).not.toBeNull();
  expect(popup()?.querySelector('[data-overview-widget]')).toBeNull();
  await press('Escape');
  expect(popup()).not.toBeNull();
  expect(popup()?.querySelector('[data-testid="context-inspector"]')).toBeNull();
  expect(document.activeElement).toBe(openButton(popup() as HTMLElement, 'Context'));
  await press('Escape');
  expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  // The popup leaves after its exit frame, then hands focus back to Overview's button.
  await vi.waitFor(() => expect(popup()).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

it('after the occupancy pill closes Overview, the Overview button reopens the widgets', async () => {
  const container = await render(model(), (value) => <OverviewPopover model={value} />);
  const pill = container.querySelector<HTMLElement>('[data-testid="composer-context-occupancy"]');
  const trigger = container.querySelector<HTMLElement>('[data-testid="session-summary-trigger"]');
  const popup = () => document.querySelector<HTMLElement>('[data-testid="session-summary-popup"]');
  await act(async () => pill?.click());
  expect(popup()?.querySelector('[data-testid="context-inspector"]')).toBeTruthy();
  await act(async () => pill?.click());
  await vi.waitFor(() => expect(popup()).toBeNull());
  await act(async () => trigger?.click());
  expect(popup()).not.toBeNull();
  expect(popup()?.querySelector('[data-testid="context-inspector"]')).toBeNull();
  expect(popup()?.querySelector('[data-overview-widget]')).not.toBeNull();
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
  // The link asks the run page to open its response area.
  expect(JSON.parse(attention?.querySelector('a')?.getAttribute('data-search') ?? '{}')).toEqual(
    expect.objectContaining({ panel: 'run', run: 'run_overview', respond: true }),
  );
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

it('states an estimate without a percentage once: the tokens, then the window as its unit', async () => {
  const base = model();
  const container = await render(
    model({
      context: {
        ...base.context,
        tokens: 2_399,
        windowTokens: 128_000,
        completeness: 'partial',
        percent: null,
        barPercent: null,
      },
    }),
  );
  const figure = container.querySelector(
    '[data-overview-widget="context"] [data-slot="card-content"] p:not(.sr-only)',
  );
  expect(figure?.textContent).toBe('2.4k/ 128k');
  expect(figure?.textContent).not.toMatch(/2\.4k.*2\.4k/);
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
  expect(agent?.textContent).toContain('Working · Waiting for a reply');
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

it('names no run scope while the last run is shown', async () => {
  const container = await render(model());
  expect(container.querySelector('[data-testid="overview-run-scope"]')).toBeNull();
  const live = await render(model({ live: true, viewed: null, runNumber: 2 } as never));
  expect(live.querySelector('[data-testid="overview-run-scope"]')).toBeNull();
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

it('hides widgets with nothing to say', async () => {
  const projection = emptyProjection('run_overview');
  projection.status = 'succeeded';
  projection.modelCalls.only = {
    modelCallId: 'only',
    executionId: 'exec',
    finished: true,
    usage: { outputTokens: 120 },
  } as never;
  const container = await render(
    model({ chips: [], results: [], usage: usageSummary(projection) }),
  );
  expect(widgets(container)).toEqual(['usage']);
  expect(container.textContent).toContain('1 model call');
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
    '[data-overview-widget="usage"] button[aria-label="Open Usage details"]',
  );
  await act(async () => trigger?.click());
  const detail = document.querySelector('[data-testid="usage-detail"]')?.textContent ?? '';
  expect(detail).toContain('Reported input tokens');
  expect(detail).toContain('3,500');
  expect(detail).toContain('Cached input');
  expect(detail).toContain('1,500 (50%)');
  expect(detail).toContain('2 calls did not report cached input');
  // The row names say what each figure is; no paragraph defines them again.
  expect(detail).not.toContain('This run:');
  expect(detail).not.toContain('not extra tokens');
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
    '[data-overview-widget="usage"] button[aria-label="Open Usage details"]',
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
    container
      .querySelector<HTMLElement>(
        '[data-overview-widget="usage"] button[aria-label="Open Usage details"]',
      )
      ?.click(),
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

it('the context detail compacts the live execution it is showing', async () => {
  const request = vi.fn(async () => null);
  const container = await render(
    model({
      compaction: { reason: null, phase: null, pending: false, request },
    } as Partial<ChatWidgetModel>),
    (value) => <ContextDetail model={value} />,
  );
  const button = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(messages.RunStatus.compactRequest),
  );
  expect(button).toBeDefined();
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  expect(request).toHaveBeenCalledTimes(1);
});

it('the context detail says why and does not compact without a running execution', async () => {
  const request = vi.fn(async () => null);
  const container = await render(
    model({
      compaction: { reason: 'compactNoExecution', phase: null, pending: false, request },
    } as Partial<ChatWidgetModel>),
    (value) => <ContextDetail model={value} />,
  );
  expect(container.textContent).toContain(
    'No execution is still running, so compaction was not sent.',
  );
  expect(
    [...container.querySelectorAll('button')].some((node) =>
      node.textContent?.includes(messages.RunStatus.compactRequest),
    ),
  ).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
