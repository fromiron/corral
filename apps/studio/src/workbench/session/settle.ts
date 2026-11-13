import { createContext, useContext, useEffect, useState } from 'react';

/**
 * How long a button that just took another's place stays unpressable (features/composer-flow.md
 * "활동 바"): Stop right after a send, the next approval right after another was on the line. A
 * second press on the same place is not taken as a press on what came there.
 */
export const SETTLE_MS = 600;

/** The wait, for a host or a test that holds its own clock. */
export const SettleContext = createContext(SETTLE_MS);

/**
 * False for the settle wait after `shown` turns true; true otherwise. What is there when the page
 * opens needs no wait: nothing else was pressed in its place.
 */
export function useSettledAppearance(shown: boolean): boolean {
  const ms = useContext(SettleContext);
  const [state, setState] = useState({ shown, held: false });
  const changed = shown !== state.shown;
  if (changed) setState({ shown, held: shown });
  const held = state.held;
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setState((current) => ({ ...current, held: false })), ms);
    return () => clearTimeout(timer);
  }, [held, ms]);
  return !shown || (!changed && !held);
}

type Key = string | number | null;

/**
 * False for the settle wait after `key` becomes a value other than the last one it had; true
 * otherwise. `null` (nothing in that place) neither starts nor ends a wait, so a value that comes
 * back after a gap, or after another, still waits; the first value ever is settled at once.
 */
export function useSettled(key: Key): boolean {
  const ms = useContext(SettleContext);
  const [state, setState] = useState<{ last: Key; held: Key }>({ last: key, held: null });
  const fresh = key !== null && key !== state.last;
  if (fresh) setState({ last: key, held: state.last === null ? null : key });
  const held = state.held;
  useEffect(() => {
    if (held === null) return;
    const timer = setTimeout(
      () => setState((current) => (current.held === held ? { ...current, held: null } : current)),
      ms,
    );
    return () => clearTimeout(timer);
  }, [held, ms]);
  if (fresh) return state.last === null;
  return held === null || held !== key;
}
