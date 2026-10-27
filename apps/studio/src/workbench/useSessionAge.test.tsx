// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionAge } from './useSessionAge.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('shows just now for a new session and advances without changing its timestamp', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  const stamp = new Date('2026-10-28T00:00:00Z');
  vi.useFakeTimers({ now: new Date(stamp.getTime() + 26_000) });
  function Age() {
    const age = useSessionAge();
    return <span>{age(stamp.toISOString())}</span>;
  }
  const render = (elapsed: number) =>
    act(async () =>
      root.render(
        <IntlProvider
          locale="en"
          now={new Date(stamp.getTime() + elapsed)}
          messages={{ Sessions: { justNow: 'Just now' } }}
        >
          <Age />
        </IntlProvider>,
      ),
    );
  try {
    await render(26_000);
    expect(container.textContent).toBe('Just now');
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(container.textContent).toBe('1 minute ago');
  } finally {
    await act(async () => root.unmount());
  }
});
