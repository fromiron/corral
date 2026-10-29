// @vitest-environment jsdom
import type { RunSummary } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionRuns } from './useSessionRuns.ts';

const fixture = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getSession: vi.fn(),
  invalidate: vi.fn(async () => {}),
}));
const services = {
  transport: { listRuns: fixture.listRuns },
  repository: { getSession: fixture.getSession },
};
const router = { invalidate: fixture.invalidate };
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => router }));
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('discovers another tab’s new request from idle and revalidates changed session entries', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let revision = 1;
  let runs: RunSummary[] = [];
  fixture.listRuns.mockImplementation(async () => runs);
  fixture.getSession.mockImplementation(async () => ({ revision }));
  function View() {
    const value = useSessionRuns('session', undefined, 1);
    return (
      <p>
        {value.runs.map((run) => run.runId).join(',')}:{value.lost ? 'lost' : 'connected'}
      </p>
    );
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(<View />));
  expect(container.textContent).toBe(':connected');
  revision = 2;
  runs = [
    {
      runId: 'remote',
      sessionId: 'session',
      status: 'succeeded',
      startedAt: '2026-10-29T00:00:00Z',
    } as RunSummary,
  ];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(container.textContent).toBe('remote:connected');
  expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  fixture.listRuns.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.textContent).toBe('remote:lost');
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(container.textContent).toBe('remote:connected');
  revision = 3;
  fixture.invalidate.mockRejectedValueOnce(new Error('Loader went offline'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.textContent).toBe('remote:lost');
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(fixture.invalidate).toHaveBeenCalledTimes(3);
  expect(container.textContent).toBe('remote:connected');
});
