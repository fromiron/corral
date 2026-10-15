import { describe, expect, it } from 'vitest';
import { isTextEditingEvent } from '../src/components/EditorToolbar.tsx';

function keydown(
  init: KeyboardEventInit & { keyCode?: number },
  target: HTMLElement = document.body,
) {
  const event = new KeyboardEvent('keydown', { bubbles: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('isTextEditingEvent', () => {
  it('[TC-CAN-005-N] treats IME composition as text editing, never as a canvas command', () => {
    expect(isTextEditingEvent(keydown({ key: 'Enter', isComposing: true }))).toBe(true);
    expect(isTextEditingEvent(keydown({ key: 'z', ctrlKey: true, keyCode: 229 }))).toBe(true);
  });

  it('leaves keys in text fields to the browser', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(
        isTextEditingEvent(keydown({ key: 'z', ctrlKey: true }, document.createElement(tag))),
      ).toBe(true);
    }
  });

  it('lets canvas shortcuts through elsewhere', () => {
    expect(isTextEditingEvent(keydown({ key: 'z', ctrlKey: true }))).toBe(false);
  });
});
