// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { watchRefresh } from './refresh.ts';

afterEach(() => vi.useRealTimers());

it('discovers background changes and retries on focus/online without overlapping reads', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const read = vi.fn(
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const watcher = watchRefresh(read, 1500);
  expect(read).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(4500);
  expect(read).toHaveBeenCalledTimes(1);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  window.dispatchEvent(new Event('online'));
  expect(read).toHaveBeenCalledTimes(2);
  finish();
  await vi.advanceTimersByTimeAsync(1500);
  expect(read).toHaveBeenCalledTimes(3);
  watcher.dispose();
  finish();
});

it('ignores a late read after disposal and removes wake-up listeners', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const apply = vi.fn();
  const read = vi.fn(async (current: () => boolean) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (current()) apply();
  });
  const watcher = watchRefresh(read, 1500);
  watcher.dispose();
  finish();
  await vi.advanceTimersByTimeAsync(3000);
  window.dispatchEvent(new Event('online'));
  window.dispatchEvent(new Event('focus'));
  watcher.refresh();
  expect(read).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
});

it('a tick that lands while a slow read is out is dropped: the next read starts at the next tick after it', async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const read = vi.fn(async () => {
    starts.push(Date.now());
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  });
  const begun = Date.now();
  const watcher = watchRefresh(read, 1500);
  await vi.advanceTimersByTimeAsync(6500);
  watcher.dispose();
  expect(starts.map((at) => at - begun)).toEqual([0, 3000, 6000]);
});

it('an ask while a read is out is served once after it, also when that read fails, and the next ask makes one read', async () => {
  vi.useFakeTimers();
  const answers: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const read = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        answers.push({ resolve, reject });
      }),
  );
  const watcher = watchRefresh(read, 60_000);
  expect(read).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event('focus'));
  answers[0]?.reject(new Error('unreachable'));
  await vi.advanceTimersByTimeAsync(0);
  // The ask made while the failed read was out is served.
  expect(read).toHaveBeenCalledTimes(2);
  answers[1]?.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);

  window.dispatchEvent(new Event('online'));
  expect(read).toHaveBeenCalledTimes(3);
  answers[2]?.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(3);
  watcher.dispose();
});
