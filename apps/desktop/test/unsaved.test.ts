import { afterEach, expect, it, vi } from 'vitest';
import { hasWindowUnsavedEdits } from '../src/unsaved.ts';

const windowAt = (url: string, probe = vi.fn(async () => false)) => ({
  isDestroyed: () => false,
  webContents: { getURL: () => url, executeJavaScript: probe },
});
afterEach(() => vi.useRealTimers());

it('[TC-ABS-007-N] ignores an unloaded native preview parent but probes loaded Studio, remote and manager windows', async () => {
  const unloaded = windowAt('');
  const blank = windowAt('about:blank');
  const studio = windowAt('http://127.0.0.1:1234/sessions/session_1');
  const remote = windowAt('http://127.0.0.1:4567/sessions/session_2');
  const manager = windowAt('corral://hosts/');
  expect(await hasWindowUnsavedEdits([unloaded, blank, studio, remote, manager])).toBe(false);
  expect(unloaded.webContents.executeJavaScript).not.toHaveBeenCalled();
  expect(blank.webContents.executeJavaScript).not.toHaveBeenCalled();
  for (const window of [studio, remote, manager])
    expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce();
});

it('[TC-ABS-007-N] a hung renderer is treated as unsaved after a bounded wait', async () => {
  vi.useFakeTimers();
  const hung = windowAt(
    'http://127.0.0.1:1234/',
    vi.fn(() => new Promise<boolean>(() => {})),
  );
  const result = hasWindowUnsavedEdits([hung]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('[TC-ABS-007-H] completed probes retain the real dirty result and cancel the timeout', async () => {
  vi.useFakeTimers();
  expect(
    await hasWindowUnsavedEdits([
      windowAt(
        'corral://hosts/',
        vi.fn(async () => true),
      ),
    ]),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(
    await hasWindowUnsavedEdits([
      windowAt(
        'corral://startup/',
        vi.fn(async () => {
          throw new Error('renderer gone');
        }),
      ),
    ]),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
