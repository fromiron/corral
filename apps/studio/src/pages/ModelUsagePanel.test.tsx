// @vitest-environment jsdom
import type { ModelAttempt } from '@corral/contracts';
import { DesignKitProvider } from '@corral/react/design-kit';
import { act, type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ModelUsagePanel } from './ModelUsagePanel.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));

afterEach(() => vi.unstubAllGlobals());

function row(
  id: string,
  patch: {
    provider?: string;
    modelId?: string;
    startedAt?: string;
    input?: number | null;
    output?: number | null;
    cache?: number | null;
    costStatus?: ModelAttempt['usage']['costStatus'];
    costUsd?: number | null;
    reasoning?: number | null;
    cacheWrite?: number | null;
  } = {},
): ModelAttempt {
  return {
    version: 2,
    attemptId: id,
    intent: { requestId: id, purpose: 'draft', revision: 0, owner: { kind: 'draft', id } },
    provider: patch.provider ?? 'fixture',
    modelId: patch.modelId ?? 'fixture',
    status: 'completed',
    startedAt: patch.startedAt ?? '2026-10-24T00:00:00Z',
    endedAt: '2026-10-24T00:00:01Z',
    payloadHash: null,
    payloadBytes: null,
    firstEventAt: null,
    failure: null,
    usage: {
      version: 2,
      inputTokens: patch.input === undefined ? null : patch.input,
      outputTokens: patch.output === undefined ? 0 : patch.output,
      reasoningTokens: patch.reasoning === undefined ? null : patch.reasoning,
      cacheReadTokens: patch.cache === undefined ? null : patch.cache,
      cacheWriteTokens: patch.cacheWrite === undefined ? null : patch.cacheWrite,
      source: 'reported',
      costStatus: patch.costStatus ?? 'reported',
      costUsd: patch.costUsd === undefined ? 0 : patch.costUsd,
    },
  };
}

async function mount(node: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: ReactNode) => {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          {next}
        </IntlProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  };
  await render(node);
  return {
    container,
    render,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, text: string) {
  return [...container.querySelectorAll('button')].find((item) => item.textContent === text);
}

async function press(container: HTMLElement, text: string) {
  const found = button(container, text);
  if (!found) throw new Error(`missing button: ${text}`);
  await act(async () => {
    found.click();
  });
}

it('loads the first bounded page when shown and keeps subscription, unknown and reported zero apart', async () => {
  const requests = vi
    .fn()
    .mockResolvedValueOnce({
      items: [
        row('subscription', { costStatus: 'subscription', costUsd: null }),
        row('unknown', { costStatus: 'unknown', costUsd: null }),
        row('zero', { costStatus: 'reported', costUsd: 0 }),
      ],
      nextCursor: 1,
    })
    .mockRejectedValueOnce(new Error('offline'));
  fixture.services = { models: { requests } };
  const view = await mount(<ModelUsagePanel />);
  try {
    expect(requests).toHaveBeenCalledTimes(1);
    expect(requests).toHaveBeenCalledWith({ limit: 50 }, expect.any(AbortSignal));
    expect(view.container.textContent).toContain('Subscription');
    expect(view.container.textContent).toContain('Unknown');
    expect(view.container.textContent).toContain('Reported $0.00');
    expect(view.container.querySelectorAll('tbody tr')).toHaveLength(3);
    const chart = view.container.querySelector('[data-usage-chart]');
    expect(chart?.querySelector('[data-series="cost"]')).toBeNull();
    expect(chart?.textContent).toContain('Subscription');
    expect(chart?.textContent).toContain('Unknown price');
    expect(chart?.textContent).toContain('Reported $0.00');
    expect(chart?.textContent).not.toContain('Estimated');
    expect(chart?.querySelector('[data-series="input"][data-tokens]')).toBeNull();
    expect(chart?.querySelector('[data-series="input"][data-mark="unknown"]')).not.toBeNull();
    expect(
      chart?.querySelector('[data-series="output"][data-mark="zero"]')?.getAttribute('data-tokens'),
    ).toBe('0');
    await press(view.container, 'Refresh');
    expect(requests).toHaveBeenLastCalledWith({ limit: 50 }, expect.any(AbortSignal));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
    expect(view.container.querySelectorAll('tbody tr')).toHaveLength(3);
  } finally {
    await view.unmount();
  }
});

