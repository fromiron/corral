import { afterEach, expect, it, vi } from 'vitest';
import { bindingError, readShortcutBindings, writeShortcutBindings } from './shortcutBindings.ts';
import { effectiveShortcuts, shortcutFor, shortcutLabel } from './shortcuts.ts';

afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('dispatchEvent', vi.fn());
  return values;
}
const press = (change = {}) =>
  ({
    key: 'K',
    code: 'KeyK',
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    altKey: false,
    ...change,
  }) as KeyboardEvent;

it('saves keybindings per surface and uses the same chord for labels and dispatch', () => {
  storage();
  writeShortcutBindings({ palette: { mod: true, shift: true, key: 'k' } });
  expect(readShortcutBindings().palette?.shift).toBe(true);
  expect(shortcutLabel('palette')).toBe('Ctrl+Shift+K');
  expect(shortcutFor(press())?.id).toBe('palette');
  expect(shortcutFor(press({ shiftKey: false }))).toBeNull();
  vi.stubGlobal('corralDesktop', {});
  expect(shortcutLabel('palette')).toBe('Ctrl+K');
  vi.stubGlobal('corralDesktop', undefined);
  expect(shortcutLabel('palette')).toBe('Ctrl+Shift+K');
  writeShortcutBindings({});
  expect(shortcutLabel('palette')).toBe('Ctrl+K');
});

it('rejects conflicting, editing, OS/browser and corrupt saved shortcuts', () => {
  const values = storage();
  expect(bindingError('palette', { mod: true, key: 'b' }, effectiveShortcuts(), false)).toBe(
    'conflict',
  );
  for (const key of ['v', 'z', 'w', 'q', 'n', '1', 'Tab', 'Enter', 'F4'])
    expect(bindingError('palette', { mod: true, key }, {}, false)).toBe('reserved');
  expect(
    bindingError(
      'palette',
      { mod: true, key: '1' },
      { 'session.jump': { mod: true, key: 'Digit' } },
      true,
    ),
  ).toBe('conflict');
  values.set('corral:shortcuts:v1:web', '{"palette":{"mod":true,"key":"v"},"help":null}');
  expect(shortcutLabel('palette')).toBe('Ctrl+K');
  values.set('corral:shortcuts:v1:web', 'broken');
  expect(shortcutLabel('palette')).toBe('Ctrl+K');
  values.set('corral:shortcuts:v1:web', '{"palette":{"mod":true,"key":1}}');
  expect(shortcutLabel('palette')).toBe('Ctrl+K');
  expect(shortcutFor(press({ isComposing: true }))).toBeNull();
  expect(shortcutFor(press({ getModifierState: () => true }))).toBeNull();
  expect(shortcutFor(press({ metaKey: true }))).toBeNull();
});
