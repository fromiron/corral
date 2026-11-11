// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { type HunkNavigation, HunkNavigator } from './HunkNavigator.tsx';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(count = 3) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const reveal = vi.fn();
  const navigation = createRef<HunkNavigation>();
  const hunks = Array.from({ length: count }, (_, i) => ({
    label: `@@ -${i * 10 + 1},3 +${i * 10 + 1},4 @@`,
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <HunkNavigator hunks={hunks} onReveal={reveal} navigation={navigation} />
      </IntlProvider>,
    ),
  );
  const header = () => container.querySelector<HTMLElement>('[data-testid="hunk-header"]');
  const button = (name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  return { container, reveal, navigation, header, button };
}

it('moves focus to each change header in order and stops at the last one', async () => {
  const view = await mount();
  expect(view.header()?.textContent).toContain('3 changes');
  for (const [index, line] of [1, 11, 21].entries()) {
    let moved = false;
    await act(async () => {
      moved = view.navigation.current?.move(1) ?? false;
    });
    expect(moved).toBe(true);
    expect(document.activeElement).toBe(view.header());
    expect(view.header()?.textContent).toContain(`Change ${index + 1} of 3`);
    expect(view.header()?.textContent).toContain(`@@ -${line},3 +${line},4 @@`);
    expect(view.reveal).toHaveBeenLastCalledWith(index);
  }
  expect(view.button('Next change')?.disabled).toBe(true);
  let moved = true;
  await act(async () => {
    moved = view.navigation.current?.move(1) ?? true;
  });
  expect(moved).toBe(false);
  expect(view.header()?.textContent).toContain('Change 3 of 3');
  expect(view.reveal).toHaveBeenCalledTimes(3);
});

it('goes back with the visible button and stops at the first change', async () => {
  const view = await mount();
  await act(async () => view.button('Previous change')?.click());
  expect(view.header()?.textContent).toContain('Change 3 of 3');
  expect(document.activeElement).toBe(view.header());
  await act(async () => view.button('Previous change')?.click());
  await act(async () => view.button('Previous change')?.click());
  expect(view.header()?.textContent).toContain('Change 1 of 3');
  expect(view.button('Previous change')?.disabled).toBe(true);
  expect(view.button('Previous change')?.getAttribute('aria-keyshortcuts')).toBe('[');
  expect(view.button('Next change')?.getAttribute('aria-keyshortcuts')).toBe(']');
});

it('has nothing to move to in a diff without changes', async () => {
  const view = await mount(0);
  expect(view.navigation.current?.move(1)).toBe(false);
  expect(view.button('Next change')?.disabled).toBe(true);
  expect(view.button('Previous change')?.disabled).toBe(true);
});
