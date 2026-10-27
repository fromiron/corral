// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GettingStarted } from './GettingStarted.tsx';

vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'browser', live: false, models: null }),
}));
vi.mock('../workbench/useModels.ts', () => ({ useModelProfiles: () => [] }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('does not show results complete in an empty project after reading another project', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.setItem('corral.gettingStarted.reviewed', '1');
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<GettingStarted runs={0} projectId="new-project" />));
    expect(container.querySelector('[data-testid="step-review"]')?.getAttribute('data-done')).toBe(
      'false',
    );
    expect(container.querySelector('[data-testid="step-review"]')?.textContent).not.toContain(
      '(done)',
    );
  } finally {
    await act(async () => root.unmount());
  }
});
