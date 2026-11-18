import { expect, it } from 'vitest';
import { stepTopbarTier, TOPBAR_TIERS, topbarLayout, topbarTierFor } from './topbarTier.ts';

// What each tier asked for in a session (English, default density), measured in the browser
// before the view tabs and the run pill left the bar; the widths of the tiers that remain.
const NEEDS = [1322, 1063, 640, 517];

it('gives way in the documented order, one thing at a time', () => {
  const layouts = TOPBAR_TIERS.map((_, index) => topbarLayout(index));
  expect(layouts.map((layout) => layout.tier)).toEqual([
    'full',
    'short-path',
    'project-icon',
    'two-rows',
  ]);
  expect(layouts.map((layout) => layout.project)).toEqual(['name', 'name', 'icon', 'icon']);
  expect(layouts.map((layout) => layout.rows)).toEqual([1, 1, 1, 2]);
});

it('lets the name shorten before the project folds, and keeps a readable one to the last', () => {
  expect(TOPBAR_TIERS.map((_, index) => topbarLayout(index).path)).toEqual([
    'full',
    'comfortable',
    'minimum',
    'minimum',
  ]);
});

it.each([
  // [bar width, tier]: 1440, 1280, 1100 and 1024 wide windows beside a 256px sidebar, then
  // 900 and 390 wide windows where the sidebar is a drawer.
  [1440, 'full'],
  [1184, 'short-path'],
  [1024, 'project-icon'],
  [844, 'project-icon'],
  [768, 'project-icon'],
  [900, 'project-icon'],
  [600, 'two-rows'],
  // The narrowest widths rest on two rows: nothing folds into the menu (decision 24).
  [390, 'two-rows'],
  [320, 'two-rows'],
] as const)('a %ipx bar rests at %s', (width, tier) => {
  expect(topbarTierFor(width, NEEDS).tier).toBe(tier);
});

it('steps down only when the tier on screen does not fit, and never past the last', () => {
  expect(stepTopbarTier(0, 1000, [1322])).toBe(1);
  expect(stepTopbarTier(0, 1400, [1322])).toBe(0);
  expect(stepTopbarTier(3, 100, NEEDS)).toBe(3);
});

it('steps back up when the roomier tier is known to fit, and tries one it has not seen', () => {
  expect(stepTopbarTier(2, 1100, NEEDS)).toBe(1);
  expect(stepTopbarTier(2, 1000, NEEDS)).toBe(2);
  // After the content changed, what the roomier tier asks for is unknown again.
  expect(stepTopbarTier(2, 1000, [undefined, undefined, 640])).toBe(1);
});

it('treats an out-of-range tier as the nearest one', () => {
  expect(topbarLayout(-3).tier).toBe('full');
  expect(topbarLayout(99).tier).toBe('two-rows');
});
