// @vitest-environment jsdom
import type { RunSummary } from '@corral/core';
import { afterEach, expect, it, vi } from 'vitest';
import { watchRunList } from './runList.ts';

type Reader = Parameters<typeof watchRunList>[1];

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
});

function watch(...args: Parameters<typeof watchRunList>) {
  const watcher = watchRunList(...args);
  disposals.push(watcher.dispose);
  return watcher;
}

const tick = () => vi.advanceTimersByTimeAsync(0);
const summary = (runId: string) => [{ runId } as RunSummary];

it('shares one periodic list read across the session and sidebar, including focus and manual refresh', async () => {
  vi.useFakeTimers();
  const transport = { listRuns: vi.fn(async () => summary('initial')) };
  const session = vi.fn<Reader>(async () => {});
  const sidebar = vi.fn<Reader>(async () => {});
  const first = watch(transport, session);
  const second = watch(transport, sidebar);
  await tick();
  expect(transport.listRuns).toHaveBeenCalledTimes(1);
  expect(session).toHaveBeenCalledTimes(1);
  expect(sidebar).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1500);
  expect(transport.listRuns).toHaveBeenCalledTimes(2);
  expect(session.mock.calls.at(-1)?.[0]).toEqual({ runs: summary('initial') });
  window.dispatchEvent(new Event('focus'));
  await tick();
  expect(transport.listRuns).toHaveBeenCalledTimes(3);
  expect(sidebar.mock.calls.at(-1)?.[2]).toBe(true);
  first.dispose();
  second.refresh();
  await tick();
  expect(transport.listRuns).toHaveBeenCalledTimes(4);
  expect(session).toHaveBeenCalledTimes(3);
  second.dispose();
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(transport.listRuns).toHaveBeenCalledTimes(4);
});

it('keeps discovery on one cadence when another consumer mounts between polling ticks', async () => {
  vi.useFakeTimers();
  let runs = summary('initial');
  const transport = { listRuns: vi.fn(async () => runs) };
  const session = vi.fn<Reader>(async () => {});
  watch(transport, session);
  await vi.advanceTimersByTimeAsync(1000);
  const sidebar = vi.fn<Reader>(async () => {});
  watch(transport, sidebar);
  await tick();
  expect(sidebar.mock.calls.at(-1)?.[0]).toEqual({ runs: summary('initial') });
  expect(transport.listRuns).toHaveBeenCalledTimes(1);
  runs = summary('remote');
  await vi.advanceTimersByTimeAsync(500);
  expect(transport.listRuns).toHaveBeenCalledTimes(2);
  expect(session.mock.calls.at(-1)?.[0]).toEqual({ runs });
  expect(sidebar.mock.calls.at(-1)?.[0]).toEqual({ runs });
});

