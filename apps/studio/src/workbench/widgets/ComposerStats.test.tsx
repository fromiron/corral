// @vitest-environment jsdom
import type { RunProjection, RunSummary } from '@corral/core';
import { emptyProjection } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ComposerStats } from './ComposerStats.tsx';

const { snapshots, services } = vi.hoisted(() => {
  const snapshots = new Map<string, unknown>();
  // One transport for every render, as the app's services are.
  const services = {
    transport: { getSnapshot: async (runId: string) => ({ projection: snapshots.get(runId) }) },
  };
  return { snapshots, services };
});
vi.mock('../../services.tsx', () => ({ useServices: () => services }));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  snapshots.clear();
  vi.unstubAllGlobals();
});

function run(runId: string, input: number, output: number): RunSummary {
  const projection: RunProjection = { ...emptyProjection(runId), status: 'succeeded' };
  projection.modelCalls.call = {
    modelCallId: 'call',
    executionId: 'exec',
    finished: true,
    usage: { inputTokens: input, outputTokens: output, cachedInputTokens: null },
  } as never;
  snapshots.set(runId, projection);
  return { runId, status: 'succeeded' } as RunSummary;
}

it('names each figure so it needs no definition, and opens nothing', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
        <ComposerStats runs={[run('one', 1_000, 200), run('two', 1_000, 300)]} />
      </IntlProvider>,
    ),
  );
  const stats = container.querySelector('[data-testid="composer-stats"]');
  expect(stats?.textContent).toBe(
    'Session total · 2 runs · 0 tool and agent steps · 2.5K reported in/out tokens · cache not reported',
  );
  // A line of figures, not a disclosure with a paragraph of definitions behind it.
  expect(container.querySelector('details, summary')).toBeNull();
  expect(container.textContent).not.toMatch(/Turns are runs|not model calls/);
});
