import { type ReactNode, useCallback, useState } from 'react';

// Remembered per-browser view choices, and the frame of the project and review pages.

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** A view preference kept in this browser; never a fact about a run. */
export function useRemembered<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [state, setValue] = useState(() => ({ key, value: stored(key, fallback) }));
  const value = state.key === key ? state.value : stored(key, fallback);
  if (state.key !== key) setValue({ key, value });
  const set = useCallback(
    (next: T) => {
      setValue({ key, value: next });
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Remembered for this page only.
      }
    },
    [key],
  );
  return [value, set];
}

/**
 * The page frame of the project and review pages. Session panes live in the dock
 * (DockWorkbench); this frame no longer has a side panel of its own (#90).
 */
export function WorkbenchLayout({ main }: { main: ReactNode }) {
  return (
    <div className="workbench-frame @container/workbench flex h-full min-h-0 min-w-0 flex-col">
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{main}</div>
      </div>
    </div>
  );
}