it('charts loaded pages only, and does not draw an unknown token count as zero', async () => {
  const requests = vi
    .fn()
    .mockResolvedValueOnce({
      items: [
        row('a', {
          provider: 'alpha',
          modelId: 'one',
          startedAt: '2026-10-24T00:00:00Z',
          input: 10,
          output: null,
          cache: 0,
          costStatus: 'unknown',
          costUsd: null,
          reasoning: 99999,
          cacheWrite: 99999,
        }),
        row('b', {
          provider: 'alpha',
          modelId: 'one',
          startedAt: '2026-10-24T01:00:00Z',
          input: null,
          output: 4,
          cache: 0,
          costStatus: 'reported',
          costUsd: 0,
        }),
        row('e', {
          provider: 'gamma',
          modelId: 'lone',
          startedAt: '2026-10-24T02:00:00Z',
          input: null,
          output: null,
          cache: null,
          costStatus: 'subscription',
          costUsd: null,
        }),
      ],
      nextCursor: 7,
    })
    .mockResolvedValueOnce({
      items: [
        row('d', {
          provider: 'beta',
          modelId: 'two',
          startedAt: '2026-10-24T03:00:00Z',
          input: 0,
          output: 0,
          cache: 0,
          costStatus: 'estimated',
          costUsd: 0,
        }),
      ],
      nextCursor: null,
    });
  fixture.services = { models: { requests } };
  const view = await mount(<ModelUsagePanel />);
  try {
    expect(requests).toHaveBeenCalledTimes(1);
    expect(requests.mock.calls[0]?.[0]).toEqual({ limit: 50 });
    const chart = () => view.container.querySelector('[data-usage-chart]');
    expect(chart()?.textContent).toContain('3 loaded requests, 2 models');
    expect(chart()?.textContent).toContain('3 requests have an unknown token count');
    expect(
      chart()?.querySelectorAll('ul[aria-label="Token totals by model"] > [data-model-summary]'),
    ).toHaveLength(2);
    const alpha = chart()?.querySelector('[data-model-summary="alpha · one"]');
    expect(alpha?.textContent).toContain('10 · unknown 1');
    expect(alpha?.textContent).toContain('Input tokens, solid');
    expect(
      chart()
        ?.querySelector('[data-series="input"][data-model="alpha · one"][data-tokens="10"]')
        ?.getAttribute('data-mark'),
    ).toBeNull();
    expect(
      chart()
        ?.querySelector('[data-series="input"][data-model="alpha · one"][data-mark="unknown"]')
        ?.getAttribute('data-excluded'),
    ).toBe('1');
    expect(
      chart()
        ?.querySelector('[data-series="cache"][data-model="alpha · one"][data-mark="zero"]')
        ?.getAttribute('data-tokens'),
    ).toBe('0');
    expect(
      chart()?.querySelector(
        '[data-series="cache"][data-model="alpha · one"][data-mark="unknown"]',
      ),
    ).toBeNull();
    expect(chart()?.querySelector('[data-model="gamma · lone"][data-tokens]')).toBeNull();
    expect(
      chart()?.querySelectorAll('[data-model="gamma · lone"][data-mark="unknown"]'),
    ).toHaveLength(3);
    expect(chart()?.querySelector('[data-request="e"]')).not.toBeNull();
    expect(Number(chart()?.querySelector('[data-request="a"]')?.getAttribute('cx'))).toBeLessThan(
      Number(chart()?.querySelector('[data-request="e"]')?.getAttribute('cx')),
    );
    expect(view.container.textContent).not.toContain('99999');
    expect(view.container.textContent).not.toContain('99,999');
    const cost = chart()?.querySelector('[data-cost-summary]');
    expect(cost?.textContent).toContain('Unknown price');
    expect(cost?.textContent).toContain('Reported $0.00');
    expect(cost?.textContent).toContain('Subscription');
    expect(cost?.textContent).not.toContain('Estimated');
    expect(chart()?.querySelector('[data-series="cost"]')).toBeNull();

    await press(view.container, 'Load older requests');
    expect(requests).toHaveBeenCalledTimes(2);
    expect(requests).toHaveBeenLastCalledWith({ before: 7, limit: 50 }, expect.any(AbortSignal));
    expect(chart()?.textContent).toContain('4 loaded requests, 3 models');
    expect(chart()?.querySelector('[data-model-summary="beta · two"]')).not.toBeNull();
    expect(chart()?.textContent).toContain('Estimated $0.00');
    expect(Number(chart()?.querySelector('[data-request="e"]')?.getAttribute('cx'))).toBeLessThan(
      Number(chart()?.querySelector('[data-request="d"]')?.getAttribute('cx')),
    );
  } finally {
    await view.unmount();
  }
});

