// Keyboard moves in the Review sub-view: `]`/`[` to the next or previous change in the file,
// Shift+`]`/`[` to the next or previous file. Only unmodified keys outside a text field count, so
// they never take the editor's keys or the global Ctrl/⌘ shortcuts (shortcuts.ts uses Ctrl/⌘+[
// and ] for history); Alt+arrows stay the browser's. Moves stop at either end; they never wrap.

export type ReviewMove = 'nextChange' | 'previousChange' | 'nextFile' | 'previousFile';

/** `aria-keyshortcuts` values for each move. */
export const REVIEW_MOVE_KEYS: Record<ReviewMove, string> = {
  nextChange: ']',
  previousChange: '[',
  nextFile: 'Shift+]',
  previousFile: 'Shift+[',
};

const BUTTON_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color']);

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !BUTTON_INPUTS.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return (
    target.isContentEditable === true ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

export function reviewMoveFor(event: KeyboardEvent): ReviewMove | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  // A key from inside a shadow root (the diff renderer) names its real target first.
  if (isTextEntry(event.composedPath?.()[0] ?? event.target)) return null;
  if (event.key === ']' && !event.shiftKey) return 'nextChange';
  if (event.key === '[' && !event.shiftKey) return 'previousChange';
  if (event.key === '}' || (event.shiftKey && event.code === 'BracketRight')) return 'nextFile';
  if (event.key === '{' || (event.shiftKey && event.code === 'BracketLeft')) return 'previousFile';
  return null;
}

/** The index one step on from `current` (none yet: the first or last), or null at an end. */
export function stepIndex(current: number | null, count: number, direction: 1 | -1) {
  if (count === 0) return null;
  if (current === null || current < 0) return direction === 1 ? 0 : count - 1;
  const next = current + direction;
  return next < 0 || next >= count ? null : next;
}

/** Instant moves when the person asked for reduced motion. */
export function prefersReducedMotion() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Brings an element into view, without animation under reduced motion. */
export function reveal(element: Element | null | undefined) {
  element?.scrollIntoView?.({
    block: 'nearest',
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
}
