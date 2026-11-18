import { expect, it } from 'vitest';
import { dropSlot, reorderIndex } from '../src/design-kit/lib/tab-drag.ts';

// A tab dragged in its strip lands in a slot between tabs (0 before the first, n after the last);
// the host is told the index the tab ends up at.

it('finds the slot under the pointer from the tabs’ midpoints', () => {
  const midpoints = [50, 150, 250, 350];
  const xs = [-20, 0, 49, 50, 51, 149, 151, 300, 351, 999];
  expect(xs.map((x) => dropSlot(midpoints, x))).toEqual([0, 0, 0, 0, 1, 1, 2, 3, 4, 4]);
  // An empty strip has one slot.
  expect(dropSlot([], 120)).toBe(0);
});

// from, slot, the index it lands at (four tabs; the slots either side of a tab are its own place).
const table: [number, number, number][] = [
  [0, 0, 0],
  [0, 1, 0],
  [0, 2, 1],
  [0, 3, 2],
  [0, 4, 3],
  [1, 0, 0],
  [1, 1, 1],
  [1, 2, 1],
  [1, 3, 2],
  [1, 4, 3],
  [2, 0, 0],
  [2, 1, 1],
  [2, 2, 2],
  [2, 3, 2],
  [2, 4, 3],
  [3, 0, 0],
  [3, 1, 1],
  [3, 2, 2],
  [3, 3, 3],
  [3, 4, 3],
];

it.each(table)('lands a tab from %i dropped in slot %i at %i', (from, slot, to) => {
  expect(reorderIndex(from, slot)).toBe(to);
});
