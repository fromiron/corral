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
export function bindingError(
  id: ShortcutId,
  candidate: Chord,
  effective: ShortcutBindings,
  desktop: boolean,
): 'reserved' | 'conflict' | null {
  if (
    candidate?.mod !== true ||
    typeof candidate.key !== 'string' ||
    !/^(?:[a-z0-9,./[\]]|Digit)$/i.test(candidate.key) ||
    (candidate.alt !== undefined && typeof candidate.alt !== 'boolean') ||
    (candidate.shift !== undefined && typeof candidate.shift !== 'boolean') ||
    Object.keys(candidate).some((key) => !['mod', 'alt', 'shift', 'key'].includes(key)) ||
    (id === 'session.jump') !== (candidate.key === 'Digit')
  )
    return 'reserved';
  if (
    /^[acvxzysfqwt]$/i.test(candidate.key) ||
    (!desktop && /^(?:[nlrpd1-9]|Digit)$/i.test(candidate.key))
  )
    return 'reserved';
  return Object.entries(effective).some(
    ([other, chord]) => other !== id && chord && sameChord(candidate, chord),
  )
    ? 'conflict'
    : null;
}
