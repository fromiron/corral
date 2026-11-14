import { expect, it } from 'vitest';
import { stepTopbarTier, TOPBAR_TIERS, topbarLayout, topbarTierFor } from './topbarTier.ts';

// What each tier asked for in a session with four view tabs and a running run (English, default
// density), measured in the browser. The run pill and its buttons account for the first steps.
const NEEDS = [1322, 1188, 1146, 1063, 838, 640, 517, 366];

it('gives way in the documented order, one thing at a time', () => {
  const layouts = TOPBAR_TIERS.map((_, index) => topbarLayout(index));
  expect(layouts.map((layout) => layout.tier)).toEqual([
    'full',
    'icons',
    'no-clock',
    'short-pill',
    'view-menu',
    'project-icon',
    'two-rows',
    'two-rows-menu',
  ]);
  expect(layouts.map((layout) => layout.actions)).toEqual([
    'words',
    ...Array.from({ length: 7 }, () => 'icons'),
  ]);
  expect(layouts.map((layout) => layout.pill)).toEqual([
    'full',
    'full',
    'no-clock',
    'short',
    'short',
    'short',
    'short',
    'number',
  ]);
  expect(layouts.map((layout) => layout.views)).toEqual([
    'tabs',
    'tabs',
    'tabs',
    'tabs',
    'menu',
    'menu',
    // On its own row the tabs return while they fit.
    'tabs',
    'menu',
  ]);
  expect(layouts.map((layout) => layout.project)).toEqual([
    'name',
    'name',
    'name',
    'name',
    'name',
    'icon',
    'icon',
    'icon',
  ]);
  expect(layouts.map((layout) => layout.rows)).toEqual([1, 1, 1, 1, 1, 1, 2, 2]);
  // Only the last tier folds the page's tools into its menu, so the second row holds.
  expect(layouts.map((layout) => layout.tools)).toEqual([
    ...Array.from({ length: 7 }, () => 'bar'),
    'menu',
  ]);
});

it('keeps the whole name through the cheap steps and a readable one to the last', () => {
  expect(TOPBAR_TIERS.map((_, index) => topbarLayout(index).path)).toEqual([
    'full',
    'full',
    'full',
    'comfortable',
    'comfortable',
    'minimum',
    'minimum',
    'minimum',
  ]);
});

it.each([
  // [bar width, tier]: 1440, 1280, 1100 and 1024 wide windows beside a 256px sidebar, then
  // 900 and 390 wide windows where the sidebar is a drawer.
  [1440, 'full'],
  [1184, 'no-clock'],
  [1024, 'view-menu'],
  [844, 'view-menu'],
  [768, 'project-icon'],
  [900, 'view-menu'],
  [600, 'two-rows'],
  [390, 'two-rows-menu'],
  [320, 'two-rows-menu'],
] as const)('a %ipx bar rests at %s', (width, tier) => {
  expect(topbarTierFor(width, NEEDS).tier).toBe(tier);
});

it('steps down only when the tier on screen does not fit, and never past the last', () => {
  expect(stepTopbarTier(0, 1000, [1322])).toBe(1);
  expect(stepTopbarTier(0, 1400, [1322])).toBe(0);
  expect(stepTopbarTier(7, 100, NEEDS)).toBe(7);
});

it('steps back up when the roomier tier is known to fit, and tries one it has not seen', () => {
  expect(stepTopbarTier(4, 1100, NEEDS)).toBe(3);
  expect(stepTopbarTier(4, 1000, NEEDS)).toBe(4);
  // After the content changed, what the roomier tier asks for is unknown again.
  expect(stepTopbarTier(4, 1000, [undefined, undefined, undefined, undefined, 838])).toBe(3);
});

it('treats an out-of-range tier as the nearest one', () => {
  expect(topbarLayout(-3).tier).toBe('full');
  expect(topbarLayout(99).tier).toBe('two-rows-menu');
});
