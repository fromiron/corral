import { afterEach, describe, expect, it } from 'vitest';
import { SHORTCUTS, shortcutFor, shortcutLabel } from './shortcuts.ts';

// Workbench polish P4: one shortcut table; what help shows is what the key handler matches.

const press = (init: KeyboardEventInit & { keyCode?: number }) =>
  ({
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    ...init,
  }) as unknown as KeyboardEvent;

afterEach(() => {
  delete (globalThis as { corralDesktop?: unknown }).corralDesktop;
});

describe('shortcut table', () => {
  it('matches the chords it lists, and nothing while an IME composes', () => {
    expect(shortcutFor(press({ key: 'k', ctrlKey: true }))?.id).toBe('palette');
    expect(shortcutFor(press({ key: 'K', ctrlKey: true }))?.id).toBe('palette');
    expect(shortcutFor(press({ key: 'k' }))).toBeNull();
    expect(shortcutFor(press({ key: 'k', ctrlKey: true, isComposing: true }))).toBeNull();
    expect(shortcutFor(press({ key: '∫', code: 'KeyB', ctrlKey: true, altKey: true }))?.id).toBe(
      'view.panel',
    );
    expect(shortcutFor(press({ key: 'b', ctrlKey: true }))?.id).toBe('view.sidebar');
  });

  it('leaves the browser its own keys and takes them in the desktop app', () => {
    expect(shortcutFor(press({ key: 'n', ctrlKey: true }))).toBeNull();
    expect(shortcutFor(press({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }))?.id).toBe(
      'session.new',
    );
    expect(shortcutLabel('session.jump')).toBeUndefined();
    (globalThis as { corralDesktop?: unknown }).corralDesktop = {};
    expect(shortcutFor(press({ key: 'n', ctrlKey: true }))?.id).toBe('session.new');
    expect(shortcutFor(press({ key: '3', code: 'Digit3', ctrlKey: true }))).toEqual({
      id: 'session.jump',
      digit: 3,
    });
  });

  it('gives every shortcut a distinct chord', () => {
    const chords = SHORTCUTS.map((s) => JSON.stringify(s.chord));
    expect(new Set(chords).size).toBe(chords.length);
  });
});
