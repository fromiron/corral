import { useCallback, useEffect, useRef, useState } from 'react';

const CHANGED = 'corral:cancel-confirmation-changed';
const keyOf = (runId: string) => `corral:cancel-confirmation:${runId}`;

function discard(key: string) {
  try {
    globalThis.sessionStorage?.removeItem(key);
    globalThis.dispatchEvent?.(new Event(CHANGED));
  } catch {
    // Storage may be unavailable; the departed view still drops its local confirmation.
  }
}

/**
 * Asks to confirm the run's whole-run cancel from outside a holder (the place that carries the
 * run's controls, as a press on its Stop would). Every holder of the run follows at once.
 */
export function askCancelConfirmation(runId: string): void {
  try {
    globalThis.sessionStorage?.setItem(keyOf(runId), 'pending');
    globalThis.dispatchEvent?.(new Event(CHANGED));
  } catch {
    // Storage may be unavailable; the holders keep what they show.
  }
}

/** Lets the run's pending confirmation go from outside a holder; nothing is sent. */
export function discardCancelConfirmation(runId: string): void {
  discard(keyOf(runId));
}

/** A pending confirmation is not a command; retain only its Run identity across reloads. */
export function useCancelConfirmation(runId: string | null, ended = false) {
  const key = runId ? keyOf(runId) : null;
  const previousKey = useRef(key);
  const effectVersion = useRef(0);
  const read = () => {
    try {
      return key && globalThis.sessionStorage?.getItem(key) === 'pending' ? key : null;
    } catch {
      return null;
    }
  };
  const [pending, setPending] = useState(read);
  const setOpen = useCallback(
    (open: boolean) => {
      setPending(open ? key : null);
      try {
        if (key) {
          if (open) globalThis.sessionStorage?.setItem(key, 'pending');
          else globalThis.sessionStorage?.removeItem(key);
          globalThis.dispatchEvent?.(new Event(CHANGED));
        }
      } catch {
        // Storage may be unavailable; confirmation still works in this view.
      }
    },
    [key],
  );
  useEffect(() => {
    const version = ++effectVersion.current;
    if (previousKey.current && previousKey.current !== key) discard(previousKey.current);
    previousKey.current = key;
    const refresh = () => {
      try {
        if (ended && key) globalThis.sessionStorage?.removeItem(key);
        setPending(
          !ended && key && globalThis.sessionStorage?.getItem(key) === 'pending' ? key : null,
        );
      } catch {
        setPending(null);
      }
    };
    refresh();
    globalThis.addEventListener?.(CHANGED, refresh);
    return () => {
      globalThis.removeEventListener?.(CHANGED, refresh);
      // StrictMode reconnects effects in the same commit; a page reload never unmounts React.
      queueMicrotask(() => {
        if (key && effectVersion.current === version) discard(key);
      });
    };
  }, [key, ended]);
  return [Boolean(key && pending === key && !ended), setOpen] as const;
}
