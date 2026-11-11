// @vitest-environment jsdom
import type { FileDiffMetadata } from '@pierre/diffs';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DiffCode, SourceCode } from './PierreCode.tsx';

const shown = vi.hoisted(() => ({
  views: [] as { style?: Record<string, unknown>; options: { unsafeCSS?: string } }[],
}));
vi.mock('@pierre/diffs/worker/worker.js?worker', () => ({ default: class {} }));
vi.mock('@pierre/diffs/react', () => ({
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  CodeView: (props: { style?: Record<string, unknown>; options: { unsafeCSS?: string } }) => {
    shown.views.push(props);
    return <div data-testid="code" />;
  },
}));
vi.mock('./preferences.ts', () => ({ usePreferences: () => ({ theme: 'dark' }) }));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  shown.views = [];
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
