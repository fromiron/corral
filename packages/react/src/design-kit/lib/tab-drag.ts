// -----------------------------------------------------------------------------
// The arithmetic of dragging a tab within a strip. A pointer falls in a slot
// between tabs: 0 before the first, n after the last. A tab dropped in one of
// the two slots beside it stays where it is.
// -----------------------------------------------------------------------------

/** The slot a pointer at `x` falls in, from the tabs' horizontal midpoints in order. */
export function dropSlot(midpoints: readonly number[], x: number): number {
  let slot = 0;
  for (const midpoint of midpoints) {
    if (midpoint < x) slot += 1;
    else break;
  }
  return slot;
}

/** The index a tab at `from` ends up at when dropped in `slot`; `from` when it does not move. */
export function reorderIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}
