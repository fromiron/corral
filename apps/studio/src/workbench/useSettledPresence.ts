import { type Presence, settle } from '@corral/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

interface Held {
  shown: Presence;
  since: number | null;
  holdUntil: number | null;
}

export interface PresenceClock {
  now(): number;
}

const systemClock: PresenceClock = { now: () => Date.now() };

/**
 * What each keyed state shows through the exit grace (docs/specs/features/presence.md). The
 * run list has no end times, so a hold starts at the first sight of the end: that `since` is kept
 * across renders, and one timer judges again when the earliest hold ends, so a poll that judges
 * again never moves the end. Keys that leave `live` are forgotten; the timer goes with the view.
 */
export function useSettledPresence(
  live: ReadonlyMap<string, Presence>,
  clock: PresenceClock = systemClock,
): ReadonlyMap<string, Presence> {
  const memory = useRef(new Map<string, Held>());
  const [wake, setWake] = useState(0);
  const settled = useMemo(() => {
    void wake;
    const now = clock.now();
    const held = new Map<string, Held>();
    for (const [key, next] of live) {
      const seen = memory.current.get(key);
      const result = settle(seen?.shown ?? null, next, { since: seen?.since ?? null, now });
      held.set(key, { shown: result.presence, since: result.since, holdUntil: result.holdUntil });
    }
    let until: number | null = null;
    for (const entry of held.values())
      if (entry.holdUntil !== null && (until === null || entry.holdUntil < until))
        until = entry.holdUntil;
    return { held, until };
  }, [live, clock, wake]);
  // Commit before paint, so the next render settles from what this one showed.
  useLayoutEffect(() => {
    memory.current = settled.held;
  }, [settled]);
  const timer = useRef<{ at: number; id: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    const at = settled.until;
    if (timer.current && timer.current.at === at) return;
    if (timer.current) clearTimeout(timer.current.id);
    timer.current = null;
    if (at === null) return;
    const id = setTimeout(
      () => {
        timer.current = null;
        setWake((count) => count + 1);
      },
      Math.max(0, at - clock.now()),
    );
    timer.current = { at, id };
  }, [settled, clock]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current.id);
      timer.current = null;
    },
    [],
  );
  return useMemo(
    () => new Map([...settled.held].map(([key, entry]) => [key, entry.shown])),
    [settled],
  );
}
