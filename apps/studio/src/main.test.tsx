// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

// The first render already carries the saved theme: main applies it before React renders.
const seen = vi.hoisted(() => ({ atRender: [] as { surface: string; dark: boolean }[] }));
vi.mock('react-dom/client', () => ({
  createRoot: () => ({
    render: () =>
      seen.atRender.push({
        surface: document.documentElement.style.getPropertyValue('--surface-1'),
        dark: document.documentElement.classList.contains('dark'),
      }),
  }),
}));
vi.mock('./services.tsx', () => ({
  createStudioServices: async () => ({ sessionMissing: false, disposeRuns: () => {} }),
  ServicesProvider: () => null,
}));
vi.mock('./router.tsx', () => ({ createStudioRouter: () => ({}) }));
vi.mock('./pages/RootLayout.tsx', () => ({ SessionMissingView: () => null }));
vi.mock('./pages/StartupFailure.tsx', () => ({ StartupFailure: () => null }));
vi.mock('./locale.tsx', () => ({ LocaleProvider: () => null }));
vi.mock('./workbench/StudioDesignKit.tsx', () => ({ StudioDesignKit: () => null }));
vi.mock('./desktop.tsx', () => ({ desktop: undefined }));
vi.mock('@tanstack/react-router', () => ({ RouterProvider: () => null }));

afterEach(() => vi.unstubAllGlobals());

it('paints the saved named theme on the root before the first render', async () => {
  const stored = new Map([
    [
      'corral:workbench:v1',
      JSON.stringify({ version: 1, theme: 'dark', palette: 'builtin:monokai' }),
    ],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  document.body.innerHTML = '<div id="root"></div>';
  await import('./main.tsx');
  expect(seen.atRender).toEqual([{ surface: '#272822', dark: true }]);
});
