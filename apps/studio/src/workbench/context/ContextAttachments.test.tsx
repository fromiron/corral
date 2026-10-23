// @vitest-environment jsdom
import type { TextAttachment } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContextAttachments, type ContextSourceStatus } from './ContextAttachments.tsx';

vi.mock('use-intl', () => ({
  useTranslations: () => (key: string, values?: { name?: string }) =>
    values?.name ? `${key}:${values.name}` : key,
}));
const capture = (name: string, text: string) =>
  createTextAttachment(name, 'text/plain', text, {
    kind: 'check',
    hostId: 'host',
    projectId: 'project',
    sessionId: 'session',
    verificationId: 'check',
    commandId: 'test',
    tree: 'a'.repeat(40),
  });
const cleanups: (() => Promise<void>)[] = [];
function pendingCapture() {
  let resolve = (_value: TextAttachment | null) => {};
  const promise = new Promise<TextAttachment | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function fixture(
  initial: TextAttachment[],
  replace: (item: TextAttachment) => Promise<TextAttachment | null>,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let value = initial;
  const inspect = vi.fn(async (): Promise<ContextSourceStatus> => ({ state: 'stale' }));
  const open = vi.fn<() => Promise<void>>(async () => {});
  const onChange = vi.fn((next: TextAttachment[]) => {
    value = next;
    render();
  });
  const render = () =>
    root.render(
      <ContextAttachments
        value={value}
        onChange={onChange}
        inspect={inspect}
        onOpen={open}
        onReplace={replace}
      />,
    );
  await act(async () => render());
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const row = (name: string) =>
    [...container.querySelectorAll('li')].find((item) =>
      item.querySelector('summary')?.textContent?.includes(name),
    );
  const button = (name: string, action: string) =>
    [...(row(name)?.querySelectorAll('button') ?? [])].find(
      (item) => item.textContent === action || item.getAttribute('aria-label') === action,
    );
  return {
    container,
    onChange,
    inspect,
    open,
    row,
    button,
    expand: async (name: string) => {
      await act(async () => row(name)?.querySelector('summary')?.click());
      expect(row(name)?.querySelector('details')?.open).toBe(true);
    },
    value: () => value,
    update: async (next: TextAttachment[]) => {
      value = next;
      await act(async () => render());
    },
  };
}

it('[TC-WBD-007-H] previews the immutable escaped capture and exposes unavailable source without changing it', async () => {
  const item = capture('selection.txt', '<img src=x onerror=alert(1)> saved capture');
  const legacy = createTextAttachment('notes.txt', 'text/plain', 'legacy body');
  const f = await fixture([item, legacy], async () => null);
  expect(f.row(item.name)?.querySelector('pre')?.textContent).toBe(item.text);
  expect(f.container.querySelector('img')).toBeNull();
  expect(f.row(item.name)?.textContent).toContain('stale');
  expect(f.row(legacy.name)?.querySelector('pre')?.textContent).toBe('legacy body');
  expect(f.button(legacy.name, 'replaceCapture')).toBeUndefined();
  const details = f.row(item.name)?.querySelector('details');
  expect(details?.open).toBe(false);
  expect(details?.contains(f.button(item.name, 'replaceCapture') ?? null)).toBe(true);
  expect(
    details
      ?.querySelector('summary')
      ?.contains(f.row(item.name)?.querySelector('[role="status"]') ?? null),
  ).toBe(true);
  expect(details?.contains(f.button(item.name, `removeCapture:${item.name}`) ?? null)).toBe(false);
  await f.expand(item.name);
  f.open.mockRejectedValueOnce(new Error('gone'));
  await act(async () => f.button(item.name, 'openSource')?.click());
  expect(f.row(item.name)?.textContent).toContain('unavailable');
  expect(f.row(item.name)?.querySelector('pre')?.textContent).toBe(item.text);
  expect(f.onChange).not.toHaveBeenCalled();
});

it('[TC-WBD-007-F] deleting a capture while replacement waits never resurrects it', async () => {
  const original = capture('first.txt', 'first');
  const other = capture('second.txt', 'second');
  const pending = pendingCapture();
  const f = await fixture([original, other], () => pending.promise);
  await f.expand(original.name);
  await act(async () => f.button(original.name, 'replaceCapture')?.click());
  await act(async () => f.button(original.name, `removeCapture:${original.name}`)?.click());
  await act(async () => pending.resolve(capture('replacement.txt', 'fresh')));
  expect(f.value()).toEqual([other]);
  expect(f.onChange).toHaveBeenCalledTimes(1);
});

it('[TC-WBD-007-N] replacement preserves current order and unrelated additions and rejects invalid content', async () => {
  const original = capture('first.txt', 'first');
  const other = capture('second.txt', 'second');
  const added = capture('third.txt', 'third');
  const replacement = capture('replacement.txt', 'fresh');
  const pending = pendingCapture();
  const replace = vi.fn(async () => pending.promise);
  const f = await fixture([original, other], replace);
  await f.expand(original.name);
  await act(async () => f.button(original.name, 'replaceCapture')?.click());
  await f.update([other, original, added]);
  await act(async () => pending.resolve(replacement));
  expect(f.value()).toEqual([other, replacement, added]);
  await f.expand(replacement.name);
  replace.mockResolvedValueOnce({ ...replacement, sha256: 'f'.repeat(64) });
  await act(async () => f.button(replacement.name, 'replaceCapture')?.click());
  expect(f.value()).toEqual([other, replacement, added]);
  expect(f.row(replacement.name)?.textContent).toContain('replacementFailed');
});

it('[TC-WBD-013-H] shows that a source is intact apart from whether it still applies', async () => {
  const item = capture('check.txt', 'output');
  const f = await fixture([item], async () => null);
  const status = () => f.row(item.name)?.querySelector('[role="status"]');
  f.inspect.mockResolvedValue({ state: 'current', applies: 'yes' });
  await f.expand(item.name);
  await act(async () => f.button(item.name, 'openSource')?.click());
  expect(status()?.textContent).toBe('current');
  expect(status()?.className).toContain('text-muted');
  f.inspect.mockResolvedValue({ state: 'current', applies: 'config_changed' });
  await act(async () => f.button(item.name, 'openSource')?.click());
  expect(status()?.textContent).toBe('current · applies.config_changed');
  expect(status()?.className).toContain('text-warning');
});
