import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

// How each history entry was reached (push, replace, Back, Forward, a jump), recorded for the
// session frame. The router reports only where it is; the history says how it got there, and
// says it synchronously, before the router resolves. The app's root records it from its first
// render on, so a conversation entered from another screen knows how it was entered.

export type HistoryActionType = 'PUSH' | 'REPLACE' | 'BACK' | 'FORWARD' | 'GO';

interface Recorder {
  subscribe(
    listener: (args: { location: { state: unknown }; action: { type: string } }) => void,
  ): () => void;
}

const recorded = new WeakMap<object, Map<string, HistoryActionType>>();

function entryKey(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const value =
    (state as { __TSR_key?: unknown; key?: unknown }).__TSR_key ?? (state as { key?: unknown }).key;
  return typeof value === 'string' ? value : null;
}

/** Starts recording this router's history actions; the app's root calls it once. */
export function useRecordHistoryActions() {
  const { history } = useRouter();
  useEffect(() => {
    let actions = recorded.get(history);
    if (!actions) {
      actions = new Map();
      recorded.set(history, actions);
    }
    const map = actions;
    return (history as unknown as Recorder).subscribe(({ location, action }) => {
      const key = entryKey(location.state);
      if (key) map.set(key, action.type as HistoryActionType);
    });
  }, [history]);
}

/** How the entry with this key was last reached; null for the first one loaded. */
export function historyActionOf(history: object, key: string): HistoryActionType | null {
  return recorded.get(history)?.get(key) ?? null;
}

/** Back, Forward or a jump: the entry was travelled to, whatever it carries. */
export function travelled(action: HistoryActionType | null): boolean {
  return action === 'BACK' || action === 'FORWARD' || action === 'GO';
}

/**
 * The history state of an address from outside the app (an OS notification): the flag alone.
 * The history assigns its own entry key and index; nothing of the entry it leaves (the frame's
 * mark of its own writes, a dialog's bookkeeping) comes along.
 */
export function outsideEntryState(): { corralEntry: 'outside' } {
  return { corralEntry: 'outside' };
}

/** Goes to `to` as an address from outside the app: the way an OS notification arrives. */
export function navigateFromOutside(
  navigate: (options: { to: string; state: { corralEntry: 'outside' } }) => Promise<unknown>,
  to: string,
): Promise<unknown> {
  return navigate({ to, state: outsideEntryState() });
}
