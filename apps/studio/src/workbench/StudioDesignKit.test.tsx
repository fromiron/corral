// @vitest-environment jsdom
import { useSize } from '@corral/react/design-kit';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  changePreferences,
  PREFERENCES_KEY,
  parsePreferences,
  preferences,
} from './preferences.ts';
import { StudioDesignKit } from './StudioDesignKit.tsx';

function Probe() {
  return <span data-testid="size">{useSize().variant}</span>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  preferences.setState(parsePreferences(null));
});

it('reads only a known interface density and defaults anything else', () => {
  expect(parsePreferences('{"version":1}').density).toBe('default');
  expect(parsePreferences('{"version":1,"density":"compact"}').density).toBe('compact');
  expect(parsePreferences('{"version":1,"density":"tiny"}').density).toBe('default');
});

it('applies the interface density to the whole kit at once and keeps it for the next load', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <StudioDesignKit>
          <Probe />
        </StudioDesignKit>,
      ),
    );
    const size = () => container.querySelector('[data-testid="size"]')?.textContent;
    expect(size()).toBe('default');
    await act(async () => changePreferences({ density: 'compact' }));
    expect(size()).toBe('compact');
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null).density).toBe('compact');
    await act(async () => changePreferences({ density: 'default' }));
    expect(size()).toBe('default');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
