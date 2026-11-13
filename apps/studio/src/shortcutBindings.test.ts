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

it('lets only the reply quote take Alt alone, and never a bare key', () => {
  storage();
  expect(bindingError('reply.quote', { alt: true, key: 'k' }, effectiveShortcuts(), false)).toBe(
    null,
  );
  expect(bindingError('reply.quote', { key: 'k' }, effectiveShortcuts(), false)).toBe('reserved');
  expect(bindingError('palette', { alt: true, key: 'k' }, effectiveShortcuts(), false)).toBe(
    'reserved',
  );
  expect(bindingError('reply.quote', { mod: true, key: 'k' }, effectiveShortcuts(), false)).toBe(
    'conflict',
  );
});

it('keeps the browser’s own Alt keys from the reply quote, as it keeps its other keys from all', () => {
  storage();
  for (const key of ['d', 'e', 'f', 'b', 'h', 's', 't', 'v'])
    expect(bindingError('reply.quote', { alt: true, key }, {}, false), key).toBe('reserved');
  // Its tabs by number, in a browser only.
  expect(bindingError('reply.quote', { alt: true, key: '1' }, {}, false)).toBe('reserved');
  expect(bindingError('reply.quote', { alt: true, key: '1' }, {}, true)).toBeNull();
  // As settings save a chord: each modifier held or not.
  for (const key of ['q', 'w', 'k'])
    expect(
      bindingError('reply.quote', { key, mod: false, alt: true, shift: false }, {}, false),
      key,
    ).toBeNull();
  expect(bindingError('reply.quote', { mod: true, key: 'w' }, {}, false)).toBe('reserved');
});
