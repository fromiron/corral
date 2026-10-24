// @vitest-environment jsdom
import type { ModelAttempt } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ModelUsagePanel } from './ModelUsagePanel.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
it('[TC-LLM-002-H] loads bounded history on demand and distinguishes subscription, unknown and reported zero cost', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const row = (
    id: string,
    costStatus: ModelAttempt['usage']['costStatus'],
    costUsd: number | null,
  ): ModelAttempt => ({
    version: 2,
    attemptId: id,
    intent: { requestId: id, purpose: 'draft', revision: 0, owner: { kind: 'draft', id } },
    provider: 'fixture',
    modelId: 'fixture',
    status: 'completed',
    startedAt: '2026-10-24T00:00:00Z',
    endedAt: '2026-10-24T00:00:01Z',
    payloadHash: null,
    payloadBytes: null,
    firstEventAt: null,
    failure: null,
    usage: {
      version: 2,
      inputTokens: null,
      outputTokens: 0,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      source: 'reported',
      costStatus,
      costUsd,
    },
  });
  const requests = vi
    .fn()
    .mockResolvedValueOnce({
      items: [
        row('subscription', 'subscription', null),
        row('unknown', 'unknown', null),
        row('zero', 'reported', 0),
      ],
      nextCursor: 1,
    })
    .mockRejectedValueOnce(new Error('offline'));
  fixture.services = { models: { requests } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ModelUsagePanel />
        </IntlProvider>,
      ),
    );
    expect(requests).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')!.click());
    expect(requests).toHaveBeenCalledWith({ limit: 50 }, expect.any(AbortSignal));
    expect(container.textContent).toContain('Subscription');
    expect(container.textContent).toContain('Unknown');
    expect(container.textContent).toContain('Reported $0.00');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
