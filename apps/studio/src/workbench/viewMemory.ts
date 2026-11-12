// What conversation rows remember across the timeline unmounting them (a run's last view, the
// person's log choice, a row's height) lives in module memory. Each such memory registers how it
// is forgotten here, so tests start from none. Without dependencies of its own, so the test setup
// can import it before any test file's mocks apply.

const resets = new Set<() => void>();

export function forgetOnReset(reset: () => void) {
  resets.add(reset);
}

/** Forgets every remembered row view; the studio test setup calls it after each test. */
export function resetViewMemory() {
  for (const reset of resets) reset();
}
