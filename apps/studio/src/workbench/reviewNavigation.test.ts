// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { REVIEW_MOVE_KEYS, reviewMoveFor, stepIndex } from './reviewNavigation.ts';

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('review keyboard moves', () => {
  it('maps the bracket keys to changes and the braces to files', () => {
    expect(reviewMoveFor(press(']'))).toBe('nextChange');
    expect(reviewMoveFor(press('['))).toBe('previousChange');
    expect(reviewMoveFor(press('}', { shiftKey: true }))).toBe('nextFile');
    expect(reviewMoveFor(press('{', { shiftKey: true }))).toBe('previousFile');
    expect(reviewMoveFor(press(']', { shiftKey: true, code: 'BracketRight' }))).toBe('nextFile');
    expect(REVIEW_MOVE_KEYS.nextFile).toBe('Shift+]');
  });

  it('leaves the keys to text fields', () => {
    for (const field of [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
    ])
      expect(reviewMoveFor(press(']', {}, field))).toBeNull();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inside = document.createElement('span');
    editable.append(inside);
    document.body.append(editable);
    expect(reviewMoveFor(press(']', {}, editable))).toBeNull();
    expect(reviewMoveFor(press(']', {}, inside))).toBeNull();
    editable.remove();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    expect(reviewMoveFor(press(']', {}, checkbox))).toBe('nextChange');
  });

  it('never takes a modified key or an IME composition', () => {
    // Ctrl/⌘+[ and ] are history back and forward (shortcuts.ts); Alt+arrows are the browser's.
    expect(reviewMoveFor(press('[', { ctrlKey: true }))).toBeNull();
    expect(reviewMoveFor(press(']', { metaKey: true }))).toBeNull();
    expect(reviewMoveFor(press(']', { altKey: true }))).toBeNull();
    expect(reviewMoveFor(press(']', { isComposing: true }))).toBeNull();
    expect(reviewMoveFor(press('j'))).toBeNull();
  });
});

describe('stepIndex', () => {
  it('starts at either end and stops there instead of wrapping', () => {
    expect(stepIndex(null, 3, 1)).toBe(0);
    expect(stepIndex(null, 3, -1)).toBe(2);
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBeNull();
    expect(stepIndex(0, 3, -1)).toBeNull();
    expect(stepIndex(null, 0, 1)).toBeNull();
  });
});
