import { useCallback, useEffect, useState } from 'react';

const CHANGED = 'corral:cancel-confirmation-changed';

/** A pending confirmation is not a command; retain only its Run identity across reloads. */
export function useCancelConfirmation(runId: string | null, ended = false) {
  const key = runId ? `corral:cancel-confirmation:${runId}` : null;
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
    return () => globalThis.removeEventListener?.(CHANGED, refresh);
  }, [key, ended]);
  return [Boolean(key && pending === key && !ended), setOpen] as const;
}
