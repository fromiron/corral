import { type Presence, settle } from '@corral/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

interface Held {
  shown: Presence;
  since: number | null;
  holdUntil: number | null;
}

interface Entry extends Held {
  /** The mounted views that list this key; the entry goes when the last one stops. */
  owners: Set<object>;
}

/** Held states by key, shared by every view that shows them. */
export type PresenceHolds = Map<string, Entry>;

export interface PresenceClock {
  now(): number;
}

const systemClock: PresenceClock = { now: () => Date.now() };
const sharedHolds: PresenceHolds = new Map();

/**
 * What each keyed state shows through the exit grace (docs/specs/features/presence.md). The
 * run list has no end times, so a hold starts at the first sight of the end. That `since` is kept
 * across renders and shared by every mounted view (the sidebar and the project's Sessions tab
 * hold one session to the same end), and one timer per view judges again when its earliest hold
 * ends, so a poll that judges again never moves the end. A key no mounted view lists is
 * forgotten, so a view opened later shows an end it did not see at once.
 */
export function useSettledPresence(
  live: ReadonlyMap<string, Presence>,
  clock: PresenceClock = systemClock,
  holds: PresenceHolds = sharedHolds,
): ReadonlyMap<string, Presence> {
  const owner = useRef({}).current;
  const [wake, setWake] = useState(0);
  const settled = useMemo(() => {
    void wake;
    const now = clock.now();
    const held = new Map<string, Held>();
    for (const [key, next] of live) {
      const seen = holds.get(key);
      const result = settle(seen?.shown ?? null, next, { since: seen?.since ?? null, now });
      held.set(key, { shown: result.presence, since: result.since, holdUntil: result.holdUntil });
    }
    return held;
  }, [live, clock, holds, wake]);
  // Commit before paint, so the next render, here or in another view, settles from this one.
  const owned = useRef(new Set<string>());
  useLayoutEffect(() => {
    for (const [key, next] of settled) {
      const entry = holds.get(key);
      // Two views that saw the same end in one pass keep the earlier sight: the end only stays.
      const since =
        entry?.since != null && next.since != null ? Math.min(entry.since, next.since) : next.since;
      const holdUntil =
        entry?.holdUntil != null && next.holdUntil != null
          ? Math.min(entry.holdUntil, next.holdUntil)
          : next.holdUntil;
      const owners = entry?.owners ?? new Set<object>();
      owners.add(owner);
      holds.set(key, { shown: next.shown, since, holdUntil, owners });
    }
    for (const key of owned.current) if (!settled.has(key)) release(holds, key, owner);
    owned.current = new Set(settled.keys());
  }, [settled, holds, owner]);
  useLayoutEffect(
    () => () => {
      for (const key of owned.current) release(holds, key, owner);
      owned.current = new Set();
    },
    [holds, owner],
  );
  const until = useMemo(() => {
    let earliest: number | null = null;
    for (const entry of settled.values())
      if (entry.holdUntil !== null && (earliest === null || entry.holdUntil < earliest))
        earliest = entry.holdUntil;
    return earliest;
  }, [settled]);
  const timer = useRef<{ at: number; id: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    if (timer.current && timer.current.at === until) return;
    if (timer.current) clearTimeout(timer.current.id);
    timer.current = null;
    if (until === null) return;
    const id = setTimeout(
      () => {
        timer.current = null;
        setWake((count) => count + 1);
      },
      Math.max(0, until - clock.now()),
    );
    timer.current = { at: until, id };
  }, [until, clock]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current.id);
      timer.current = null;
    },
    [],
  );
  return useMemo(() => new Map([...settled].map(([key, entry]) => [key, entry.shown])), [settled]);
}

function release(holds: PresenceHolds, key: string, owner: object) {
  const entry = holds.get(key);
  if (!entry) return;
  entry.owners.delete(owner);
  if (!entry.owners.size) holds.delete(key);
}
