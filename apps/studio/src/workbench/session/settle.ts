import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

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

/**
 * True for the settle wait after `key` (what came to a place: an approval's buttons) turns to a
 * new value where a frame was painted with only View there (`viewAlone`) since the place was last
 * empty (`there` false). What a frame paints is read before it is painted, from the frame's own
 * callback, which a later render does not take back: a View judged away in the same task is not
 * counted, and one painted, however briefly and however slow the device, always is.
 */
export function useHeldAfterView({
  viewAlone,
  there,
  key,
}: {
  viewAlone: boolean;
  there: boolean;
  key: Key;
}): boolean {
  const ms = useContext(SettleContext);
  const now = useRef({ viewAlone, there });
  const painted = useRef(false);
  const last = useRef<Key>(null);
  const [held, setHeld] = useState<Key>(null);
  useLayoutEffect(() => {
    now.current = { viewAlone, there };
    if (key !== null && key !== last.current && painted.current) setHeld(key);
    last.current = key;
    if (typeof requestAnimationFrame === 'undefined') return;
    // Never cancelled: the frame reads what it is about to paint, whatever rendered since.
    requestAnimationFrame(() => {
      if (now.current.viewAlone) painted.current = true;
      else if (!now.current.there) painted.current = false;
    });
  });
  useEffect(() => {
    if (held === null) return;
    const timer = setTimeout(() => setHeld(null), ms);
    return () => clearTimeout(timer);
  }, [held, ms]);
  return held !== null && held === key;
}
