import { useEffect } from 'react';

// A modal confirmation that holds the screen (features/session-panel.md "실행 조작이 서는 곳":
// the composer's whole-run confirmation). While one is up, global shortcuts and the panel's
// own actions do nothing; Escape and the confirmation's own buttons still answer it.

let open = 0;

/** True while a modal confirmation is up. */
export function modalConfirmationOpen(): boolean {
  return open > 0;
}

/** Holds the screen while `active`: a confirmation calls this with its open state. */
export function useModalConfirmation(active: boolean) {
  useEffect(() => {
    if (!active) return;
    open += 1;
    // The desktop shell's shortcuts are synced from the same rule.
    window.dispatchEvent(new Event('corral:shortcut-context'));
    return () => {
      open -= 1;
      window.dispatchEvent(new Event('corral:shortcut-context'));
    };
  }, [active]);
}