it('never overlaps list requests and fences each disposed consumer independently', async () => {
  vi.useFakeTimers();
  let resolve!: (runs: RunSummary[]) => void;
  const transport = {
    listRuns: vi.fn(() => new Promise<RunSummary[]>((done) => (resolve = done))),
  };
  const first = vi.fn<Reader>(async () => {});
  const second = vi.fn<Reader>(async () => {});
  const removed = watch(transport, first);
  watch(transport, second);
  removed.dispose();
  await vi.advanceTimersByTimeAsync(4500);
  window.dispatchEvent(new Event('online'));
  expect(transport.listRuns).toHaveBeenCalledTimes(1);
  resolve(summary('remote'));
  await tick();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

it('isolates transports and retries a failed list without caching failure as success', async () => {
  vi.useFakeTimers();
  const failure = new Error('offline');
  const first = {
    listRuns: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(summary('a')),
  };
  const second = { listRuns: vi.fn(async () => summary('b')) };
  const a = vi.fn<Reader>(async () => {});
  const b = vi.fn<Reader>(async () => {});
  watch(first, a);
  watch(second, b);
  await tick();
  expect(a.mock.calls.at(-1)?.[0]).toEqual({ error: failure });
  expect(b.mock.calls.at(-1)?.[0]).toEqual({ runs: summary('b') });
  window.dispatchEvent(new Event('online'));
  await tick();
  expect(a.mock.calls.at(-1)?.[0]).toEqual({ runs: summary('a') });
  expect(first.listRuns).toHaveBeenCalledTimes(2);
  expect(second.listRuns).toHaveBeenCalledTimes(2);
});

it('does not let a slow consumer block list discovery and applies only its latest pending read', async () => {
  vi.useFakeTimers();
  let runs = summary('initial');
  const transport = { listRuns: vi.fn(async () => runs) };
  let finish!: () => void;
  const applied: string[] = [];
  const slow = vi.fn<Reader>(async (result, current) => {
    if (slow.mock.calls.length === 1) await new Promise<void>((done) => (finish = done));
    if (current() && 'runs' in result) applied.push(result.runs.map((run) => run.runId).join(','));
  });
  const fast = vi.fn<Reader>(async () => {});
  const slowWatcher = watch(transport, slow);
  watch(transport, fast);
  await tick();
  runs = summary('middle');
  await vi.advanceTimersByTimeAsync(1500);
  runs = summary('latest');
  await vi.advanceTimersByTimeAsync(1500);
  expect(slow).toHaveBeenCalledTimes(1);
  expect(fast.mock.calls.at(-1)?.[0]).toEqual({ runs });
  finish();
  await tick();
  expect(applied).toEqual(['initial', 'latest']);
  expect(slow).toHaveBeenCalledTimes(2);
  slowWatcher.dispose();
});

it('drops a disposed consumer’s late result and queued snapshot without stopping the remaining reader', async () => {
  vi.useFakeTimers();
  const transport = { listRuns: vi.fn(async () => summary('remote')) };
  let finish!: () => void;
  const apply = vi.fn();
  const slow = vi.fn<Reader>(async (_, current) => {
    await new Promise<void>((done) => (finish = done));
    if (current()) apply();
  });
  const removed = watch(transport, slow);
  const remaining = vi.fn<Reader>(async () => {});
  watch(transport, remaining);
  await vi.advanceTimersByTimeAsync(1500);
  removed.dispose();
  finish();
  await vi.advanceTimersByTimeAsync(1500);
  expect(apply).not.toHaveBeenCalled();
  expect(slow).toHaveBeenCalledTimes(1);
  expect(remaining).toHaveBeenCalledTimes(3);
});

it('continues discovery and consumer updates after a reader throws', async () => {
  vi.useFakeTimers();
  const transport = { listRuns: vi.fn(async () => summary('remote')) };
  const reader = vi.fn<Reader>().mockRejectedValueOnce(new Error('metadata unavailable'));
  reader.mockResolvedValue(undefined);
  const other = vi.fn<Reader>(async () => {});
  watch(transport, reader);
  watch(transport, other);
  await vi.advanceTimersByTimeAsync(1500);
  expect(reader).toHaveBeenCalledTimes(2);
  expect(other).toHaveBeenCalledTimes(2);
  expect(transport.listRuns).toHaveBeenCalledTimes(2);
});

it('ignores completion after the last consumer is removed and starts a fresh owner on remount', async () => {
  vi.useFakeTimers();
  let complete!: (runs: RunSummary[]) => void;
  const transport = {
    listRuns: vi
      .fn()
      .mockImplementationOnce(() => new Promise<RunSummary[]>((done) => (complete = done)))
      .mockResolvedValue(summary('fresh')),
  };
  const old = vi.fn<Reader>(async () => {});
  const previous = watch(transport, old);
  previous.dispose();
  const current = vi.fn<Reader>(async () => {});
  watch(transport, current);
  await tick();
  complete(summary('old'));
  await tick();
  expect(old).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledTimes(1);
  expect(current.mock.calls[0]?.[0]).toEqual({ runs: summary('fresh') });
});