it('does not read history until the usage tab is selected, and does not reread it on return', async () => {
  const requests = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  fixture.services = { models: { requests } };
  const view = await mount(<ModelUsagePanel active={false} />);
  try {
    expect(requests).not.toHaveBeenCalled();
    await view.render(<ModelUsagePanel active />);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(requests).toHaveBeenCalledWith({ limit: 50 }, expect.any(AbortSignal));
    await view.render(<ModelUsagePanel active={false} />);
    await view.render(<ModelUsagePanel active />);
    expect(requests).toHaveBeenCalledTimes(1);
  } finally {
    await view.unmount();
  }
});

it('still shows the first page when it mounts already selected under StrictMode', async () => {
  const requests = vi.fn().mockResolvedValue({ items: [row('first')], nextCursor: null });
  fixture.services = { models: { requests } };
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    // StrictMode must wrap the root (as main.tsx does) for React to replay mount effects.
    await act(async () => {
      root.render(
        <StrictMode>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <ModelUsagePanel active />
          </IntlProvider>
        </StrictMode>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The replayed cleanup aborts the first read; the replayed effect reads again.
    const signals = requests.mock.calls.map(([, signal]) => signal as AbortSignal);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('shows the same chart values when motion is reduced', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }));
  const requests = vi.fn().mockResolvedValue({
    items: [
      row('still', {
        provider: 'alpha',
        modelId: 'one',
        input: 4,
        output: 2,
        cache: 1,
        costStatus: 'reported',
        costUsd: 1,
      }),
    ],
    nextCursor: null,
  });
  fixture.services = { models: { requests } };
  const view = await mount(<ModelUsagePanel />);
  try {
    const chart = view.container.querySelector('[data-usage-chart]');
    expect(chart?.getAttribute('data-motion')).toBe('reduced');
    expect(chart?.querySelector('animate, animateTransform, animateMotion')).toBeNull();
    expect(
      chart
        ?.querySelector('[data-series="input"][data-model="alpha · one"]')
        ?.getAttribute('data-tokens'),
    ).toBe('4');
  } finally {
    await view.unmount();
  }
});

it('follows compact density for the chart text', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }));
  const requests = vi.fn().mockResolvedValue({
    items: [row('dense', { provider: 'alpha', modelId: 'one', input: 1, output: 1, cache: 1 })],
    nextCursor: null,
  });
  fixture.services = { models: { requests } };
  const view = await mount(
    <DesignKitProvider size="compact">
      <ModelUsagePanel />
    </DesignKitProvider>,
  );
  try {
    const chart = view.container.querySelector('[data-usage-chart]');
    expect(chart?.getAttribute('data-density')).toBe('compact');
    expect(chart?.className).toContain('--fs-caption-compact');
    expect(chart?.getAttribute('data-motion')).toBe('static');
  } finally {
    await view.unmount();
  }
});
