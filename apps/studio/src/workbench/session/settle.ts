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

type Hold = { round: number; counting: boolean };

/**
 * Whether the activity line's place holds its press (features/composer-flow.md "활동 바"): for the
 * settle wait after what stands there changes to
 *
 * - another approval than the one before on the line, its View or its buttons (the first approval
 *   ever on the line is taken at once);
 * - an approval's buttons where a frame painted View alone (its own, or a count line's) since the
 *   line last waited on nothing;
 * - anything at all while a wait runs: buttons that leave and come back are counted again.
 *
 * The wait counts from the frame that paints what came, never from before it, however late the
 * frame. What a frame paints is read from that frame's own callback, which a later render does not
 * take back: a View judged away in the same task is never counted, one painted always is.
 */
export function useLineHold({
  approval,
  decide,
  waiting,
}: {
  /** The approval the line names, if any. */
  approval: string | null;
  /** Its buttons are on the line. */
  decide: boolean;
  /** The line says something waits (an approval, a question, or a count of them). */
  waiting: boolean;
}): boolean {
  const ms = useContext(SettleContext);
  const [hold, setHold] = useState<Hold | null>(null);
  const place = approval ? `${approval}:${decide ? 'decide' : 'view'}` : null;
  const now = useRef({ waiting, viewAlone: waiting && !decide, hold });
  const first = useRef<string | null>(null);
  const shown = useRef<string | null>(null);
  const last = useRef<string | null>(null);
  const painted = useRef(false);
  const frame = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    now.current = { waiting, viewAlone: waiting && !decide, hold };
    if (approval && first.current === null) first.current = approval;
    if (place !== shown.current && place !== null) {
      const another = last.current !== null && place !== last.current && approval !== first.current;
      if (hold || another || (decide && painted.current))
        setHold({ round: (hold?.round ?? 0) + 1, counting: false });
      last.current = place;
    }
    shown.current = place;
    if (frame.current !== null || typeof requestAnimationFrame === 'undefined') return;
    // One frame waited for at a time, never cancelled by a render: it reads what it paints.
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const painting = now.current;
      if (painting.viewAlone) painted.current = true;
      else if (!painting.waiting) painted.current = false;
      const counting = painting.hold;
      if (!counting || counting.counting) return;
      setHold({ ...counting, counting: true });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setHold((current) => (current?.round === counting.round ? null : current));
      }, ms);
    });
  });
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return hold !== null;
}
