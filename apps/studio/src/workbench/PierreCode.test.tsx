// @vitest-environment jsdom
import type { FileDiffMetadata } from '@pierre/diffs';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DiffCode, SourceCode } from './PierreCode.tsx';

const shown = vi.hoisted(() => ({
  views: [] as {
    style?: Record<string, unknown>;
    options: { unsafeCSS?: string; theme?: unknown; themeType?: unknown };
  }[],
  palette: null as object | null,
  pool: { setRenderOptions: vi.fn(async (_options: { theme: unknown }) => {}) },
  registered: [] as { name: string; theme: unknown }[],
}));
vi.mock('@pierre/diffs/worker/worker.js?worker', () => ({ default: class {} }));
vi.mock('@pierre/diffs', () => ({
  registerCustomTheme: (name: string, load: () => Promise<unknown>) =>
    void load().then((theme) => shown.registered.push({ name, theme })),
}));
vi.mock('@pierre/diffs/react', () => ({
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useWorkerPool: () => shown.pool,
  CodeView: (props: (typeof shown.views)[number]) => {
    shown.views.push(props);
    return <div data-testid="code" />;
  },
}));
vi.mock('./preferences.ts', () => ({ usePreferences: () => ({ theme: 'dark' }) }));
vi.mock('./themes/appearance.ts', () => ({ useAppliedPalette: () => shown.palette }));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  shown.views = [];
  shown.palette = null;
  shown.pool.setRenderOptions.mockClear();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(node));
}

it.each([
  [
    'a diff',
    <DiffCode
      key="diff"
      diff={{ name: 'a.ts', hunks: [] } as unknown as FileDiffMetadata}
      layout="unified"
      comments={[]}
    />,
  ],
  ['a source file', <SourceCode key="source" path="a.ts" text="x" onSelect={() => {}} />],
])('%s sits on the app surface in the kit code type, in either theme', async (_name, node) => {
  await render(node);
  const view = shown.views.at(-1);
  if (!view) throw new Error('Nothing rendered');
  const css = view.options.unsafeCSS ?? '';
  // The renderer's own light and dark backgrounds (GitHub's) give way to the app's surface,
  // and its separators to the app's quiet fill.
  expect(css).toMatch(/--diffs-light-bg:\s*var\(--background\)/);
  expect(css).toMatch(/--diffs-dark-bg:\s*var\(--background\)/);
  expect(css).toMatch(/--diffs-bg-separator-override:\s*var\(--muted\)/);
  // The kit code size comes from its type role, not a number written here.
  expect(css).toMatch(/--diffs-font-size:\s*var\(--fs-caption\)/);
  expect(view.style?.fontSize).toBeUndefined();
});

it.each(['unified', 'split'] as const)(
  'keeps the %s diff comment "+" inside the gutter, off the code',
  async (layout) => {
    await render(
      <DiffCode
        diff={{ name: 'a.ts', hunks: [] } as unknown as FileDiffMetadata}
        layout={layout}
        comments={[]}
        onPick={() => {}}
      />,
    );
    const css = shown.views.at(-1)?.options.unsafeCSS ?? '';
    // The renderer's own rule hangs the button past the number column by a line height less one
    // character; with no overhang it covers the line number, never the line's first character.
    expect(css).toMatch(/\[data-utility-button\]\s*\{\s*margin-right:\s*0;?\s*\}/);
  },
);

const sources = [
  [
    'diff',
    () => (
      <DiffCode
        diff={{ name: 'a.ts', hunks: [] } as unknown as FileDiffMetadata}
        layout="unified"
        comments={[]}
      />
    ),
  ],
  ['source view', () => <SourceCode path="a.ts" text="x" onSelect={() => {}} />],
] as const;

it.each(sources)(
  'keeps GitHub light and dark syntax colors in the %s without a named theme',
  async (_name, node) => {
    await render(node());
    expect(shown.views.at(-1)?.options.theme).toEqual({
      dark: 'github-dark',
      light: 'github-light',
    });
    expect(shown.pool.setRenderOptions).toHaveBeenLastCalledWith({
      theme: { dark: 'github-dark', light: 'github-light' },
    });
  },
);

it.each(sources)(
  'colors the %s from the root syntax tokens under a named theme',
  async (_name, node) => {
    shown.palette = { name: 'Any' };
    await render(node());
    const named = { dark: 'corral-dark', light: 'corral-light' };
    expect(shown.views.at(-1)?.options.theme).toEqual(named);
    // The shared highlight pool (and its worker) switches to the registered token themes.
    expect(shown.pool.setRenderOptions).toHaveBeenLastCalledWith({ theme: named });
    expect(shown.registered.map((each) => each.name).sort()).toEqual([
      'corral-dark',
      'corral-light',
    ]);
    expect(JSON.stringify(shown.registered)).toContain('var(--syntax-keyword)');
  },
);
