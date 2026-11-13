import { useSyncExternalStore } from 'react';
import type { Chord, ShortcutId } from './shortcuts.ts';

export type ShortcutBindings = Partial<Record<ShortcutId, Chord>>;
const EVENT = 'corral:shortcut-bindings';
const key = () =>
  `corral:shortcuts:v1:${(globalThis as { corralDesktop?: unknown }).corralDesktop ? 'desktop' : 'web'}`;
const snapshot = () => {
  try {
    return globalThis.localStorage?.getItem(key()) ?? '{}';
  } catch {
    return '{}';
  }
};
const subscribe = (notify: () => void) => {
  globalThis.addEventListener?.(EVENT, notify);
  globalThis.addEventListener?.('storage', notify);
  return () => {
    globalThis.removeEventListener?.(EVENT, notify);
    globalThis.removeEventListener?.('storage', notify);
  };
};
export function useShortcutBindings() {
  return useSyncExternalStore(subscribe, snapshot, () => '{}');
}
export function readShortcutBindings(serialized = snapshot()): ShortcutBindings {
  try {
    const value = JSON.parse(serialized);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
export function writeShortcutBindings(value: ShortcutBindings) {
  globalThis.localStorage.setItem(key(), JSON.stringify(value));
  globalThis.dispatchEvent(new Event(EVENT));
}
export function sameChord(a: Chord, b: Chord) {
  const overlap =
    a.key.toLowerCase() === b.key.toLowerCase() ||
    (a.key === 'Digit' && /^[1-9]$/.test(b.key)) ||
    (b.key === 'Digit' && /^[1-9]$/.test(a.key));
  return (
    overlap &&
    Boolean(a.mod) === Boolean(b.mod) &&
    Boolean(a.alt) === Boolean(b.alt) &&
    Boolean(a.shift) === Boolean(b.shift)
  );
}
/**
 * The chords a browser or the system keeps for itself, which no shortcut takes: with the platform
 * modifier, editing, finding, tabs, windows and quitting, and in a browser its own window keys;
 * with Alt alone, the browser's address bar and menus (Alt+D, Alt+E, Alt+F and the menu bar's
 * letters) and, in a browser, its tabs by number.
 */
const RESERVED: { alt: boolean; keys: RegExp; web: boolean }[] = [
  { alt: false, keys: /^[acvxzysfqwt]$/i, web: false },
  { alt: false, keys: /^(?:[nlrpd1-9]|Digit)$/i, web: true },
  { alt: true, keys: /^[bdefhstv]$/i, web: false },
  { alt: true, keys: /^(?:[1-9]|Digit)$/i, web: true },
];
function browserKeeps(chord: Chord, desktop: boolean) {
  const altOnly = chord.mod !== true;
  return RESERVED.some(
    (reserved) =>
      reserved.alt === altOnly && (!reserved.web || !desktop) && reserved.keys.test(chord.key),
  );
}
export function bindingError(
  id: ShortcutId,
  candidate: Chord,
  effective: ShortcutBindings,
  desktop: boolean,
): 'reserved' | 'conflict' | null {
  // A quote is taken while reading a reply, outside any text box, so Alt alone may lead its keys.
  const altOnly = id === 'reply.quote' && candidate?.mod !== true && candidate?.alt === true;
  if (
    (candidate?.mod !== true && !altOnly) ||
    typeof candidate.key !== 'string' ||
    !/^(?:[a-z0-9,./[\]]|Digit)$/i.test(candidate.key) ||
    (candidate.alt !== undefined && typeof candidate.alt !== 'boolean') ||
    (candidate.shift !== undefined && typeof candidate.shift !== 'boolean') ||
    Object.keys(candidate).some((key) => !['mod', 'alt', 'shift', 'key'].includes(key)) ||
    (id === 'session.jump') !== (candidate.key === 'Digit')
  )
    return 'reserved';
  if (browserKeeps(candidate, desktop)) return 'reserved';
  return Object.entries(effective).some(
    ([other, chord]) => other !== id && chord && sameChord(candidate, chord),
  )
    ? 'conflict'
    : null;
}
