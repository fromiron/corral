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
